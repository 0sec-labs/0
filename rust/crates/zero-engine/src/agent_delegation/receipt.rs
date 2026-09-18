use super::*;
use zero_protocol::{
    agent::{AgentResult, AgentStatus},
    model::{Completion, CompletionStatus, Content, ResponsesRequest},
};

fn clipped(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].into()
}
/// Reconstruct model-facing data from durable child outcomes, never from a model claim.
pub(crate) fn derive(store: &Store, group: &Operation) -> Result<Value, EngineError> {
    derive_bounded(store, group, &mut 0)
}
fn charge(bytes: &mut usize, value: &impl serde::Serialize) -> Result<(), EngineError> {
    *bytes = bytes.saturating_add(serde_json::to_vec(value)?.len());
    if *bytes > 64 * 1024 * 1024 {
        return Err(error("delegation receipt exceeds journal read budget"));
    }
    Ok(())
}
fn derive_bounded(
    store: &Store,
    group: &Operation,
    bytes: &mut usize,
) -> Result<Value, EngineError> {
    charge(bytes, group)?;
    if group.payload["kind"] != "agent_delegation" {
        return Err(error("not a delegated group"));
    }
    let root = store.get_operation(
        group.payload["parent_operation"]
            .as_str()
            .ok_or_else(|| error("missing delegation parent"))?,
    )?;
    charge(bytes, &root)?;
    if root.session_id != group.session_id
        || root.payload["kind"] != "offline_snapshot_agent"
        || root.payload.get("parent_operation").is_some()
    {
        return Err(error("delegation root identity mismatch"));
    }
    let parent: AgentRequest = serde_json::from_value(root.payload["request"].clone())?;
    let policy = parent
        .delegation_policy
        .as_ref()
        .ok_or_else(|| error("missing delegation authority"))?;
    policy.validate().map_err(error)?;
    if group.payload["delegation_context_sha256"] != hash(&root.payload["delegation_context"])? {
        return Err(error("delegation context identity mismatch"));
    }
    let tasks: Vec<Task> = serde_json::from_value(group.payload["tasks"].clone())?;
    let commands: Vec<String> = serde_json::from_value(group.payload["child_commands"].clone())?;
    if tasks.is_empty()
        || tasks.len() > policy.max_children as usize
        || tasks.len() != commands.len()
    {
        return Err(error("delegation receipt cardinality mismatch"));
    }
    let (turn, index) = group
        .command_id
        .strip_prefix(&format!("{}:tool:", root.id))
        .and_then(|suffix| suffix.split_once(':'))
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<usize>().ok()?)))
        .filter(|(turn, index)| *turn < 32 && *index < 32)
        .ok_or_else(|| error("delegation group command is not a bounded parent tool"))?;
    let inference =
        store.get_operation_by_command(&group.session_id, &format!("{}:model:{turn}", root.id))?;
    charge(bytes, &inference)?;
    if inference.status != OperationStatus::Succeeded
        || inference.payload["parent_operation"] != root.id
        || inference.payload["kind"] != "agent_inference"
    {
        return Err(error("delegation origin inference identity mismatch"));
    }
    let completion: Completion = serde_json::from_value(
        inference
            .outcome
            .ok_or_else(|| error("delegation origin completion absent"))?,
    )?;
    if completion.status != CompletionStatus::Completed || completion.error.is_some() {
        return Err(error("delegation origin completion is not successful"));
    }
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|content| match content {
            Content::ToolCall {
                id,
                name,
                arguments,
            } => Some((id, name, arguments)),
            _ => None,
        })
        .collect();
    let (id, name, args) = calls
        .get(index)
        .ok_or_else(|| error("delegation origin call absent"))?;
    if *name != "delegate_tasks" || group.payload["call_id"] != **id {
        return Err(error("delegation origin call differs"));
    }
    let original: Arguments = serde_json::from_value((*args).clone())?;
    if serde_json::to_value(original.tasks)? != serde_json::to_value(&tasks)? {
        return Err(error("delegation tasks differ from original provider call"));
    }
    let mut children = vec![];
    for (index, (task, command)) in tasks.iter().zip(&commands).enumerate() {
        if command != &format!("{}:agent:{index}", group.command_id) {
            return Err(error("delegation child command mismatch"));
        }
        let child = store.get_operation_by_command(&group.session_id, command)?;
        charge(bytes, &child)?;
        if child.session_id != group.session_id
            || child.payload["parent_operation"] != root.id
            || child.payload["kind"] != "offline_snapshot_agent"
            || child.payload["delegation_group_command"] != group.command_id
            || child.payload["delegation_index"] != index
            || child.payload["delegation_role"] != task.role
            || matches!(
                child.status,
                OperationStatus::Admitted | OperationStatus::Running
            )
        {
            return Err(error("delegation child identity or settlement mismatch"));
        }
        let role = policy
            .roles
            .iter()
            .find(|r| r.name == task.role)
            .ok_or_else(|| error("delegation role absent from host policy"))?;
        if child.payload["request"]
            != serde_json::to_value(child_request(&parent, role, &task.prompt))?
        {
            return Err(error("delegated request authority differs"));
        }
        let identity = root.payload["delegation_context"]["roles"]
            .as_array()
            .and_then(|roles| roles.iter().find(|entry| entry["name"] == task.role))
            .ok_or_else(|| error("delegation role receipt absent"))?;
        if child.payload["delegation_template"] != identity["template"]
            || [
                "endpoint",
                "rates",
                "wire_api",
                "hosted_catalog",
                "plugin_context",
            ]
            .iter()
            .any(|key| child.payload.get(key) != identity.get(key))
        {
            return Err(error("delegated provider/template identity mismatch"));
        }
        let outcome = child
            .outcome
            .as_ref()
            .ok_or_else(|| error("delegated child outcome missing"))?;
        let result = serde_json::from_value::<AgentResult>(outcome.clone()).ok();
        if (child.status == OperationStatus::Succeeded
            && result
                .as_ref()
                .is_none_or(|r| r.status != AgentStatus::Completed))
            || (group.status == OperationStatus::Succeeded
                && matches!(
                    child.status,
                    OperationStatus::Unknown | OperationStatus::Cancelled
                ))
        {
            return Err(error("delegated receipt contradicts child status"));
        }
        let text = result.as_ref().map_or("", |r| r.text.as_str());
        let displayed = clipped(text, 16384);
        let message = result
            .as_ref()
            .and_then(|r| r.error.as_deref())
            .or_else(|| outcome["error"].as_str());
        children.push(json!({"operation_id":child.id,"payload_sha256":hash(&child.payload)?,"outcome_sha256":hash(outcome)?,"status":child.status,"agent_status":result.as_ref().map(|r|&r.status),"text":displayed,"truncated":displayed.len()!=text.len(),"error":message.map(|m|clipped(m,4096))}));
    }
    let value = json!({"version":1,"untrusted":true,"children":children});
    if serde_json::to_vec(&value)?.len() > 512 * 1024 {
        return Err(error("delegation result exceeds bound"));
    }
    Ok(value)
}
/// Exact tool-output witness used by continuation and checkpoint validation.
pub(crate) fn validate_receipt(store: &Store, group: &Operation) -> Result<String, EngineError> {
    validate_bounded(store, group, &mut 0)
}
fn validate_bounded(
    store: &Store,
    group: &Operation,
    bytes: &mut usize,
) -> Result<String, EngineError> {
    if group.status != OperationStatus::Succeeded {
        return Err(error("delegation group did not settle completely"));
    }
    let expected = derive_bounded(store, group, bytes)?;
    if group.outcome.as_ref() != Some(&expected) {
        return Err(error("delegation group receipt changed"));
    }
    let bytes = serde_json::to_vec(&expected)?;
    let attached = store.operation_artifacts(&group.id)?;
    let digest = attached
        .get("delegation.result")
        .ok_or_else(|| error("delegation result artifact absent"))?;
    if store.artifact(digest)? != bytes {
        return Err(error("delegation result artifact mismatch"));
    }
    Ok(serde_json::to_string(&expected)?)
}

