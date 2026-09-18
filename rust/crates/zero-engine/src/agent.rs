//! Bounded session actor. Model output selects only the explicitly offered tool.
use super::*;
use zero_protocol::{
    agent::{AgentRequest, AgentResult, AgentStatus},
    model::{Content, ResponsesRequest, ToolDefinition},
};

pub(super) fn validate_initial(request: &AgentRequest) -> Result<ResponsesRequest, EngineError> {
    request
        .execution
        .validate()
        .map_err(|e| EngineError::State(e.to_string()))?;
    if !(1..=32).contains(&request.max_turns)
        || request.reservation_per_turn == 0
        || request.prompt.trim().is_empty()
    {
        return Err(EngineError::State(
            "agent requires a prompt, 1..32 turns and nonzero per-turn reservation".into(),
        ));
    }
    if let Some(max) = request.source_submission_max_hypotheses {
        if !request.source_snapshot_tools
            || !(1..=32).contains(&max)
            || request.prompt.len() > 16384
            || request.prompt.contains('\0')
            || request
                .plugin_tools
                .iter()
                .any(|p| p.alias == "submit_source_hypotheses")
        {
            return Err(EngineError::State("structured submission requires snapshot tools, bounded question and 1..32 hypotheses; plugin alias cannot shadow submission".into()));
        }
    }
    let initial = model_request(
        request,
        vec![serde_json::json!({"role":"user","content":request.prompt})],
        None,
    );
    zero_provider::validate_request(&initial).map_err(|e| EngineError::State(e.to_string()))?;
    Ok(initial)
}

