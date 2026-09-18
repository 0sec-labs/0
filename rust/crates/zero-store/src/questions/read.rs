use super::*;
use zero_protocol::model::{Completion, CompletionStatus, Content};

pub(super) fn origin(
    conn: &Connection,
    actor: &Operation,
    command: &str,
    call: &str,
    origin_id: &str,
    request: &Request,
    reads: &mut Reads,
) -> Result<std::rc::Rc<Operation>> {
    let (turn, index) = command
        .strip_prefix(&format!("{}:tool:", actor.id))
        .and_then(|s| s.split_once(':'))
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<usize>().ok()?)))
        .filter(|(a, b)| *a < 32 && *b < 32)
        .ok_or_else(|| bad("question command is not a bounded actor tool"))?;
    if command != format!("{}:tool:{turn}:{index}", actor.id) {
        return Err(bad("question command is not canonical"));
    }
    let original = reads.operation(conn, origin_id)?;
    if original.session_id != actor.session_id
        || original.command_id != format!("{}:model:{turn}", actor.id)
        || original.status != OperationStatus::Succeeded
        || original.payload["kind"] != "agent_inference"
        || original.payload["parent_operation"] != actor.id
        || actor.payload["request"]["operator_questions"] != true
        || !original.payload["request"]["tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|t| t["name"] == "ask_operator"))
    {
        return Err(bad("question origin lacks offered actor authority"));
    }
    let completion: Completion = serde_json::from_value(
        original
            .outcome
            .clone()
            .ok_or_else(|| bad("question completion missing"))?,
    )?;
    if completion.status != CompletionStatus::Completed || completion.error.is_some() {
        return Err(bad("question origin completion is not successful"));
    }
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|c| {
            if let Content::ToolCall {
                id,
                name,
                arguments,
            } = c
            {
                Some((id, name, arguments))
            } else {
                None
            }
        })
        .collect();
    if calls.len() > 32
        || calls
            .iter()
            .map(|c| c.0)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != calls.len()
    {
        return Err(bad("invalid question origin call set"));
    }
    let (id, name, args) = calls
        .get(index)
        .ok_or_else(|| bad("question call index absent"))?;
    let decoded: Request = serde_json::from_value((*args).clone())?;
    decoded
        .validate()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    if *id != call || *name != "ask_operator" || &decoded != request {
        return Err(bad("question request differs from original provider call"));
    }
    Ok(original)
}
pub(super) fn receipt(conn: &Connection, key: &str, reads: &mut Reads) -> Result<Option<Receipt>> {
    let size: Option<usize> = conn.query_row("SELECT length(CAST(id AS BLOB))+length(CAST(session_id AS BLOB))+length(CAST(command_id AS BLOB))+length(CAST(request_sha256 AS BLOB))+length(CAST(decision AS BLOB)) FROM operator_question_decisions WHERE question_operation_id=?1", [key], |r|r.get(0)).optional()?;
    if let Some(size) = size {
        if size > 128 * 1024 {
            return Err(bad("question decision exceeds read bound"));
        }
        reads.witnesses.reserve(size)?;
    }
    let row=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=4096 THEN id END,CASE WHEN length(CAST(session_id AS BLOB))<=4096 THEN session_id END,CASE WHEN length(CAST(command_id AS BLOB))<=4096 THEN command_id END,CASE WHEN length(CAST(request_sha256 AS BLOB))<=71 THEN request_sha256 END,CASE WHEN length(CAST(decision AS BLOB))<=65536 THEN decision END,sequence FROM operator_question_decisions WHERE question_operation_id=?1",[key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,u64>(5)?))).optional()?;
    let Some(row) = row else { return Ok(None) };
    let result = Receipt {
        id: row.0,
        session_id: row.1,
        command_id: row.2,
        question_operation_id: key.into(),
        request_sha256: row.3,
        decision: serde_json::from_str(&row.4)?,
        sequence: row.5,
    };
    for s in [
        &result.id,
        &result.session_id,
        &result.command_id,
        &result.request_sha256,
    ] {
        id(s)?;
    }
    let (kind, value) =
        reads
            .witnesses
            .event(conn, &result.session_id, result.sequence, 128 * 1024)?;
    if kind != "operator_question_decided" || *value != serde_json::to_value(&result)? {
        return Err(bad("question decision differs from immutable event"));
    }
    Ok(Some(result))
}
pub(super) fn record(
    conn: &Connection,
    session: &str,
    key: &str,
    reads: &mut Reads,
) -> Result<Record> {
    id(session)?;
    id(key)?;
    let size:usize=conn.query_row("SELECT length(CAST(actor_operation_id AS BLOB))+length(CAST(root_operation_id AS BLOB)) FROM operator_questions WHERE operation_id=?1 AND session_id=?2",params![key,session],|r|r.get(0)).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    if size > 8192 {
        return Err(bad("question index exceeds read bound"));
    }
    reads.witnesses.reserve(size)?;
    let (actor_id,root_id,sequence):(String,String,u64)=conn.query_row("SELECT CASE WHEN length(CAST(actor_operation_id AS BLOB))<=4096 THEN actor_operation_id END,CASE WHEN length(CAST(root_operation_id AS BLOB))<=4096 THEN root_operation_id END,sequence FROM operator_questions WHERE operation_id=?1 AND session_id=?2",params![key,session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    id(&actor_id)?;
    id(&root_id)?;
    let op = reads.operation(conn, key)?;
    if op.session_id != session
        || op.payload["kind"] != "agent_operator_question"
        || op.payload["parent_operation"] != actor_id
        || op.payload["root_operation"] != root_id
    {
        return Err(bad("question index differs from tool operation"));
    }
    let (kind, witness) = reads.witnesses.event(conn, session, sequence, 128 * 1024)?;
    let mut admitted = (*op).clone();
    admitted.status = OperationStatus::Admitted;
    admitted.owner = None;
    admitted.outcome = None;
    if kind != "command_admitted" || *witness != serde_json::to_value(admitted)? {
        return Err(bad("question differs from original admission event"));
    }
    let request: Request = serde_json::from_value(op.payload["request"].clone())?;
    request
        .validate()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let digest = op.payload["request_sha256"]
        .as_str()
        .ok_or_else(|| bad("question request digest absent"))?
        .to_owned();
    let mut identity = op.payload.clone();
    identity
        .as_object_mut()
        .ok_or_else(|| bad("question payload not object"))?
        .remove("request_sha256");
    if digest != hash(&identity)? {
        return Err(bad("question request digest differs"));
    }
    let actor = reads.operation(conn, &actor_id)?;
    let root = reads.operation(conn, &root_id)?;
    if actor.session_id != session
        || zero_protocol::agent::validate_actor_payload(&actor.payload).is_err()
        || root.session_id != session
        || zero_protocol::agent::validate_actor_payload(&root.payload).is_err()
        || root.payload.get("parent_operation").is_some()
        || actor.payload["parent_operation"]
            .as_str()
            .unwrap_or(&actor.id)
            != root_id
    {
        return Err(bad("question actor/root differs"));
    }
    let original = origin(
        conn,
        &actor,
        &op.command_id,
        op.payload["call_id"]
            .as_str()
            .ok_or_else(|| bad("question call missing"))?,
        op.payload["origin_inference_id"]
            .as_str()
            .ok_or_else(|| bad("question origin missing"))?,
        &request,
        reads,
    )?;
    if op.payload["origin_payload_sha256"] != hash(&original.payload)?
        || op.payload["origin_outcome_sha256"] != hash(&serde_json::to_value(&original.outcome)?)?
    {
        return Err(bad("question original inference identity changed"));
    }
    let decision = receipt(conn, key, reads)?;
    let status = if let Some(decision) = &decision {
        decision
            .decision
            .validate(&request)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        if decision.session_id != session
            || decision.request_sha256 != digest
            || op.status != OperationStatus::Succeeded
            || op.outcome.as_ref() != Some(&outcome(key, &digest, Some(&decision.decision)))
        {
            return Err(bad("question decision contradicts terminal receipt"));
        }
        match decision.decision {
            Decision::Answer { .. } => Status::Answered,
            Decision::Dismiss => Status::Dismissed,
        }
    } else {
        match op.status {
            OperationStatus::Running
                if actor.status == OperationStatus::Running
                    && root.status == OperationStatus::Running =>
            {
                Status::Pending
            }
            OperationStatus::Cancelled => {
                if op.outcome.as_ref() != Some(&outcome(key, &digest, None)) {
                    return Err(bad("question cancellation receipt differs"));
                }
                Status::Cancelled
            }
            OperationStatus::Unknown
            | OperationStatus::Running
            | OperationStatus::Admitted
            | OperationStatus::Failed => Status::Interrupted,
            OperationStatus::Succeeded => return Err(bad("question succeeded without decision")),
        }
    };
    Ok(Record {
        operation_id: key.into(),
        session_id: session.into(),
        actor_operation_id: actor_id,
        root_operation_id: root_id,
        sequence,
        request_sha256: digest,
        request,
        status,
        decision,
    })
}
impl Store {
    pub fn get_operator_question(&self, session: &str, key: &str) -> Result<Record> {
        let tx = self.conn.unchecked_transaction()?;
        let r = record(&tx, session, key, &mut Reads::default())?;
        tx.commit()?;
        Ok(r)
    }
    pub fn operator_questions(
        &self,
        session: &str,
        root: Option<&str>,
        after: u64,
        limit: u32,
    ) -> Result<Vec<Record>> {
        id(session)?;
        if let Some(root) = root {
            id(root)?;
        }
        if !(1..=100).contains(&limit) {
            return Err(Error::Invalid("question page limit must be1..100".into()));
        }
        let tx = self.conn.unchecked_transaction()?;
        crate::get_session(&tx, session)?;
        let keys = {
            let (query, bind) = if let Some(root) = root {
                (
                    "SELECT CASE WHEN length(CAST(operation_id AS BLOB))<=4096 THEN operation_id END FROM operator_questions WHERE session_id=?1 AND sequence>?2 AND root_operation_id=?3 ORDER BY sequence LIMIT ?4",
                    root,
                )
            } else {
                (
                    "SELECT CASE WHEN length(CAST(operation_id AS BLOB))<=4096 THEN operation_id END FROM operator_questions WHERE session_id=?1 AND sequence>?2 AND ?3 IS NULL ORDER BY sequence LIMIT ?4",
                    "",
                )
            };
            let mut stmt = tx.prepare(query)?;
            let mut rows = stmt.query(params![
                session,
                integer(after)?,
                if root.is_some() { Some(bind) } else { None },
                limit
            ])?;
            let mut keys = vec![];
            while let Some(row) = rows.next()? {
                keys.push(row.get::<_, String>(0)?);
            }
            keys
        };
        let mut reads = Reads::default();
        let mut out = vec![];
        let mut bytes = 2usize;
        for key in keys {
            let r = match record(&tx, session, &key, &mut reads) {
                Err(Error::Invalid(e)) if e == READ_BUDGET && !out.is_empty() => break,
                result => result?,
            };
            let size = serde_json::to_vec(&r)?.len() + 1;
            if bytes + size > 1024 * 1024 {
                break;
            }
            bytes += size;
            out.push(r);
        }
        tx.commit()?;
        Ok(out)
    }
    pub fn operator_question_decision_by_command(
        &self,
        session: &str,
        command: &str,
    ) -> Result<Option<Receipt>> {
        id(session)?;
        id(command)?;
        let tx = self.conn.unchecked_transaction()?;
        let key:Option<String>=tx.query_row("SELECT CASE WHEN length(CAST(question_operation_id AS BLOB))<=4096 THEN question_operation_id END FROM operator_question_decisions WHERE session_id=?1 AND command_id=?2",params![session,command],|r|r.get(0)).optional()?;
        let r = key
            .map(|key| record(&tx, session, &key, &mut Reads::default()).map(|r| r.decision))
            .transpose()?
            .flatten();
        tx.commit()?;
        Ok(r)
    }
    pub fn operator_question_output(&self, session: &str, key: &str) -> Result<Value> {
        let r = self.get_operator_question(session, key)?;
        match r.status {
            Status::Answered | Status::Dismissed => Ok(outcome(
                key,
                &r.request_sha256,
                r.decision.as_ref().map(|d| &d.decision),
            )),
            Status::Cancelled => Ok(outcome(key, &r.request_sha256, None)),
            _ => Err(bad("question has no settled informational output")),
        }
    }
}
