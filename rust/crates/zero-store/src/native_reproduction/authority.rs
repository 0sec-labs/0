//! One-use preparation and sandbox permissions, derived from retained host intent.
use super::*;
use zero_protocol::{
    review_reproduction::ReviewReproductionBinding, sandbox::SandboxRequest, verification::Plan,
};
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
    let Some((seq, value)) = event(conn, b, "native_reproduction_preparation_started", r)? else {
        return Ok(None);
    };
    if value
        != json!({"reproduction_id":b.record.id,"operation_id":b.operation.id,"intent_sha256":b.record.intent_sha256,"owner":b.operation.owner})
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
fn expected_binding(b: &Bound, execution: &FrozenPlan) -> Result<ReviewReproductionBinding> {
    let logical = validate(&b.admission)?;
    logical.validate_reanchored(execution).map_err(bad)?;
    Ok(ReviewReproductionBinding {
        schema_version: 1,
        review_id: b.record.source_review_id.clone(),
        source_session_id: b.record.source_session_id.clone(),
        source_operation_id: b.record.source_operation_id.clone(),
        archive_manifest_sha256: b.admission.authorization.archive_manifest_sha256.clone(),
        authorization_sha256: b.record.authorization_sha256.clone(),
        logical_plan_sha256: logical.digest().into(),
        execution_plan_sha256: execution.digest().into(),
    })
}
fn bound_source(
    conn: &Connection,
    b: &Bound,
    r: &mut Reader,
) -> Result<Option<(FrozenPlan, ReviewReproductionBinding)>> {
    let marker = event(conn, b, "native_reproduction_source_bound", r)?;
    let mut q=conn.prepare("SELECT name,digest FROM operation_artifacts WHERE operation_id=?1 AND name IN ('native_reproduction.execution_plan','native_reproduction.source_binding') ORDER BY name")?;
    let refs = q
        .query_map([&b.operation.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let Some((sequence, witness)) = marker else {
        if !refs.is_empty() {
            return Err(bad("source binding witness missing"));
        }
        return Ok(None);
    };
    if refs.len() != 2 {
        return Err(bad("source binding artifacts missing"));
    }
    let prep = preparation(conn, b, r)?.ok_or_else(|| bad("preparation permission absent"))?;
    let execution_bytes = r.artifact(conn, &refs[0].1, zero_verification::MAX_PLAN_BYTES)?;
    let execution = FrozenPlan::parse(&execution_bytes).map_err(bad)?;
    // Matrix plans use their canonical typed encoding; never silently normalize evidence.
    if serde_json::to_vec(execution.plan())? != execution_bytes {
        return Err(bad("execution plan encoding differs"));
    }
    let binding_bytes = r.artifact(conn, &refs[1].1, 65536)?;
    let binding: ReviewReproductionBinding = serde_json::from_slice(&binding_bytes)?;
    if encode(&binding)? != binding_bytes
        || binding != expected_binding(b, &execution)?
        || prep >= sequence
        || witness
            != json!({"reproduction_id":b.record.id,"operation_id":b.operation.id,"execution_plan_artifact":refs[0].1,"binding_artifact":refs[1].1,"preparation_sequence":prep,"owner":b.operation.owner})
    {
        return Err(bad("retained source binding differs"));
    }
    Ok(Some((execution, binding)))
}
pub(super) fn validate_bound_source(conn: &Connection, b: &Bound, r: &mut Reader) -> Result<()> {
    preparation(conn, b, r)?;
    let source = bound_source(conn, b, r)?;
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM operations WHERE session_id=?1 AND id!=?2",
        params![b.record.session_id, b.operation.id],
        |r| r.get(0),
    )?;
    if count > b.admission.authorization.max_executions as u64 || (count > 0 && source.is_none()) {
        return Err(bad("case inventory exceeds captured source authority"));
    }
    child_inventory(conn, b, source.as_ref().map(|(p, _)| p), r)?;
    Ok(())
}

// A missing projection must not make an already consumed case ordinal reusable.
// In particular, lifecycle/artifact/physical-start witnesses survive deletion of
// a child and its command admission; inspect both directions, within one read.
fn child_inventory(
    conn: &Connection,
    b: &Bound,
    plan: Option<&FrozenPlan>,
    r: &mut Reader,
) -> Result<()> {
    use std::collections::BTreeMap;
    let mut q = conn.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM operations WHERE session_id=?1 AND id!=?2 LIMIT 257")?;
    let ids = q
        .query_map(params![b.record.session_id, b.operation.id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if ids.len() > 256 {
        return Err(bad("case inventory bound"));
    }
    let mut children = BTreeMap::new();
    let mut ordinals = BTreeMap::new();
    for id in ids {
        let plan = plan.ok_or_else(|| bad("child without source binding"))?;
        let op = workflow::operation(conn, &id, r)?;
        let case = plan
            .plan()
            .cases
            .iter()
            .position(|c| op.payload["case_id"] == c.id)
            .ok_or_else(|| bad("case inventory identity"))?;
        let repeat = op.payload["repeat"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| bad("case inventory repeat"))?;
        let (command, payload, request) = case_payload(&b.operation.id, plan, case, repeat)?;
        let ordinal = case
            .checked_mul(plan.plan().repeats)
            .and_then(|n| n.checked_add(repeat))
            .ok_or_else(|| bad("case inventory ordinal overflow"))?;
        if op.command_id != command
            || op.payload != payload
            || op.owner != b.operation.owner
            || ordinal >= b.admission.authorization.max_executions as usize
            || ordinals.insert(ordinal, id.clone()).is_some()
        {
            return Err(bad("case inventory differs from frozen authority"));
        }
        children.insert(id, (op, request));
    }
    if ordinals.keys().copied().ne(0..ordinals.len()) {
        return Err(bad("case inventory has an ordinal gap"));
    }
    let source_seq = event(conn, b, "native_reproduction_source_bound", r)?.map(|(s, _)| s);
    let close_seq: Option<u64> = conn.query_row(
        "SELECT close_sequence FROM native_reproductions WHERE id=?1",
        [&b.record.id],
        |row| row.get(0),
    )?;
    let mut q = conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind IN ('command_admitted','operation_started','operation_settled','operation_unknown','operation_not_started','operation_artifact','operation_detail','native_reproduction_effect_started') ORDER BY sequence LIMIT 20001")?;
    let sequences = q
        .query_map([&b.record.session_id], |row| row.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if sequences.len() > 20000 {
        return Err(bad("case witness inventory bound"));
    }
    let mut starts = BTreeMap::new();
    let mut effects = BTreeMap::new();
    let mut artifacts = BTreeMap::new();
    for seq in sequences {
        let (kind, value) = r.event(conn, &b.record.session_id, seq)?;
        let id = value
            .get("id")
            .or_else(|| value.get("operation_id"))
            .and_then(Value::as_str)
            .ok_or_else(|| bad("case witness identity absent"))?;
        if id == b.operation.id {
            if kind == "native_reproduction_effect_started" {
                return Err(bad("parent cannot own a case effect"));
            }
            continue;
        }
        if !children.contains_key(id) {
            return Err(bad("orphan case lifecycle, artifact, or effect witness"));
        }
        if source_seq.is_none_or(|s| seq <= s) {
            return Err(bad("case predates source binding"));
        }
        match kind.as_str() {
            "command_admitted" | "operation_started" | "native_reproduction_effect_started"
                if close_seq.is_some_and(|s| seq >= s) =>
            {
                return Err(bad("case admission or effect follows close"));
            }
            _ => {}
        }
        match kind.as_str() {
            "operation_started" => {
                if starts.insert(id.to_owned(), seq).is_some() {
                    return Err(bad("duplicate case start"));
                }
            }
            "native_reproduction_effect_started" => {
                if effects.insert(id.to_owned(), (seq, value)).is_some() {
                    return Err(bad("duplicate case physical start"));
                }
            }
            "operation_artifact" => {
                let name = value["name"]
                    .as_str()
                    .filter(|n| !n.is_empty() && n.len() <= 128)
                    .ok_or_else(|| bad("case artifact name"))?;
                let digest = value["digest"]
                    .as_str()
                    .filter(|d| zero_protocol::is_sha256(d))
                    .ok_or_else(|| bad("case artifact digest"))?;
                let bytes = value["bytes"]
                    .as_u64()
                    .filter(|n| *n <= crate::MAX_ARTIFACT_BYTES as u64)
                    .ok_or_else(|| bad("case artifact size"))?;
                if artifacts
                    .insert(
                        (id.to_owned(), name.to_owned()),
                        (digest.to_owned(), bytes, seq),
                    )
                    .is_some()
                {
                    return Err(bad("duplicate case artifact attribution"));
                }
            }
            _ => {}
        }
    }
    let mut q=conn.prepare("SELECT a.operation_id,CASE WHEN length(CAST(a.name AS BLOB))<=128 THEN a.name END,CASE WHEN length(a.digest)=71 THEN a.digest END,length(v.bytes) FROM operation_artifacts a LEFT JOIN artifacts v ON v.digest=a.digest WHERE a.operation_id IN (SELECT id FROM operations WHERE session_id=?1 AND id!=?2) LIMIT 16385")?;
    let attachments = q
        .query_map(params![b.record.session_id, b.operation.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u64>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if attachments.len() > 16384 || attachments.len() != artifacts.len() {
        return Err(bad("case artifact inventory differs"));
    }
    for (id, name, digest, bytes) in attachments {
        if artifacts
            .get(&(id, name))
            .is_none_or(|(d, n, _)| d != &digest || *n != bytes)
        {
            return Err(bad("case artifact projection differs from witness"));
        }
    }
    for (ordinal, id) in &ordinals {
        let (op, request) = &children[id];
        let start = starts.get(id).ok_or_else(|| bad("case start absent"))?;
        let consumed = artifacts.get(&(id.clone(), "native_reproduction.effect_start".into()));
        if consumed.is_some() != effects.contains_key(id) {
            return Err(bad("physical start artifact and witness disagree"));
        }
        if let Some((seq, value)) = effects.get(id) {
            let (digest, _, attached) = artifacts
                .get(&(id.clone(), "reproduction.request".into()))
                .ok_or_else(|| bad("physical case request absent"))?;
            if seq <= start
                || seq <= attached
                || *value
                    != json!({"reproduction_id":b.record.id,"operation_id":id,"parent_operation_id":b.operation.id,"request_sha256":digest,"owner":b.operation.owner})
                || r.artifact(conn, digest, zero_verification::MAX_PLAN_BYTES)?
                    != serde_json::to_vec(request)?
            {
                return Err(bad("case physical request or start witness differs"));
            }
            let (consumed_digest, _, consumed_sequence) =
                consumed.ok_or_else(|| bad("physical start artifact absent"))?;
            if consumed_sequence <= attached
                || consumed_sequence >= seq
                || r.artifact(conn, consumed_digest, 65536)? != encode(value)?
            {
                return Err(bad("physical start artifact identity or ordering differs"));
            }
        } else if op.status == OperationStatus::Succeeded {
            return Err(bad("successful case lacks physical start"));
        }
        if *ordinal + 1 < ordinals.len() && op.status != OperationStatus::Succeeded {
            return Err(bad("case follows unsettled or unsuccessful predecessor"));
        }
    }
    Ok(())
}
fn case_payload(
    parent: &str,
    plan: &FrozenPlan,
    case_index: usize,
    repeat: usize,
) -> Result<(String, Value, SandboxRequest)> {
    let case = plan
        .plan()
        .cases
        .get(case_index)
        .ok_or_else(|| bad("case outside plan"))?;
    let execution = format!("reproduction-{parent}-{case_index}-{repeat}");
    let request = plan.request(&case.id, repeat, &execution).map_err(bad)?;
    Ok((
        format!("{parent}:reproduction:case:{case_index}:{repeat}"),
        json!({"parent_operation":parent,"kind":"reproduction_case","plan_digest":plan.digest(),"case_id":case.id,"repeat":repeat,"execution_id":request.execution_id}),
        request,
    ))
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
impl Store {
    pub fn native_reproduction_authorization(&self, key: &str) -> Result<ReviewReproductionPlan> {
        let tx = self.conn.unchecked_transaction()?;
        Ok(bound(&tx, key, &mut Reader::new())?.admission.authorization)
    }
    /// One use only: a retry never starts another source reconstruction.
    pub fn begin_native_reproduction_preparation(&mut self, key: &str, owner: &str) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        open(&tx, &b, owner)?;
        if preparation(&tx, &b, &mut r)?.is_some() {
            return Err(bad("preparation already started"));
        }
        append(
            &tx,
            &b.record.session_id,
            "native_reproduction_preparation_started",
            &json!({"reproduction_id":b.record.id,"operation_id":b.operation.id,"intent_sha256":b.record.intent_sha256,"owner":owner}),
        )?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok(())
    }
    pub fn bind_native_reproduction_source(
        &mut self,
        key: &str,
        owner: &str,
        execution: &Plan,
        binding: &ReviewReproductionBinding,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        let execution = FrozenPlan::new(execution.clone()).map_err(bad)?;
        if *binding != expected_binding(&b, &execution)? {
            return Err(bad("source binding differs from host authority"));
        }
        if let Some((original, retained)) = bound_source(&tx, &b, &mut r)? {
            if original.digest() != execution.digest()
                || retained != *binding
                || b.operation.owner.as_deref() != Some(owner)
            {
                return Err(bad("source binding retry differs"));
            }
            return Ok(());
        }
        open(&tx, &b, owner)?;
        let prep = preparation(&tx, &b, &mut r)?.ok_or_else(|| bad("preparation not started"))?;
        let execution_digest = retain(
            &tx,
            &b,
            &b.operation.id,
            "native_reproduction.execution_plan",
            &serde_json::to_vec(execution.plan())?,
        )?;
        let binding_digest = retain(
            &tx,
            &b,
            &b.operation.id,
            "native_reproduction.source_binding",
            &encode(binding)?,
        )?;
        append(
            &tx,
            &b.record.session_id,
            "native_reproduction_source_bound",
            &json!({"reproduction_id":b.record.id,"operation_id":b.operation.id,"execution_plan_artifact":execution_digest,"binding_artifact":binding_digest,"preparation_sequence":prep,"owner":owner}),
        )?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok(())
    }
    pub fn native_reproduction_bound_source(
        &self,
        key: &str,
    ) -> Result<Option<(Plan, ReviewReproductionBinding)>> {
        let tx = self.conn.unchecked_transaction()?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        Ok(bound_source(&tx, &b, &mut r)?.map(|(p, b)| (p.plan().clone(), b)))
    }
    /// Atomically start exactly the next case; generic operation admission remains forbidden.
    pub fn admit_native_reproduction_case(
        &mut self,
        key: &str,
        owner: &str,
        case_index: usize,
        repeat: usize,
    ) -> Result<(Operation, SandboxRequest)> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        open(&tx, &b, owner)?;
        let (plan, _) = bound_source(&tx, &b, &mut r)?.ok_or_else(|| bad("source not bound"))?;
        let (command, payload, request) = case_payload(&b.operation.id, &plan, case_index, repeat)?;
        let ordinal = case_index
            .checked_mul(plan.plan().repeats)
            .and_then(|n| n.checked_add(repeat))
            .ok_or_else(|| bad("case ordinal overflow"))?;
        let count: usize = tx.query_row(
            "SELECT count(*) FROM operations WHERE session_id=?1 AND id!=?2",
            params![b.record.session_id, b.operation.id],
            |r| r.get(0),
        )?;
        if ordinal != count || ordinal >= b.admission.authorization.max_executions as usize {
            return Err(bad("case replay, gap, or execution limit"));
        }
        if ordinal > 0 {
            let (previous, _, _) = case_payload(
                &b.operation.id,
                &plan,
                (ordinal - 1) / plan.plan().repeats,
                (ordinal - 1) % plan.plan().repeats,
            )?;
            let previous: String = tx.query_row(
                "SELECT id FROM operations WHERE session_id=?1 AND command_id=?2",
                params![b.record.session_id, previous],
                |r| r.get(0),
            )?;
            if workflow::operation(&tx, &previous, &mut r)?.status != OperationStatus::Succeeded {
                return Err(bad("previous execution has not settled successfully"));
            }
        }
        let op = running_child(&tx, &b, owner, command, payload)?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok((op, request))
    }
    /// Consume once immediately before dispatch. A recorded start never permits replay.
    pub fn begin_native_reproduction_effect(
        &mut self,
        key: &str,
        child: &str,
        owner: &str,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        open(&tx, &b, owner)?;
        let (plan, _) = bound_source(&tx, &b, &mut r)?.ok_or_else(|| bad("source not bound"))?;
        let op = workflow::operation(&tx, child, &mut r)?;
        let case = plan
            .plan()
            .cases
            .iter()
            .position(|c| op.payload["case_id"] == c.id)
            .ok_or_else(|| bad("unknown case"))?;
        let repeat = op.payload["repeat"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| bad("invalid repeat"))?;
        let (command, payload, request) = case_payload(&b.operation.id, &plan, case, repeat)?;
        if op.session_id != b.record.session_id
            || op.owner.as_deref() != Some(owner)
            || op.status != OperationStatus::Running
            || op.command_id != command
            || op.payload != payload
        {
            return Err(bad("case authority differs"));
        }
        let digest:String=tx.query_row("SELECT digest FROM operation_artifacts WHERE operation_id=?1 AND name='reproduction.request'",[child],|r|r.get(0))?;
        if r.artifact(&tx, &digest, zero_verification::MAX_PLAN_BYTES)?
            != serde_json::to_vec(&request)?
        {
            return Err(bad("retained physical request differs"));
        }
        let count:u64=tx.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND kind='native_reproduction_effect_started' AND json_extract(payload,'$.operation_id')=?2",params![b.record.session_id,child],|r|r.get(0))?;
        if count != 0 {
            return Err(bad("physical effect already started"));
        }
        let receipt = json!({"reproduction_id":b.record.id,"operation_id":child,"parent_operation_id":b.operation.id,"request_sha256":digest,"owner":owner});
        retain(
            &tx,
            &b,
            child,
            "native_reproduction.effect_start",
            &encode(&receipt)?,
        )?;
        append(
            &tx,
            &b.record.session_id,
            "native_reproduction_effect_started",
            &receipt,
        )?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok(())
    }
}
