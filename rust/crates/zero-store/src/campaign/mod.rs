//! Campaign accounting authority lives beside session/effect journals.
use crate::{Error, Operation, OperationStatus, Result, Store, append, integer};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use zero_protocol::campaign::*;

mod delegation;
mod hooks;
mod lifecycle;
mod read;
mod write;
pub(super) use hooks::{
    admit_http, authorize, experiment, forbid_input, recover, reserve_model, settle_http,
    settle_model,
};
fn bad(message: &str) -> Error {
    Error::Conflict(format!("campaign: {message}"))
}
fn id(s: &str) -> Result<()> {
    if s.is_empty() || s.len() > 256 || s.chars().any(char::is_control) {
        Err(bad("invalid identifier"))
    } else {
        Ok(())
    }
}
fn hash(v: &Value) -> Result<String> {
    zero_web_verification::hash(v).map_err(|_| bad("identity exceeds bound"))
}
fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| bad("clock before epoch"))?
        .as_millis()
        .try_into()
        .map_err(|_| bad("clock overflow"))
}
fn next(conn: &Connection, session: &str) -> Result<u64> {
    crate::questions::next(conn, session)
}
fn event(conn: &Connection, session: &str, sequence: u64, kind: &str, value: &Value) -> Result<()> {
    let (actual_kind,size):(String,usize)=conn.query_row("SELECT CASE WHEN length(CAST(kind AS BLOB))<=64 THEN kind END,length(CAST(payload AS BLOB)) FROM events WHERE session_id=?1 AND sequence=?2",params![session,integer(sequence)?],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if size > serde_json::to_vec(value)?.len().saturating_add(1024) || actual_kind != kind {
        return Err(bad("immutable witness missing or oversized"));
    }
    let bytes: String = conn.query_row(
        "SELECT payload FROM events WHERE session_id=?1 AND sequence=?2",
        params![session, integer(sequence)?],
        |r| r.get(0),
    )?;
    if serde_json::from_str::<Value>(&bytes)? != *value {
        return Err(bad("immutable witness differs"));
    }
    Ok(())
}
fn session(
    tx: &Transaction<'_>,
    generation: &str,
    limit: u64,
    at: u64,
) -> Result<zero_protocol::session::Session> {
    let s = zero_protocol::session::Session {
        id: uuid::Uuid::new_v4().to_string(),
        generation: generation.into(),
        generation_epoch: None,
        created_at_ms: at,
        budget_limit: limit,
    };
    tx.execute("INSERT INTO sessions(id,generation,created_at_ms,budget_limit,generation_epoch) VALUES(?1,?2,?3,?4,NULL)",params![s.id,s.generation,integer(at)?,integer(limit)?])?;
    append(tx, &s.id, "session_created", &serde_json::to_value(&s)?)?;
    Ok(s)
}
fn original(conn: &Connection, key: &str) -> Result<Campaign> {
    id(key)?;
    let (session,size,sequence):(String,usize,u64)=conn.query_row("SELECT CASE WHEN length(CAST(journal_session_id AS BLOB))<=256 THEN journal_session_id END,length(CAST(record AS BLOB)),sequence FROM campaigns WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    if size > 65536 || session.len() > 256 {
        return Err(bad("oversized campaign record"));
    }
    let encoded: String =
        conn.query_row("SELECT record FROM campaigns WHERE id=?1", [key], |r| {
            r.get(0)
        })?;
    let campaign: Campaign = serde_json::from_str(&encoded)?;
    campaign.plan.validate().map_err(|e| bad(&e.to_string()))?;
    if campaign.id != key
        || campaign.journal_session_id != session
        || campaign.status != CampaignStatus::Open
        || campaign.plan_sha256 != hash(&serde_json::to_value(&campaign.plan)?)?
    {
        return Err(bad("campaign identity changed"));
    }
    event(
        conn,
        &session,
        sequence,
        "campaign_created",
        &serde_json::to_value(&campaign)?,
    )?;
    Ok(campaign)
}
fn current(conn: &Connection, key: &str) -> Result<Campaign> {
    let mut c = original(conn, key)?;
    let closed: Option<u64> = conn.query_row(
        "SELECT cancel_sequence FROM campaigns WHERE id=?1",
        [key],
        |r| r.get(0),
    )?;
    let mut q = conn.prepare(
        "SELECT sequence FROM events WHERE session_id=?1 AND kind='campaign_cancelled' LIMIT 2",
    )?;
    let observed = q
        .query_map([&c.journal_session_id], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if observed.as_slice() != closed.as_slice() {
        return Err(bad("campaign cancellation projection differs"));
    }
    if let Some(sequence) = closed {
        event(
            conn,
            &c.journal_session_id,
            sequence,
            "campaign_cancelled",
            &json!({"campaign_id":key}),
        )?;
        c.status = CampaignStatus::Cancelled;
    } else if now()?.max(conn.query_row(
        "SELECT last_ms FROM campaigns WHERE id=?1",
        [key],
        |r| r.get::<_, u64>(0),
    )?) >= c.plan.expires_at_ms
    {
        c.status = CampaignStatus::Expired;
    }
    Ok(c)
}
fn open(conn: &Connection, key: &str) -> Result<Campaign> {
    let c = current(conn, key)?;
    if c.status != CampaignStatus::Open {
        return Err(bad("admissions closed"));
    }
    conn.execute(
        "UPDATE campaigns SET last_ms=MAX(last_ms,?2) WHERE id=?1",
        params![key, integer(now()?)?],
    )?;
    Ok(c)
}
fn binding(conn: &Connection, session: &str) -> Result<Option<CampaignRun>> {
    let found:Option<(String,String)>=conn.query_row("SELECT CASE WHEN length(CAST(campaign_id AS BLOB))<=256 THEN campaign_id END,CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM campaign_runs WHERE session_id=?1",[session],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let mut q=conn.prepare("SELECT sequence,length(CAST(payload AS BLOB)) FROM events WHERE session_id=?1 AND kind='campaign_session_bound' LIMIT 2")?;
    let witnesses = q
        .query_map([session], |r| {
            Ok((r.get::<_, u64>(0)?, r.get::<_, usize>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    match found {
        None => {
            if !witnesses.is_empty() {
                return Err(bad("bound session projection missing"));
            }
            Ok(None)
        }
        Some((campaign, key)) => {
            let r = read::run(conn, &campaign, &key)?;
            if witnesses.len() != 1 || witnesses[0].1 > 4096 {
                return Err(bad("bound session witness absent"));
            }
            event(
                conn,
                session,
                witnesses[0].0,
                "campaign_session_bound",
                &json!({"campaign_id":campaign,"run_id":key,"request_sha256":r.request_sha256,"run_sequence":r.sequence}),
            )?;
            Ok(Some(r))
        }
    }
}
fn require_epoch(conn: &Connection, owner: &str) -> Result<()> {
    let actual: Option<String> = conn
        .query_row(
            "SELECT owner FROM engine_epoch WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if actual.as_deref() != Some(owner) {
        return Err(bad("run owner is not current engine epoch"));
    }
    Ok(())
}