impl Engine {
    pub(super) async fn run_agent(
        &self,
        session_id: String,
        command_id: String,
        request: AgentRequest,
        events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        self.run_agent_input(session_id, command_id, request, events, None)
            .await
    }
    pub(super) async fn run_agent_input(
        &self,
        session_id: String,
        command_id: String,
        request: AgentRequest,
        events: mpsc::Sender<ExecutionEvent>,
        queued_input: Option<String>,
    ) -> Result<Reply, EngineError> {
        let initial = validate_initial(&request)?;
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            if control.closing {
                return Err(EngineError::State("engine is shutting down".into()));
            }
            if let Some(input_id) = &queued_input {
                let input = lock(&self.shared.store)?.queued_agent(&session_id, input_id)?;
                if input.status == zero_protocol::queue::QueuedAgentStatus::Cancelled
                    || input.run_command_id != command_id
                    || input
                        .resolved_request
                        .as_ref()
                        .map(serde_json::to_value)
                        .transpose()?
                        != Some(serde_json::to_value(&request)?)
                {
                    return Err(EngineError::State(
                        "queued input authority changed before admission".into(),
                    ));
                }
            } else if command_id.starts_with("queued-agent:") {
                return Err(EngineError::State(
                    "queued agent command IDs require queue dispatch".into(),
                ));
            }
            if control
                .active
                .get(&session_id)
                .is_some_and(|active| active.command_id != command_id)
            {
                return Err(EngineError::State(
                    "session already has an active operation".into(),
                ));
            }
            if control.active.len() >= 64 && !control.active.contains_key(&session_id) {
                return Err(EngineError::State(
                    "engine active operation limit reached".into(),
                ));
            }
            let profile = lock(&self.shared.providers)?
                .get(&request.provider)
                .cloned()
                .ok_or_else(|| EngineError::State("provider profile is not configured".into()))?;
            profile
                .client
                .validate(&initial)
                .map_err(|e| EngineError::State(e.to_string()))?;
            // A durable completed/uncertain receipt remains replayable after an
            // activation. Compare the request/provider and freshly configured
            // host launch, but never reinterpret its historical plugin graph.
            let prior =
                lock(&self.shared.store)?.get_operation_by_command(&session_id, &command_id);
            match prior {
                Ok(prior) => {
                    let mut payload = serde_json::json!({"kind":"offline_snapshot_agent","request":request,"endpoint":profile.client.endpoint_identity(),"rates":profile.rates});
                    if profile.client.wire_api() != zero_protocol::model::WireApi::Responses {
                        payload["wire_api"] = serde_json::to_value(profile.client.wire_api())?;
                    }
                    profile.stamp(&mut payload)?;
                    if let Some(context) = prior.payload.get("plugin_context") {
                        let profiles = lock(&self.shared.plugins)?;
                        let configured = profiles.as_ref().ok_or_else(|| {
                            EngineError::State("plugins are not configured".into())
                        })?;
                        let mut context = context.clone();
                        context["launch"] = serde_json::to_value(&configured.launch)?;
                        payload["plugin_context"] = context;
                    }
                    let admission = lock(&self.shared.store)?.admit_command(
                        &session_id,
                        &command_id,
                        &payload,
                    )?;
                    let result = admission
                        .operation
                        .outcome
                        .clone()
                        .and_then(|v| serde_json::from_value(v).ok());
                    return Ok(Reply::Agent {
                        operation: admission.operation,
                        result,
                        duplicate: true,
                    });
                }
                Err(zero_store::Error::NotFound(_)) => {}
                Err(error) => return Err(error.into()),
            }
            let session = lock(&self.shared.store)?.get_session(&session_id)?;
            let plugins = agent_plugins::capture(&self.shared, &session, &request.plugin_tools)?;
            let mut store = lock(&self.shared.store)?;
            let source = agent_source::capture(&store, &session_id, &request)?;
            let input =
                continuation_input(&store, &session_id, &request, &profile, plugins.as_ref())?;
            profile
                .client
                .validate(&model_request(&request, input.clone(), plugins.as_ref()))
                .map_err(|e| EngineError::State(e.to_string()))?;
            let mut payload = serde_json::json!({"kind":"offline_snapshot_agent","request":request,"endpoint":profile.client.endpoint_identity(),"rates":profile.rates});
            if profile.client.wire_api() != zero_protocol::model::WireApi::Responses {
                payload["wire_api"] = serde_json::to_value(profile.client.wire_api())?;
            }
            profile.stamp(&mut payload)?;
            if let Some(context) = &plugins {
                payload["plugin_context"] = context.identity.clone();
            }
            let admission = store.admit_command(&session_id, &command_id, &payload)?;
            if admission.duplicate {
                let result = admission
                    .operation
                    .outcome
                    .clone()
                    .and_then(|v| serde_json::from_value(v).ok());
                return Ok(Reply::Agent {
                    operation: admission.operation,
                    result,
                    duplicate: true,
                });
            }
            let operation = store.begin_operation(&admission.operation.id, &self.shared.owner)?;
            let cancel = CancellationToken::new();
            control.active.insert(
                session_id.clone(),
                Active {
                    command_id: command_id.clone(),
                    execution_id: command_id,
                    cancel: cancel.clone(),
                },
            );
            emit_admission(&events, &operation, &operation.command_id, &cancel);
            let shared = Arc::clone(&self.shared);
            let (sender, receiver) = oneshot::channel();
            let mut guard = WorkerGuard::new(shared, &session_id, &operation.id, cancel.clone());
            tokio::spawn(async move {
                let result = run_actor(
                    &guard.shared,
                    &session_id,
                    &operation.id,
                    request,
                    profile,
                    input,
                    plugins,
                    source,
                    cancel,
                    events,
                )
                .await;
                guard.settled = result.is_ok();
                drop(guard);
                let _ = sender.send(result);
            });
            receiver
        };
        receiver
            .await
            .map_err(|_| EngineError::State("agent owner stopped before settlement".into()))?
    }
}

