//! Separately authorized archive-backed verification with joined cancellation.
use super::*;
use zero_protocol::{review::ReviewCloseReason, review_reproduction::ReviewReproductionPlan};

fn error(value: impl std::fmt::Display) -> EngineError {
    EngineError::State(value.to_string())
}
fn now() -> Result<u64, EngineError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(error)?
        .as_millis()
        .try_into()
        .map_err(error)
}
impl Engine {
    /// Host-only verification. Exact retries inspect retained state before source
    /// reconstruction or backend access; no model receives this authority.
    pub async fn reproduce_review(
        &self,
        command: String,
        authorization: ReviewReproductionPlan,
        events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            let mut store = lock(&self.shared.store)?;
            let previous = store.native_reproduction_by_command(&command)?;
            let admission = if let Some(record) = previous {
                zero_store::NativeReproductionAdmission {
                    id: record.id,
                    session_id: record.session_id,
                    operation_id: record.operation_id,
                    source_operation_sha256: record.source_operation_sha256,
                    authorization,
                }
            } else {
                if control.closing || control.active.len() >= 64 {
                    return Err(error("engine closing or active operation limit reached"));
                }
                // Authenticate the source before capturing its exact operation hash.
                super::review_reproduction::validate_authorization(&store, &authorization)?;
                let operation = store.get_operation(&authorization.source_operation_id)?;
                let source_operation_sha256 = format!(
                    "sha256:{}",
                    zero_plugin::sha256(&serde_json::to_vec(&serde_json::to_value(operation)?)?)
                );
                zero_store::NativeReproductionAdmission {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: uuid::Uuid::new_v4().to_string(),
                    operation_id: uuid::Uuid::new_v4().to_string(),
                    source_operation_sha256,
                    authorization,
                }
            };
            let admitted =
                store.admit_native_reproduction(&command, &self.shared.owner, &admission)?;
            if admitted.duplicate {
                let view = store.native_reproduction_read_snapshot(&admitted.record.id)?;
                return workflow_provenance::native_reproduction(&view, &admitted.record.id);
            }
            drop(store);
            let cancel = CancellationToken::new();
            let record = admitted.record;
            control.active.insert(
                record.session_id.clone(),
                Active {
                    command_id: command.clone(),
                    execution_id: command,
                    cancel: cancel.clone(),
                },
            );
            emit_admission(
                &events,
                &admitted.operation,
                &admitted.operation.command_id,
                &cancel,
            );
            let mut guard = WorkerGuard::new(
                self.shared.clone(),
                &record.session_id,
                &record.operation_id,
                cancel.clone(),
            );
            let (tx, rx) = oneshot::channel();
            tokio::spawn(async move {
                let result = owned(
                    &guard.shared,
                    &record,
                    admission.authorization,
                    cancel,
                    events,
                )
                .await;
                guard.settled = result.is_ok();
                drop(guard);
                let _ = tx.send(result);
            });
            rx
        };
        receiver
            .await
            .map_err(|_| error("native reproduction owner ended without settlement"))?
    }
}
async fn owned(
    shared: &Arc<Shared>,
    record: &zero_protocol::review_reproduction::NativeReproductionRecord,
    authorization: ReviewReproductionPlan,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    let work = run(shared, record, authorization, cancel.clone(), events);
    tokio::pin!(work);
    let remaining = record.deadline_at_ms.saturating_sub(now()?);
    tokio::select! {
        result = &mut work => result,
        _ = tokio::time::sleep(std::time::Duration::from_millis(remaining)) => {
            let closed = lock(&shared.store).and_then(|mut store| Ok(store.stop_native_reproduction(&record.id, &shared.owner, ReviewCloseReason::Deadline)?));
            cancel.cancel();
            let result = work.await;
            closed?;
            result
        },
        _ = cancel.cancelled() => {
            let closed = lock(&shared.store).and_then(|mut store| Ok(store.stop_native_reproduction(&record.id, &shared.owner, ReviewCloseReason::Cancelled)?));
            let result = work.await;
            closed?;
            result
        }
    }
}
fn settle(
    shared: &Shared,
    record: &zero_protocol::review_reproduction::NativeReproductionRecord,
    cancel: &CancellationToken,
    outcome: zero_protocol::verification::ReproductionOutcome,
    status: OperationStatus,
) -> Result<Reply, EngineError> {
    let mut store = lock(&shared.store)?;
    let operation = store.settle_native_reproduction(
        &record.id,
        &shared.owner,
        status,
        &outcome,
        cancel.is_cancelled(),
    )?;
    let result = operation
        .outcome
        .clone()
        .map(serde_json::from_value)
        .transpose()?;
    Ok(Reply::SourceReproduction {
        operation,
        result,
        duplicate: false,
    })
}
async fn run(
    shared: &Arc<Shared>,
    record: &zero_protocol::review_reproduction::NativeReproductionRecord,
    authorization: ReviewReproductionPlan,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    let preparation =
        lock(&shared.store)?.begin_native_reproduction_preparation(&record.id, &shared.owner);
    let prepared = match preparation {
        Err(e) => Err(error(e)),
        Ok(()) => {
            let path = shared.state_path.clone();
            let deadline = record.deadline_at_ms;
            let stop = cancel.clone();
            // Independent read connection keeps the owner's cancellation journal
            // writable while bounded archive IO drains on the blocking worker.
            tokio::task::spawn_blocking(move || {
                let store = Store::open_read_only(path)?;
                super::review_reproduction::prepare(&store, &authorization, &|| {
                    if stop.is_cancelled() || now().map_err(|e| e.to_string())? >= deadline {
                        Err("native reproduction preparation cancelled or expired".into())
                    } else {
                        Ok(())
                    }
                })
            })
            .await
            .map_err(error)?
        }
    };
    let prepared = match prepared {
        Ok(value) => value,
        Err(e) => {
            let mut outcome = reproduction::empty_outcome();
            outcome.error = Some(e.to_string());
            let status = if matches!(e, EngineError::CleanupUnconfirmed(_)) {
                OperationStatus::Unknown
            } else if cancel.is_cancelled() || now()? >= record.deadline_at_ms {
                outcome.stop_reason =
                    Some(zero_protocol::verification::ReproductionStop::Cancelled);
                OperationStatus::Cancelled
            } else {
                OperationStatus::Failed
            };
            return settle(shared, record, &cancel, outcome, status);
        }
    };
    let binding = lock(&shared.store)?.bind_native_reproduction_source(
        &record.id,
        &shared.owner,
        prepared.execution_plan().plan(),
        prepared.binding(),
    );
    let result = match binding {
        Ok(()) => {
            reproduction::matrix_with_authority(
                shared,
                &record.session_id,
                &record.operation_id,
                prepared.execution_plan(),
                cancel.clone(),
                events,
                "reproduction",
                Some(&record.id),
            )
            .await
        }
        Err(e) => {
            let mut outcome = reproduction::empty_outcome();
            outcome.error = Some(e.to_string());
            Ok((outcome, OperationStatus::Failed))
        }
    };
    // The matrix joins the sandbox supervisor; guest copies have independent
    // ownership. No future may still use this private preparation directory.
    let cleanup = tokio::task::spawn_blocking(move || prepared.remove())
        .await
        .map_err(error)?;
    let (mut outcome, mut status) = result?;
    if let Err(e) = cleanup {
        outcome.error = Some(format!("private reconstruction cleanup failed: {e}"));
        status = OperationStatus::Unknown;
    }
    settle(shared, record, &cancel, outcome, status)
}

