//! Shared raw-byte budgets for independently reassessed reports.
use crate::{Error, Operation, Result, SessionEvent, Store, integer};
use rusqlite::{OptionalExtension, params};

fn charge(remaining: &mut usize, size: usize, maximum: usize) -> Result<()> {
    if size > maximum || size > *remaining {
        return Err(Error::Invalid(
            "report evidence read budget exceeded".into(),
        ));
    }
    *remaining -= size;
    Ok(())
}
fn operation_size(conn: &rusqlite::Connection, id: &str) -> Result<usize> {
    conn.query_row("SELECT length(CAST(id AS BLOB))+length(CAST(session_id AS BLOB))+length(CAST(command_id AS BLOB))+length(CAST(payload AS BLOB))+length(CAST(status AS BLOB))+COALESCE(length(CAST(owner AS BLOB)),0)+COALESCE(length(CAST(outcome AS BLOB)),0) FROM operations WHERE id=?1", [id], |r|r.get(0))
        .optional()?.ok_or_else(||Error::NotFound(id.into()))
}
impl Store {
    /// Reject oversized bytes before allocation; the same SQLite snapshot owns both reads.
    pub fn artifact_bounded(
        &self,
        digest: &str,
        maximum: usize,
        remaining: &mut usize,
    ) -> Result<Vec<u8>> {
        let tx = self.conn.unchecked_transaction()?;
        let size: usize = tx
            .query_row(
                "SELECT length(bytes) FROM artifacts WHERE digest=?1",
                [digest],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(digest.into()))?;
        charge(
            remaining,
            size,
            maximum.min(crate::artifacts::MAX_ARTIFACT_BYTES),
        )?;
        let bytes = crate::artifacts::read(&tx, digest)?;
        tx.commit()?;
        Ok(bytes)
    }
    pub fn get_operation_bounded(&self, id: &str, remaining: &mut usize) -> Result<Operation> {
        let tx = self.conn.unchecked_transaction()?;
        charge(remaining, operation_size(&tx, id)?, 32 * 1024 * 1024)?;
        let op = crate::operations::operation(&tx, id)?;
        tx.commit()?;
        Ok(op)
    }
    pub fn get_operation_by_command_bounded(
        &self,
        session: &str,
        command: &str,
        remaining: &mut usize,
    ) -> Result<Operation> {
        let tx = self.conn.unchecked_transaction()?;
        let id: String = tx.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=4096 THEN id END FROM operations WHERE session_id=?1 AND command_id=?2", params![session, command], |r|r.get(0))
            .optional()?.ok_or_else(||Error::NotFound(command.into()))?;
        charge(remaining, operation_size(&tx, &id)?, 32 * 1024 * 1024)?;
        let op = crate::operations::operation(&tx, &id)?;
        tx.commit()?;
        Ok(op)
    }
    /// Bounded journal page. An oversized next row fails explicitly rather than masquerading as EOF.
    pub fn events_bounded(
        &self,
        session: &str,
        after: u64,
        limit: u32,
        remaining: &mut usize,
    ) -> Result<Vec<SessionEvent>> {
        if session.is_empty() || session.len() > 4096 || !(1..=256).contains(&limit) {
            return Err(Error::Invalid("bounded event cursor or page limit".into()));
        }
        let tx = self.conn.unchecked_transaction()?;
        let mut query = tx.prepare("SELECT sequence,length(CAST(kind AS BLOB))+length(CAST(payload AS BLOB)) FROM events WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
        let sizes = query
            .query_map(params![session, integer(after)?, limit], |r| {
                Ok((r.get::<_, u64>(0)?, r.get::<_, usize>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(query);
        let mut output = vec![];
        let mut page_bytes = 0usize;
        for (sequence, size) in sizes {
            if !output.is_empty() && page_bytes.saturating_add(size) > 4 * 1024 * 1024 {
                break;
            }
            charge(remaining, size, 32 * 1024 * 1024)?;
            let (kind, payload): (String, String) = tx.query_row(
                "SELECT kind,payload FROM events WHERE session_id=?1 AND sequence=?2",
                params![session, integer(sequence)?],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            output.push(SessionEvent {
                session_id: session.into(),
                sequence,
                kind,
                payload: serde_json::from_str(&payload)?,
            });
            page_bytes += size;
        }
        tx.commit()?;
        Ok(output)
    }
}
