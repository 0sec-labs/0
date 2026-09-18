//! Bounded journal witnesses for the full (including omitted) context history.
use super::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use zero_context::ContextState;
use zero_protocol::{
    Operation,
    agent::{AgentRequest, AgentResult, AgentStatus},
    model::{Completion, ResponsesRequest},
};
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn hash(value: &impl serde::Serialize) -> Result<String, EngineError> {
    Ok(format!(
        "sha256:{}",
        zero_plugin::sha256(&serde_json::to_vec(value)?)
    ))
}
fn ends_with_round(input: &[Value], replay: &[Value], outputs: &[Value]) -> bool {
    let count = replay.len() + outputs.len();
    count > 0
        && input.len() >= count
        && input[input.len() - count..input.len() - outputs.len()] == *replay
        && input[input.len() - outputs.len()..] == *outputs
}
const MAX_JOURNAL_BYTES: usize = 64 * 1024 * 1024;
struct Journal<'a> {
    store: &'a Store,
    operations: std::collections::HashMap<String, Operation>,
    commands: std::collections::HashMap<(String, String), String>,
    bytes: usize,
}
impl<'a> Journal<'a> {
    fn bytes(&mut self, bytes: usize) -> Result<(), EngineError> {
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .filter(|n| *n <= MAX_JOURNAL_BYTES)
            .ok_or_else(|| error("context journal validation exceeds 64 MiB"))?;
        Ok(())
    }
    fn record(&mut self, operation: Operation) -> Result<Operation, EngineError> {
        if let Some(existing) = self.operations.get(&operation.id) {
            return Ok(existing.clone());
        }
        self.bytes(serde_json::to_vec(&operation)?.len())?;
        self.commands.insert(
            (operation.session_id.clone(), operation.command_id.clone()),
            operation.id.clone(),
        );
        self.operations
            .insert(operation.id.clone(), operation.clone());
        Ok(operation)
    }
    fn get(&mut self, id: &str) -> Result<Operation, EngineError> {
        if let Some(existing) = self.operations.get(id) {
            return Ok(existing.clone());
        }
        self.record(self.store.get_operation(id)?)
    }
    fn command(&mut self, session: &str, command: &str) -> Result<Option<Operation>, EngineError> {
        if let Some(id) = self
            .commands
            .get(&(session.into(), command.into()))
            .cloned()
        {
            return self.get(&id).map(Some);
        }
        match self.store.get_operation_by_command(session, command) {
            Ok(op) => self.record(op).map(Some),
            Err(zero_store::Error::NotFound(_)) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}
pub(super) fn validate(
    store: &Store,
    parent: &Operation,
    current: &Operation,
    state: &ContextState,
    turn: u32,
) -> Result<(), EngineError> {
    let mut journal = Journal {
        store,
        operations: Default::default(),
        commands: Default::default(),
        bytes: 0,
    };
    journal.record(parent.clone())?;
    journal.record(current.clone())?;
    let request: AgentRequest = serde_json::from_value(parent.payload["request"].clone())?;
    let policy = request
        .context_policy
        .as_ref()
        .ok_or_else(|| error("context lineage requires policy"))?;
    let mut lineage = Vec::new();
    let mut visited = BTreeSet::new();
    let mut op = parent.clone();
    let mut count = turn;
    let mut total = 0usize;
    loop {
        if !visited.insert(op.id.clone())
            || visited.len() > zero_context::MAX_INPUT_ITEMS
            || op.session_id != parent.session_id
            || zero_protocol::agent::validate_actor_payload(&op.payload).is_err()
            || op.payload.get("parent_operation").is_some()
        {
            return Err(error("invalid bounded context lineage"));
        }
        let req: AgentRequest = serde_json::from_value(op.payload["request"].clone())?;
        if req.context_policy.as_ref() != Some(policy) || count > 32 {
            return Err(error("context lineage policy/round mismatch"));
        }
        if req.web_submission_max_hypotheses != request.web_submission_max_hypotheses
            || req.http_profile != request.http_profile
            || req.tool_approval_policy != request.tool_approval_policy
            || req.operator_questions != request.operator_questions
            || req.provider != request.provider
            || req.delegation_policy != request.delegation_policy
            || req.model != request.model
            || req.instructions != request.instructions
            || req.source_review_operation_id != request.source_review_operation_id
            || req.source_snapshot_tools != request.source_snapshot_tools
            || req.source_submission_max_hypotheses != request.source_submission_max_hypotheses
            || req.plugin_tools != request.plugin_tools
            || serde_json::to_value(req.execution_identity())?
                != serde_json::to_value(request.execution_identity())?
            || [
                "endpoint",
                "rates",
                "hosted_catalog",
                "plugin_context",
                "context_template",
                "delegation_context",
                "http_context",
                "http_output_version",
            ]
            .iter()
            .any(|key| op.payload.get(key) != parent.payload.get(key))
            || op
                .payload
                .get("wire_api")
                .cloned()
                .unwrap_or(json!("responses"))
                != parent
                    .payload
                    .get("wire_api")
                    .cloned()
                    .unwrap_or(json!("responses"))
        {
            return Err(error("context ancestor changed captured agent authority"));
        }
        total = total
            .checked_add(count as usize)
            .ok_or_else(|| error("context lineage overflow"))?;
        if total > zero_context::MAX_INPUT_ITEMS {
            return Err(error("context lineage exceeds round bound"));
        }
        let previous = req.continuation_of.clone();
        lineage.push((op, req, count));
        let Some(previous) = previous else {
            break;
        };
        op = journal.get(&previous)?;
        let result: AgentResult = serde_json::from_value(
            op.outcome
                .clone()
                .ok_or_else(|| error("context ancestor outcome missing"))?,
        )?;
        if result.turns == 0
            || result.error.is_some()
            || result.source_recovery_path.is_some()
            || result.source_review.is_some()
            || !((op.status == OperationStatus::Succeeded
                && result.status == AgentStatus::Completed)
                || (op.status == OperationStatus::Failed
                    && result.status == AgentStatus::TurnLimit))
        {
            return Err(error(
                "context ancestor is not a completed conversation boundary",
            ));
        }
        count = result.turns;
    }
    let mut witnesses = state.round_witnesses();
    let mut expected = Vec::new();
    for (ancestor, request, count) in lineage.into_iter().rev() {
        expected.push(json!({"role":"user","content":request.prompt}));
        for index in 0..count {
            let origin = journal
                .command(
                    &parent.session_id,
                    &format!("{}:model:{index}", ancestor.id),
                )?
                .ok_or_else(|| error("original context model operation missing"))?;
            expected.extend(agent_steering::captured_input(store, &origin)?);
            let witness = witnesses
                .next()
                .ok_or_else(|| error("context omitted an original completed round"))?;
            if witness.input_start != expected.len()
                || witness.inference_operation_id != origin.id
                || origin.session_id != parent.session_id
                || origin.payload["parent_operation"] != ancestor.id
                || origin.payload["kind"] != "agent_inference"
                || origin.status != OperationStatus::Succeeded
            {
                return Err(error("context round lineage/order mismatch"));
            }
            let completion: Completion = serde_json::from_value(
                origin
                    .outcome
                    .clone()
                    .ok_or_else(|| error("context round completion missing"))?,
            )?;
            let origin_request: ResponsesRequest =
                serde_json::from_value(origin.payload["request"].clone())?;
            inference::validate_hosted_pair(&ancestor.payload, &origin.payload, &origin_request)?;
            if completion.status != zero_protocol::model::CompletionStatus::Completed
                || completion.error.is_some()
            {
                return Err(error(
                    "context succeeded inference has contradictory completion",
                ));
            }
            if witness.replay != completion.replay {
                return Err(error("context replay differs from original completion"));
            }
            for (call_index, call) in completion
                .content
                .iter()
                .filter_map(|item| {
                    if let zero_protocol::model::Content::ToolCall { id, name, .. } = item {
                        Some((id, name))
                    } else {
                        None
                    }
                })
                .enumerate()
            {
                let question = call.1 == "ask_operator" && request.operator_questions;
                let approved = request.tool_approval_policy.as_ref().is_some_and(|policy| {
                    policy.require_approval.iter().any(|alias| alias == call.1)
                });
                let delegation = call.1 == "delegate_tasks" && request.delegation_policy.is_some();
                let http = call.1 == "http_request" && request.http_profile.is_some();
                if !delegation && !question && !approved && !http {
                    continue;
                }
                let output = witness
                    .tool_outputs
                    .get(call_index)
                    .ok_or_else(|| error("context receipted tool output missing"))?;
                if output["call_id"] != *call.0 {
                    return Err(error("context receipted tool output correlation mismatch"));
                }
                match journal.command(
                    &parent.session_id,
                    &format!("{}:tool:{index}:{call_index}", ancestor.id),
                )? {
                    Some(group) => {
                        let expected_kind = if approved {
                            "agent_approved_tool"
                        } else if question {
                            "agent_operator_question"
                        } else if http {
                            "agent_http"
                        } else {
                            "agent_delegation"
                        };
                        if group.payload["kind"] != expected_kind
                            || group.payload["parent_operation"] != ancestor.id
                            || group.payload["call_id"] != *call.0
                        {
                            return Err(error("context receipted tool identity mismatch"));
                        }
                        let derived = if approved {
                            agent_approvals::validate_receipt(store, &group)?
                        } else if question {
                            agent_questions::validate_receipt(store, &group)?
                        } else if http {
                            agent_http::validate_receipt(store, &group)?
                        } else {
                            agent_delegation::validate_receipt(store, &group)?
                        };
                        if output["output"].as_str() != Some(derived.as_str()) {
                            return Err(error(
                                "context receipted tool output differs from child receipts",
                            ));
                        }
                    }
                    None => {
                        if !output["output"]
                            .as_str()
                            .is_some_and(|s| s.starts_with("Tool rejected:"))
                        {
                            return Err(error("context receipted tool output lacks settled group"));
                        }
                    }
                }
            }
            if !witness.tool_outputs.is_empty() {
                // The immediate next request must retain this entire most-recent round.
                // Reading that original request is an anchor, not recursive context loading.
                let next_command = format!("{}:model:{}", ancestor.id, index + 1);
                let next = journal.command(&parent.session_id, &next_command)?;
                let recorded = match next {
                    Some(next) => {
                        if next.session_id != parent.session_id
                            || next.payload["parent_operation"] != ancestor.id
                            || next.payload["kind"] != "agent_inference"
                        {
                            return Err(error("context next-request witness mismatch"));
                        }
                        let model: ResponsesRequest =
                            serde_json::from_value(next.payload["request"].clone())?;
                        agent_steering::strip_captured_input(store, &next, model.input)?
                    }
                    None => {
                        let result: AgentResult =
                            serde_json::from_value(ancestor.outcome.clone().ok_or_else(|| {
                                error("context tool round has no next request/checkpoint")
                            })?)?;
                        if ancestor.status != OperationStatus::Failed
                            || result.status != AgentStatus::TurnLimit
                            || result.turns != index + 1
                        {
                            return Err(error("context tool round lacks terminal checkpoint"));
                        }
                        let digest = result
                            .continuation_artifact
                            .ok_or_else(|| error("context checkpoint missing"))?;
                        if store
                            .operation_artifacts(&ancestor.id)?
                            .get("agent.continuation")
                            != Some(&digest)
                        {
                            return Err(error("context checkpoint attachment mismatch"));
                        }
                        let bytes = store.artifact(&digest)?;
                        journal.bytes(bytes.len())?;
                        let checkpoint: Value = serde_json::from_slice(&bytes)?;
                        if checkpoint["version"] != 1
                            || checkpoint["session_id"] != parent.session_id
                            || checkpoint["parent_operation"] != ancestor.id
                            || checkpoint["next_turn"] != index + 1
                            || checkpoint["last_inference"] != origin.id
                            || checkpoint["parent_payload_sha256"] != hash(&ancestor.payload)?
                            || checkpoint["last_completion_sha256"]
                                != hash(
                                    &origin
                                        .outcome
                                        .as_ref()
                                        .ok_or_else(|| error("missing round completion"))?,
                                )?
                        {
                            return Err(error("context checkpoint witness mismatch"));
                        }
                        serde_json::from_value::<Vec<Value>>(checkpoint["input"].clone())?
                    }
                };
                if !ends_with_round(&recorded, witness.replay, witness.tool_outputs) {
                    return Err(error(
                        "context tool outputs differ from original next request/checkpoint",
                    ));
                }
            }
            expected.extend_from_slice(witness.replay);
            expected.extend_from_slice(witness.tool_outputs);
        }
    }
    expected.extend(agent_steering::captured_input(store, current)?);
    if witnesses.next().is_some() || expected != state.input() {
        return Err(error(
            "context full history differs from original prompts/rounds",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_replay_cannot_witness_an_earlier_round_output() {
        // Providers may reuse a call ID and byte-identical replay in later rounds.
        // Only the final completed round anchors the immediate next model input
        // (and likewise the terminal checkpoint), never an earlier occurrence.
        let replay = vec![
            json!({"type":"function_call", "call_id":"reused", "name":"execute_snapshot", "arguments":"{}"}),
        ];
        let earlier =
            vec![json!({"type":"function_call_output", "call_id":"reused", "output":"old result"})];
        let latest =
            vec![json!({"type":"function_call_output", "call_id":"reused", "output":"new result"})];
        let mut input = vec![json!({"role":"user", "content":"host prompt"})];
        input.extend(replay.clone());
        input.extend(earlier.clone());
        input.extend(replay.clone());
        input.extend(latest.clone());
        assert!(ends_with_round(&input, &replay, &latest));
        assert!(!ends_with_round(&input, &replay, &earlier));
        assert!(!ends_with_round(&[], &replay, &latest));
        assert!(!ends_with_round(&input, &[], &[]));
    }
}
