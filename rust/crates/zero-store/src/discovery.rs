//! Read-only attachment catalog. Detail APIs own evidence/provenance validation.
use crate::{Error, OperationStatus, Result, Store, integer};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use zero_protocol::discovery::{SourceReviewCandidate, SourceReviewPage};

const SCAN_ROWS: u32 = 128;
const ADMISSION_BYTES: usize = 32 * 1024 * 1024;
const READ_BYTES: usize = 64 * 1024 * 1024;
const PAGE_BYTES: usize = 512 * 1024;
const ID_BYTES: usize = 4096;
// Reserve the maximum possible operation metadata before decoding an admission.
const METADATA_BYTES: usize = 3 * ID_BYTES + 32 + 71;
fn invalid(message: &str) -> Error {
    Error::Invalid(format!("invalid source review catalog: {message}"))
}
fn id(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > ID_BYTES {
        return Err(invalid("identity must be 1..4096 bytes"));
    }
    Ok(())
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("missing admission identity"))
}
impl Store {
    /// Bounded attachment catalog. Empty pages can still carry a journal cursor.
    pub fn source_reviews(
        &self,
        session: &str,
        before: Option<u64>,
        limit: u32,
    ) -> Result<SourceReviewPage> {
        let page = scan(
            &self.conn,
            session,
            before,
            limit,
            |conn, session, sequence, admission| {
                candidate(conn, session, sequence, admission)?
                    .map(serde_json::to_value)
                    .transpose()
                    .map_err(Into::into)
            },
        )?;
        Ok(SourceReviewPage {
            reviews: page
                .entries
                .into_iter()
                .map(serde_json::from_value)
                .collect::<std::result::Result<_, _>>()?,
            next_before_sequence: page.next_before_sequence,
        })
    }
}
pub(super) struct RawPage {
    pub entries: Vec<Value>,
    pub next_before_sequence: Option<u64>,
}
/// Shared bounded journal scanning for source attachments and partial web roots.
/// Pickers return metadata only; detail endpoints own full provenance checks.
pub(super) fn scan(
    conn: &Connection,
    session: &str,
    before: Option<u64>,
    limit: u32,
    pick: impl Fn(&Connection, &str, u64, &Value) -> Result<Option<Value>>,
) -> Result<RawPage> {
    scan_direction(conn, session, before, limit, false, pick)
}
pub(super) fn scan_forward(
    conn: &Connection,
    session: &str,
    after: Option<u64>,
    limit: u32,
    pick: impl Fn(&Connection, &str, u64, &Value) -> Result<Option<Value>>,
) -> Result<RawPage> {
    scan_direction(conn, session, after, limit, true, pick)
}
fn scan_direction(
    conn: &Connection,
    session: &str,
    cursor: Option<u64>,
    limit: u32,
    forward: bool,
    pick: impl Fn(&Connection, &str, u64, &Value) -> Result<Option<Value>>,
) -> Result<RawPage> {
    id(session)?;
    if !(1..=32).contains(&limit) {
        return Err(invalid("limit must be 1..32"));
    }
    // An inclusive bound lets SQLite use both parts of the journal primary
    // key without an OR predicate, including the largest valid sequence.
    let bound = if forward {
        cursor.map(integer).transpose()?.unwrap_or(0)
    } else {
        cursor.map(integer).transpose()?.map_or(i64::MAX, |n| n - 1)
    };
    let tx = conn.unchecked_transaction()?;
    if tx
        .query_row("SELECT 1 FROM sessions WHERE id=?1", [session], |_| Ok(()))
        .optional()?
        .is_none()
    {
        return Err(Error::NotFound(session.into()));
    }
    let query = if forward {
        "SELECT sequence,
 CASE WHEN length(CAST(kind AS BLOB))<=128 THEN kind END,
 CASE WHEN kind='command_admitted' THEN length(CAST(payload AS BLOB)) ELSE 0 END
 FROM events WHERE session_id=?1 AND sequence>?2 ORDER BY sequence ASC LIMIT ?3"
    } else {
        "SELECT sequence,
 CASE WHEN length(CAST(kind AS BLOB))<=128 THEN kind END,
 CASE WHEN kind='command_admitted' THEN length(CAST(payload AS BLOB)) ELSE 0 END
 FROM events WHERE session_id=?1 AND sequence<=?2 ORDER BY sequence DESC LIMIT ?3"
    };
    let mut statement = tx.prepare(query)?;
    let mut rows = statement.query(params![session, bound, SCAN_ROWS])?;
    let mut page = RawPage {
        entries: vec![],
        next_before_sequence: None,
    };
    let mut consumed = None;
    let mut read_bytes = 0usize;
    while page.entries.len() < limit as usize {
        let Some(row) = rows.next()? else {
            break;
        };
        let sequence: u64 = row.get(0)?;
        if sequence == 0 {
            return Err(invalid("journal sequence must be positive"));
        }
        let kind = row
            .get::<_, Option<String>>(1)?
            .ok_or_else(|| invalid("oversized journal kind"))?;
        if kind.is_empty() {
            return Err(invalid("empty journal kind"));
        }
        if kind != "command_admitted" {
            if read_bytes.saturating_add(kind.len()) > READ_BYTES {
                break;
            }
            read_bytes = read_bytes.saturating_add(kind.len());
            consumed = Some(sequence);
            continue;
        }
        let bytes: usize = row.get(2)?;
        let cost = bytes
            .saturating_add(METADATA_BYTES)
            .saturating_add(kind.len());
        if bytes > ADMISSION_BYTES || read_bytes.saturating_add(cost) > READ_BYTES {
            if consumed.is_none() {
                return Err(invalid(
                    "first admission exceeds 32 MiB row / 64 MiB page read budget; cursor unchanged",
                ));
            }
            break;
        }
        read_bytes += cost;
        // Phase two fetches the bounded bytes only after the page quota
        // decision, in the same read snapshot as the metadata scan.
        let encoded: String = tx.query_row(
            "SELECT payload FROM events WHERE session_id=?1 AND sequence=?2",
            params![session, integer(sequence)?],
            |r| r.get(0),
        )?;
        let admission: Value = serde_json::from_str(&encoded)?;
        if let Some(review) = pick(&tx, session, sequence, &admission)? {
            page.entries.push(review);
            page.next_before_sequence = Some(sequence);
            if serde_json::to_vec(&page.entries)?.len().saturating_add(128) > PAGE_BYTES {
                page.entries.pop();
                if consumed.is_none() {
                    return Err(invalid(
                        "first candidate exceeds page byte budget; cursor unchanged",
                    ));
                }
                break;
            }
        }
        consumed = Some(sequence);
    }
    page.next_before_sequence = match consumed {
        Some(sequence)
            if tx.query_row(
                if forward {
                    "SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence>?2)"
                } else {
                    "SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence<?2)"
                },
                params![session, integer(sequence)?],
                |r| r.get::<_, bool>(0),
            )? =>
        {
            Some(sequence)
        }
        _ => None,
    };
    Ok(page)
}

