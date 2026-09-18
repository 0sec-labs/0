//! Verify both directions between operation projections and immutable admissions.
use crate::{Error, Result, Store};

impl Store {
    /// Read-only evidence check. An unwitnessed operation must not disappear
    /// merely because a scorer enumerates the admission journal.
    pub fn validate_session_admission_closure(&self, session: &str) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        validate(&tx, session)
    }
}
/// Reuse an already pinned read or admission transaction without nesting BEGIN.
pub(crate) fn validate(conn: &rusqlite::Connection, session: &str) -> Result<()> {
    if session.is_empty() || session.len() > 256 {
        return Err(Error::Invalid("admission closure session bound".into()));
    }
    let (operations, operation_bytes, oversized): (u64, u64, bool) = conn.query_row(
        "SELECT count(*),COALESCE(sum(length(CAST(payload AS BLOB))),0),COALESCE(max(length(CAST(payload AS BLOB))>33554432 OR length(CAST(id AS BLOB))>256 OR length(CAST(command_id AS BLOB))>256),0) FROM operations WHERE session_id=?1",
        [session], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    let (admissions, event_bytes, event_max): (u64, u64, u64) = conn.query_row(
        "SELECT count(*),COALESCE(sum(length(CAST(payload AS BLOB))),0),COALESCE(max(length(CAST(payload AS BLOB))),0) FROM events WHERE session_id=?1 AND kind='command_admitted'",
        [session], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    if oversized
        || operations > 65_536
        || admissions != operations
        || event_max > 32 * 1024 * 1024
        || operation_bytes
            .checked_add(event_bytes)
            .is_none_or(|n| n > 64 * 1024 * 1024)
    {
        return Err(Error::Invalid(
            "operation/admission closure count or byte bound differs".into(),
        ));
    }
    // Match the lifecycle expression index and strip the outer TEXT affinity
    // with unary + so SQLite can seek by operation ID, not rescan every
    // admission for every operation. The full IN predicate selects its
    // partial index; the equality restricts it to admissions.
    let mismatch: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM operations o WHERE o.session_id=?1 AND (SELECT count(*) FROM events e INDEXED BY campaign_root_lifecycle WHERE e.session_id=o.session_id AND e.kind IN ('command_admitted','operation_started','operation_settled','operation_unknown','operation_not_started') AND e.kind='command_admitted' AND CASE WHEN json_valid(e.payload) THEN coalesce(json_extract(e.payload,'$.id'),json_extract(e.payload,'$.operation_id')) END=+o.id AND CASE WHEN json_valid(e.payload) AND json_valid(o.payload) THEN json(e.payload)=json(json_object('command_id',o.command_id,'id',o.id,'outcome',NULL,'owner',NULL,'payload',json(o.payload),'session_id',o.session_id,'status','admitted')) ELSE 0 END)!=1)",
        [session], |r| r.get(0))?;
    if mismatch {
        return Err(Error::Invalid(
            "operation projection and exact admission witnesses differ".into(),
        ));
    }
    Ok(())
}
