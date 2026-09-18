use super::*;
use zero_protocol::{
    agent::AgentRequest,
    model::{Completion, CompletionStatus, Content, ResponsesRequest},
};

/// Validate the model's exact offered call and the separately committed operator
/// decision before reconstructing ordinary, untrusted tool-result data.
pub(crate) fn validate_receipt(store: &Store, tool: &Operation) -> Result<String, EngineError> {
    if tool.payload["kind"] != "agent_operator_question"
        || tool.status != OperationStatus::Succeeded
    {
        return Err(error("operator question receipt is not settled"));
    }
    let record = store.get_operator_question(&tool.session_id, &tool.id)?;
    let actor = store.get_operation(&record.actor_operation_id)?;
    let request: AgentRequest = serde_json::from_value(actor.payload["request"].clone())?;
    if !request.operator_questions
        || actor.session_id != tool.session_id
        || actor.payload["kind"] != "offline_snapshot_agent"
        || tool.payload["parent_operation"] != actor.id
        || record.operation_id != tool.id
    {
        return Err(error("operator question lacks pinned actor authority"));
    }
    let (turn, index) = tool
        .command_id
        .strip_prefix(&format!("{}:tool:", actor.id))
        .and_then(|rest| rest.split_once(':'))
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<usize>().ok()?)))
        .filter(|(turn, index)| *turn < request.max_turns && *turn < 32 && *index < 32)
        .ok_or_else(|| error("operator question command is not a bounded actor tool"))?;
    let origin =
        store.get_operation_by_command(&tool.session_id, &format!("{}:model:{turn}", actor.id))?;
    if origin.session_id != tool.session_id
        || origin.status != OperationStatus::Succeeded
        || origin.payload["kind"] != "agent_inference"
        || origin.payload["parent_operation"] != actor.id
    {
        return Err(error("operator question origin inference differs"));
    }
    let model: ResponsesRequest = serde_json::from_value(origin.payload["request"].clone())?;
    // Historical templates stay pinned: an existing schema cannot gain fields
    // merely because the current executable knows how to interpret them.
    let offered = model
        .tools
        .iter()
        .filter(|tool| tool.name == "ask_operator")
        .collect::<Vec<_>>();
    if offered.len() != 1
        || serde_json::to_value(offered[0])? != serde_json::to_value(definition())?
    {
        return Err(error(
            "operator question was not offered by the pinned native template",
        ));
    }
    let completion: Completion = serde_json::from_value(
        origin
            .outcome
            .clone()
            .ok_or_else(|| error("operator question origin outcome missing"))?,
    )?;
    if completion.status != CompletionStatus::Completed || completion.error.is_some() {
        return Err(error("operator question requires a complete provider call"));
    }
    let calls = completion
        .content
        .iter()
        .filter_map(|c| match c {
            Content::ToolCall {
                id,
                name,
                arguments,
            } => Some((id, name, arguments)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let (id, name, args) = calls
        .get(index)
        .ok_or_else(|| error("operator question original call missing"))?;
    let parsed: OperatorQuestionRequest = serde_json::from_value((*args).clone())?;
    parsed.validate().map_err(error)?;
    if *name != "ask_operator" || tool.payload["call_id"] != **id || parsed != record.request {
        return Err(error(
            "operator question differs from original provider arguments",
        ));
    }
    Ok(serde_json::to_string(
        &store.operator_question_output(&tool.session_id, &tool.id)?,
    )?)
}
