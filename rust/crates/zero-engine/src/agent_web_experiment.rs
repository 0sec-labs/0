//! Model-selected experiments under captured authority, with independently measured feedback.
use super::*;
use serde_json::{Value, json};
use zero_protocol::{
    Operation,
    model::{Completion, CompletionStatus, Content, ResponsesRequest},
    web_experiment::*,
};
use zero_web_verification::FrozenExperiment;
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
pub(crate) fn rejection(reason: impl std::fmt::Display) -> String {
    let mut message = format!("Tool rejected: {reason}");
    if message.len() > 4096 {
        let mut end = 4093;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.push_str("...");
    }
    message
}
fn hash(v: &impl serde::Serialize) -> Result<String, EngineError> {
    Ok(format!(
        "sha256:{}",
        zero_plugin::sha256(&serde_json::to_vec(v)?)
    ))
}
pub(crate) use zero_web_verification::experiment_tool_definition as definition;
pub(crate) struct Prepared {
    pub frozen: FrozenExperiment,
    pub payload: Value,
}
pub(crate) fn prepare(
    store: &Store,
    actor: &Operation,
    inference: &Operation,
    call: &str,
    args: Value,
    context: &agent_http::Context,
) -> Result<Prepared, EngineError> {
    let inference = store.get_operation(&inference.id)?;
    let request = zero_protocol::agent::validate_actor_payload(&actor.payload).map_err(error)?;
    let policy = request
        .web_experiment_policy
        .clone()
        .ok_or_else(|| error("experiment authority absent"))?;
    let proposal: WebExperimentProposal = serde_json::from_value(args)?;
    let frozen = FrozenExperiment::new(
        &actor.session_id,
        &actor.id,
        &inference.id,
        call,
        policy,
        proposal,
        context.identity.clone(),
        request.tool_approval_policy,
    )
    .map_err(error)?;
    // This checks private auth values before publishing a pending approval or admitting work.
    for case in frozen.cases() {
        context
            .client
            .prepare(case.request.clone())
            .map_err(error)?;
    }
    let payload = frozen
        .parent_payload(
            &hash(&actor.payload)?,
            &hash(&inference.payload)?,
            &hash(&inference.outcome)?,
        )
        .map_err(error)?;
    validate_prior(store, actor, &frozen)?;
    Ok(Prepared { frozen, payload })
}
fn base_origin(
    store: &Store,
    op: &Operation,
) -> Result<(FrozenExperiment, Operation, Operation), EngineError> {
    if serde_json::to_vec(&op.payload)?.len() > 4 * 1024 * 1024
        || op.payload["kind"] != "agent_web_experiment"
    {
        return Err(error("invalid experiment operation"));
    }
    store.validate_web_experiment_parent(op)?;
    let frozen = FrozenExperiment::from_intent(&op.payload["execution_intent"]).map_err(error)?;
    let actor = store.get_operation(
        op.payload["parent_operation"]
            .as_str()
            .ok_or_else(|| error("experiment actor absent"))?,
    )?;
    let request = zero_protocol::agent::validate_actor_payload(&actor.payload).map_err(error)?;
    let policy = request
        .web_experiment_policy
        .clone()
        .ok_or_else(|| error("experiment authority absent"))?;
    let inference = store.get_operation(
        op.payload["origin_inference_id"]
            .as_str()
            .ok_or_else(|| error("experiment inference absent"))?,
    )?;
    if inference.session_id != op.session_id
        || actor.session_id != op.session_id
        || inference.payload["kind"] != "agent_inference"
        || inference.payload["parent_operation"] != actor.id
        || inference.status != OperationStatus::Succeeded
        || actor.payload["http_output_version"] != 2
    {
        return Err(error("experiment original inference mismatch"));
    }
    if serde_json::to_vec(&actor)?.len() > 8 * 1024 * 1024
        || serde_json::to_vec(&inference)?.len() > 16 * 1024 * 1024
    {
        return Err(error("experiment original receipt exceeds read bound"));
    }
    let model: ResponsesRequest = serde_json::from_value(inference.payload["request"].clone())?;
    inference::validate_hosted_pair(&actor.payload, &inference.payload, &model)?;
    let offered: Vec<_> = model
        .tools
        .iter()
        .filter(|t| t.name == "run_web_experiment")
        .collect();
    if offered.len() != 1
        || serde_json::to_value(offered[0])? != serde_json::to_value(definition(&policy))?
    {
        return Err(error("native experiment definition changed"));
    }
    let completion: Completion = serde_json::from_value(
        inference
            .outcome
            .clone()
            .ok_or_else(|| error("experiment origin outcome absent"))?,
    )?;
    if completion.status != CompletionStatus::Completed || completion.error.is_some() {
        return Err(error("experiment origin did not complete"));
    }
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|c| {
            if let Content::ToolCall {
                id,
                name,
                arguments,
            } = c
            {
                Some((id, name, arguments))
            } else {
                None
            }
        })
        .collect();
    let mut ids = std::collections::BTreeSet::new();
    if calls.len() > 32 || calls.iter().any(|c| !ids.insert(c.0)) {
        return Err(error("invalid experiment original calls"));
    }
    let index = calls
        .iter()
        .position(|c| Some(c.0.as_str()) == op.payload["call_id"].as_str())
        .ok_or_else(|| error("experiment original call missing"))?;
    let (id, name, args) = calls[index];
    if name != "run_web_experiment" {
        return Err(error("experiment original tool differs"));
    }
    let turn = inference
        .command_id
        .strip_prefix(&format!("{}:model:", actor.id))
        .and_then(|t| t.parse::<u32>().ok())
        .filter(|n| *n < 32)
        .ok_or_else(|| error("experiment original turn invalid"))?;
    let command = format!("{}:tool:{turn}:{index}", actor.id);
    let approved = op.payload.get("approval_operation").is_some();
    if op.command_id
        != if approved {
            format!("{command}:effect")
        } else {
            command
        }
    {
        return Err(error("experiment command differs"));
    }
    let expected = FrozenExperiment::new(
        &op.session_id,
        &actor.id,
        &inference.id,
        id,
        policy,
        serde_json::from_value(args.clone())?,
        actor.payload["http_context"].clone(),
        request.tool_approval_policy,
    )
    .map_err(error)?;
    if expected.intent() != frozen.intent() {
        return Err(error("experiment proposal or authority changed"));
    }
    let mut payload = frozen
        .parent_payload(
            &hash(&actor.payload)?,
            &hash(&inference.payload)?,
            &hash(&inference.outcome)?,
        )
        .map_err(error)?;
    if approved {
        payload["approval_operation"] = op.payload["approval_operation"].clone();
    }
    if payload != op.payload {
        return Err(error("experiment origin hashes differ"));
    }
    if frozen.approval_required() && !approved {
        return Err(error("experiment approval missing"));
    }
    // Store admission and consumed-approval witnesses independently validate effect authority.
    Ok((frozen, actor, inference))
}
fn validate_prior(
    store: &Store,
    actor: &Operation,
    frozen: &FrozenExperiment,
) -> Result<(), EngineError> {
    let Some(link) = &frozen.hypothesis().prior_revision else {
        return Ok(());
    };
    let root = actor.payload["parent_operation"]
        .as_str()
        .unwrap_or(&actor.id);
    let op = store.get_operation(&link.operation_id)?;
    // Store authenticates the complete older causal chain with a shared read
    // budget. Check only the new edge here; do not recursively reload every link.
    let (old, old_actor, _) = base_origin(store, &op)?;
    if op.session_id != actor.session_id
        || old.hypothesis_sha256() != link.hypothesis_sha256
        || !agent_web::owns_actor(store, root, &old_actor.id)?
    {
        return Err(error(
            "prior revision is outside this investigation or changed",
        ));
    }
    let artifacts = store.operation_artifacts(&op.id)?;
    let digest = artifacts
        .get("experiment.hypothesis")
        .ok_or_else(|| error("prior hypothesis not retained"))?;
    let retained: Value = serde_json::from_slice(&store.artifact(digest)?)?;
    if retained != serde_json::to_value(old.hypothesis())? {
        return Err(error("prior hypothesis artifact differs"));
    }
    Ok(())
}