/// Reconstruct a completed turn from immutable journal records. No historical
/// tool or provider request is re-issued. This also permits explicit branching
/// from any completed turn, while preserving the execution/provider authority.
fn continuation_input(
    store: &Store,
    session: &str,
    request: &AgentRequest,
    profile: &inference::Profile,
    plugins: Option<&agent_plugins::Context>,
) -> Result<Vec<serde_json::Value>, EngineError> {
    let mut input = Vec::new();
    if let Some(parent_id) = &request.continuation_of {
        let parent = store.get_operation(parent_id)?;
        if parent.session_id != session
            || !matches!(
                parent.status,
                OperationStatus::Succeeded | OperationStatus::Failed
            )
            || parent.payload["kind"] != "offline_snapshot_agent"
        {
            return Err(EngineError::State(
                "continuation requires a completed agent operation in this session".into(),
            ));
        }
        let prior: AgentRequest = serde_json::from_value(parent.payload["request"].clone())?;
        let result: AgentResult = serde_json::from_value(
            parent
                .outcome
                .ok_or_else(|| EngineError::State("continuation has no outcome".into()))?,
        )?;
        let wire: zero_protocol::model::WireApi = serde_json::from_value(
            parent
                .payload
                .get("wire_api")
                .cloned()
                .unwrap_or_else(|| serde_json::json!("responses")),
        )?;
        if prior.source_submission_max_hypotheses != request.source_submission_max_hypotheses
            || prior.source_snapshot_tools != request.source_snapshot_tools
            || prior.source_review_operation_id != request.source_review_operation_id
            || prior.plugin_tools != request.plugin_tools
            || parent.payload.get("plugin_context") != plugins.map(|p| &p.identity)
            || prior.provider != request.provider
            || prior.model != request.model
            || prior.instructions != request.instructions
            || serde_json::to_value(prior.execution.sandbox_request())?
                != serde_json::to_value(request.execution.sandbox_request())?
            || parent.payload["endpoint"] != profile.client.endpoint_identity()
            || parent.payload["rates"] != serde_json::to_value(profile.rates)?
            || parent.payload.get("hosted_catalog").cloned()
                != profile
                    .client
                    .hosted_catalog()
                    .map(serde_json::to_value)
                    .transpose()?
            || wire != profile.client.wire_api()
        {
            return Err(EngineError::State("continuation must retain its provider, model, instructions, rates and pinned execution profile".into()));
        }
        if result.source_review.is_some() {
            return Err(EngineError::State(
                "a terminal source submission cannot be continued as conversation".into(),
            ));
        }
        let turn_limit =
            parent.status == OperationStatus::Failed && result.status == AgentStatus::TurnLimit;
        if !turn_limit
            && (parent.status != OperationStatus::Succeeded
                || result.status != AgentStatus::Completed
                || result.turns == 0)
        {
            return Err(EngineError::State(
                "continuation requires a completed provider turn".into(),
            ));
        }
        if turn_limit {
            input = agent_checkpoint::load(store, session, parent_id, &result)?;
        } else {
            let last = store.get_operation_by_command(
                session,
                &format!("{parent_id}:model:{}", result.turns - 1),
            )?;
            if last.status != OperationStatus::Succeeded
                || last.payload["parent_operation"] != *parent_id
            {
                return Err(EngineError::State(
                    "continuation provider journal is incomplete".into(),
                ));
            }
            let model: ResponsesRequest = serde_json::from_value(last.payload["request"].clone())?;
            inference::validate_hosted_pair(&parent.payload, &last.payload, &model)?;
            let completion: zero_protocol::model::Completion =
                serde_json::from_value(last.outcome.ok_or_else(|| {
                    EngineError::State("continuation provider outcome is absent".into())
                })?)?;
            if completion.status != zero_protocol::model::CompletionStatus::Completed
                || completion.replay.is_empty()
            {
                return Err(EngineError::State(
                    "continuation has no complete replay data".into(),
                ));
            }
            input = model.input;
            input.extend(completion.replay);
        }
    }
    input.push(serde_json::json!({"role":"user","content":request.prompt}));
    Ok(input)
}