/// Independently reassess retained native observations without source/config IO.
pub fn read_review_reproduction(state: &Path, key: &str) -> Result<Reply, EngineError> {
    let store = Store::open_read_only(state)?;
    let view = store.native_reproduction_read_snapshot(key)?;
    workflow_provenance::native_reproduction(&view, key)
}

/// Command retries bind the caller's complete authorization inside the pinned
/// evidence view before reusing any retained assessment.
pub fn read_review_reproduction_for_command(
    state: &Path,
    command: &str,
    expected: &ReviewReproductionPlan,
) -> Result<Option<Reply>, EngineError> {
    let store = match Store::open_read_only(state) {
        Ok(store) => store,
        // Native reproduction did not exist before schema20. A fresh owned
        // admission will validate and migrate the exact historical schema.
        Err(zero_store::Error::Schema(1..=19)) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let Some(record) = store.native_reproduction_by_command(command)? else {
        return Ok(None);
    };
    let view = store.native_reproduction_read_snapshot(&record.id)?;
    let captured = view.native_reproduction_authorization(&record.id)?;
    if serde_json::to_value(&captured)? != serde_json::to_value(expected)? {
        return Err(error(
            "reproduction command conflicts with retained host authorization",
        ));
    }
    Ok(Some(workflow_provenance::native_reproduction(
        &view, &record.id,
    )?))
}
