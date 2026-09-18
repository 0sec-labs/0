//! Admission-based web discovery includes runs that never produced a review.
use crate::{Error, Result, Store};
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use zero_protocol::web::{WebRunCandidate, WebRunsPage};

fn invalid() -> Error {
    Error::Invalid("invalid web run catalog admission".into())
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 4096)
        .ok_or_else(invalid)
}
impl Store {
    pub fn web_runs(&self, session: &str, before: Option<u64>, limit: u32) -> Result<WebRunsPage> {
        let page = crate::discovery::scan(
            &self.conn,
            session,
            before,
            limit,
            |conn, session, sequence, value| {
                candidate(conn, session, sequence, value)?
                    .map(serde_json::to_value)
                    .transpose()
                    .map_err(Into::into)
            },
        )?;
        Ok(WebRunsPage {
            runs: page
                .entries
                .into_iter()
                .map(serde_json::from_value)
                .collect::<std::result::Result<_, _>>()?,
            next_before_sequence: page.next_before_sequence,
        })
    }
}
fn candidate(
    conn: &Connection,
    session: &str,
    sequence: u64,
    admission: &Value,
) -> Result<Option<WebRunCandidate>> {
    let id = text(admission, "id")?;
    let command = text(admission, "command_id")?;
    if text(admission, "session_id")? != session
        || admission["status"] != "admitted"
        || admission.get("owner") != Some(&Value::Null)
        || admission.get("outcome") != Some(&Value::Null)
    {
        return Err(invalid());
    }
    let payload = admission.get("payload").ok_or_else(invalid)?;
    if payload.get("parent_operation").is_some()
        || payload["request"]["web_submission_max_hypotheses"].is_null()
    {
        return Ok(None);
    }
    let max = payload["request"]["web_submission_max_hypotheses"]
        .as_u64()
        .filter(|n| (1..=32).contains(n))
        .ok_or_else(invalid)?;
    let _ = max;
    zero_protocol::agent::validate_actor_payload(payload).map_err(|_| invalid())?;
    // Read metadata only, never live request/outcome or artifact blobs.
    let (actual_session,actual_command,status,attached,digest):(Option<String>,Option<String>,Option<String>,bool,Option<String>)=conn.query_row("SELECT CASE WHEN length(CAST(o.session_id AS BLOB))<=4096 THEN o.session_id END,CASE WHEN length(CAST(o.command_id AS BLOB))<=4096 THEN o.command_id END,CASE WHEN length(CAST(o.status AS BLOB))<=32 THEN o.status END,a.operation_id IS NOT NULL,CASE WHEN length(CAST(a.digest AS BLOB))<=71 THEN a.digest END FROM operations o LEFT JOIN operation_artifacts a ON a.operation_id=o.id AND a.name='web.review' WHERE o.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?.ok_or_else(invalid)?;
    if actual_session.as_deref() != Some(session) || actual_command.as_deref() != Some(command) {
        return Err(invalid());
    }
    let status = serde_json::from_value(Value::String(status.ok_or_else(invalid)?))?;
    let digest = if attached {
        Some(
            digest
                .filter(|s| zero_protocol::is_sha256(s))
                .ok_or_else(invalid)?,
        )
    } else {
        None
    };
    Ok(Some(WebRunCandidate {
        sequence,
        operation_id: id.into(),
        command_id: command.into(),
        operation_status: status,
        web_review_sha256: digest,
    }))
}

impl Store {
    /// Bounded admission metadata only. The engine validates root membership
    /// and retained evidence before exposing an individual response.
    pub fn http_operation_candidates(
        &self,
        session: &str,
        after: Option<u64>,
        limit: u32,
    ) -> Result<zero_protocol::web::WebHttpOperationsPage> {
        let page = crate::discovery::scan_forward(
            &self.conn,
            session,
            after,
            limit,
            |conn, session, sequence, admission| {
                let id = text(admission, "id")?;
                let command = text(admission, "command_id")?;
                if text(admission, "session_id")? != session
                    || admission["status"] != "admitted"
                    || admission.get("owner") != Some(&Value::Null)
                    || admission.get("outcome") != Some(&Value::Null)
                {
                    return Err(invalid());
                }
                let payload = admission.get("payload").ok_or_else(invalid)?;
                if payload["kind"] != "agent_http" {
                    return Ok(None);
                }
                let parent = text(payload, "parent_operation")?;
                let (actual_session,actual_command,status,attached,digest):(Option<String>,Option<String>,Option<String>,bool,Option<String>)=conn.query_row("SELECT CASE WHEN length(CAST(o.session_id AS BLOB))<=4096 THEN o.session_id END,CASE WHEN length(CAST(o.command_id AS BLOB))<=4096 THEN o.command_id END,CASE WHEN length(CAST(o.status AS BLOB))<=32 THEN o.status END,a.operation_id IS NOT NULL,CASE WHEN length(CAST(a.digest AS BLOB))<=71 THEN a.digest END FROM operations o LEFT JOIN operation_artifacts a ON a.operation_id=o.id AND a.name='http.response' WHERE o.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?.ok_or_else(invalid)?;
                if actual_session.as_deref() != Some(session)
                    || actual_command.as_deref() != Some(command)
                {
                    return Err(invalid());
                }
                let operation_status =
                    serde_json::from_value(Value::String(status.ok_or_else(invalid)?))?;
                let response_manifest_sha256 = if attached {
                    Some(
                        digest
                            .filter(|s| zero_protocol::is_sha256(s))
                            .ok_or_else(invalid)?,
                    )
                } else {
                    None
                };
                Ok(Some(serde_json::to_value(
                    zero_protocol::web::WebHttpOperation {
                        sequence,
                        operation_id: id.into(),
                        actor_operation_id: parent.into(),
                        operation_status,
                        response_manifest_sha256,
                    },
                )?))
            },
        )?;
        Ok(zero_protocol::web::WebHttpOperationsPage {
            operations: page
                .entries
                .into_iter()
                .map(serde_json::from_value)
                .collect::<std::result::Result<_, _>>()?,
            next_after_sequence: page.next_before_sequence,
        })
    }
}
