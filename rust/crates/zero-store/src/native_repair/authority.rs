//! One-use preparation, two isolated candidates, and exact sandbox permissions.
use super::*;
use zero_protocol::{
    repair::{CandidateReceipt, MaterializeRequest},
    review_repair::ReviewRepairBinding,
    sandbox::SandboxRequest,
    verification::Plan,
};
mod effects;
mod finish;
mod inventory;
mod matrix;
mod phase;
pub(super) mod source;
pub(super) fn validate_bound(conn: &Connection, b: &Bound, r: &mut Reader) -> Result<()> {
    inventory::validate_bound(conn, b, r)
}
use phase::{bound_candidate, completed_phase};
use source::bound_source;
fn open(conn: &Connection, b: &Bound, owner: &str) -> Result<()> {
    epoch(conn, owner)?;
    if b.operation.owner.as_deref() != Some(owner)
        || b.operation.status != OperationStatus::Running
        || b.close.is_some()
        || now()? >= b.record.deadline_at_ms
    {
        return Err(bad("execution admission is closed or owner differs"));
    }
    Ok(())
}
fn event(conn: &Connection, b: &Bound, kind: &str, r: &mut Reader) -> Result<Option<(u64, Value)>> {
    let mut q = conn.prepare(
        "SELECT sequence FROM events WHERE session_id=?1 AND kind=?2 ORDER BY sequence LIMIT 2",
    )?;
    let rows = q
        .query_map(params![b.record.session_id, kind], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    match rows.as_slice() {
        [] => Ok(None),
        [seq] => Ok(Some((*seq, r.event(conn, &b.record.session_id, *seq)?.1))),
        _ => Err(bad("duplicate authority witness")),
    }
}
fn preparation(conn: &Connection, b: &Bound, r: &mut Reader) -> Result<Option<u64>> {
    let Some((seq, value)) = event(conn, b, "native_repair_preparation_started", r)? else {
        return Ok(None);
    };
    if value
        != json!({"repair_id":b.record.id,"operation_id":b.operation.id,"intent_sha256":b.record.intent_sha256,"owner":b.operation.owner})
    {
        return Err(bad("preparation witness differs"));
    }
    Ok(Some(seq))
}
fn retain(
    conn: &rusqlite::Transaction<'_>,
    b: &Bound,
    operation: &str,
    name: &str,
    bytes: &[u8],
) -> Result<String> {
    if bytes.len() > crate::MAX_ARTIFACT_BYTES {
        return Err(bad("artifact bound"));
    }
    let digest = format!("sha256:{:x}", Sha256::digest(bytes));
    conn.execute(
        "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
        params![digest, bytes],
    )?;
    if crate::artifacts::read(conn, &digest)? != bytes {
        return Err(bad("artifact collision"));
    }
    conn.execute(
        "INSERT INTO operation_artifacts(operation_id,name,digest) VALUES(?1,?2,?3)",
        params![operation, name, digest],
    )?;
    append(
        conn,
        &b.record.session_id,
        "operation_artifact",
        &json!({"operation_id":operation,"name":name,"digest":digest,"bytes":bytes.len()}),
    )?;
    Ok(digest)
}
fn running_child(
    conn: &rusqlite::Transaction<'_>,
    b: &Bound,
    owner: &str,
    command: String,
    payload: Value,
) -> Result<Operation> {
    let text = String::from_utf8(encode(&payload)?).map_err(bad)?;
    let payload_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let mut op = Operation {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: b.record.session_id.clone(),
        command_id: command,
        payload,
        status: OperationStatus::Admitted,
        owner: None,
        outcome: None,
    };
    conn.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES(?1,?2,?3,?4,?5,'admitted')",params![op.id,op.session_id,op.command_id,text,payload_hash])?;
    append(
        conn,
        &op.session_id,
        "command_admitted",
        &serde_json::to_value(&op)?,
    )?;
    conn.execute(
        "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
        params![op.id, owner],
    )?;
    op.status = OperationStatus::Running;
    op.owner = Some(owner.into());
    append(
        conn,
        &op.session_id,
        "operation_started",
        &serde_json::to_value(&op)?,
    )?;
    Ok(op)
}

fn phase_index(phase: &str) -> Result<usize> {
    match phase {
        "candidate" => Ok(0),
        "reconstructed" => Ok(1),
        _ => Err(bad("unknown repair phase")),
    }
}
fn attached(
    conn: &Connection,
    b: &Bound,
    name: &str,
    r: &mut Reader,
    max: usize,
) -> Result<(String, Vec<u8>)> {
    let digest:String=conn.query_row("SELECT CASE WHEN length(CAST(digest AS BLOB))=71 THEN digest END FROM operation_artifacts WHERE operation_id=?1 AND name=?2",params![b.operation.id,name],|r|r.get(0))?;
    let bytes = r.artifact(conn, &digest, max)?;
    let mut query = conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='operation_artifact' AND json_extract(payload,'$.operation_id')=?2 AND json_extract(payload,'$.name')=?3 ORDER BY sequence LIMIT 2")?;
    let sequences = query
        .query_map(params![b.record.session_id, b.operation.id, name], |row| {
            row.get::<_, u64>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if sequences.len() != 1
        || r.event(conn, &b.record.session_id, sequences[0])?.1
            != json!({"operation_id":b.operation.id,"name":name,"digest":digest,"bytes":bytes.len()})
    {
        return Err(bad("retained parent artifact witness differs"));
    }
    Ok((digest, bytes))
}
fn phase_event(
    conn: &Connection,
    b: &Bound,
    phase: &str,
    suffix: &str,
    r: &mut Reader,
) -> Result<Option<(u64, Value)>> {
    phase_index(phase)?;
    event(conn, b, &format!("native_repair_{phase}_{suffix}"), r)
}
fn case_payload(
    parent: &str,
    phase: &str,
    plan: &FrozenPlan,
    case_index: usize,
    repeat: usize,
) -> Result<(String, Value, SandboxRequest)> {
    phase_index(phase)?;
    let case = plan
        .plan()
        .cases
        .get(case_index)
        .ok_or_else(|| bad("case outside plan"))?;
    let request = plan
        .request(
            &case.id,
            repeat,
            &format!("{phase}-{parent}-{case_index}-{repeat}"),
        )
        .map_err(bad)?;
    Ok((
        format!("{parent}:{phase}:case:{case_index}:{repeat}"),
        json!({"parent_operation":parent,"kind":"reproduction_case","plan_digest":plan.digest(),"case_id":case.id,"repeat":repeat,"execution_id":request.execution_id}),
        request,
    ))
}
