//! Validate carried operator inputs against their durable inference bindings.
//! No-context histories still need a full witness: checking only the last suffix
//! would allow an earlier captured message to disappear on continuation.
use super::*;
use std::collections::{HashMap, HashSet};
use zero_protocol::{
    agent::{AgentRequest, AgentResult, AgentStatus},
    model::{Completion, CompletionStatus, Content},
};

const MAX_BYTES: usize = 64 * 1024 * 1024;
struct Journal<'a> {
    store: &'a Store,
    operations: HashMap<String, Operation>,
    bytes: usize,
}
impl Journal<'_> {
    fn charge(&mut self, bytes: usize) -> Result<(), EngineError> {
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .filter(|n| *n <= MAX_BYTES)
            .ok_or_else(|| error("steering history exceeds journal read budget"))?;
        Ok(())
    }
    fn get(&mut self, id: &str) -> Result<Operation, EngineError> {
        if let Some(op) = self.operations.get(id) {
            return Ok(op.clone());
        }
        let op = self.store.get_operation(id)?;
        self.charge(serde_json::to_vec(&op)?.len())?;
        self.operations.insert(op.id.clone(), op.clone());
        Ok(op)
    }
    fn model(&mut self, parent: &Operation, turn: u32) -> Result<Operation, EngineError> {
        let op = self
            .store
            .get_operation_by_command(&parent.session_id, &format!("{}:model:{turn}", parent.id))?;
        let op = self.get(&op.id)?;
        if op.session_id != parent.session_id
            || op.payload["parent_operation"] != parent.id
            || op.payload["kind"] != "agent_inference"
        {
            return Err(error("steering inference ancestry mismatch"));
        }
        Ok(op)
    }
}
fn authority(request: &AgentRequest) -> Result<Value, EngineError> {
    Ok(
        serde_json::json!({"provider":request.provider,"model":request.model,
        "instructions":request.instructions,"execution":request.execution.sandbox_request(),
        "source_review_operation_id":request.source_review_operation_id,
        "source_snapshot_tools":request.source_snapshot_tools,
        "source_submission_max_hypotheses":request.source_submission_max_hypotheses,
        "plugin_tools":request.plugin_tools,"delegation_policy":request.delegation_policy,
        "operator_questions":request.operator_questions,
        "context_policy":request.context_policy}),
    )
}
fn checkpoint(
    journal: &mut Journal<'_>,
    parent: &Operation,
    origin: &Operation,
    turn: u32,
) -> Result<Vec<Value>, EngineError> {
    let result: AgentResult = serde_json::from_value(
        parent
            .outcome
            .clone()
            .ok_or_else(|| error("steering ancestor outcome missing"))?,
    )?;
    if parent.status != OperationStatus::Failed
        || result.status != AgentStatus::TurnLimit
        || result.turns != turn + 1
    {
        return Err(error(
            "steering final tool round requires completed checkpoint",
        ));
    }
    let digest = result
        .continuation_artifact
        .ok_or_else(|| error("steering checkpoint absent"))?;
    if journal
        .store
        .operation_artifacts(&parent.id)?
        .get("agent.continuation")
        != Some(&digest)
    {
        return Err(error("steering checkpoint attachment differs"));
    }
    let bytes = journal.store.artifact(&digest)?;
    journal.charge(bytes.len())?;
    let value: Value = serde_json::from_slice(&bytes)?;
    if value["version"] != 1
        || value["session_id"] != parent.session_id
        || value["parent_operation"] != parent.id
        || value["next_turn"] != turn + 1
        || value["last_inference"] != origin.id
        || value["parent_payload_sha256"] != digest_value(&parent.payload)?
        || value["last_completion_sha256"]
            != digest_value(
                origin
                    .outcome
                    .as_ref()
                    .ok_or_else(|| error("steering completion absent"))?,
            )?
    {
        return Err(error("steering checkpoint identity differs"));
    }
    Ok(serde_json::from_value(value["input"].clone())?)
}
fn digest_value(value: &Value) -> Result<String, EngineError> {
    digest(value)
}

