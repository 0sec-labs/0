//! Metadata-only journal discovery; detail readers authenticate experiment origins.
use crate::{Error, Result, Store};
use rusqlite::OptionalExtension;
use serde_json::Value;
use zero_protocol::web_experiment::{WebExperimentCandidate, WebExperimentsPage};
fn invalid() -> Error {
    Error::Invalid("invalid experiment catalog admission".into())
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(invalid)
}
impl Store {
    pub fn experiment_operation_candidates(
        &self,
        session: &str,
        after: Option<u64>,
        limit: u32,
    ) -> Result<WebExperimentsPage> {
        let page = crate::discovery::scan_forward(
            &self.conn,
            session,
            after,
            limit,
            |conn, session, sequence, admission| {
                if text(admission, "session_id")? != session
                    || admission["status"] != "admitted"
                    || admission.get("owner") != Some(&Value::Null)
                    || admission.get("outcome") != Some(&Value::Null)
                {
                    return Err(invalid());
                }
                let payload = admission.get("payload").ok_or_else(invalid)?;
                if payload["kind"] != "agent_web_experiment" {
                    return Ok(None);
                }
                let id = text(admission, "id")?;
                let command = text(admission, "command_id")?;
                let actor = text(payload, "parent_operation")?;
                let hypothesis = text(payload, "hypothesis_sha256")?;
                if !zero_protocol::is_sha256(hypothesis) {
                    return Err(invalid());
                }
                let (stored_session,stored_command,status):(Option<String>,Option<String>,Option<String>)=conn.query_row("SELECT CASE WHEN length(CAST(session_id AS BLOB))<=4096 THEN session_id END,CASE WHEN length(CAST(command_id AS BLOB))<=4096 THEN command_id END,CASE WHEN length(CAST(status AS BLOB))<=32 THEN status END FROM operations WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(invalid)?;
                if stored_session.as_deref() != Some(session)
                    || stored_command.as_deref() != Some(command)
                {
                    return Err(invalid());
                }
                let operation_status =
                    serde_json::from_value(Value::String(status.ok_or_else(invalid)?))?;
                Ok(Some(serde_json::to_value(WebExperimentCandidate {
                    sequence,
                    operation_id: id.into(),
                    actor_operation_id: actor.into(),
                    operation_status,
                    hypothesis_sha256: Some(hypothesis.into()),
                })?))
            },
        )?;
        Ok(WebExperimentsPage {
            experiments: page
                .entries
                .into_iter()
                .map(serde_json::from_value)
                .collect::<std::result::Result<_, _>>()?,
            next_after_sequence: page.next_before_sequence,
        })
    }
}
