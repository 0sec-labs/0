use super::*;
use zero_protocol::sandbox::{SandboxCleanup, SandboxRequest, SandboxResult};
impl Engine {
    pub(super) async fn run_sandbox(
        &self,
        session_id: String,
        command_id: String,
        request: SandboxRequest,
        event_tx: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        request
            .validate()
            .map_err(|e| EngineError::State(e.to_string()))?;
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
            let payload = serde_json::json!({"kind":"offline_sandbox_snapshot","request":request});
            let mut store = lock(&self.shared.store)?;
            let admission = store.admit_command(&session_id, &command_id, &payload)?;
            if admission.duplicate {
                let result = admission
                    .operation
                    .outcome
                    .clone()
                    .and_then(|v| serde_json::from_value::<SandboxResult>(v).ok());
                return Ok(Reply::Sandbox {
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
                    command_id,
                    execution_id: request.execution_id.clone(),
                    cancel: cancel.clone(),
                },
            );
            emit_admission(&event_tx, &operation, &request.execution_id, &cancel);
            let shared = Arc::clone(&self.shared);
            let (sender, receiver) = oneshot::channel();
            let mut guard = WorkerGuard::new(shared, &session_id, &operation.id, cancel.clone());
            tokio::spawn(async move {
                let result =
                    run_sandbox_owned(&guard.shared, &operation.id, request, cancel, event_tx)
                        .await;
                guard.settled = result.is_ok();
                drop(guard);
                let _ = sender.send(result);
            });
            receiver
        };
        receiver
            .await
            .map_err(|_| EngineError::State("sandbox owner stopped before settlement".into()))?
    }
}
pub(super) async fn run_sandbox_owned(
    shared: &Arc<Shared>,
    operation_id: &str,
    request: SandboxRequest,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    // Linearize permission against the durable review close/owner frontier
    // immediately before dispatch. Existing non-review workflows are unaffected.
    lock(&shared.store)?.begin_review_effect(
        operation_id,
        &shared.owner,
        &serde_json::to_value(&request)?,
    )?;
    lock(&shared.store)?.begin_workspace_test_dispatch(operation_id, &shared.owner, &request)?;
    let executor = Arc::clone(&shared.sandbox);
    let unavailable = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = Arc::clone(&unavailable);
    let sink_cancel = cancel.clone();
    let sink = Arc::new(move |event| {
        if events.try_send(ExecutionEvent::Sandbox { event }).is_err() {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            sink_cancel.cancel();
        }
    });
    let result = tokio::spawn(async move { executor.execute(request, cancel, sink).await }).await;
    match result {
        Ok(mut result) => {
            if unavailable.load(std::sync::atomic::Ordering::Relaxed) {
                result.error =
                    Some("event consumer unavailable; sandbox execution cancelled".into());
                if result.status == ExecutionStatus::Exited {
                    result.status = ExecutionStatus::Cancelled;
                }
            }
            let uncertain = matches!(
                result.cleanup,
                SandboxCleanup::Unknown { .. } | SandboxCleanup::Unconfirmed { .. }
            );
            let outcome = serde_json::to_value(&result)?;
            let mut store = lock(&shared.store)?;
            let operation = if uncertain {
                store.mark_operation_unknown_with_outcome(operation_id, &shared.owner, &outcome)?
            } else {
                let status = match result.status {
                    ExecutionStatus::Cancelled => OperationStatus::Cancelled,
                    ExecutionStatus::Exited
                        if result.exit_code == Some(0)
                            && matches!(result.cleanup, SandboxCleanup::Confirmed) =>
                    {
                        OperationStatus::Succeeded
                    }
                    _ => OperationStatus::Failed,
                };
                store.settle_operation(operation_id, &shared.owner, status, &outcome)?
            };
            Ok(Reply::Sandbox {
                operation,
                result: Some(result),
                duplicate: false,
            })
        }
        Err(_) => {
            let operation = lock(&shared.store)?.mark_operation_unknown(
                operation_id,
                &shared.owner,
                "sandbox worker failed; external outcome uncertain",
            )?;
            Ok(Reply::Sandbox {
                operation,
                result: None,
                duplicate: false,
            })
        }
    }
}