fn model_request(
    request: &AgentRequest,
    input: Vec<serde_json::Value>,
    plugins: Option<&agent_plugins::Context>,
) -> ResponsesRequest {
    let mut model = ResponsesRequest{model:request.model.clone(),instructions:request.instructions.clone(),input,max_output_tokens:8192,
        tools:vec![ToolDefinition{name:"execute_snapshot".into(),description:"Run an argv vector in the explicitly pinned offline snapshot sandbox. This cannot change the image, mounts, networking, limits or host files. The working copy is disposable for each call.".into(),
            parameters:serde_json::json!({"type":"object","properties":{"argv":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":128}},"required":["argv"],"additionalProperties":false})}]};
    if request.source_snapshot_tools || request.source_review_operation_id.is_some() {
        model.tools.extend(agent_source::definitions());
    }
    if let Some(max) = request.source_submission_max_hypotheses {
        if let Ok(tool) = zero_source::adaptive_submission_tool(max) {
            model.tools.push(tool);
        }
    }
    if let Some(plugins) = plugins {
        model.tools.extend(plugins.tools.clone());
    }
    model
}
fn child_operation(
    shared: &Shared,
    session: &str,
    command: &str,
    payload: &serde_json::Value,
) -> Result<zero_protocol::Operation, EngineError> {
    let mut store = lock(&shared.store)?;
    let admission = store.admit_command(session, command, payload)?;
    if admission.duplicate {
        return Err(EngineError::State(
            "agent child effect already admitted; explicit recovery required".into(),
        ));
    }
    Ok(store.begin_operation(&admission.operation.id, &shared.owner)?)
}

#[allow(clippy::too_many_arguments)]
async fn run_rounds(
    shared: &Arc<Shared>,
    session: &str,
    parent: &str,
    request: AgentRequest,
    profile: inference::Profile,
    mut input: Vec<serde_json::Value>,
    plugins: Option<agent_plugins::Context>,
    source: Option<Arc<agent_source::Context>>,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<(AgentResult, Vec<serde_json::Value>), EngineError> {
    let mut output = AgentResult {
        status: AgentStatus::TurnLimit,
        text: String::new(),
        turns: 0,
        tool_calls: 0,
        error: None,
        continuation_artifact: None,
        source_recovery_path: None,
        source_review: None,
    };
    'turns: for turn in 0..request.max_turns {
        if cancel.is_cancelled() {
            output.status = AgentStatus::Cancelled;
            break;
        }
        if let Some(context) = &plugins {
            if let Err(error) = agent_plugins::current(shared, context) {
                output.status = AgentStatus::Failed;
                output.error = Some(error.to_string());
                break;
            }
        }
        let model = model_request(&request, input.clone(), plugins.as_ref());
        // Adaptive evidence must be retainable before another provider charge.
        if request.source_submission_max_hypotheses.is_some()
            && serde_json::to_vec(&model)?.len() > zero_source::MAX_ARTIFACT_BYTES
        {
            output.status = AgentStatus::Failed;
            output.error = Some("adaptive source request exceeds retained evidence limit".into());
            break;
        }
        // Validate accumulated context before reserving/spending or admitting an effect.
        if profile.client.validate(&model).is_err() {
            output.status = AgentStatus::Failed;
            output.error = Some("agent context exceeds provider request bounds".into());
            break;
        }
        let mut child_payload = serde_json::json!({"parent_operation":parent,"kind":"agent_inference","request":model,"endpoint":profile.client.endpoint_identity(),"rates":profile.rates,"wire_api":profile.client.wire_api()});
        profile.stamp(&mut child_payload)?;
        let child = child_operation(
            shared,
            session,
            &format!("{parent}:model:{turn}"),
            &child_payload,
        )?;
        {
            let mut store = lock(&shared.store)?;
            if let Err(error) =
                store.reserve_budget(session, &child.id, request.reservation_per_turn)
            {
                store.settle_operation(
                    &child.id,
                    &shared.owner,
                    OperationStatus::Failed,
                    &serde_json::json!({"error":"budget reservation rejected"}),
                )?;
                output.status = AgentStatus::Failed;
                output.error = Some(error.to_string());
                break;
            }
        }
        output.turns += 1;
        let reply = inference::run_inference(
            shared,
            session,
            &child.id,
            profile.clone(),
            model.clone(),
            cancel.clone(),
        )
        .await?;
        let Reply::Inference {
            operation,
            completion,
            ..
        } = reply
        else {
            return Err(EngineError::State("unexpected inference reply".into()));
        };
        let Some(completion) = completion else {
            if operation.status == OperationStatus::Cancelled {
                output.status = AgentStatus::Cancelled;
            } else {
                output.status = AgentStatus::Unknown;
                output.error = Some("provider outcome is uncertain; reservation retained".into());
            }
            break;
        };
        if operation.status != OperationStatus::Succeeded {
            output.status = if operation.status == OperationStatus::Unknown {
                AgentStatus::Unknown
            } else {
                AgentStatus::Failed
            };
            output.error = completion.error;
            break;
        }
        let calls: Vec<_> = completion
            .content
            .iter()
            .filter_map(|block| match block {
                Content::ToolCall {
                    id,
                    name,
                    arguments,
                } => Some((id.clone(), name.clone(), arguments.clone())),
                _ => None,
            })
            .collect();
        if let Some(max) = request.source_submission_max_hypotheses {
            if calls
                .iter()
                .any(|(_, name, _)| name == "submit_source_hypotheses")
            {
                let context = source.as_ref().cloned().ok_or_else(|| {
                    EngineError::State("missing snapshot submission authority".into())
                })?;
                let question = request.prompt.clone();
                let model = model.clone();
                let completion = completion.clone();
                let accepted = tokio::task::spawn_blocking(move || {
                    agent_submission::prepare(&context, &question, max, model, completion)
                })
                .await
                .map_err(|e| EngineError::State(e.to_string()))?;
                if cancel.is_cancelled() {
                    output.status = AgentStatus::Cancelled;
                    break;
                }
                match accepted {
                    Ok(prepared) => {
                        match agent_submission::retain(shared, parent, &child.id, prepared) {
                            Ok(review) => {
                                output.source_review = Some(review);
                                output.status = AgentStatus::Completed;
                            }
                            Err(error) => {
                                output.status = AgentStatus::Failed;
                                output.error = Some(error.to_string());
                            }
                        }
                    }
                    Err(error) => {
                        output.status = AgentStatus::Failed;
                        output.error = Some(error.to_string());
                    }
                }
                break;
            }
            if calls.is_empty() {
                output.status = AgentStatus::Failed;
                output.error = Some(
                    "structured source submission required; final prose is not a review".into(),
                );
                break;
            }
        }
        if calls.is_empty() {
            output.status = AgentStatus::Completed;
            output.text = completion
                .content
                .iter()
                .filter_map(|block| match block {
                    Content::Text { text } | Content::Refusal { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            if output.text.trim().is_empty() {
                output.status = AgentStatus::Failed;
                output.error =
                    Some("provider completed without a final answer or tool call".into());
            }
            break;
        }
        if calls.len() > 32 {
            output.status = AgentStatus::Failed;
            output.error = Some("provider requested too many tools in one turn".into());
            break;
        }
        input.extend(completion.replay);
        for (index, (id, name, arguments)) in calls.into_iter().enumerate() {
            if cancel.is_cancelled() {
                output.status = AgentStatus::Cancelled;
                break 'turns;
            }
            if let Some(bundle) = source.as_ref().filter(|_| agent_source::is_tool(&name)) {
                let context = Arc::clone(bundle);
                let tool = name.clone();
                let args = arguments.clone();
                // The read owns its context until completion; cancellation must
                // await it before cleanup, without blocking runtime threads.
                let result = tokio::task::spawn_blocking(move || {
                    agent_source::invoke(&context, &tool, args)
                })
                .await
                .map_err(|e| EngineError::State(e.to_string()))?;
                if cancel.is_cancelled() {
                    output.status = AgentStatus::Cancelled;
                    break 'turns;
                }
                match result {
                    Err(error) => {
                        input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":format!("Tool rejected: {error}")}));
                    }
                    Ok(value) => {
                        let child = child_operation(
                            shared,
                            session,
                            &format!("{parent}:tool:{turn}:{index}"),
                            &serde_json::json!({"parent_operation":parent,"kind":"agent_source_tool","call_id":id,"name":name,"arguments":arguments,"source_operation":request.source_review_operation_id,"bundle_sha256":bundle.bundle_digest(),"source_identity":bundle.identity()}),
                        )?;
                        let bytes = serde_json::to_vec(&value)?;
                        let mut store = lock(&shared.store)?;
                        let persisted = (|| {
                            let digest = store.retain_operation_artifact(
                                &child.id,
                                &shared.owner,
                                "source.tool_result",
                                &bytes,
                            )?;
                            store.settle_operation(&child.id, &shared.owner, OperationStatus::Succeeded,
                                &serde_json::json!({"result_artifact":digest,"bundle_sha256":bundle.bundle_digest(),"source_identity":bundle.identity()}))?;
                            Ok::<_, zero_store::Error>(())
                        })();
                        if let Err(error) = persisted {
                            let failure = serde_json::json!({"error":"source tool result persistence failed","external_effects_started":false});
                            if store
                                .settle_operation(
                                    &child.id,
                                    &shared.owner,
                                    OperationStatus::Failed,
                                    &failure,
                                )
                                .is_err()
                            {
                                let _ = store.mark_operation_unknown_with_outcome(
                                    &child.id,
                                    &shared.owner,
                                    &failure,
                                );
                                return Err(error.into());
                            }
                            output.status = AgentStatus::Failed;
                            output.error = Some("source tool result persistence failed".into());
                            break 'turns;
                        }
                        output.tool_calls += 1;
                        input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":serde_json::to_string(&value)?}));
                    }
                }
                if cancel.is_cancelled() {
                    output.status = AgentStatus::Cancelled;
                    break 'turns;
                }
                continue;
            }
            if let Some(binding) = request.plugin_tools.iter().find(|b| b.alias == name) {
                let context = plugins
                    .as_ref()
                    .ok_or_else(|| EngineError::State("missing captured plugin context".into()))?;
                if let Err(error) =
                    agent_plugins::validate(shared, context, binding, arguments.clone())
                {
                    input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":format!("Tool rejected: {error}")}));
                    continue;
                }
                let reply = agent_plugins::execute(
                    shared,
                    session,
                    parent,
                    &format!("{parent}:tool:{turn}:{index}"),
                    &id,
                    context,
                    binding,
                    arguments,
                    cancel.clone(),
                    events.clone(),
                )
                .await?;
                output.tool_calls += 1;
                let Reply::Plugin {
                    operation,
                    result: Some(result),
                    ..
                } = reply
                else {
                    output.status = AgentStatus::Unknown;
                    output.error = Some("plugin outcome is uncertain".into());
                    break 'turns;
                };
                if operation.status == OperationStatus::Unknown {
                    output.status = AgentStatus::Unknown;
                    output.error =
                        Some("plugin cleanup or completion is uncertain; lease retained".into());
                    break 'turns;
                }
                if cancel.is_cancelled() {
                    output.status = AgentStatus::Cancelled;
                    break 'turns;
                }
                input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":serde_json::to_string(&serde_json::json!({"untrusted_plugin_data":result.untrusted_reply,"error":result.error,"status":operation.status}))?}));
                continue;
            }
            let mut execution = request.execution.sandbox_request();
            execution.execution_id = format!("agent-{parent}-{turn}-{index}");
            let permitted = if name == "execute_snapshot" {
                arguments
                    .as_object()
                    .filter(|object| object.len() == 1 && object.contains_key("argv"))
                    .and_then(|object| {
                        serde_json::from_value::<Vec<String>>(object["argv"].clone()).ok()
                    })
            } else {
                None
            };
            let Some(argv) = permitted else {
                input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":"Tool rejected: unknown/unoffered tool or invalid execute_snapshot arguments."}));
                continue;
            };
            execution.argv = argv;
            if execution.validate().is_err() {
                input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":"Tool rejected: argv violates the execution bounds."}));
                continue;
            }
            let child = child_operation(
                shared,
                session,
                &format!("{parent}:tool:{turn}:{index}"),
                &serde_json::json!({"parent_operation":parent,"kind":"agent_tool","call_id":id,"request":execution}),
            )?;
            output.tool_calls += 1;
            let reply = sandbox::run_sandbox_owned(
                shared,
                &child.id,
                execution,
                cancel.clone(),
                events.clone(),
            )
            .await?;
            let Reply::Sandbox {
                operation,
                result: Some(result),
                ..
            } = reply
            else {
                output.status = AgentStatus::Unknown;
                output.error = Some("tool outcome is uncertain".into());
                break 'turns;
            };
            if matches!(
                result.cleanup,
                zero_protocol::sandbox::SandboxCleanup::Unconfirmed { .. }
                    | zero_protocol::sandbox::SandboxCleanup::Unknown { .. }
            ) || operation.status == OperationStatus::Unknown
            {
                output.status = AgentStatus::Unknown;
                output.error = Some("tool cleanup or completion is uncertain".into());
                break 'turns;
            }
            if cancel.is_cancelled() {
                output.status = AgentStatus::Cancelled;
                break 'turns;
            }
            // Raw bytes stay in the durable execution result. The model gets a
            // clearly lossy text rendering and must treat tool output as data.
            input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":serde_json::to_string(&serde_json::json!({"status":result.status,"exit_code":result.exit_code,"stdout_text":String::from_utf8_lossy(&result.stdout),"stderr_text":String::from_utf8_lossy(&result.stderr),"error":result.error}))?}));
        }
    }
    Ok((output, input))
}

fn settle_agent(shared: &Shared, parent: &str, output: AgentResult) -> Result<Reply, EngineError> {
    let outcome = serde_json::to_value(&output)?;
    let mut store = lock(&shared.store)?;
    let operation = if output.status == AgentStatus::Unknown {
        store.mark_operation_unknown_with_outcome(parent, &shared.owner, &outcome)?
    } else {
        let status = match output.status {
            AgentStatus::Completed => OperationStatus::Succeeded,
            AgentStatus::Cancelled => OperationStatus::Cancelled,
            _ => OperationStatus::Failed,
        };
        store.settle_operation(parent, &shared.owner, status, &outcome)?
    };
    Ok(Reply::Agent {
        operation,
        result: Some(output),
        duplicate: false,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_actor(
    shared: &Arc<Shared>,
    session: &str,
    parent: &str,
    request: AgentRequest,
    profile: inference::Profile,
    input: Vec<serde_json::Value>,
    plugins: Option<agent_plugins::Context>,
    mut source: Option<agent_source::Context>,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    let empty = |status, error| AgentResult {
        status,
        text: String::new(),
        turns: 0,
        tool_calls: 0,
        error,
        continuation_artifact: None,
        source_recovery_path: None,
        source_review: None,
    };
    let mut preparation_error = None;
    if request.source_snapshot_tools {
        let pin = request.execution.sandbox_request().snapshot;
        let cancellation = cancel.clone();
        // Never detach a blocking copy when cancelled: the owner must receive
        // its handle and finish cleanup before settling the operation.
        let prepared = tokio::task::spawn_blocking(move || {
            zero_source::SnapshotInvestigation::prepare_checked(&pin, &|| {
                if cancellation.is_cancelled() {
                    Err("source preparation cancelled".into())
                } else {
                    Ok(())
                }
            })
        })
        .await;
        match prepared {
            Ok(Ok(snapshot)) => {
                let retained = (|| {
                    let bytes = snapshot
                        .catalog_bytes()
                        .map_err(|e| EngineError::State(e.to_string()))?;
                    let mut store = lock(&shared.store)?;
                    let digest = store.retain_operation_artifact(
                        parent,
                        &shared.owner,
                        "source.snapshot_catalog",
                        &bytes,
                    )?;
                    store.append_operation_event(parent,&shared.owner,"source.snapshot_prepared",
                        &serde_json::json!({"path":snapshot.root(),"snapshot_digest":snapshot.snapshot_digest(),"catalog_artifact":digest}))?;
                    Ok::<_, EngineError>(())
                })();
                source = Some(agent_source::Context::Snapshot(snapshot));
                if let Err(error) = retained {
                    preparation_error = Some(error.to_string());
                }
            }
            Ok(Err(error)) => preparation_error = Some(error.to_string()),
            Err(error) => preparation_error = Some(error.to_string()),
        }
    }
    let source = source.map(Arc::new);
    let prepared_path = source.as_ref().and_then(|context| match context.as_ref() {
        agent_source::Context::Snapshot(snapshot) => {
            Some(snapshot.root().to_string_lossy().into_owned())
        }
        agent_source::Context::Retained(_) => None,
    });
    let work = if let Some(error) = preparation_error {
        Ok((
            empty(
                if cancel.is_cancelled() {
                    AgentStatus::Cancelled
                } else {
                    AgentStatus::Failed
                },
                Some(error),
            ),
            input,
        ))
    } else {
        run_rounds(
            shared,
            session,
            parent,
            request,
            profile,
            input,
            plugins,
            source.clone(),
            cancel.clone(),
            events,
        )
        .await
    };
    let cleanup = match source {
        Some(context) => {
            tokio::task::spawn_blocking(move || match Arc::try_unwrap(context) {
                Ok(context) => context.cleanup(),
                Err(_) => Err(zero_source::snapshot_investigation::SnapshotError::Invalid(
                    "source reader still owns private copy",
                )),
            })
            .await
        }
        None => Ok(Ok(())),
    };
    let mut recovery = prepared_path;
    let cleanup_error = match cleanup {
        Ok(Ok(())) => None,
        Ok(Err(error)) => {
            if let zero_source::snapshot_investigation::SnapshotError::Cleanup { path } = &error {
                recovery = Some(path.to_string_lossy().into_owned());
            }
            Some(error.to_string())
        }
        Err(error) => Some(error.to_string()),
    };
    let (mut output, input) = match work {
        Ok(value) => value,
        Err(error) => {
            if let Some(cleanup_error) = cleanup_error {
                let mut output = empty(
                    AgentStatus::Unknown,
                    Some(format!("{error}; {cleanup_error}")),
                );
                output.source_recovery_path = recovery;
                let _ = settle_agent(shared, parent, output);
            }
            return Err(error);
        }
    };
    if let Some(error) = cleanup_error {
        output.status = AgentStatus::Unknown;
        output.error = Some(error);
        output.source_recovery_path = recovery;
    }
    if cancel.is_cancelled()
        && matches!(
            output.status,
            AgentStatus::TurnLimit | AgentStatus::Completed
        )
    {
        output.status = AgentStatus::Cancelled;
    }
    if output.status == AgentStatus::TurnLimit {
        let mut store = lock(&shared.store)?;
        match agent_checkpoint::save(
            &mut store,
            &shared.owner,
            session,
            parent,
            output.turns,
            input,
        ) {
            Ok(digest) => output.continuation_artifact = Some(digest),
            Err(error) => {
                output.status = AgentStatus::Failed;
                output.error = Some(format!("could not retain continuation checkpoint: {error}"));
            }
        }
    }
    settle_agent(shared, parent, output)
}