pub(super) fn validate(
    store: &Store,
    parent: &Operation,
    current: &Operation,
    model: &ResponsesRequest,
) -> Result<(), EngineError> {
    let turn = current
        .command_id
        .strip_prefix(&format!("{}:model:", parent.id))
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n < 32)
        .ok_or_else(|| error("steering model turn is invalid"))?;
    let mut journal = Journal {
        store,
        operations: HashMap::new(),
        bytes: 0,
    };
    let request: AgentRequest = serde_json::from_value(parent.payload["request"].clone())?;
    let required = authority(&request)?;
    let mut lineage = Vec::new();
    let mut visited = HashSet::new();
    let mut ancestor = journal.get(&parent.id)?;
    let mut last = turn;
    loop {
        if !visited.insert(ancestor.id.clone())
            || visited.len() > zero_context::MAX_INPUT_ITEMS
            || ancestor.session_id != parent.session_id
            || ancestor.payload["kind"] != "offline_snapshot_agent"
        {
            return Err(error("steering history ancestry differs or exceeds bound"));
        }
        let req: AgentRequest = serde_json::from_value(ancestor.payload["request"].clone())?;
        if authority(&req)? != required
            || req.context_policy.is_some()
            || [
                "endpoint",
                "rates",
                "hosted_catalog",
                "plugin_context",
                "delegation_context",
            ]
            .iter()
            .any(|key| ancestor.payload.get(key) != parent.payload.get(key))
            || ancestor
                .payload
                .get("wire_api")
                .cloned()
                .unwrap_or(serde_json::json!("responses"))
                != parent
                    .payload
                    .get("wire_api")
                    .cloned()
                    .unwrap_or(serde_json::json!("responses"))
        {
            return Err(error("steering ancestor authority differs"));
        }
        let previous = req.continuation_of.clone();
        lineage.push((ancestor, req, last));
        let Some(previous) = previous else {
            break;
        };
        ancestor = journal.get(&previous)?;
        if ancestor.payload.get("parent_operation").is_some() {
            return Err(error(
                "delegated operation cannot be a conversation ancestor",
            ));
        }
        let result: AgentResult = serde_json::from_value(
            ancestor
                .outcome
                .clone()
                .ok_or_else(|| error("steering ancestor has no outcome"))?,
        )?;
        if !(1..=32).contains(&result.turns)
            || result.source_review.is_some()
            || result.source_recovery_path.is_some()
            || !((ancestor.status == OperationStatus::Succeeded
                && result.status == AgentStatus::Completed)
                || (ancestor.status == OperationStatus::Failed
                    && result.status == AgentStatus::TurnLimit))
        {
            return Err(error("steering ancestor lacks a completed boundary"));
        }
        last = result.turns - 1;
    }
    let mut expected = Vec::new();
    for (ancestor, req, last) in lineage.into_iter().rev() {
        expected.push(serde_json::json!({"role":"user","content":req.prompt}));
        for index in 0..=last {
            let origin = journal.model(&ancestor, index)?;
            let actual: ResponsesRequest =
                serde_json::from_value(origin.payload["request"].clone())?;
            inference::validate_hosted_pair(&ancestor.payload, &origin.payload, &actual)?;
            if actual.model != req.model
                || actual.instructions != req.instructions
                || actual.max_output_tokens != 8192
                || ["endpoint", "rates"]
                    .iter()
                    .any(|key| origin.payload.get(key) != ancestor.payload.get(key))
                || origin
                    .payload
                    .get("wire_api")
                    .cloned()
                    .unwrap_or(serde_json::json!("responses"))
                    != ancestor
                        .payload
                        .get("wire_api")
                        .cloned()
                        .unwrap_or(serde_json::json!("responses"))
            {
                return Err(error("steering inference changed captured authority"));
            }
            expected.extend(agent_steering::captured_input(store, &origin)?);
            if actual.input != expected {
                return Err(error(
                    "steering history changed original prompts, replay or captured inputs",
                ));
            }
            if origin.id == current.id {
                if serde_json::to_value(&actual)? != serde_json::to_value(model)? {
                    return Err(error("steering current request differs"));
                }
                return Ok(());
            }
            if origin.status != OperationStatus::Succeeded {
                return Err(error("steering predecessor inference is not successful"));
            }
            let completion: Completion = serde_json::from_value(
                origin
                    .outcome
                    .clone()
                    .ok_or_else(|| error("steering predecessor completion missing"))?,
            )?;
            if completion.status != CompletionStatus::Completed || completion.error.is_some() {
                return Err(error("steering predecessor completion is incomplete"));
            }
            let calls: Vec<_> = completion
                .content
                .iter()
                .filter_map(|item| match item {
                    Content::ToolCall { id, name, .. } => Some((id, name)),
                    _ => None,
                })
                .collect();
            expected.extend(completion.replay);
            if !calls.is_empty() {
                if calls.len() > 32 {
                    return Err(error("steering predecessor tool round exceeds bound"));
                }
                let recorded = if index < last {
                    let next = journal.model(&ancestor, index + 1)?;
                    let next_model: ResponsesRequest =
                        serde_json::from_value(next.payload["request"].clone())?;
                    agent_steering::strip_captured_input(store, &next, next_model.input)?
                } else {
                    checkpoint(&mut journal, &ancestor, &origin, index)?
                };
                if recorded.len() != expected.len() + calls.len()
                    || recorded[..expected.len()] != expected
                {
                    return Err(error("steering predecessor tool replay differs"));
                }
                for (call_index, ((call, name), output)) in calls
                    .into_iter()
                    .zip(&recorded[expected.len()..])
                    .enumerate()
                {
                    if output.as_object().map(|o| o.len()) != Some(3)
                        || output["type"] != "function_call_output"
                        || output["call_id"] != *call
                        || !output["output"].is_string()
                    {
                        return Err(error("steering predecessor tool result differs"));
                    }
                    if name == "ask_operator" && req.operator_questions {
                        match store.get_operation_by_command(
                            &ancestor.session_id,
                            &format!("{}:tool:{index}:{call_index}", ancestor.id),
                        ) {
                            Ok(question) => {
                                if question.payload["kind"] != "agent_operator_question"
                                    || question.payload["parent_operation"] != ancestor.id
                                    || question.payload["call_id"] != *call
                                    || output["output"]
                                        != agent_questions::validate_receipt(store, &question)?
                                {
                                    return Err(error(
                                        "operator answer history differs from durable decision",
                                    ));
                                }
                            }
                            Err(zero_store::Error::NotFound(_))
                                if output["output"]
                                    .as_str()
                                    .is_some_and(|text| text.starts_with("Tool rejected:")) => {}
                            Err(error) => return Err(error.into()),
                        }
                    }
                }
                expected = recorded;
            }
        }
    }
    Err(error("steering current inference absent from lineage"))
}
