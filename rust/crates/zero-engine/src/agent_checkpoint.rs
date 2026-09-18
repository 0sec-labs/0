//! Explicit continuation of a complete tool round, never replay of effects.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zero_protocol::{
    agent::AgentResult,
    model::{Completion, CompletionStatus, Content, ResponsesRequest},
};
const NAME: &str = "agent.continuation";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    version: u32,
    session_id: String,
    parent_operation: String,
    parent_payload_sha256: String,
    next_turn: u32,
    last_inference: String,
    last_completion_sha256: String,
    input: Vec<Value>,
}
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn digest(value: &Value) -> Result<String, EngineError> {
    Ok(format!(
        "sha256:{}",
        zero_plugin::sha256(&serde_json::to_vec(value)?)
    ))
}
fn last_model(
    store: &Store,
    session: &str,
    parent: &str,
    turns: u32,
) -> Result<zero_protocol::Operation, EngineError> {
    if !(1..=32).contains(&turns) {
        return Err(error("invalid checkpoint turn count"));
    }
    let op = store.get_operation_by_command(session, &format!("{parent}:model:{}", turns - 1))?;
    if op.session_id != session
        || op.status != OperationStatus::Succeeded
        || op.payload["parent_operation"] != parent
        || op.payload["kind"] != "agent_inference"
    {
        return Err(error("checkpoint inference is not settled"));
    }
    match store.get_operation_by_command(session, &format!("{parent}:model:{turns}")) {
        Err(zero_store::Error::NotFound(_)) => (),
        Err(e) => return Err(e.into()),
        Ok(_) => return Err(error("checkpoint is older than a later inference attempt")),
    }
    Ok(op)
}
fn validate(store: &Store, checkpoint: &Checkpoint) -> Result<(), EngineError> {
    let parent = store.get_operation(&checkpoint.parent_operation)?;
    if checkpoint.version != 1
        || parent.session_id != checkpoint.session_id
        || checkpoint.parent_payload_sha256 != digest(&parent.payload)?
        || parent.payload["kind"] != "offline_snapshot_agent"
        || parent.payload["request"]["max_turns"].as_u64() != Some(u64::from(checkpoint.next_turn))
    {
        return Err(error("checkpoint authority or terminal turn mismatch"));
    }
    let last = last_model(
        store,
        &checkpoint.session_id,
        &parent.id,
        checkpoint.next_turn,
    )?;
    let outcome = last
        .outcome
        .as_ref()
        .ok_or_else(|| error("missing checkpoint completion"))?;
    if checkpoint.last_inference != last.id || checkpoint.last_completion_sha256 != digest(outcome)?
    {
        return Err(error("checkpoint completion identity mismatch"));
    }
    let model: ResponsesRequest = serde_json::from_value(last.payload["request"].clone())?;
    inference::validate_hosted_pair(&parent.payload, &last.payload, &model)?;
    let completion: Completion = serde_json::from_value(outcome.clone())?;
    if completion.status != CompletionStatus::Completed || completion.replay.is_empty() {
        return Err(error("checkpoint has incomplete provider replay"));
    }
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|c| match c {
            Content::ToolCall { id, name, .. } => Some((id, name)),
            _ => None,
        })
        .collect();
    if calls.is_empty()
        || calls.len() > 32
        || calls
            .iter()
            .map(|(id, _)| id)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != calls.len()
    {
        return Err(error("checkpoint requires a bounded tool round"));
    }
    let restored = agent_context::load(store, &parent, &last, &model)?;
    let mut prefix = restored.map(|s| s.input()).unwrap_or(model.input);
    prefix.extend(completion.replay);
    if checkpoint.input.len() != prefix.len() + calls.len()
        || checkpoint.input[..prefix.len()] != prefix
    {
        return Err(error(
            "checkpoint changed provider replay or omitted tool results",
        ));
    }
    for (index, ((id, name), item)) in calls
        .iter()
        .zip(&checkpoint.input[prefix.len()..])
        .enumerate()
    {
        if item.as_object().map(|o| o.len()) != Some(3)
            || item["type"] != "function_call_output"
            || item["call_id"] != **id
            || !item["output"].is_string()
        {
            return Err(error("checkpoint tool result correlation mismatch"));
        }
        match store.get_operation_by_command(
            &checkpoint.session_id,
            &format!("{}:tool:{}:{index}", parent.id, checkpoint.next_turn - 1),
        ) {
            Ok(child) => {
                if child.payload["parent_operation"] != parent.id
                    || child.payload["call_id"] != **id
                    || !matches!(
                        child.status,
                        OperationStatus::Succeeded | OperationStatus::Failed
                    )
                {
                    return Err(error("checkpoint includes unsettled tool effects"));
                }
                if (name.as_str() == "ask_operator"
                    && parent.payload["request"]["operator_questions"] == true)
                    || child.payload["kind"] == "agent_operator_question"
                {
                    if name.as_str() != "ask_operator"
                        || child.payload["kind"] != "agent_operator_question"
                    {
                        return Err(error("checkpoint operator question kind mismatch"));
                    }
                    let output = agent_questions::validate_receipt(store, &child)?;
                    if item["output"].as_str() != Some(output.as_str()) {
                        return Err(error(
                            "checkpoint operator answer differs from durable decision",
                        ));
                    }
                }
                if name.as_str() == "delegate_tasks" || child.payload["kind"] == "agent_delegation"
                {
                    if name.as_str() != "delegate_tasks"
                        || child.payload["kind"] != "agent_delegation"
                    {
                        return Err(error("checkpoint delegation tool kind mismatch"));
                    }
                    let output = agent_delegation::validate_receipt(store, &child)?;
                    if item["output"].as_str() != Some(output.as_str()) {
                        return Err(error(
                            "checkpoint delegation output differs from child receipts",
                        ));
                    }
                }
            }
            // Denied/unoffered tools have no child, but their exact error output is retained.
            Err(zero_store::Error::NotFound(_)) => {
                if !item["output"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("Tool rejected:"))
                {
                    return Err(error("checkpoint has output without a settled tool"));
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
pub(super) fn save(
    store: &mut Store,
    owner: &str,
    session: &str,
    parent: &str,
    turns: u32,
    input: Vec<Value>,
) -> Result<String, EngineError> {
    let operation = store.get_operation(parent)?;
    let last = last_model(store, session, parent, turns)?;
    let checkpoint = Checkpoint {
        version: 1,
        session_id: session.into(),
        parent_operation: parent.into(),
        parent_payload_sha256: digest(&operation.payload)?,
        next_turn: turns,
        last_inference: last.id,
        last_completion_sha256: digest(&last.outcome.ok_or_else(|| error("missing completion"))?)?,
        input,
    };
    validate(store, &checkpoint)?;
    let bytes = serde_json::to_vec(&checkpoint)?;
    Ok(store.retain_operation_artifact(parent, owner, NAME, &bytes)?)
}
pub(super) fn load(
    store: &Store,
    session: &str,
    parent: &str,
    result: &AgentResult,
) -> Result<Vec<Value>, EngineError> {
    let expected = result
        .continuation_artifact
        .as_ref()
        .ok_or_else(|| error("turn-limit operation has no continuation checkpoint"))?;
    let attached = store.operation_artifacts(parent)?;
    if attached.get(NAME) != Some(expected) {
        return Err(error("checkpoint attachment mismatch"));
    }
    let checkpoint: Checkpoint = serde_json::from_slice(&store.artifact(expected)?)?;
    if checkpoint.parent_operation != parent
        || checkpoint.session_id != session
        || checkpoint.next_turn != result.turns
    {
        return Err(error("checkpoint parent/session/turn mismatch"));
    }
    validate(store, &checkpoint)?;
    Ok(checkpoint.input)
}
