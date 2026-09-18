//! Durable informational questions; no decision mutates authority or resumes an actor.
use crate::steering::{READ_BUDGET, Witnesses, id, operation};
use crate::{Error, Operation, OperationStatus, Result, Store, append, integer};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zero_protocol::questions::{
    OperatorDecision as Decision, OperatorQuestionDecisionReceipt as Receipt,
    OperatorQuestionRecord as Record, OperatorQuestionRequest as Request,
    OperatorQuestionStatus as Status,
};
mod read;
mod write;
fn bad(message: &str) -> Error {
    Error::Conflict(message.into())
}
pub(super) fn hash(value: &Value) -> Result<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value)?)
    ))
}
pub(super) fn next(conn: &Connection, session: &str) -> Result<u64> {
    Ok(conn.query_row(
        "SELECT coalesce(max(sequence),0)+1 FROM events WHERE session_id=?1",
        [session],
        |r| r.get(0),
    )?)
}
fn outcome(op: &str, digest: &str, decision: Option<&Decision>) -> Value {
    let status = match decision {
        Some(Decision::Answer { .. }) => "answered",
        Some(Decision::Dismiss) => "dismissed",
        None => "cancelled",
    };
    json!({"schema_version":1,"question_operation_id":op,"request_sha256":digest,"status":status,"decision":decision,"authorizes_nothing":true})
}
pub(super) fn full(conn: &Connection, key: &str) -> Result<Operation> {
    let mut op = operation(conn, key)?;
    let (text,present):(Option<String>,bool)=conn.query_row("SELECT CASE WHEN length(CAST(outcome AS BLOB))<=?2 THEN outcome END,outcome IS NOT NULL FROM operations WHERE id=?1",params![key,32*1024*1024],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if present && text.is_none() {
        return Err(bad("question origin outcome exceeds read bound"));
    }
    op.outcome = text.map(|v| serde_json::from_str(&v)).transpose()?;
    Ok(op)
}
pub(super) fn owner(op: &Operation, session: &str, who: &str) -> Result<()> {
    if op.session_id != session
        || op.status != OperationStatus::Running
        || op.owner.as_deref() != Some(who)
    {
        return Err(bad("question owner or live operation changed"));
    }
    Ok(())
}
pub(super) fn settlement(
    tx: &Transaction<'_>,
    op: &mut Operation,
    status: OperationStatus,
    value: Value,
) -> Result<()> {
    let wire = match status {
        OperationStatus::Succeeded => "succeeded",
        OperationStatus::Cancelled => "cancelled",
        _ => return Err(bad("invalid question settlement")),
    };
    tx.execute(
        "UPDATE operations SET status=?2,outcome=?3 WHERE id=?1",
        params![op.id, wire, serde_json::to_string(&value)?],
    )?;
    op.status = status;
    op.outcome = Some(value);
    append(
        tx,
        &op.session_id,
        "operation_settled",
        &serde_json::to_value(&*op)?,
    )?;
    Ok(())
}

#[derive(Default)]
pub(super) struct Reads {
    pub(super) witnesses: Witnesses,
    operations: std::collections::BTreeMap<String, std::rc::Rc<Operation>>,
}
impl Reads {
    pub(super) fn operation(
        &mut self,
        conn: &Connection,
        key: &str,
    ) -> Result<std::rc::Rc<Operation>> {
        id(key)?;
        if let Some(op) = self.operations.get(key) {
            return Ok(op.clone());
        }
        let (payload,outcome,metadata):(usize,usize,usize) = conn.query_row("SELECT length(CAST(payload AS BLOB)),coalesce(length(CAST(outcome AS BLOB)),0),length(CAST(id AS BLOB))+length(CAST(session_id AS BLOB))+length(CAST(command_id AS BLOB))+length(CAST(status AS BLOB))+coalesce(length(CAST(owner AS BLOB)),0) FROM operations WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
        if payload > 32 * 1024 * 1024 || outcome > 32 * 1024 * 1024 || metadata > 5 * 4096 {
            return Err(bad("question operation exceeds read bound"));
        }
        self.witnesses
            .reserve(payload.saturating_add(outcome).saturating_add(metadata))?;
        let op = std::rc::Rc::new(full(conn, key)?);
        self.operations.insert(key.into(), op.clone());
        Ok(op)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operation_cache_and_event_witnesses_share_one_before_materialization_budget() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("state.db")).unwrap();
        let session = store.create_session("g", 100).unwrap().id;
        let mut ids = Vec::new();
        for i in 0..3 {
            let op = store
                .admit_command(&session, &format!("op{i}"), &json!({"kind":"fixture"}))
                .unwrap()
                .operation;
            store.conn.execute("UPDATE operations SET payload=json_object('padding',replace(hex(zeroblob(?2)),'0','a')) WHERE id=?1",params![op.id,12*1024*1024]).unwrap();
            ids.push(op.id);
        }
        let tx = store.conn.unchecked_transaction().unwrap();
        let mut reads = Reads::default();
        let first = reads.operation(&tx, &ids[0]).unwrap();
        let again = reads.operation(&tx, &ids[0]).unwrap();
        assert!(std::rc::Rc::ptr_eq(&first, &again));
        reads.operation(&tx, &ids[1]).unwrap();
        // This reserve represents event/index/decision bytes in the same cache.
        reads.witnesses.reserve(8 * 1024 * 1024).unwrap();
        assert!(
            matches!(reads.operation(&tx,&ids[2]),Err(Error::Invalid(ref e)) if e==READ_BUDGET)
        );
        assert!(reads.operation(&tx, &ids[0]).is_ok());
    }
}
