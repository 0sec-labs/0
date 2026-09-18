use super::invalid;
use crate::{Operation, OperationStatus, Result};
use rusqlite::Row;
use serde_json::Value;
use sha2::{Digest, Sha256};
use zero_protocol::{
    agent::{AgentRequest, AgentResult, AgentStatus},
    history::{ConversationEntry, DisplayText, MAX_DISPLAY_TEXT_BYTES},
};

fn text(value: &str) -> DisplayText {
    let mut end = value.len().min(MAX_DISPLAY_TEXT_BYTES);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    DisplayText {
        text: value[..end].into(),
        truncated: end < value.len(),
    }
}
fn required(row: &Row<'_>, index: usize) -> Result<String> {
    row.get::<_, Option<String>>(index)?
        .ok_or_else(|| invalid("missing, oversized or malformed operation/admission field"))
}
pub(super) fn entry(row: &Row<'_>, session: &str) -> Result<ConversationEntry> {
    let admission: Operation = serde_json::from_str(&required(row, 4)?)?;
    let id = required(row, 5)?;
    let stored_session = required(row, 6)?;
    let command = required(row, 7)?;
    let status: OperationStatus = serde_json::from_value(Value::String(required(row, 8)?))?;
    let hash = required(row, 9)?;
    let payload = required(row, 10)?;
    let request: Value = serde_json::from_str(&payload)?;
    if stored_session != session
        || admission.session_id != session
        || admission.id != id
        || admission.command_id != command
        || admission.status != OperationStatus::Admitted
        || admission.owner.is_some()
        || admission.outcome.is_some()
        || admission.payload != request
        || format!("{:x}", Sha256::digest(payload.as_bytes())) != hash
        || zero_protocol::agent::validate_actor_payload(&request).is_err()
        || request.get("parent_operation").is_some()
    {
        return Err(invalid("admission and operation identities disagree"));
    }
    let request: AgentRequest = serde_json::from_value(request["request"].clone())?;
    let outcome = row
        .get::<_, Option<String>>(11)?
        .map(|s| serde_json::from_str::<Value>(&s))
        .transpose()?;
    let mut result = ConversationEntry {
        sequence: row.get(0)?,
        operation_id: id,
        command_id: command,
        status,
        agent_status: None,
        continuable: false,
        prompt: text(&request.prompt),
        reply_text: None,
        error: None,
        tool_calls: None,
    };
    match outcome {
        None if matches!(
            status,
            OperationStatus::Admitted | OperationStatus::Running | OperationStatus::Unknown
        ) => {}
        None => return Err(invalid("terminal agent is missing its outcome")),
        Some(value) if value.get("status").is_some() => {
            let output: AgentResult = serde_json::from_value(value)?;
            let expected = match output.status {
                AgentStatus::Completed => OperationStatus::Succeeded,
                AgentStatus::Cancelled => OperationStatus::Cancelled,
                AgentStatus::Unknown => OperationStatus::Unknown,
                AgentStatus::Failed | AgentStatus::TurnLimit => OperationStatus::Failed,
            };
            if expected != status {
                return Err(invalid("agent outcome status contradicts operation status"));
            }
            let checkpoint: Option<String> = row.get(12)?;
            result.continuable = output.web_review.is_none()
                && output.source_review.is_none()
                && output.source_recovery_path.is_none()
                && output.error.is_none()
                && (1..=32).contains(&output.turns)
                && (output.status == AgentStatus::Completed
                    || (output.status == AgentStatus::TurnLimit
                        && output
                            .continuation_artifact
                            .as_deref()
                            .is_some_and(|digest| {
                                zero_protocol::is_sha256(digest)
                                    && checkpoint.as_deref() == Some(digest)
                            })));
            result.agent_status = Some(output.status);
            result.reply_text = Some(text(&output.text));
            result.error = output.error.as_deref().map(text);
            result.tool_calls = Some(output.tool_calls);
        }
        Some(value) => {
            let reason = value
                .get("reason")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("unrecognized agent recovery outcome"))?;
            if status != OperationStatus::Unknown
                && !(status == OperationStatus::Failed
                    && reason == "not_started"
                    && value["external_effects_started"] == false)
            {
                return Err(invalid("recovery outcome contradicts operation status"));
            }
            result.error = Some(text(reason));
        }
    }
    Ok(result)
}
