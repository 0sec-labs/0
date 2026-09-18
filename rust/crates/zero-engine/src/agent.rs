//! Bounded session actor. Model output selects only the explicitly offered tool.
use super::*;
use futures_util::FutureExt;
use zero_protocol::{
    agent::{AgentRequest, AgentResult, AgentStatus},
    model::{Content, ResponsesRequest, ToolDefinition},
};

pub(super) struct PreparedActor {
    pub request: AgentRequest,
    pub profile: inference::Profile,
    pub history: agent_context::History,
    pub plugins: Option<agent_plugins::Context>,
    pub http: Option<agent_http::Context>,
    pub source: Option<agent_source::Context>,
    pub template: ResponsesRequest,
    pub delegation: Option<agent_delegation::Context>,
    pub checkpoint: bool,
}

pub(super) fn validate_initial(request: &AgentRequest) -> Result<ResponsesRequest, EngineError> {
    agent_approvals::validate_policy(request)?;
    if request.http_profile.is_some()
        && request
            .plugin_tools
            .iter()
            .any(|p| p.alias == "http_request")
    {
        return Err(EngineError::State(
            "plugin alias shadows native HTTP tool".into(),
        ));
    }
    if request.operator_questions
        && request
            .plugin_tools
            .iter()
            .any(|p| p.alias == "ask_operator")
    {
        return Err(EngineError::State(
            "plugin alias shadows native operator question tool".into(),
        ));
    }
    if let Some(policy) = &request.delegation_policy {
        policy
            .validate()
            .map_err(|e| EngineError::State(e.to_string()))?;
        if request
            .plugin_tools
            .iter()
            .any(|p| p.alias == "delegate_tasks")
        {
            return Err(EngineError::State(
                "plugin alias shadows delegated tool".into(),
            ));
        }
    }
    request
        .validate_capabilities()
        .map_err(|e| EngineError::State(e.to_string()))?;
    if !(1..=32).contains(&request.max_turns)
        || request.reservation_per_turn == 0
        || request.prompt.trim().is_empty()
    {
        return Err(EngineError::State(
            "agent requires a prompt, 1..32 turns and nonzero per-turn reservation".into(),
        ));
    }
    if request.web_submission_max_hypotheses.is_some()
        && request
            .plugin_tools
            .iter()
            .any(|p| p.alias == "submit_web_hypotheses")
    {
        return Err(EngineError::State(
            "plugin alias shadows web submission".into(),
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
    if let Some(policy) = &request.context_policy {
        policy
            .validate()
            .map_err(|e| EngineError::State(e.to_string()))?;
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
        progress_events: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<Reply, EngineError> {
        self.run_agent_input(
            session_id,
            command_id,
            request,
            events,
            progress_events,
            None,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_agent_input(
        &self,
        session_id: String,
        command_id: String,
        request: AgentRequest,
        events: mpsc::Sender<ExecutionEvent>,
        progress_events: Option<mpsc::Sender<ExecutionEvent>>,
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
                    let mut payload = serde_json::json!({"kind":zero_protocol::agent::actor_kind(&request),"request":request,"endpoint":profile.client.endpoint_identity(),"rates":profile.rates});
                    if profile.client.wire_api() != zero_protocol::model::WireApi::Responses {
                        payload["wire_api"] = serde_json::to_value(profile.client.wire_api())?;
                    }
                    profile.stamp(&mut payload)?;
                    if let Some(version) = prior.payload.get("http_output_version") {
                        payload["http_output_version"] = version.clone();
                    }
                    if request.http_profile.is_some() {
                        payload["http_context"] = agent_http::retry_identity(
                            &self.shared,
                            &session_id,
                            &request,
                            prior.payload.get("http_context").ok_or_else(|| {
                                EngineError::State("missing historical HTTP context".into())
                            })?,
                        )?;
                    }
                    if request.delegation_policy.is_some() {
                        payload["delegation_context"] = agent_delegation::retry_identity(
                            &self.shared,
                            &request,
                            prior.payload.get("delegation_context").ok_or_else(|| {
                                EngineError::State("missing historical delegation context".into())
                            })?,
                        )?;
                    }
                    if request.context_policy.is_some() {
                        payload["context_template"] = prior
                            .payload
                            .get("context_template")
                            .cloned()
                            .ok_or_else(|| {
                                EngineError::State("missing historical context template".into())
                            })?;
                    }
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
            agent_approvals::validate_plugins(&request, plugins.as_ref())?;
            let mut store = lock(&self.shared.store)?;
            let source = agent_source::capture(&store, &session_id, &request)?;
            let http =
                agent_http::capture(&self.shared, &store, &session_id, &command_id, &request)?;
            // A context lineage keeps its original offered schemas across upgrades.
            // continuation_input has already validated the ancestor's request and
            // hash-bound template; only fresh conversations capture current tools.
            let template = if request.context_policy.is_some() {
                match &request.continuation_of {
                    Some(parent) => serde_json::from_value::<ResponsesRequest>(
                        store.get_operation(parent)?.payload["context_template"].clone(),
                    )?,
                    None => model_request(&request, vec![], plugins.as_ref()),
                }
            } else {
                model_request(&request, vec![], plugins.as_ref())
            };
            let delegation = agent_delegation::capture(
                &self.shared,
                &request,
                &template,
                plugins.as_ref(),
                http.as_ref(),
            )?;
            let input = continuation_input(
                &store,
                &session_id,
                &request,
                &profile,
                plugins.as_ref(),
                delegation.as_ref(),
                http.as_ref(),
            )?;
            let mut projected = template.clone();
            projected.input = input.projected(request.context_policy.as_ref())?;
            profile
                .client
                .validate(&projected)
                .map_err(|e| EngineError::State(e.to_string()))?;
            let mut payload = serde_json::json!({"kind":zero_protocol::agent::actor_kind(&request),"request":request,"endpoint":profile.client.endpoint_identity(),"rates":profile.rates});
            if profile.client.wire_api() != zero_protocol::model::WireApi::Responses {
                payload["wire_api"] = serde_json::to_value(profile.client.wire_api())?;
            }
            profile.stamp(&mut payload)?;
            if let Some(context) = &delegation {
                payload["delegation_context"] = context.identity.clone();
            }
            if request.context_policy.is_some() {
                payload["context_template"] = serde_json::to_value(&template)?;
            }
            if let Some(context) = &plugins {
                payload["plugin_context"] = context.identity.clone();
            }
            if let Some(context) = &http {
                payload["http_context"] = context.identity.clone();
                if context.output_version == 2 {
                    payload["http_output_version"] = serde_json::json!(2);
                }
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
                    PreparedActor {
                        request,
                        profile,
                        history: input,
                        plugins,
                        http,
                        source,
                        template,
                        delegation,
                        checkpoint: true,
                    },
                    cancel,
                    events,
                    progress_events,
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
    delegation: Option<&agent_delegation::Context>,
    http: Option<&agent_http::Context>,
) -> Result<agent_context::History, EngineError> {
    let mut history = agent_context::History::new(Vec::new(), request.context_policy.as_ref())?;
    if let Some(parent_id) = &request.continuation_of {
        let parent = store.get_operation(parent_id)?;
        if parent.session_id != session
            || !matches!(
                parent.status,
                OperationStatus::Succeeded | OperationStatus::Failed
            )
            || zero_protocol::agent::validate_actor_payload(&parent.payload).is_err()
            || parent.payload.get("parent_operation").is_some()
        {
            return Err(EngineError::State(
                "continuation requires a completed agent operation in this session".into(),
            ));
        }
        let prior: AgentRequest = serde_json::from_value(parent.payload["request"].clone())?;
        let result: AgentResult = serde_json::from_value(
            parent
                .outcome
                .clone()
                .ok_or_else(|| EngineError::State("continuation has no outcome".into()))?,
        )?;
        let wire: zero_protocol::model::WireApi = serde_json::from_value(
            parent
                .payload
                .get("wire_api")
                .cloned()
                .unwrap_or_else(|| serde_json::json!("responses")),
        )?;
        if prior.http_profile != request.http_profile
            || parent.payload.get("http_context") != http.map(|h| &h.identity)
            || parent.payload["http_output_version"].as_u64().unwrap_or(1)
                != u64::from(http.map(|h| h.output_version).unwrap_or(1))
            || prior.tool_approval_policy != request.tool_approval_policy
            || prior.operator_questions != request.operator_questions
            || prior.context_policy != request.context_policy
            || prior.delegation_policy != request.delegation_policy
            || parent.payload.get("delegation_context") != delegation.map(|d| &d.identity)
            || prior.source_submission_max_hypotheses != request.source_submission_max_hypotheses
            || prior.web_submission_max_hypotheses != request.web_submission_max_hypotheses
            || prior.source_snapshot_tools != request.source_snapshot_tools
            || prior.source_review_operation_id != request.source_review_operation_id
            || prior.plugin_tools != request.plugin_tools
            || parent.payload.get("plugin_context") != plugins.map(|p| &p.identity)
            || prior.provider != request.provider
            || prior.model != request.model
            || prior.instructions != request.instructions
            || serde_json::to_value(prior.execution_identity())?
                != serde_json::to_value(request.execution_identity())?
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
        if result.source_review.is_some() || result.web_review.is_some() {
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
        agent_delegation::validate_parent_receipts(store, &parent, result.turns)?;
        if turn_limit {
            let input = agent_checkpoint::load(store, session, parent_id, &result)?;
            let last = store.get_operation_by_command(
                session,
                &format!("{parent_id}:model:{}", result.turns - 1),
            )?;
            let model: ResponsesRequest = serde_json::from_value(last.payload["request"].clone())?;
            let state = agent_context::load(store, &parent, &last, &model)?;
            if let Some(mut state) = state {
                let completion: zero_protocol::model::Completion =
                    serde_json::from_value(last.outcome.clone().ok_or_else(|| {
                        EngineError::State("missing checkpoint completion".into())
                    })?)?;
                let offset = state.input().len() + completion.replay.len();
                state
                    .append_round(
                        &last.id,
                        &completion,
                        input
                            .get(offset..)
                            .ok_or_else(|| {
                                EngineError::State("checkpoint output boundary mismatch".into())
                            })?
                            .to_vec(),
                    )
                    .map_err(|e| EngineError::State(e.to_string()))?;
                if state.input() != input {
                    return Err(EngineError::State("checkpoint full state mismatch".into()));
                }
                history = agent_context::History {
                    input,
                    state: Some(state),
                };
            } else {
                history = agent_context::History::new(input, request.context_policy.as_ref())?;
            }
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
                serde_json::from_value(last.outcome.clone().ok_or_else(|| {
                    EngineError::State("continuation provider outcome is absent".into())
                })?)?;
            if completion.status != zero_protocol::model::CompletionStatus::Completed
                || completion.replay.is_empty()
            {
                return Err(EngineError::State(
                    "continuation has no complete replay data".into(),
                ));
            }
            if let Some(mut state) = agent_context::load(store, &parent, &last, &model)? {
                state
                    .append_round(&last.id, &completion, vec![])
                    .map_err(|e| EngineError::State(e.to_string()))?;
                history = agent_context::History {
                    input: state.input(),
                    state: Some(state),
                };
            } else {
                let mut input = model.input;
                input.extend(completion.replay);
                history = agent_context::History::new(input, request.context_policy.as_ref())?;
            }
        }
    }
    history.append_user(&request.prompt)?;
    Ok(history)
}

fn model_request(
    request: &AgentRequest,
    input: Vec<serde_json::Value>,
    plugins: Option<&agent_plugins::Context>,
) -> ResponsesRequest {
    let mut model = ResponsesRequest{model:request.model.clone(),instructions:request.instructions.clone(),input,max_output_tokens:8192,
        tools:vec![ToolDefinition{name:"execute_snapshot".into(),description:"Run an argv vector in the explicitly pinned offline snapshot sandbox. This cannot change the image, mounts, networking, limits or host files. The working copy is disposable for each call.".into(),
            parameters:serde_json::json!({"type":"object","properties":{"argv":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":128}},"required":["argv"],"additionalProperties":false})}]};
    if request.execution.is_none() {
        model.tools.clear();
    }
    if let Some(max) = request.web_submission_max_hypotheses {
        model.tools.push(agent_web::definition(max));
    }
    if request.http_profile.is_some() {
        model.tools.push(agent_http::definition());
    }
    if request.operator_questions {
        model.tools.push(agent_questions::definition());
    }
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
    if let Some(policy) = &request.delegation_policy {
        model.tools.push(agent_delegation::definition(policy));
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
    history: agent_context::History,
    plugins: Option<agent_plugins::Context>,
    http: Option<agent_http::Context>,
    source: Option<Arc<agent_source::Context>>,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    progress_events: Option<mpsc::Sender<ExecutionEvent>>,
    template: ResponsesRequest,
    delegation: Option<agent_delegation::Context>,
    joined: &mut agent_delegation::JoinedTasks,
) -> Result<(AgentResult, Vec<serde_json::Value>), EngineError> {
    let mut input = history.input;
    let mut context_state = history.state;
    let mut output = AgentResult {
        status: AgentStatus::TurnLimit,
        text: String::new(),
        turns: 0,
        tool_calls: 0,
        error: None,
        continuation_artifact: None,
        source_recovery_path: None,
        source_review: None,
        web_review: None,
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
        // This immutable pending prefix is captured only by the following
        // durable inference admission; newly accepted messages wait a boundary.
        let steering =
            lock(&shared.store)?.pending_agent_steering(session, parent, &shared.owner)?;
        for message in &steering {
            if let Some(state) = &mut context_state {
                if let Err(error) = state.append_user(&message.prompt) {
                    output.status = AgentStatus::Failed;
                    output.error = Some(error.to_string());
                    break 'turns;
                }
            }
            input.push(serde_json::json!({"role":"user","content":message.prompt}));
        }
        let projected = match agent_context::project_input(
            &input,
            context_state.as_ref(),
            request.context_policy.as_ref(),
        ) {
            Ok(input) => input,
            Err(error) => {
                output.status = AgentStatus::Failed;
                output.error = Some(error.to_string());
                break;
            }
        };
        let mut model = template.clone();
        model.input = projected;
        // Adaptive evidence must be retainable before another provider charge.
        if (request.source_submission_max_hypotheses.is_some()
            || request.web_submission_max_hypotheses.is_some())
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
        if !steering.is_empty() {
            child_payload["steering"] = serde_json::to_value(&steering)?;
        }
        if let (Some(state), Some(policy)) =
            (context_state.as_ref(), request.context_policy.as_ref())
        {
            match agent_context::retain(shared, parent, turn, state, policy, &model) {
                Ok(binding) => child_payload["context"] = binding,
                Err(error) => {
                    output.status = AgentStatus::Failed;
                    output.error = Some(error.to_string());
                    break;
                }
            }
        }
        let child = lock(&shared.store)?.admit_steered_inference(
            session,
            parent,
            &shared.owner,
            &format!("{parent}:model:{turn}"),
            &child_payload,
            &steering,
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
            progress_events.clone(),
            Some(parent),
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
        if let Some(max) = request.web_submission_max_hypotheses {
            if calls
                .iter()
                .any(|(_, name, _)| name == "submit_web_hypotheses")
            {
                let prepared = {
                    let store = lock(&shared.store)?;
                    let operation = store.get_operation(parent)?;
                    agent_web::prepare(&store, &operation, max, model.clone(), completion.clone())
                };
                if cancel.is_cancelled() {
                    output.status = AgentStatus::Cancelled;
                    break;
                }
                match prepared
                    .and_then(|prepared| agent_web::retain(shared, parent, &child.id, prepared))
                {
                    Ok(review) => {
                        output.web_review = Some(review);
                        output.status = AgentStatus::Completed;
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
                output.error =
                    Some("structured web submission required; final prose is not a review".into());
                break;
            }
        }
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
            if let Some(state) = &mut context_state {
                if let Err(error) = state.append_round(&child.id, &completion, vec![]) {
                    output.status = AgentStatus::Failed;
                    output.error = Some(error.to_string());
                    break;
                }
            }
            input.extend(completion.replay.clone());
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
            if output.status == AgentStatus::Completed
                && turn + 1 < request.max_turns
                && !cancel.is_cancelled()
                && !lock(&shared.store)?.seal_agent_steering(
                    session,
                    parent,
                    &shared.owner,
                    false,
                )?
            {
                // A final answer raced an accepted operator message. Preserve
                // that exact replay, then service the inbox without extra turns.
                output.status = AgentStatus::TurnLimit;
                output.text.clear();
                continue;
            }
            break;
        }
        if calls.len() > 32 {
            output.status = AgentStatus::Failed;
            output.error = Some("provider requested too many tools in one turn".into());
            break;
        }
        input.extend(completion.replay.clone());
        let outputs_start = input.len();
        for (index, (id, name, arguments)) in calls.into_iter().enumerate() {
            if cancel.is_cancelled() {
                output.status = AgentStatus::Cancelled;
                break 'turns;
            }
            if !model.tools.iter().any(|tool| tool.name == name) {
                input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":"Tool rejected: tool was not offered by the host."}));
                continue;
            }
            if name == "ask_operator" && request.operator_questions {
                let question = serde_json::from_value::<
                    zero_protocol::questions::OperatorQuestionRequest,
                >(arguments.clone())
                .map_err(|e| e.to_string())
                .and_then(|q| q.validate().map(|_| q).map_err(|e| e.to_string()));
                let question = match question {
                    Ok(question) => question,
                    Err(error) => {
                        input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":format!("Tool rejected: {error}")}));
                        continue;
                    }
                };
                let answer = agent_questions::run(
                    shared,
                    session,
                    parent,
                    &format!("{parent}:tool:{turn}:{index}"),
                    &id,
                    &child,
                    &question,
                    &cancel,
                    &events,
                )
                .await?;
                output.tool_calls += 1;
                let Some(answer) = answer else {
                    output.status = AgentStatus::Cancelled;
                    break 'turns;
                };
                input.push(
                    serde_json::json!({"type":"function_call_output","call_id":id,"output":answer}),
                );
                continue;
            }
            if name == "delegate_tasks" && request.delegation_policy.is_some() {
                let Some(context) = delegation.as_ref() else {
                    input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":"Tool rejected: delegated actors cannot create children."}));
                    continue;
                };
                let batch = match context.prepare(shared, session, &request, arguments, joined.used)
                {
                    Ok(batch) => batch,
                    Err(error) => {
                        input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":format!("Tool rejected: {error}")}));
                        continue;
                    }
                };
                let result = agent_delegation::run_joined(
                    shared,
                    session,
                    parent,
                    &format!("{parent}:tool:{turn}:{index}"),
                    &id,
                    context,
                    batch,
                    joined,
                    cancel.clone(),
                    events.clone(),
                    progress_events.clone(),
                )
                .await?;
                output.tool_calls += 1;
                if result.uncertain {
                    output.status = AgentStatus::Unknown;
                    output.error =
                        Some("delegated child completion or cleanup is uncertain".into());
                    break 'turns;
                }
                if cancel.is_cancelled() {
                    output.status = AgentStatus::Cancelled;
                    break 'turns;
                }
                input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":result.output}));
                continue;
            }
            if let Some(context) = http.as_ref().filter(|_| name == "http_request") {
                let prepared = match context.prepare(arguments.clone()) {
                    Ok(request) => request,
                    Err(reason) => {
                        input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":format!("Tool rejected: {reason}")}));
                        continue;
                    }
                };
                let command = format!("{parent}:tool:{turn}:{index}");
                let result = if agent_approvals::required(&request, &name) {
                    agent_approvals::run(
                        shared,
                        session,
                        parent,
                        &command,
                        &child,
                        &id,
                        &name,
                        agent_approvals::Effect::Http {
                            context: context.clone(),
                            request: prepared,
                        },
                        &cancel,
                        &events,
                    )
                    .await?
                } else {
                    let op = child_operation(
                        shared,
                        session,
                        &command,
                        &context.payload(parent, &id, &prepared),
                    )?;
                    let op =
                        agent_http::execute_admitted(shared, op, context, prepared, cancel.clone())
                            .await?;
                    match op.status {
                        OperationStatus::Failed
                            if op
                                .outcome
                                .as_ref()
                                .is_some_and(|v| v["error_code"] == "http_preparation_failed") =>
                        {
                            agent_approvals::ResultKind::Failed(
                                "HTTP preparation failed before dispatch".into(),
                            )
                        }
                        OperationStatus::Unknown => agent_approvals::ResultKind::Unknown(
                            "HTTP dispatch or response is uncertain".into(),
                        ),
                        OperationStatus::Cancelled => agent_approvals::ResultKind::Cancelled,
                        _ => agent_approvals::ResultKind::Output(agent_http::validate_receipt(
                            &*lock(&shared.store)?,
                            &op,
                        )?),
                    }
                };
                output.tool_calls += 1;
                match result {
                    agent_approvals::ResultKind::Output(value)=>input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":value})),
                    agent_approvals::ResultKind::Cancelled=>{output.status=AgentStatus::Cancelled;break 'turns;},
                    agent_approvals::ResultKind::Unknown(reason)=>{output.status=AgentStatus::Unknown;output.error=Some(reason);break 'turns;},
                    agent_approvals::ResultKind::Failed(reason)=>{output.status=AgentStatus::Failed;output.error=Some(reason);break 'turns;},
                }
                if cancel.is_cancelled() {
                    output.status = AgentStatus::Cancelled;
                    break 'turns;
                }
                continue;
            }
            if let Some(bundle) = source.as_ref().filter(|_| agent_source::is_tool(&name)) {
                let context = Arc::clone(bundle);
                let tool = name.clone();
                let args = arguments.clone();
                let offered = model
                    .tools
                    .iter()
                    .find(|definition| definition.name == name)
                    .cloned();
                // The read owns its context until completion; cancellation must
                // await it before cleanup, without blocking runtime threads.
                let result = tokio::task::spawn_blocking(move || {
                    agent_source::invoke(&context, &tool, args, offered.as_ref())
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
                if agent_approvals::required(&request, &name) {
                    let result = agent_approvals::run(
                        shared,
                        session,
                        parent,
                        &format!("{parent}:tool:{turn}:{index}"),
                        &child,
                        &id,
                        &name,
                        agent_approvals::Effect::Plugin {
                            context: context.clone(),
                            binding: binding.clone(),
                            input: arguments.clone(),
                        },
                        &cancel,
                        &events,
                    )
                    .await?;
                    output.tool_calls += 1;
                    match result {
                        agent_approvals::ResultKind::Output(value)=>input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":value})),
                        agent_approvals::ResultKind::Cancelled=>{output.status=AgentStatus::Cancelled;break 'turns;},
                        agent_approvals::ResultKind::Unknown(reason)=>{output.status=AgentStatus::Unknown;output.error=Some(reason);break 'turns;},
                        agent_approvals::ResultKind::Failed(reason)=>{output.status=AgentStatus::Failed;output.error=Some(reason);break 'turns;},
                    }
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
            let mut execution = request
                .snapshot_request()
                .map_err(|e| EngineError::State(e.to_string()))?;
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
            if agent_approvals::required(&request, &name) {
                let result = agent_approvals::run(
                    shared,
                    session,
                    parent,
                    &format!("{parent}:tool:{turn}:{index}"),
                    &child,
                    &id,
                    &name,
                    agent_approvals::Effect::Snapshot(execution),
                    &cancel,
                    &events,
                )
                .await?;
                output.tool_calls += 1;
                match result {
                    agent_approvals::ResultKind::Output(value)=>input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":value})),
                    agent_approvals::ResultKind::Cancelled=>{output.status=AgentStatus::Cancelled;break 'turns;},
                    agent_approvals::ResultKind::Unknown(reason)=>{output.status=AgentStatus::Unknown;output.error=Some(reason);break 'turns;},
                    agent_approvals::ResultKind::Failed(reason)=>{output.status=AgentStatus::Failed;output.error=Some(reason);break 'turns;},
                }
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
        if let Some(state) = &mut context_state {
            if let Err(error) =
                state.append_round(&child.id, &completion, input[outputs_start..].to_vec())
            {
                output.status = AgentStatus::Failed;
                output.error = Some(error.to_string());
                break;
            }
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

pub(super) fn run_actor<'a>(
    shared: &'a Arc<Shared>,
    session: &'a str,
    parent: &'a str,
    actor: PreparedActor,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    progress_events: Option<mpsc::Sender<ExecutionEvent>>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Reply, EngineError>> + Send + 'a>> {
    Box::pin(async move {
        let _target = agent_steering::TargetGuard::enter(shared, session, parent, &cancel)?;
        let PreparedActor {
            request,
            profile,
            history: input,
            plugins,
            http,
            mut source,
            template,
            delegation,
            checkpoint,
        } = actor;
        let empty = |status, error| AgentResult {
            status,
            text: String::new(),
            turns: 0,
            tool_calls: 0,
            error,
            continuation_artifact: None,
            source_recovery_path: None,
            source_review: None,
            web_review: None,
        };
        let mut preparation_error = None;
        if request.source_snapshot_tools {
            let pin = request
                .snapshot_request()
                .map_err(|e| EngineError::State(e.to_string()))?
                .snapshot;
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
        let mut joined = agent_delegation::JoinedTasks::new();
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
                input.input,
            ))
        } else {
            match std::panic::AssertUnwindSafe(run_rounds(
                shared,
                session,
                parent,
                request,
                profile,
                input,
                plugins,
                http,
                source.clone(),
                cancel.clone(),
                events,
                progress_events,
                template,
                delegation,
                &mut joined,
            ))
            .catch_unwind()
            .await
            {
                Ok(result) => result,
                Err(_) => Err(EngineError::State(
                    "agent round panicked; owned children require reconciliation".into(),
                )),
            }
        };
        // Never drop/abort joined actors when the round future errors or unwinds.
        // Their own source copies/backend cleanup must finish before root settlement.
        let sealed = lock(&shared.store).and_then(|mut store| {
            Ok(store.seal_agent_steering(session, parent, &shared.owner, true)?)
        });
        let drained = joined.drain(shared, &cancel).await;
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
                if let zero_source::snapshot_investigation::SnapshotError::Cleanup { path } = &error
                {
                    recovery = Some(path.to_string_lossy().into_owned());
                }
                Some(error.to_string())
            }
            Err(error) => Some(error.to_string()),
        };
        let (mut output, input) = match work.and_then(|value| sealed.and(drained).map(|_| value)) {
            Ok(value) => value,
            Err(error) => {
                // Unexpected actor/journal failures close admission; all already
                // owned work is cancelled and drained before releasing its lock.
                if let Ok(mut control) = shared.control.lock() {
                    control.closing = true;
                    for active in control.active.values() {
                        active.cancel.cancel();
                    }
                }
                let mut output = empty(
                    AgentStatus::Unknown,
                    Some(match cleanup_error {
                        Some(cleanup) => format!("{error}; {cleanup}"),
                        None => error.to_string(),
                    }),
                );
                output.source_recovery_path = recovery;
                return settle_agent(shared, parent, output);
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
        if output.status == AgentStatus::TurnLimit && checkpoint {
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
                    output.error =
                        Some(format!("could not retain continuation checkpoint: {error}"));
                }
            }
        }
        settle_agent(shared, parent, output)
    })
}