pub(crate) fn origin(
    store: &Store,
    op: &Operation,
) -> Result<(FrozenExperiment, Operation, Operation), EngineError> {
    base_origin(store, op)
}
pub(crate) fn validate_receipt(store: &Store, op: &Operation) -> Result<String, EngineError> {
    let (frozen, _, _) = origin(store, op)?;
    let outcome = web_experiment::load(store, op)?;
    let mut observations = Vec::new();
    for attempt in &outcome.attempts {
        let effect = store.get_operation(&attempt.operation_id)?;
        if attempt.response_manifest_sha256.is_some() {
            let (manifest, result, body) = agent_http::checked_evidence(store, &effect)?;
            let preview = String::from_utf8_lossy(&body[..body.len().min(2048)]).into_owned();
            observations.push(json!({"operation_id":effect.id,"response_manifest_sha256":attempt.response_manifest_sha256,"retained_body_sha256":manifest["body"]["sha256"],"retained_bytes":body.len(),"status":result.response.as_ref().map(|r|r.status),"complete":attempt.complete,"body_preview":preview,"preview_truncated":body.len()>2048,"target_data_untrusted":true}));
        }
    }
    let result = json!({"experiment_operation_id":op.id,"hypothesis":frozen.hypothesis(),"model_predictions":true,"vulnerability_reportable":false,"evolution_eligible":false,"assessment":outcome.assessment,"attempts":outcome.attempts,"stop":outcome.stop,"observations":observations,"limitations":"Same static identity and existing target state. Matching model predictions is not independent security qualification."});
    let encoded = serde_json::to_string(&result)?;
    if encoded.len() > 512 * 1024 {
        return Err(error("experiment model result exceeds bound"));
    }
    Ok(encoded)
}
