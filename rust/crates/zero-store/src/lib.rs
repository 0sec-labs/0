//! Native-only SQLite journal. Opening a store never recovers somebody else's work.
mod admission_closure;
mod approvals;
mod artifacts;
mod bounded_read;
mod budget;
mod campaign;
mod campaign_snapshot;
pub use campaign_snapshot::CampaignSnapshotData;
mod discovery;
mod history;
mod http;
pub use http::HttpAdmission;
mod lifecycle;
mod operations;
mod questions;
mod queue;
mod readonly;
mod review;
mod scan;
mod workflow;
pub use review::{AdmittedReview, ReviewAdmission};
mod schema;
pub use scan::{AdmittedScan, ScanAdmission};
mod steering;
mod strategy_session;
mod triage;
mod web_discovery;
mod web_experiment;
mod web_experiment_discovery;
mod web_experiment_quota;
mod web_triage;
mod web_verification;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
pub use zero_protocol::session::{Admission, BudgetSnapshot, Operation, OperationStatus};
use zero_protocol::session::{Session, SessionEvent};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("storage error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported native database schema {0}")]
    Schema(i64),
    #[error("database belongs to another application")]
    ForeignDatabase,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflicting retry or state transition: {0}")]
    Conflict(String),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("budget exceeded")]
    BudgetExceeded,
}
pub use artifacts::MAX_ARTIFACT_BYTES;
pub type Result<T> = std::result::Result<T, Error>;
pub struct Store {
    conn: Connection,
}
impl Store {
    /// Explicit path only: no legacy database discovery or migration.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", true)?;
        schema::initialize(&mut conn)?;
        Ok(Self { conn })
    }
    pub fn create_session(&mut self, generation: &str, budget_limit: u64) -> Result<Session> {
        self.create_session_bound(generation, None, budget_limit)
    }
    pub fn create_pinned_session(
        &mut self,
        generation: &str,
        epoch: u64,
        budget_limit: u64,
    ) -> Result<Session> {
        if epoch == 0 {
            return Err(Error::Invalid(
                "activated generation epoch must be positive".into(),
            ));
        }
        integer(epoch)?;
        self.create_session_bound(generation, Some(epoch), budget_limit)
    }
    fn create_session_bound(
        &mut self,
        generation: &str,
        generation_epoch: Option<u64>,
        budget_limit: u64,
    ) -> Result<Session> {
        nonempty(generation)?;
        let limit = integer(budget_limit)?;
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            generation: generation.into(),
            generation_epoch,
            created_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| Error::Invalid("clock before epoch".into()))?
                .as_millis()
                .try_into()
                .map_err(|_| Error::Invalid("clock overflow".into()))?,
            budget_limit,
        };
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO sessions(id,generation,created_at_ms,budget_limit,generation_epoch) VALUES (?1,?2,?3,?4,?5)",
            params![
                session.id,
                session.generation,
                integer(session.created_at_ms)?,
                limit,
                generation_epoch.map(integer).transpose()?,
            ],
        )?;
        append(
            &tx,
            &session.id,
            "session_created",
            &serde_json::to_value(&session)?,
        )?;
        tx.commit()?;
        Ok(session)
    }
    pub fn get_session(&self, id: &str) -> Result<Session> {
        get_session(&self.conn, id)
    }
    pub fn list_sessions(&self) -> Result<Vec<Session>> {
        let mut stmt = self.conn.prepare("SELECT id,generation,created_at_ms,budget_limit,generation_epoch FROM sessions ORDER BY created_at_ms,id")?;
        Ok(stmt
            .query_map([], session_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn events(
        &self,
        session: &str,
        after_sequence: u64,
        limit: u32,
    ) -> Result<Vec<SessionEvent>> {
        self.get_session(session)?;
        if limit == 0 || limit > 10000 {
            return Err(Error::Invalid("event page limit must be 1..10000".into()));
        }
        // Bound bytes as well as row count. Read a size sentinel rather than
        // materializing an oversized payload just to discover its length.
        const PAGE_BYTES: usize = 4 * 1024 * 1024;
        let mut stmt = self.conn.prepare("SELECT sequence,kind,length(CAST(payload AS BLOB)),CASE WHEN length(CAST(payload AS BLOB))<=?4 THEN payload ELSE NULL END FROM events WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
        let rows = stmt.query_map(
            params![session, integer(after_sequence)?, limit, PAGE_BYTES],
            |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, usize>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )?;
        let mut events = Vec::new();
        let mut retained_bytes = 2;
        for row in rows {
            let (sequence, kind, payload_bytes, payload) = row?;
            let metadata_bytes = serde_json::to_vec(&serde_json::json!({
                "session_id":session,"sequence":sequence,"kind":kind,"payload":null
            }))?
            .len();
            let event_bytes = metadata_bytes
                .saturating_sub(4)
                .saturating_add(payload_bytes)
                .saturating_add(1);
            if retained_bytes + event_bytes > PAGE_BYTES {
                if events.is_empty() {
                    return Err(Error::Invalid(format!(
                        "event {sequence} exceeds the 4 MiB event-page byte budget; cursor was not advanced"
                    )));
                }
                break;
            }
            let payload = payload.ok_or_else(|| {
                Error::Invalid(format!("event {sequence} exceeds event-page byte budget"))
            })?;
            events.push(SessionEvent {
                session_id: session.into(),
                sequence,
                kind,
                payload: serde_json::from_str(&payload)?,
            });
            retained_bytes += event_bytes;
        }
        Ok(events)
    }
}
fn session_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        generation: r.get(1)?,
        generation_epoch: r.get(4)?,
        created_at_ms: r.get(2)?,
        budget_limit: r.get(3)?,
    })
}
fn get_session(conn: &Connection, id: &str) -> Result<Session> {
    conn.query_row(
        "SELECT id,generation,created_at_ms,budget_limit,generation_epoch FROM sessions WHERE id=?1",
        [id],
        session_row,
    )
    .optional()?
    .ok_or_else(|| Error::NotFound(id.into()))
}
fn nonempty(value: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(Error::Invalid("identifier must not be empty".into()))
    } else {
        Ok(())
    }
}
fn integer(value: u64) -> Result<i64> {
    value
        .try_into()
        .map_err(|_| Error::Invalid("integer exceeds SQLite range".into()))
}
fn append(tx: &Transaction<'_>, session: &str, kind: &str, payload: &Value) -> Result<()> {
    tx.execute("INSERT INTO events(session_id,sequence,kind,payload) SELECT ?1,COALESCE(MAX(sequence),0)+1,?2,?3 FROM events WHERE session_id=?1",params![session,kind,serde_json::to_string(payload)?])?;
    Ok(())
}
