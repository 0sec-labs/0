//! Immutable full history and hash-bound deterministic request projections.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zero_context::{ContextState, ProjectionReceipt};
use zero_protocol::{
    Operation, agent::AgentRequest, context::ContextPolicy, model::ResponsesRequest,
};

pub(super) struct History {
    pub input: Vec<Value>,
    pub state: Option<ContextState>,
}
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn digest(value: &impl Serialize) -> Result<String, EngineError> {
    Ok(format!(
        "sha256:{}",
        zero_plugin::sha256(&serde_json::to_vec(value)?)
    ))
}
impl History {
    pub fn new(input: Vec<Value>, policy: Option<&ContextPolicy>) -> Result<Self, EngineError> {
        let state = policy
            .map(|_| ContextState::protected(input.clone()).map_err(error))
            .transpose()?;
        Ok(Self { input, state })
    }
    pub fn append_user(&mut self, prompt: &str) -> Result<(), EngineError> {
        if let Some(state) = &mut self.state {
            state.append_user(prompt).map_err(error)?;
        }
        self.input
            .push(serde_json::json!({"role":"user","content":prompt}));
        Ok(())
    }
    pub fn projected(&self, policy: Option<&ContextPolicy>) -> Result<Vec<Value>, EngineError> {
        project_input(&self.input, self.state.as_ref(), policy)
    }
}
pub(super) fn project_input(
    input: &[Value],
    state: Option<&ContextState>,
    policy: Option<&ContextPolicy>,
) -> Result<Vec<Value>, EngineError> {
    match (state, policy) {
        (None, None) => Ok(input.to_vec()),
        (Some(state), Some(policy)) => {
            if state.input() != input {
                return Err(error("full context differs from retained spans"));
            }
            Ok(zero_context::project(state, policy).map_err(error)?.input)
        }
        _ => Err(error("context policy/state mismatch")),
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    state_sha256: String,
    receipt_sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema_version: u32,
    session_id: String,
    parent_operation: String,
    parent_payload_sha256: String,
    turn: u32,
    request_sha256: String,
    projection: ProjectionReceipt,
}
/// Both artifacts must be durable before admitting a child or reserving usage.
pub(super) fn retain(
    shared: &Shared,
    parent: &str,
    turn: u32,
    state: &ContextState,
    policy: &ContextPolicy,
    model: &ResponsesRequest,
) -> Result<Value, EngineError> {
    let state_bytes = state.to_bytes().map_err(error)?;
    let projected = zero_context::project(state, policy).map_err(error)?;
    if projected.input != model.input {
        return Err(error("context projection/request mismatch"));
    }
    let mut store = lock(&shared.store)?;
    let operation = store.get_operation(parent)?;
    let receipt = Receipt {
        schema_version: 1,
        session_id: operation.session_id,
        parent_operation: parent.into(),
        parent_payload_sha256: digest(&operation.payload)?,
        turn,
        request_sha256: digest(model)?,
        projection: projected.receipt,
    };
    let receipt_bytes = serde_json::to_vec(&receipt)?;
    if state_bytes.len() > zero_context::MAX_STATE_BYTES
        || receipt_bytes.len() > zero_context::MAX_STATE_BYTES
    {
        return Err(error("context artifact exceeds 8 MiB"));
    }
    let state_sha256 = store.retain_operation_artifact(
        parent,
        &shared.owner,
        &format!("context.state.{turn}"),
        &state_bytes,
    )?;
    let receipt_sha256 = store.retain_operation_artifact(
        parent,
        &shared.owner,
        &format!("context.receipt.{turn}"),
        &receipt_bytes,
    )?;
    Ok(serde_json::to_value(Binding {
        state_sha256,
        receipt_sha256,
    })?)
}
/// Restore full input, never treating an already-projected request as full history.
pub(super) fn load(
    store: &Store,
    parent: &Operation,
    child: &Operation,
    model: &ResponsesRequest,
) -> Result<Option<ContextState>, EngineError> {
    let request: AgentRequest = serde_json::from_value(parent.payload["request"].clone())?;
    let Some(policy) = request.context_policy.as_ref() else {
        if child.payload.get("context").is_some()
            || parent.payload.get("context_template").is_some()
        {
            return Err(error("context metadata without explicit policy"));
        }
        return Ok(None);
    };
    policy.validate().map_err(error)?;
    let binding: Binding = serde_json::from_value(
        child
            .payload
            .get("context")
            .cloned()
            .ok_or_else(|| error("missing context binding"))?,
    )?;
    if child.session_id != parent.session_id
        || child.payload["parent_operation"] != parent.id
        || child.payload["kind"] != "agent_inference"
    {
        return Err(error("context inference parent mismatch"));
    }
    let prefix = format!("{}:model:", parent.id);
    let turn = child
        .command_id
        .strip_prefix(&prefix)
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|v| *v < 32)
        .ok_or_else(|| error("context inference turn mismatch"))?;
    let attached = store.operation_artifacts(&parent.id)?;
    if attached.get(&format!("context.state.{turn}")) != Some(&binding.state_sha256)
        || attached.get(&format!("context.receipt.{turn}")) != Some(&binding.receipt_sha256)
    {
        return Err(error("context attachment mismatch"));
    }
    let state = ContextState::from_bytes(&store.artifact(&binding.state_sha256)?).map_err(error)?;
    let receipt: Receipt = serde_json::from_slice(&store.artifact(&binding.receipt_sha256)?)?;
    if receipt.schema_version != 1
        || receipt.session_id != parent.session_id
        || receipt.parent_operation != parent.id
        || receipt.parent_payload_sha256 != digest(&parent.payload)?
        || receipt.turn != turn
        || receipt.request_sha256 != digest(model)?
    {
        return Err(error("context receipt authority mismatch"));
    }
    zero_context::validate_receipt(&state, policy, &receipt.projection).map_err(error)?;
    if zero_context::project(&state, policy).map_err(error)?.input != model.input {
        return Err(error("context projected input mismatch"));
    }
    let mut template: ResponsesRequest =
        serde_json::from_value(parent.payload["context_template"].clone())?;
    if !template.input.is_empty()
        || template.model != request.model
        || template.instructions != request.instructions
        || template.max_output_tokens != 8192
    {
        return Err(error("context request template authority mismatch"));
    }
    template.input = model.input.clone();
    if serde_json::to_value(&template)? != serde_json::to_value(model)? {
        return Err(error("context request differs from fixed template"));
    }
    agent_context_history::validate(store, parent, child, &state, turn)?;
    Ok(Some(state))
}
