//! Bounded, read-only UI views. Raw journal values remain untouched.
use crate::{Error, Result, Store, integer};
use rusqlite::{OptionalExtension, params};
use zero_protocol::history::{
    MAX_HISTORY_PAGE_BYTES, SessionCursor, SessionHistoryPage, SessionListPage,
};

mod projection;
const ROW_BYTES: usize = 32 * 1024 * 1024;
const READ_BYTES: usize = 64 * 1024 * 1024;
const ID_BYTES: usize = 4096;

fn limit(value: u32) -> Result<()> {
    if !(1..=100).contains(&value) {
        return Err(Error::Invalid("history page limit must be 1..100".into()));
    }
    Ok(())
}
fn invalid(message: &str) -> Error {
    Error::Invalid(format!("invalid retained conversation: {message}"))
}
impl Store {
    /// Ascending immutable (created_at_ms,id) order, including tied timestamps.
    pub fn session_list_page(
        &self,
        after: Option<&SessionCursor>,
        count: u32,
    ) -> Result<SessionListPage> {
        limit(count)?;
        let tx = self.conn.unchecked_transaction()?;
        if let Some(cursor) = after {
            if cursor.id.len() > ID_BYTES || cursor.id.is_empty() {
                return Err(Error::Invalid("invalid session cursor".into()));
            }
            let exists = tx
                .query_row(
                    "SELECT 1 FROM sessions WHERE id=?1 AND created_at_ms=?2",
                    params![cursor.id, integer(cursor.created_at_ms)?],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !exists {
                return Err(Error::Invalid(
                    "session cursor does not match a retained session".into(),
                ));
            }
        }
        let mut statement = tx.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=4096 THEN id END,CASE WHEN length(CAST(generation AS BLOB))<=524288 THEN generation END,created_at_ms,budget_limit,generation_epoch FROM sessions WHERE ?1 IS NULL OR created_at_ms>?1 OR (created_at_ms=?1 AND id>?2) ORDER BY created_at_ms,id LIMIT ?3")?;
        let mut rows = statement.query(params![
            after.map(|c| integer(c.created_at_ms)).transpose()?,
            after.map(|c| c.id.as_str()),
            count + 1
        ])?;
        let mut page = SessionListPage {
            sessions: vec![],
            next_cursor: None,
        };
        while let Some(row) = rows.next()? {
            if page.sessions.len() == count as usize {
                break;
            }
            let session = zero_protocol::Session {
                id: row
                    .get::<_, Option<String>>(0)?
                    .ok_or_else(|| invalid("session ID exceeds display bound"))?,
                generation: row
                    .get::<_, Option<String>>(1)?
                    .ok_or_else(|| invalid("session generation exceeds display bound"))?,
                created_at_ms: row.get(2)?,
                budget_limit: row.get(3)?,
                generation_epoch: row.get(4)?,
            };
            if session.id.is_empty()
                || session.generation.trim().is_empty()
                || session.generation_epoch == Some(0)
            {
                return Err(invalid("invalid session metadata"));
            }
            let previous = page.next_cursor.clone();
            page.next_cursor = Some(SessionCursor {
                created_at_ms: session.created_at_ms,
                id: session.id.clone(),
            });
            page.sessions.push(session);
            if serde_json::to_vec(&page)?.len() > MAX_HISTORY_PAGE_BYTES {
                page.sessions.pop();
                page.next_cursor = previous;
                if page.sessions.is_empty() {
                    return Err(invalid(
                        "first session exceeds page byte bound; cursor unchanged",
                    ));
                }
                return Ok(page);
            }
        }
        // A separate EXISTS query avoids consuming/discarding the look-ahead
        // row and preserves a cursor only when another row really exists.
        if let Some(last) = &page.next_cursor {
            let more:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE created_at_ms>?1 OR (created_at_ms=?1 AND id>?2))",params![integer(last.created_at_ms)?,last.id],|r|r.get(0))?;
            if !more {
                page.next_cursor = None;
            }
        }
        Ok(page)
    }

