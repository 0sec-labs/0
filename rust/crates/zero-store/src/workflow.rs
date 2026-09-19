//! Shared bounded evidence reads for durable controller workflows.
//! Callers hold one read transaction and share a Reader across the whole result.
use crate::{Error, Operation, OperationStatus, Result, integer};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::BTreeMap;

// Preserve existing scan diagnostics while sharing its proven witness checks.
fn bad(s: impl std::fmt::Display) -> Error {
    Error::Conflict(format!("scan: {s}"))
}
fn id(v: &str) -> Result<()> {
    if v.is_empty() || v.len() > 256 || v.contains('\0') {
        Err(bad("identifier bounds"))
    } else {
        Ok(())
    }
}
pub(crate) struct Reader {
    pub(crate) remaining: usize,
}
impl Reader {
    pub(crate) fn new() -> Self {
        Self {
            remaining: 64 * 1024 * 1024,
        }
    }
    pub(crate) fn charge(&mut self, n: usize, max: usize) -> Result<()> {
        if n > max || n > self.remaining {
            return Err(bad("bounded evidence read exhausted"));
        }
        self.remaining -= n;
        Ok(())
    }
    pub(crate) fn event(
        &mut self,
        conn: &Connection,
        session: &str,
        seq: u64,
    ) -> Result<(String, Value)> {
        let n: usize = conn.query_row(
            "SELECT length(CAST(payload AS BLOB)) FROM events WHERE session_id=?1 AND sequence=?2",
            params![session, integer(seq)?],
            |r| r.get(0),
        )?;
        self.charge(n, 32 * 1024 * 1024)?;
        let (kind,text):(String,String)=conn.query_row("SELECT CASE WHEN length(CAST(kind AS BLOB))<=128 THEN kind END,payload FROM events WHERE session_id=?1 AND sequence=?2",params![session,integer(seq)?],|r|Ok((r.get(0)?,r.get(1)?)))?;
        Ok((kind, serde_json::from_str(&text)?))
    }
    pub(crate) fn artifact(
        &mut self,
        conn: &Connection,
        digest: &str,
        max: usize,
    ) -> Result<Vec<u8>> {
        let n: usize = conn.query_row(
            "SELECT length(bytes) FROM artifacts WHERE digest=?1",
            [digest],
            |r| r.get(0),
        )?;
        self.charge(n, max)?;
        crate::artifacts::read(conn, digest)
    }
}

pub(crate) fn operation(conn: &Connection, key: &str, r: &mut Reader) -> Result<Operation> {
    let n:usize=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 AND length(CAST(session_id AS BLOB))<=256 AND length(CAST(command_id AS BLOB))<=256 AND length(CAST(status AS BLOB))<=16 AND (owner IS NULL OR length(CAST(owner AS BLOB))<=4096) THEN length(CAST(payload AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0) END FROM operations WHERE id=?1",[key],|r|r.get(0))?;
    r.charge(n, 32 * 1024 * 1024)?;
    let op = crate::operations::operation(conn, key)?;
    for value in [&op.id, &op.session_id, &op.command_id] {
        id(value)?;
    }
    let mut q=conn.prepare("SELECT kind,sequence FROM events INDEXED BY campaign_root_lifecycle WHERE session_id=?1 AND kind IN ('command_admitted','operation_started','operation_settled','operation_unknown','operation_not_started') AND CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id')) END=?2 ORDER BY sequence LIMIT 5")?;
    let rows = q
        .query_map(params![op.session_id, op.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let expected_count = if op.status == OperationStatus::Running {
        2
    } else {
        3
    };
    if rows.len() != expected_count
        || rows[0].0 != "command_admitted"
        || rows[1].0 != "operation_started"
    {
        return Err(bad("operation lifecycle differs"));
    }
    let mut admitted = op.clone();
    admitted.status = OperationStatus::Admitted;
    admitted.owner = None;
    admitted.outcome = None;
    let mut started = op.clone();
    started.status = OperationStatus::Running;
    started.outcome = None;
    if op.owner.is_none()
        || r.event(conn, &op.session_id, rows[0].1)?.1 != serde_json::to_value(admitted)?
        || r.event(conn, &op.session_id, rows[1].1)?.1 != serde_json::to_value(started)?
    {
        return Err(bad("admission or ownership witness differs"));
    }
    if rows.len() == 3 {
        let (kind, value) = r.event(conn, &op.session_id, rows[2].1)?;
        if op.status == OperationStatus::Unknown {
            if kind != "operation_unknown"
                || (value != serde_json::to_value(&op)?
                    && !(op.outcome.is_none()
                        && (value == json!({"operation_id":op.id,"owner":op.owner})
                            || value
                                == json!({"operation_id":op.id,"owner":op.owner,"reason":"previous engine epoch ended"}))))
            {
                return Err(bad("Unknown witness differs"));
            }
        } else if !matches!(
            op.status,
            OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled
        ) || kind != "operation_settled"
            || value != serde_json::to_value(&op)?
        {
            return Err(bad("terminal witness differs"));
        }
    }
    Ok(op)
}

pub(crate) fn checked_budget(
    conn: &Connection,
    session: &str,
    r: &mut Reader,
) -> Result<crate::BudgetSnapshot> {
    let mut q=conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind IN ('budget_reserved','budget_settled','budget_reconciled') ORDER BY sequence LIMIT 2049")?;
    let events = q
        .query_map([session], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if events.len() > 2048 {
        return Err(bad("model ledger event bound"));
    }
    let mut ledger: BTreeMap<String, (u64, Option<u64>)> = BTreeMap::new();
    for seq in events {
        let (kind, v) = r.event(conn, session, seq)?;
        let key = v["reservation_id"]
            .as_str()
            .ok_or_else(|| bad("reservation id absent"))?;
        id(key)?;
        if kind == "budget_reserved" {
            let amount = v["amount"]
                .as_u64()
                .ok_or_else(|| bad("reservation amount absent"))?;
            if ledger.insert(key.into(), (amount, None)).is_some() {
                return Err(bad("duplicate reservation witness"));
            }
        } else if kind == "budget_settled" {
            let charge = v["charged"].as_u64().ok_or_else(|| bad("charge absent"))?;
            let item = ledger
                .get_mut(key)
                .ok_or_else(|| bad("unreserved settlement"))?;
            if item.1.replace(charge).is_some() {
                return Err(bad("duplicate settlement"));
            }
        } else {
            return Err(bad("manual scan reconciliation forbidden"));
        }
    }
    let mut q=conn.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END,amount,charged FROM reservations WHERE session_id=?1 ORDER BY id LIMIT 1025")?;
    let rows = q
        .query_map([session], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, Option<u64>>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > 1024
        || rows.len() != ledger.len()
        || rows
            .iter()
            .any(|(key, a, c)| ledger.get(key) != Some(&(*a, *c)))
    {
        return Err(bad("model ledger projection differs"));
    }
    crate::budget::snapshot(conn, session)
}
