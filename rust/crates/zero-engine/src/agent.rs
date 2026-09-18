//! Bounded session actor. Model output selects only the explicitly offered tool.
use super::*;
use zero_protocol::{
    agent::{AgentRequest, AgentResult, AgentStatus},
    model::{Content, ResponsesRequest, ToolDefinition},
};

impl Engine {
    pub(super) async fn run_agent(
        &self,
        session_id: String,
        command_id: String,
        request: AgentRequest,
        events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
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
        let initial = model_request(
            &request,
            vec![serde_json::json!({"role":"user","content":request.prompt})],
        );
        zero_provider::validate_request(&initial).map_err(|e| EngineError::State(e.to_string()))?;
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            if control.closing {
                return Err(EngineError::State("engine is shutting down".into()));
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
            let mut store = lock(&self.shared.store)?;
            let mut payload = serde_json::json!({"kind":"offline_snapshot_agent","request":request,"endpoint":profile.client.endpoint_identity(),"rates":profile.rates});
            if profile.client.wire_api() != zero_protocol::model::WireApi::Responses {
                payload["wire_api"] = serde_json::to_value(profile.client.wire_api())?;
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
            tokio::spawn(async move {
                let mut guard =
                    WorkerGuard::new(&shared, &session_id, &operation.id, cancel.clone());
                let result = run_actor(
                    &shared,
                    &session_id,
                    &operation.id,
                    request,
                    profile,
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

fn model_request(request: &AgentRequest, input: Vec<serde_json::Value>) -> ResponsesRequest {
    ResponsesRequest{model:request.model.clone(),instructions:request.instructions.clone(),input,max_output_tokens:8192,
        tools:vec![ToolDefinition{name:"execute_snapshot".into(),description:"Run an argv vector in the explicitly pinned offline snapshot sandbox. This cannot change the image, mounts, networking, limits or host files. The working copy is disposable for each call.".into(),
            parameters:serde_json::json!({"type":"object","properties":{"argv":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":128}},"required":["argv"],"additionalProperties":false})}]}
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
async fn run_actor(
    shared: &Arc<Shared>,
    session: &str,
    parent: &str,
    request: AgentRequest,
    profile: inference::Profile,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    let mut output = AgentResult {
        status: AgentStatus::TurnLimit,
        text: String::new(),
        turns: 0,
        tool_calls: 0,
        error: None,
    };
    let mut input = vec![serde_json::json!({"role":"user","content":request.prompt})];
    'turns: for turn in 0..request.max_turns {
        if cancel.is_cancelled() {
            output.status = AgentStatus::Cancelled;
            break;
        }
        let model = model_request(&request, input.clone());
        // Validate accumulated context before reserving/spending or admitting an effect.
        if profile.client.validate(&model).is_err() {
            output.status = AgentStatus::Failed;
            output.error = Some("agent context exceeds provider request bounds".into());
            break;
        }
        let child = child_operation(
            shared,
            session,
            &format!("{parent}:model:{turn}"),
            &serde_json::json!({"parent_operation":parent,"kind":"agent_inference","request":model,"endpoint":profile.client.endpoint_identity(),"rates":profile.rates,"wire_api":profile.client.wire_api()}),
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
            model,
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
                input.push(serde_json::json!({"type":"function_call_output","call_id":id,"output":"Tool rejected: only execute_snapshot with an argv array is authorized."}));
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