fn candidate(
    conn: &Connection,
    session: &str,
    sequence: u64,
    admission: &Value,
) -> Result<Option<SourceReviewCandidate>> {
    let operation = field(admission, "id")?;
    let command = field(admission, "command_id")?;
    let admitted_session = field(admission, "session_id")?;
    for value in [operation, command, admitted_session] {
        id(value)?;
    }
    if admitted_session != session
        || admission.get("status").and_then(Value::as_str) != Some("admitted")
        || admission.get("owner") != Some(&Value::Null)
        || admission.get("outcome") != Some(&Value::Null)
    {
        return Err(invalid(
            "admission metadata does not match its journal session/status",
        ));
    }
    // Never select operations.payload/outcome, payload_hash or artifacts.bytes.
    let metadata=conn.query_row("SELECT
 CASE WHEN length(CAST(o.session_id AS BLOB))<=4096 THEN o.session_id END,
 CASE WHEN length(CAST(o.command_id AS BLOB))<=4096 THEN o.command_id END,
 CASE WHEN length(CAST(o.status AS BLOB))<=32 THEN o.status END,
 a.operation_id IS NOT NULL,
 CASE WHEN length(CAST(a.digest AS BLOB))<=71 THEN a.digest END
 FROM operations o LEFT JOIN operation_artifacts a ON a.operation_id=o.id AND a.name='source.review' WHERE o.id=?1",[operation],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,bool>(3)?,r.get::<_,Option<String>>(4)?))).optional()?.ok_or_else(||invalid("admission references missing operation"))?;
    if metadata.0.as_deref() != Some(session) || metadata.1.as_deref() != Some(command) {
        return Err(invalid("operation and admission identities disagree"));
    }
    let status: OperationStatus = serde_json::from_value(Value::String(
        metadata
            .2
            .ok_or_else(|| invalid("missing or oversized operation status"))?,
    ))?;
    if !metadata.3 {
        return Ok(None);
    }
    let digest = metadata
        .4
        .filter(|s| zero_protocol::is_sha256(s))
        .ok_or_else(|| invalid("invalid source.review attachment digest"))?;
    Ok(Some(SourceReviewCandidate {
        sequence,
        operation_id: operation.into(),
        command_id: command.into(),
        operation_status: status,
        source_review_sha256: digest,
    }))
}
