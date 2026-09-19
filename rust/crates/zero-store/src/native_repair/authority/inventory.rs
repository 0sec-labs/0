use super::*;
pub(super) fn validate_bound(conn: &Connection, b: &Bound, r: &mut Reader) -> Result<()> {
    internal_inventory(conn, b)?;
    parent_artifact_inventory(conn, b, r)?;
    attached(conn, b, "native_repair.intent", r, MAX_INTENT)?;
    preparation(conn, b, r)?;
    bound_source(conn, b, r)?;
    let plans = [
        bound_candidate(conn, b, "candidate", r)?,
        bound_candidate(conn, b, "reconstructed", r)?,
    ];
    child_inventory(conn, b, &plans, r)?;
    let first = completed_phase(conn, b, "candidate", r)?;
    completed_phase(conn, b, "reconstructed", r)?;
    let start = phase_event(conn, b, "reconstructed", "started", r)?;
    if let Some((seq, _)) = start {
        let completed = phase_event(conn, b, "candidate", "completed", r)?
            .ok_or_else(|| bad("reconstruction before first observed matrix"))?;
        if first.is_none() || seq <= completed.0 {
            return Err(bad("reconstruction phase order differs"));
        }
    }
    if let (Some((a, _)), Some((c, _))) = (&plans[0], &plans[1]) {
        if a.plan().snapshot.root == c.plan().snapshot.root {
            return Err(bad("candidate private root reused"));
        }
    }
    Ok(())
}
fn child_inventory(
    conn: &Connection,
    b: &Bound,
    plans: &[Option<(FrozenPlan, CandidateReceipt)>; 2],
    r: &mut Reader,
) -> Result<()> {
    use std::collections::BTreeMap;
    let mut q = conn.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM operations WHERE session_id=?1 AND id!=?2 LIMIT 513")?;
    let ids = q
        .query_map(params![b.record.session_id, b.operation.id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if ids.len() > 512 {
        return Err(bad("case inventory bound"));
    }
    let mut children = BTreeMap::new();
    let mut ordinals = BTreeMap::new();
    for id in ids {
        let op = workflow::operation(conn, &id, r)?;
        let phase = if op
            .command_id
            .starts_with(&format!("{}:candidate:case:", b.operation.id))
        {
            "candidate"
        } else if op
            .command_id
            .starts_with(&format!("{}:reconstructed:case:", b.operation.id))
        {
            "reconstructed"
        } else {
            return Err(bad("case phase differs"));
        };
        let phase_number = phase_index(phase)?;
        let (plan, _) = plans[phase_number]
            .as_ref()
            .ok_or_else(|| bad("case before candidate binding"))?;
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
        let (command, payload, request) = case_payload(&b.operation.id, phase, plan, case, repeat)?;
        let ordinal = case
            .checked_mul(plan.plan().repeats)
            .and_then(|n| n.checked_add(repeat))
            .and_then(|n| {
                n.checked_add(phase_number * plan.plan().cases.len() * plan.plan().repeats)
            })
            .ok_or_else(|| bad("case inventory ordinal overflow"))?;
        if op.command_id != command
            || op.payload != payload
            || op.owner != b.operation.owner
            || ordinal >= b.admission.authorization.max_executions as usize
            || ordinals.insert(ordinal, id.clone()).is_some()
        {
            return Err(bad("case inventory differs from frozen authority"));
        }
        children.insert(id, (op, request, phase));
    }
    if ordinals.keys().copied().ne(0..ordinals.len()) {
        return Err(bad("case inventory has an ordinal gap"));
    }
    let candidate_seq = phase_event(conn, b, "candidate", "bound", r)?.map(|(s, _)| s);
    let reconstructed_seq = phase_event(conn, b, "reconstructed", "bound", r)?.map(|(s, _)| s);
    let close_seq: Option<u64> = conn.query_row(
        "SELECT close_sequence FROM native_repairs WHERE id=?1",
        [&b.record.id],
        |row| row.get(0),
    )?;
    let mut q = conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind IN ('command_admitted','operation_started','operation_settled','operation_unknown','operation_not_started','operation_artifact','operation_detail','native_repair_effect_started') ORDER BY sequence LIMIT 20001")?;
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
            if kind == "native_repair_effect_started" {
                return Err(bad("parent cannot own a case effect"));
            }
            continue;
        }
        if !children.contains_key(id) {
            return Err(bad("orphan case lifecycle, artifact, or effect witness"));
        }
        let source_seq = if children[id].2 == "candidate" {
            candidate_seq
        } else {
            reconstructed_seq
        };
        if source_seq.is_none_or(|s| seq <= s) {
            return Err(bad("case predates source binding"));
        }
        match kind.as_str() {
            "command_admitted" | "operation_started" | "native_repair_effect_started"
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
            "native_repair_effect_started" => {
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
        let (op, request, phase) = &children[id];
        let start = starts.get(id).ok_or_else(|| bad("case start absent"))?;
        let consumed = artifacts.get(&(id.clone(), "native_repair.effect_start".into()));
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
                    != json!({"repair_id":b.record.id,"operation_id":id,"parent_operation_id":b.operation.id,"request_sha256":digest,"owner":b.operation.owner,"phase":phase})
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

fn internal_inventory(conn: &Connection, b: &Bound) -> Result<()> {
    let mut q=conn.prepare("SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END FROM operation_artifacts WHERE operation_id=?1 AND name GLOB 'native_repair.*' LIMIT 12")?;
    let names = q
        .query_map([&b.operation.id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if names.len() > 11
        || names.iter().any(|name| {
            !matches!(
                name.as_str(),
                "native_repair.intent"
                    | "native_repair.execution_baseline"
                    | "native_repair.source_binding"
                    | "native_repair.candidate.start"
                    | "native_repair.candidate.plan"
                    | "native_repair.candidate.completed"
                    | "native_repair.reconstructed.start"
                    | "native_repair.reconstructed.plan"
                    | "native_repair.reconstructed.completed"
            )
        })
    {
        return Err(bad("unknown internal repair attachment"));
    }
    let (created, closed): (u64, Option<u64>) = conn.query_row(
        "SELECT binding_sequence,close_sequence FROM native_repairs WHERE id=?1",
        [&b.record.id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let settled:Option<u64>=conn.query_row("SELECT min(sequence) FROM events WHERE session_id=?1 AND kind IN ('operation_settled','operation_unknown') AND coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id'))=?2",params![b.record.session_id,b.operation.id],|r|r.get(0))?;
    let mut q=conn.prepare("SELECT CASE WHEN length(CAST(kind AS BLOB))<=128 THEN kind END,sequence FROM events WHERE session_id=?1 AND kind GLOB 'native_repair_*' AND kind!='native_repair_effect_started' ORDER BY sequence LIMIT 17")?;
    let rows = q
        .query_map([&b.record.session_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > 16 {
        return Err(bad("repair control witness bound"));
    }
    for (kind, seq) in rows {
        if !matches!(
            kind.as_str(),
            "native_repair_created"
                | "native_repair_closed"
                | "native_repair_preparation_started"
                | "native_repair_source_bound"
                | "native_repair_candidate_started"
                | "native_repair_candidate_bound"
                | "native_repair_candidate_completed"
                | "native_repair_reconstructed_started"
                | "native_repair_reconstructed_bound"
                | "native_repair_reconstructed_completed"
        ) {
            return Err(bad("unknown repair control witness"));
        }
        if !matches!(
            kind.as_str(),
            "native_repair_created" | "native_repair_closed"
        ) && (seq <= created
            || closed.is_some_and(|c| seq >= c)
            || settled.is_some_and(|s| seq >= s))
        {
            return Err(bad("repair permission outside owned open lifecycle"));
        }
    }
    Ok(())
}

// Parent artifacts also carry one-use permissions. Surviving attribution events
// must prevent replay when an attacker deletes both marker and projection.
fn parent_artifact_inventory(conn: &Connection, b: &Bound, r: &mut Reader) -> Result<()> {
    let mut q=conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='operation_artifact' AND json_extract(payload,'$.operation_id')=?2 ORDER BY sequence LIMIT 129")?;
    let sequences = q
        .query_map(params![b.record.session_id, b.operation.id], |row| {
            row.get::<_, u64>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if sequences.len() > 128 {
        return Err(bad("parent artifact witness bound"));
    }
    let mut witnesses = std::collections::BTreeMap::new();
    for sequence in sequences {
        let (_, value) = r.event(conn, &b.record.session_id, sequence)?;
        let name = value["name"]
            .as_str()
            .filter(|n| !n.is_empty() && n.len() <= 128)
            .ok_or_else(|| bad("parent artifact name"))?;
        let digest = value["digest"]
            .as_str()
            .filter(|d| zero_protocol::is_sha256(d))
            .ok_or_else(|| bad("parent artifact digest"))?;
        let bytes = value["bytes"]
            .as_u64()
            .filter(|n| *n <= crate::MAX_ARTIFACT_BYTES as u64)
            .ok_or_else(|| bad("parent artifact bytes"))?;
        if value != json!({"operation_id":b.operation.id,"name":name,"digest":digest,"bytes":bytes})
            || witnesses
                .insert(name.to_owned(), (digest.to_owned(), bytes))
                .is_some()
        {
            return Err(bad("parent artifact attribution differs"));
        }
    }
    let mut q=conn.prepare("SELECT CASE WHEN length(CAST(a.name AS BLOB))<=128 THEN a.name END,CASE WHEN length(CAST(a.digest AS BLOB))=71 THEN a.digest END,length(v.bytes) FROM operation_artifacts a LEFT JOIN artifacts v ON v.digest=a.digest WHERE a.operation_id=?1 ORDER BY a.name LIMIT 129")?;
    let refs = q
        .query_map([&b.operation.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if refs.len() > 128
        || refs.len() != witnesses.len()
        || refs
            .iter()
            .any(|(name, digest, bytes)| witnesses.get(name) != Some(&(digest.clone(), *bytes)))
    {
        return Err(bad("parent artifact projection or witness absent"));
    }
    Ok(())
}