    /// Only top-level agent turns. Admission sequence is the stable cursor;
    /// operation status is current at this single SQLite read snapshot.
    pub fn session_history(
        &self,
        session: &str,
        before: Option<u64>,
        count: u32,
    ) -> Result<SessionHistoryPage> {
        limit(count)?;
        before.map(integer).transpose()?;
        if session.len() > ID_BYTES {
            return Err(invalid("session ID exceeds bound"));
        }
        let tx = self.conn.unchecked_transaction()?;
        let exists = tx
            .query_row("SELECT 1 FROM sessions WHERE id=?1", [session], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Err(Error::NotFound(session.into()));
        }
        // CASE (not boolean AND) gates JSON parsing on the byte sentinel. A
        // malformed admission is surfaced, never silently skipped. Joining by
        // ID first lets projection reject cross-session identity corruption.
        let mut statement = tx.prepare("WITH admissions AS (
 SELECT sequence,length(CAST(payload AS BLOB)) AS admission_bytes,
 CASE WHEN length(CAST(payload AS BLOB))<=?4 THEN CASE WHEN json_valid(payload) THEN payload END END AS admission
 FROM events WHERE session_id=?1 AND (?2 IS NULL OR sequence<?2) AND kind='command_admitted'
), candidates AS (
 SELECT e.*,o.id,o.session_id,o.command_id,o.status,o.payload_hash,
 length(CAST(o.payload AS BLOB)) AS request_bytes,length(CAST(o.outcome AS BLOB)) AS outcome_bytes,
 CASE WHEN length(CAST(o.payload AS BLOB))<=?4 THEN CASE WHEN json_valid(o.payload) THEN o.payload END END AS request,
 CASE WHEN length(CAST(o.outcome AS BLOB))<=?4 THEN o.outcome END AS outcome
 FROM admissions e LEFT JOIN operations o ON o.id=json_extract(e.admission,'$.id')
)
 SELECT sequence,admission_bytes,request_bytes,coalesce(outcome_bytes,0),admission,
 CASE WHEN length(CAST(id AS BLOB))<=4096 THEN id END,
 CASE WHEN length(CAST(session_id AS BLOB))<=4096 THEN session_id END,
 CASE WHEN length(CAST(command_id AS BLOB))<=4096 THEN command_id END,
 CASE WHEN length(CAST(status AS BLOB))<=64 THEN status END,
 CASE WHEN length(CAST(payload_hash AS BLOB))<=64 THEN payload_hash END,request,outcome,
 (SELECT CASE WHEN length(CAST(a.digest AS BLOB))<=71 THEN a.digest END FROM operation_artifacts a WHERE a.operation_id=candidates.id AND a.name='agent.continuation')
 FROM candidates WHERE admission IS NULL
 OR (json_extract(admission,'$.payload.kind')='offline_snapshot_agent' AND json_type(admission,'$.payload.parent_operation') IS NULL)
 OR (json_extract(request,'$.kind')='offline_snapshot_agent' AND json_type(request,'$.parent_operation') IS NULL)
 ORDER BY sequence DESC LIMIT ?3")?;
        let mut rows = statement.query(params![
            session,
            before.map(integer).transpose()?,
            count + 1,
            ROW_BYTES
        ])?;
        let mut page = SessionHistoryPage {
            entries: vec![],
            next_before_sequence: None,
        };
        let mut read_bytes = 0usize;
        while let Some(row) = rows.next()? {
            if page.entries.len() == count as usize {
                page.next_before_sequence = page.entries.last().map(|e| e.sequence);
                return Ok(page);
            }
            let sizes = [
                row.get::<_, usize>(1)?,
                row.get::<_, Option<usize>>(2)?
                    .ok_or_else(|| invalid("admission references a missing operation"))?,
                row.get::<_, usize>(3)?,
            ];
            if sizes.iter().any(|s| *s > ROW_BYTES) {
                return Err(invalid("retained row exceeds 32 MiB read bound"));
            }
            let bytes = sizes.iter().sum::<usize>();
            if read_bytes.saturating_add(bytes) > READ_BYTES {
                if page.entries.is_empty() {
                    return Err(invalid(
                        "first entry exceeds 64 MiB page read bound; cursor unchanged",
                    ));
                }
                page.next_before_sequence = page.entries.last().map(|e| e.sequence);
                return Ok(page);
            }
            read_bytes += bytes;
            let entry = projection::entry(row, session)?;
            let sequence = entry.sequence;
            page.entries.push(entry);
            page.next_before_sequence = Some(sequence);
            if serde_json::to_vec(&page)?.len() > MAX_HISTORY_PAGE_BYTES {
                page.entries.pop();
                if page.entries.is_empty() {
                    return Err(invalid(
                        "first entry exceeds page byte bound; cursor unchanged",
                    ));
                }
                page.next_before_sequence = page.entries.last().map(|e| e.sequence);
                return Ok(page);
            }
        }
        page.next_before_sequence = None;
        Ok(page)
    }
}
