//! Logical edit generations and joined disposable test copies owned by one actor.
use super::*;
use zero_protocol::workspace_edit::{WorkspaceCall, WorkspaceCapture};
#[derive(Default)]
pub(super) struct Stages {
    stages: Vec<zero_executor::StagedSnapshot>,
}
impl Stages {
    pub async fn drain(&mut self) -> Result<(), EngineError> {
        let stages = std::mem::take(&mut self.stages);
        tokio::task::spawn_blocking(move || {
            let mut failures = vec![];
            for stage in stages {
                let path = stage.root().to_path_buf();
                if let Err(e) = stage.remove() {
                    failures.push(format!("{}: {e}", path.display()));
                }
            }
            if failures.is_empty() {
                Ok(())
            } else {
                Err(EngineError::State(format!(
                    "workspace staging cleanup uncertain: {}",
                    failures.join("; ")
                )))
            }
        })
        .await
        .map_err(|e| EngineError::State(e.to_string()))?
    }
}
fn check(cancel: &CancellationToken, deadline: u64) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("workspace cancelled".into());
    }
    if agent_interactive::now().map_err(|e| e.to_string())? >= deadline {
        return Err("workspace original deadline elapsed".into());
    }
    Ok(())
}
pub(super) async fn prepare(
    shared: &Arc<Shared>,
    parent: &str,
    request: &zero_protocol::agent::AgentRequest,
    cancel: &CancellationToken,
) -> Result<(), EngineError> {
    if request.workspace_policy.is_none() {
        return Ok(());
    }
    let capture: WorkspaceCapture = serde_json::from_value(
        lock(&shared.store)?.get_operation(parent)?.payload["workspace_capture"].clone(),
    )?;
    let pin = request
        .snapshot_request()
        .map_err(|e| EngineError::State(e.to_string()))?
        .snapshot;
    let token = cancel.clone();
    let source = tokio::task::spawn_blocking(move || {
        zero_executor::capture_source_archive(&pin, &|| check(&token, capture.deadline_at_ms))
    })
    .await
    .map_err(|e| EngineError::State(e.to_string()))?
    .map_err(EngineError::State)?;
    lock(&shared.store)?.prepare_workspace(parent, &shared.owner, &source)?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn call(
    shared: &Arc<Shared>,
    parent: &str,
    request: &zero_protocol::agent::AgentRequest,
    turn: u32,
    index: usize,
    id: &str,
    name: &str,
    args: &serde_json::Value,
    cancel: &CancellationToken,
    events: &mpsc::Sender<ExecutionEvent>,
    stages: &mut Stages,
) -> Result<serde_json::Value, EngineError> {
    let call = match WorkspaceCall::parse(name, args) {
        Ok(call) => call,
        Err(error) => return Ok(serde_json::json!({"rejected":error})),
    };
    let state = lock(&shared.store)?.workspace_state(parent)?;
    check(cancel, state.capture.deadline_at_ms).map_err(EngineError::State)?;
    if !call.is_edit() && !matches!(call, WorkspaceCall::Execute { .. }) {
        return Ok(match zero_workspace::observe(&state.current, &call) {
            Ok(v) => v,
            Err(error) => serde_json::json!({"rejected":error}),
        });
    }
    if call.is_edit() {
        if let Err(error) = zero_workspace::propose(&state.current, &state.policy, &call) {
            return Ok(serde_json::json!({"rejected":error}));
        }
    }
    let invocation = zero_store::WorkspaceInvocation {
        turn,
        index,
        call_id: id.into(),
    };
    if let WorkspaceCall::Execute {
        argv,
        expected_generation,
    } = &call
    {
        if zero_workspace::generation(&state.current).map_err(EngineError::State)?
            != *expected_generation
        {
            return Ok(
                serde_json::json!({"rejected":"workspace generation changed; inspect current workspace"}),
            );
        }
        let mut execution = request
            .snapshot_request()
            .map_err(|e| EngineError::State(e.to_string()))?;
        execution.argv = argv.clone();
        execution.execution_id = format!("workspace-{}", uuid::Uuid::new_v4());
        execution.timeout_ms = execution.timeout_ms.min(
            state
                .capture
                .deadline_at_ms
                .saturating_sub(agent_interactive::now()?),
        );
        if let Err(error) = execution.validate() {
            return Ok(serde_json::json!({"rejected":error.to_string()}));
        }
        lock(&shared.store)?.claim_workspace_effect(parent, &shared.owner, &invocation, &call)?;
        let token = cancel.clone();
        let deadline = state.capture.deadline_at_ms;
        let archive = state.current;
        #[cfg(all(test, target_os = "linux"))]
        let stage_session = state.actor.session_id.clone();
        let (stage, pin) = tokio::task::spawn_blocking(move || {
            #[cfg(all(test, target_os = "linux"))]
            crate::workspace_dispatch_tests::pause_staging(&stage_session);
            zero_executor::stage_source_archive(&archive, &|| check(&token, deadline))
        })
        .await
        .map_err(|e| EngineError::State(e.to_string()))?
        .map_err(EngineError::State)?;
        stages.stages.push(stage);
        execution.snapshot = pin;
        check(cancel, deadline).map_err(EngineError::State)?;
        let child = agent::child_operation(
            shared,
            &state.actor.session_id,
            &format!("{parent}:workspace:{turn}:{index}"),
            &serde_json::json!({"kind":"agent_workspace_test","parent_operation":parent,"workspace_generation":expected_generation,"invocation":invocation,"request":execution}),
        )?;
        check(cancel, deadline).map_err(EngineError::State)?;
        let reply = sandbox::run_sandbox_owned(
            shared,
            &child.id,
            execution,
            cancel.clone(),
            events.clone(),
        )
        .await;
        let cleanup = stages.drain().await;
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                let mut store = lock(&shared.store)?;
                let current = store.get_operation(&child.id)?;
                if current.status == OperationStatus::Running
                    && current.owner.as_deref() == Some(&shared.owner)
                {
                    store.mark_operation_unknown_with_outcome(
                        &child.id,
                        &shared.owner,
                        &serde_json::json!({"error":error.to_string(),"detail":"workspace test dispatch or settlement uncertain"}),
                    )?;
                }
                cleanup?;
                return Err(error);
            }
        };
        cleanup?;
        let Reply::Sandbox {
            operation,
            result: Some(result),
            ..
        } = reply
        else {
            return Err(EngineError::State("workspace test result uncertain".into()));
        };
        if operation.status == OperationStatus::Unknown
            || matches!(
                result.cleanup,
                zero_protocol::sandbox::SandboxCleanup::Unknown { .. }
                    | zero_protocol::sandbox::SandboxCleanup::Unconfirmed { .. }
            )
        {
            return Err(EngineError::State(
                "workspace test cleanup uncertain".into(),
            ));
        }
        Ok(
            serde_json::json!({"generation":expected_generation,"operation_id":operation.id,"assessment":"unverified","status":result.status,"exit_code":result.exit_code,"stdout_text":String::from_utf8_lossy(&result.stdout),"stderr_text":String::from_utf8_lossy(&result.stderr),"error":result.error}),
        )
    } else {
        let receipt = lock(&shared.store)?
            .claim_workspace_effect(parent, &shared.owner, &invocation, &call)?
            .ok_or_else(|| EngineError::State("workspace edit receipt absent".into()))?;
        Ok(
            serde_json::json!({"assessment":"unverified","generation":receipt.after_generation,"receipt":receipt}),
        )
    }
}
