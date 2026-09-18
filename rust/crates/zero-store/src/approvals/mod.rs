//! Exact permission receipts; only atomic consumption admits an executable child.
use crate::questions::{Reads, hash, next, owner, settlement};
use crate::steering::{READ_BUDGET, id};
use crate::{Error, Operation, OperationStatus, Result, Store, append, integer};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, rc::Rc};
use zero_protocol::approvals::{
    ToolApprovalConsumption as Consumption, ToolApprovalDecision as Decision,
    ToolApprovalDecisionReceipt as Receipt, ToolApprovalPolicy as Policy,
    ToolApprovalRecord as Record, ToolApprovalStatus as Status,
};
mod intent;
mod read;
mod write;
fn bad(s: &str) -> Error {
    Error::Conflict(s.into())
}
const MAX: usize = 8 * 1024 * 1024;
#[derive(Default)]
struct Cache {
    reads: Reads,
    intents: BTreeMap<String, Rc<Value>>,
}
impl Cache {
    fn artifact(&mut self, conn: &Connection, digest: &str) -> Result<Rc<Value>> {
        if let Some(value) = self.intents.get(digest) {
            return Ok(value.clone());
        }
        if !zero_protocol::is_sha256(digest) {
            return Err(bad("invalid approval intent digest"));
        }
        let size: usize = conn
            .query_row(
                "SELECT length(bytes) FROM artifacts WHERE digest=?1",
                [digest],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(digest.into()))?;
        if size > MAX {
            return Err(bad("approval intent exceeds 8 MiB"));
        }
        self.reads.witnesses.reserve(size)?;
        let bytes = crate::artifacts::read(conn, digest)?;
        let value: Rc<Value> = Rc::new(serde_json::from_slice(&bytes)?);
        self.intents.insert(digest.into(), value.clone());
        Ok(value)
    }
}
fn terminal(key: &str, digest: &str, status: &str) -> Value {
    json!({"status":status,"approval_operation_id":key,"intent_sha256":digest,"external_effects_started":false})
}
fn insert(
    tx: &Transaction<'_>,
    session: &str,
    command: &str,
    payload: &Value,
    who: &str,
) -> Result<(Operation, u64)> {
    let key = uuid::Uuid::new_v4().to_string();
    let text = serde_json::to_string(payload)?;
    if text.len() > MAX {
        return Err(bad("approval operation exceeds 8 MiB"));
    }
    tx.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES(?1,?2,?3,?4,?5,'admitted')",params![key,session,command,text,format!("{:x}",Sha256::digest(text.as_bytes()))])?;
    let mut op = Operation {
        id: key,
        session_id: session.into(),
        command_id: command.into(),
        payload: payload.clone(),
        status: OperationStatus::Admitted,
        owner: None,
        outcome: None,
    };
    let sequence = next(tx, session)?;
    append(tx, session, "command_admitted", &serde_json::to_value(&op)?)?;
    tx.execute(
        "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
        params![op.id, who],
    )?;
    op.status = OperationStatus::Running;
    op.owner = Some(who.into());
    append(
        tx,
        session,
        "operation_started",
        &serde_json::to_value(&op)?,
    )?;
    Ok((op, sequence))
}
fn check_admission(
    conn: &Connection,
    op: &Operation,
    sequence: u64,
    cache: &mut Cache,
) -> Result<()> {
    let (kind, value) =
        cache
            .reads
            .witnesses
            .event(conn, &op.session_id, sequence, MAX + 32 * 1024)?;
    let mut expected = op.clone();
    expected.status = OperationStatus::Admitted;
    expected.owner = None;
    expected.outcome = None;
    if kind != "command_admitted" || *value != serde_json::to_value(expected)? {
        return Err(bad("approval admission witness differs"));
    }
    Ok(())
}

pub(super) fn validate_experiment_consumption(
    conn: &Connection,
    effect: &Operation,
    key: &str,
    reads: &mut Reads,
) -> Result<()> {
    let mut cache = Cache {
        reads: std::mem::take(reads),
        intents: BTreeMap::new(),
    };
    let result = read::checked(conn, &effect.session_id, key, &mut cache);
    *reads = cache.reads;
    let checked = result?;
    if checked
        .record
        .consumption
        .as_ref()
        .map(|c| c.effect_operation_id.as_str())
        != Some(effect.id.as_str())
    {
        return Err(bad("experiment lacks exact approval consumption"));
    }
    Ok(())
}
