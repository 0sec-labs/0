//! Separately authorized archive-backed verification with joined cancellation.
use super::*;
use zero_protocol::{
    repair::{RepairPhase, RepairValidationOutcome, RepairValidationStatus},
    review::ReviewCloseReason,
    review_repair::{NativeRepairRecord, ReviewRepairPlan},
    verification::Disposition,
};

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
    pub async fn repair_review(
        &self,
        command: String,
        authorization: ReviewRepairPlan,
        events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            let mut store = lock(&self.shared.store)?;
            let previous = store.native_repair_by_command(&command)?;
            let admission = if let Some(record) = previous {
                zero_store::NativeRepairAdmission {
                    id: record.id,
                    session_id: record.session_id,
                    operation_id: record.operation_id,
                    reproduction_operation_id: record.reproduction_operation_id,
                    reproduction_evidence_sha256: record.reproduction_evidence_sha256,
                    authorization,
                }
            } else {
                if control.closing || control.active.len() >= 64 {
                    return Err(error("engine closing or active operation limit reached"));
                }
                let assessed = super::review_repair::assess(&store, &authorization)?;
                zero_store::NativeRepairAdmission {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: uuid::Uuid::new_v4().to_string(),
                    operation_id: uuid::Uuid::new_v4().to_string(),
                    reproduction_operation_id: assessed.reproduction_operation_id,
                    reproduction_evidence_sha256: assessed.reproduction_evidence_sha256,
                    authorization,
                }
            };
            let admitted = store.admit_native_repair(&command, &self.shared.owner, &admission)?;
            if admitted.duplicate {
                let view = store.native_repair_read_snapshot(&admitted.record.id)?;
                return workflow_provenance::native_repair(&view, &admitted.record.id);
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
            .map_err(|_| error("native repair owner ended without settlement"))?
    }
}
async fn owned(
    shared: &Arc<Shared>,
    record: &zero_protocol::review_repair::NativeRepairRecord,
    authorization: ReviewRepairPlan,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    let work = run(shared, record, authorization, cancel.clone(), events);
    tokio::pin!(work);
    let remaining = record.deadline_at_ms.saturating_sub(now()?);
    tokio::select! {
        result = &mut work => result,
        _ = tokio::time::sleep(std::time::Duration::from_millis(remaining)) => {
            let closed = lock(&shared.store).and_then(|mut store| Ok(store.stop_native_repair(&record.id, &shared.owner, ReviewCloseReason::Deadline)?));
            cancel.cancel();
            let result = work.await;
            closed?;
            result
        },
        _ = cancel.cancelled() => {
            let closed = lock(&shared.store).and_then(|mut store| Ok(store.stop_native_repair(&record.id, &shared.owner, ReviewCloseReason::Cancelled)?));
            let result = work.await;
            closed?;
            result
        }
    }
}
fn empty_outcome() -> RepairValidationOutcome {
    RepairValidationOutcome {
        status: RepairValidationStatus::NotValidated,
        original_plan_digest: None,
        candidate_receipt: None,
        phases: vec![],
        artifacts: Default::default(),
        cleanup_recovery: vec![],
        error: None,
        vulnerability_reportable: false,
    }
}
fn settle(
    shared: &Shared,
    record: &NativeRepairRecord,
    cancel: &CancellationToken,
    outcome: RepairValidationOutcome,
) -> Result<Reply, EngineError> {
    let operation = lock(&shared.store)?.settle_native_repair(
        &record.id,
        &shared.owner,
        &outcome,
        cancel.is_cancelled(),
    )?;
    let result = operation
        .outcome
        .clone()
        .map(serde_json::from_value)
        .transpose()?;
    Ok(Reply::SourceRepair {
        operation,
        result,
        duplicate: false,
    })
}
fn fail(
    output: &mut RepairValidationOutcome,
    cause: impl std::fmt::Display,
    cancel: &CancellationToken,
    deadline: u64,
) {
    output.error = Some(cause.to_string());
    if cancel.is_cancelled() || now().is_ok_and(|time| time >= deadline) {
        output.status = RepairValidationStatus::Cancelled;
    }
}
fn capture_artifacts(
    shared: &Shared,
    record: &NativeRepairRecord,
    output: &mut RepairValidationOutcome,
) -> Result<(), EngineError> {
    for (name, digest) in lock(&shared.store)?.operation_artifacts(&record.operation_id)? {
        if name.starts_with("repair.") {
            output.artifacts.insert(name, digest);
        }
    }
    Ok(())
}
async fn run(
    shared: &Arc<Shared>,
    record: &NativeRepairRecord,
    authorization: ReviewRepairPlan,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    let mut output = empty_outcome();
    let preparation =
        lock(&shared.store)?.begin_native_repair_preparation(&record.id, &shared.owner);
    let prepared = match preparation {
        Err(e) => Err(error(e)),
        Ok(()) => {
            let path = shared.state_path.clone();
            let deadline = record.deadline_at_ms;
            let stop = cancel.clone();
            tokio::task::spawn_blocking(move || {
                let store = Store::open_read_only(path)?;
                super::review_repair::prepare(&store, &authorization, &|| {
                    if stop.is_cancelled() || now().map_err(|e| e.to_string())? >= deadline {
                        Err("native repair preparation cancelled or expired".into())
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
        Ok(prepared) => prepared,
        Err(cause) => {
            fail(&mut output, &cause, &cancel, record.deadline_at_ms);
            if matches!(cause, EngineError::CleanupUnconfirmed(_)) {
                output.status = RepairValidationStatus::Unknown;
            }
            return settle(shared, record, &cancel, output);
        }
    };
    let execution = async {
        let binding = lock(&shared.store)?.bind_native_repair_source(
            &record.id,
            &shared.owner,
            prepared.execution_baseline().plan(),
            prepared.binding(),
            prepared.materialize_request(),
        );
        match binding {
            Err(cause) => fail(&mut output, cause, &cancel, record.deadline_at_ms),
            Ok(()) => {
                output.original_plan_digest = Some(prepared.binding().logical_plan_sha256.clone());
                capture_artifacts(shared, record, &mut output)?;
                for phase in ["candidate", "reconstructed"] {
                    let result = phase_run(
                        shared,
                        record,
                        &prepared,
                        phase,
                        &cancel,
                        events.clone(),
                        &mut output,
                    )
                    .await;
                    match result {
                        Ok(true) => {}
                        Ok(false) => break,
                        Err(cause) => {
                            output.error = Some(cause.to_string());
                            output.status = RepairValidationStatus::Unknown;
                            break;
                        }
                    }
                }
            }
        }
        Ok::<_, EngineError>(())
    }
    .await;
    if let Err(cause) = execution {
        output.error = Some(cause.to_string());
        output.status = RepairValidationStatus::Unknown;
    }
    // All candidate workers are joined before the archive reconstruction is removed.
    let recovery = prepared.recovery_root().to_string_lossy().into_owned();
    let cleanup = tokio::task::spawn_blocking(move || prepared.remove())
        .await
        .map_err(error)
        .and_then(|result| result);
    if let Err(cause) = cleanup {
        output.error = Some(format!("repair baseline cleanup failed: {cause}"));
        output.cleanup_recovery.push(recovery);
        output.status = RepairValidationStatus::Unknown;
    }
    capture_artifacts(shared, record, &mut output)?;
    settle(shared, record, &cancel, output)
}
async fn phase_run(
    shared: &Arc<Shared>,
    record: &NativeRepairRecord,
    prepared: &review_repair::PreparedReviewRepair,
    phase: &str,
    cancel: &CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    output: &mut RepairValidationOutcome,
) -> Result<bool, EngineError> {
    if let Err(cause) =
        lock(&shared.store)?.begin_native_repair_candidate(&record.id, &shared.owner, phase)
    {
        fail(output, cause, cancel, record.deadline_at_ms);
        return Ok(false);
    }
    let spec = prepared.materialize_request().clone();
    let stop = cancel.clone();
    let deadline = record.deadline_at_ms;
    let materialized = tokio::task::spawn_blocking(move || {
        zero_repair::materialize_checked(&spec, &|| {
            if stop.is_cancelled() || now().map_err(|e| e.to_string())? >= deadline {
                Err("native repair materialization cancelled or expired".into())
            } else {
                Ok(())
            }
        })
    })
    .await
    .map_err(error)?;
    let candidate = match materialized {
        Ok(candidate) => candidate,
        Err(cause) => {
            fail(output, &cause, cancel, deadline);
            if let zero_repair::Error::Cleanup { path } = cause {
                output
                    .cleanup_recovery
                    .push(path.to_string_lossy().into_owned());
                output.status = RepairValidationStatus::Unknown;
            }
            return Ok(false);
        }
    };
    let safe = match prepared.candidate_plan(&candidate) {
        Ok(safe) => safe,
        Err(cause) => {
            fail(output, cause, cancel, deadline);
            cleanup_candidate(candidate, output).await?;
            return Ok(false);
        }
    };
    let binding = lock(&shared.store).and_then(|mut store| {
        Ok(store.bind_native_repair_candidate(
            &record.id,
            &shared.owner,
            phase,
            safe.plan(),
            candidate.receipt(),
        )?)
    });
    if let Err(cause) = binding {
        fail(output, cause, cancel, deadline);
        cleanup_candidate(candidate, output).await?;
        return Ok(false);
    }
    output.candidate_receipt = Some(candidate.receipt().clone());
    let matrix = reproduction::repair_matrix(
        shared,
        &record.session_id,
        &record.operation_id,
        &safe,
        cancel.clone(),
        events,
        phase,
        &record.id,
    )
    .await;
    let (observations, status) = match matrix {
        Ok(value) => value,
        Err(cause) => {
            output.error = Some(cause.to_string());
            output.status = RepairValidationStatus::Unknown;
            if let Some(path) = candidate.retain_for_recovery() {
                output
                    .cleanup_recovery
                    .push(path.to_string_lossy().into_owned());
            }
            return Ok(false);
        }
    };
    let observed = observations
        .assessment
        .as_ref()
        .is_some_and(|a| a.disposition == Disposition::ObservedForPlan);
    output.phases.push(RepairPhase {
        name: phase.into(),
        derived_plan_digest: safe.digest().into(),
        observations,
    });
    if status == OperationStatus::Unknown {
        output.status = RepairValidationStatus::Unknown;
        if let Some(path) = candidate.retain_for_recovery() {
            output
                .cleanup_recovery
                .push(path.to_string_lossy().into_owned());
        }
        return Ok(false);
    }
    cleanup_candidate(candidate, output).await?;
    if output.status == RepairValidationStatus::Unknown {
        return Ok(false);
    }
    if status == OperationStatus::Cancelled || cancel.is_cancelled() {
        output.status = RepairValidationStatus::Cancelled;
        return Ok(false);
    }
    if status != OperationStatus::Succeeded || !observed {
        output.error =
            Some("candidate did not satisfy frozen safe observations and controls".into());
        return Ok(false);
    }
    // Store independently re-evaluates retained evidence before permitting phase two.
    let completion = lock(&shared.store)?.complete_native_repair_phase(
        &record.id,
        &shared.owner,
        phase,
        &output
            .phases
            .last()
            .expect("phase retained above")
            .observations,
    );
    if let Err(cause) = completion {
        if cancel.is_cancelled()
            || lock(&shared.store)?.native_repair_closed(&record.id)?
            || now()? >= record.deadline_at_ms
        {
            output.status = RepairValidationStatus::Cancelled;
            output.error = Some(cause.to_string());
            return Ok(false);
        }
        return Err(cause.into());
    }
    if phase == "reconstructed" {
        output.status = RepairValidationStatus::ValidatedCandidateForPlan;
    }
    Ok(true)
}
async fn cleanup_candidate(
    candidate: zero_repair::Candidate,
    output: &mut RepairValidationOutcome,
) -> Result<(), EngineError> {
    let recovery = candidate
        .recovery_root()
        .map(|p| p.to_string_lossy().into_owned());
    let cleanup = tokio::task::spawn_blocking(move || candidate.cleanup()).await;
    match cleanup {
        Ok(Ok(())) => {}
        failure => {
            let recovery = match &failure {
                Ok(Err(zero_repair::Error::Cleanup { path })) => {
                    Some(path.to_string_lossy().into_owned())
                }
                _ => recovery,
            };
            if let Some(path) = recovery {
                output.cleanup_recovery.push(path);
            }
            output.error = Some(match failure {
                Ok(Err(cause)) => cause.to_string(),
                Err(cause) => cause.to_string(),
                Ok(Ok(())) => unreachable!(),
            });
            output.status = RepairValidationStatus::Unknown;
        }
    }
    Ok(())
}

pub fn read_review_repair(state: &Path, key: &str) -> Result<Reply, EngineError> {
    let store = Store::open_read_only(state)?;
    let view = store.native_repair_read_snapshot(key)?;
    workflow_provenance::native_repair(&view, key)
}
pub fn read_review_repair_for_command(
    state: &Path,
    command: &str,
    expected: &ReviewRepairPlan,
) -> Result<Option<Reply>, EngineError> {
    let store = match Store::open_read_only(state) {
        Ok(store) => store,
        Err(zero_store::Error::Schema(1..=20)) => return Ok(None),
        Err(cause) => return Err(cause.into()),
    };
    let Some(record) = store.native_repair_by_command(command)? else {
        return Ok(None);
    };
    let view = store.native_repair_read_snapshot(&record.id)?;
    if serde_json::to_value(view.native_repair_authorization(&record.id)?)?
        != serde_json::to_value(expected)?
    {
        return Err(error(
            "repair command conflicts with retained host authorization",
        ));
    }
    Ok(Some(workflow_provenance::native_repair(&view, &record.id)?))
}