/// Completed parents without a context policy still bind every delegated replay
/// to its original completion and immediate next provider request.
pub(crate) fn validate_parent_receipts(
    store: &Store,
    parent: &Operation,
    turns: u32,
) -> Result<(), EngineError> {
    if parent.payload["request"].get("delegation_policy").is_none() {
        return Ok(());
    }
    let mut ancestor = parent.clone();
    let mut count = turns;
    let mut bytes = 0usize;
    let mut visited = std::collections::BTreeSet::new();
    loop {
        if !visited.insert(ancestor.id.clone())
            || visited.len() > 32
            || ancestor.session_id != parent.session_id
            || ancestor.payload["kind"] != "offline_snapshot_agent"
            || ancestor.payload.get("parent_operation").is_some()
            || ancestor.payload.get("delegation_context")
                != parent.payload.get("delegation_context")
            || ancestor.payload["request"]["delegation_policy"]
                != parent.payload["request"]["delegation_policy"]
        {
            return Err(error(
                "delegation continuation lineage differs or exceeds bound",
            ));
        }
        charge(&mut bytes, &ancestor)?;
        validate_actor_receipts(store, &ancestor, count, &mut bytes)?;
        let Some(previous) = ancestor.payload["request"]["continuation_of"].as_str() else {
            break;
        };
        ancestor = store.get_operation(previous)?;
        let result: AgentResult = serde_json::from_value(
            ancestor
                .outcome
                .clone()
                .ok_or_else(|| error("delegation ancestor outcome missing"))?,
        )?;
        if !((ancestor.status == OperationStatus::Succeeded
            && result.status == AgentStatus::Completed)
            || (ancestor.status == OperationStatus::Failed
                && result.status == AgentStatus::TurnLimit))
        {
            return Err(error("delegation ancestor not at a completed boundary"));
        }
        count = result.turns;
    }
    Ok(())
}
fn validate_actor_receipts(
    store: &Store,
    parent: &Operation,
    turns: u32,
    bytes: &mut usize,
) -> Result<(), EngineError> {
    if turns > 32 {
        return Err(error("delegation parent turn bound exceeded"));
    }
    for turn in 0..turns {
        let origin = store
            .get_operation_by_command(&parent.session_id, &format!("{}:model:{turn}", parent.id))?;
        charge(bytes, &origin)?;
        if origin.status != OperationStatus::Succeeded
            || origin.payload["parent_operation"] != parent.id
            || origin.payload["kind"] != "agent_inference"
        {
            return Err(error("delegation parent inference correlation differs"));
        }
        let completion: Completion = serde_json::from_value(
            origin
                .outcome
                .clone()
                .ok_or_else(|| error("delegation parent completion missing"))?,
        )?;
        if completion.status != CompletionStatus::Completed || completion.error.is_some() {
            return Err(error("delegation parent completion is not successful"));
        }
        let calls: Vec<_> = completion
            .content
            .iter()
            .filter_map(|c| match c {
                Content::ToolCall { id, name, .. } => Some((id, name)),
                _ => None,
            })
            .collect();
        if !calls.iter().any(|(_, name)| *name == "delegate_tasks") {
            continue;
        }
        let input = if turn + 1 == turns {
            let result: AgentResult = serde_json::from_value(
                parent
                    .outcome
                    .clone()
                    .ok_or_else(|| error("delegation checkpoint result missing"))?,
            )?;
            if parent.status != OperationStatus::Failed || result.status != AgentStatus::TurnLimit {
                return Err(error("delegated final tool round lacks checkpoint"));
            }
            let digest = result
                .continuation_artifact
                .ok_or_else(|| error("delegation checkpoint missing"))?;
            if store
                .operation_artifacts(&parent.id)?
                .get("agent.continuation")
                != Some(&digest)
            {
                return Err(error("delegation checkpoint identity differs"));
            }
            let checkpoint: Value = serde_json::from_slice(&store.artifact(&digest)?)?;
            charge(bytes, &checkpoint)?;
            if checkpoint["version"] != 1
                || checkpoint["session_id"] != parent.session_id
                || checkpoint["parent_operation"] != parent.id
                || checkpoint["next_turn"] != turns
                || checkpoint["last_inference"] != origin.id
                || checkpoint["parent_payload_sha256"] != hash(&parent.payload)?
                || checkpoint["last_completion_sha256"]
                    != hash(
                        &origin
                            .outcome
                            .as_ref()
                            .ok_or_else(|| error("missing completion"))?,
                    )?
            {
                return Err(error("delegation checkpoint authority differs"));
            }
            serde_json::from_value::<Vec<Value>>(checkpoint["input"].clone())?
        } else {
            let next = store.get_operation_by_command(
                &parent.session_id,
                &format!("{}:model:{}", parent.id, turn + 1),
            )?;
            charge(bytes, &next)?;
            if next.payload["parent_operation"] != parent.id
                || next.payload["kind"] != "agent_inference"
            {
                return Err(error("delegation next request correlation differs"));
            }
            let model: ResponsesRequest = serde_json::from_value(next.payload["request"].clone())?;
            agent_steering::strip_captured_input(store, &next, model.input)?
        };
        let start = input
            .len()
            .checked_sub(calls.len() + completion.replay.len())
            .ok_or_else(|| error("delegation replay omitted"))?;
        if input[start..start + completion.replay.len()] != completion.replay {
            return Err(error("delegation replay changed"));
        }
        let outputs = &input[start + completion.replay.len()..];
        for (index, ((id, name), output)) in calls.iter().zip(outputs).enumerate() {
            if *name != "delegate_tasks" {
                continue;
            }
            if output["type"] != "function_call_output" || output["call_id"] != **id {
                return Err(error("delegation output correlation differs"));
            }
            match store.get_operation_by_command(
                &parent.session_id,
                &format!("{}:tool:{turn}:{index}", parent.id),
            ) {
                Ok(group) => {
                    if output["output"] != validate_bounded(store, &group, bytes)? {
                        return Err(error("delegation tool output differs from durable receipt"));
                    }
                }
                Err(zero_store::Error::NotFound(_))
                    if output["output"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("Tool rejected:")) => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(())
}
