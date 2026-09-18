//! Host-requested observation plans. Never offered as a model tool.
use super::*;
use serde_json::json;
use zero_protocol::{
    sandbox::{SandboxCleanup, SandboxRequest},
    source::{ReviewResult, SourceReviewOutcome, SourceReviewRequest},
    verification::{
        Disposition, Evidence, ReproductionOutcome, ReproductionStop, SourceReproductionRequest,
    },
};
use zero_verification::FrozenPlan;
fn state(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
impl Engine {
    pub(super) async fn reproduce_source(
        &self,
        session: String,
        command: String,
        request: SourceReproductionRequest,
        events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        let frozen = FrozenPlan::new(request.plan.clone()).map_err(state)?;
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            if control.closing {
                return Err(state("engine is shutting down"));
            }
            if control
                .active
                .get(&session)
                .is_some_and(|a| a.command_id != command)
                || (control.active.len() >= 64 && !control.active.contains_key(&session))
            {
                return Err(state("session busy or active operation limit reached"));
            }
            let operation = {
                let mut store = lock(&self.shared.store)?;
                let admission=store.admit_command(&session,&command,&json!({"kind":"host_source_reproduction","request":request,"plan_digest":frozen.digest()}))?;
                if admission.duplicate {
                    let result = admission
                        .operation
                        .outcome
                        .clone()
                        .and_then(|v| serde_json::from_value(v).ok());
                    return Ok(Reply::SourceReproduction {
                        operation: admission.operation,
                        result,
                        duplicate: true,
                    });
                }
                store.begin_operation(&admission.operation.id, &self.shared.owner)?
            };
            let cancel = CancellationToken::new();
            control.active.insert(
                session.clone(),
                Active {
                    command_id: command.clone(),
                    execution_id: command,
                    cancel: cancel.clone(),
                },
            );
            emit_admission(&events, &operation, &operation.command_id, &cancel);
            let shared = self.shared.clone();
            let (sender, receiver) = oneshot::channel();
            tokio::spawn(async move {
                let mut guard = WorkerGuard::new(&shared, &session, &operation.id, cancel.clone());
                let result = run(
                    &shared,
                    &session,
                    &operation.id,
                    &request.source_operation_id,
                    frozen,
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
            .map_err(|_| state("reproduction owner stopped before settlement"))?
    }
}
fn validate_source(
    shared: &Shared,
    session: &str,
    source_id: &str,
    frozen: &FrozenPlan,
) -> Result<(), EngineError> {
    let store = lock(&shared.store)?;
    let source = store.get_operation(source_id)?;
    if source.session_id != session
        || source.status != OperationStatus::Succeeded
        || source.payload["kind"] != "source_hypothesis_review"
    {
        return Err(state(
            "plan requires a successful source review in this session",
        ));
    }
    let source_request: SourceReviewRequest =
        serde_json::from_value(source.payload["request"].clone())?;
    let outcome: SourceReviewOutcome = serde_json::from_value(
        source
            .outcome
            .ok_or_else(|| state("source outcome missing"))?,
    )?;
    let attachments = store.operation_artifacts(source_id)?;
    for name in ["source.bundle", "source.review"] {
        if !attachments.contains_key(name) || attachments.get(name) != outcome.artifacts.get(name) {
            return Err(state("source attachment differs from outcome"));
        }
    }
    let bundle_id = attachments
        .get("source.bundle")
        .ok_or_else(|| state("bundle absent"))?;
    let review_id = attachments
        .get("source.review")
        .ok_or_else(|| state("review absent"))?;
    let bundle =
        zero_source::SourceBundle::from_bytes(&store.artifact(bundle_id)?).map_err(state)?;
    let review: ReviewResult = serde_json::from_slice(&store.artifact(review_id)?)?;
    if serde_json::to_value(&review)?
        != serde_json::to_value(
            outcome
                .review
                .ok_or_else(|| state("source review absent"))?,
        )?
        || review.bundle_sha256 != *bundle_id
        || bundle.digest() != bundle_id
        || bundle.digest() != frozen.plan().source_bundle_digest
        || review.snapshot_sha256 != bundle.snapshot_digest()
        || bundle.snapshot_digest() != frozen.plan().snapshot.digest
        || !review
            .hypotheses
            .iter()
            .any(|h| h.id == frozen.plan().hypothesis_id)
    {
        return Err(state("plan hypothesis/bundle provenance mismatch"));
    }
    // Exact original root/id/full index; a matching digest alone cannot authorize
    // a different host root. The executor independently verifies bytes per run.
    if serde_json::to_value(&source_request.source.snapshot)?
        != serde_json::to_value(&frozen.plan().snapshot)?
    {
        return Err(state("plan snapshot differs from admitted source snapshot"));
    }
    Ok(())
}
fn retain(
    shared: &Shared,
    parent: &str,
    outcome: &mut ReproductionOutcome,
    name: &str,
    bytes: &[u8],
) -> Result<(), EngineError> {
    let digest =
        lock(&shared.store)?.retain_operation_artifact(parent, &shared.owner, name, bytes)?;
    outcome.artifacts.insert(name.into(), digest);
    Ok(())
}
fn settle(
    shared: &Shared,
    parent: &str,
    outcome: ReproductionOutcome,
    status: OperationStatus,
) -> Result<Reply, EngineError> {
    let value = serde_json::to_value(&outcome)?;
    let mut store = lock(&shared.store)?;
    let operation = if status == OperationStatus::Unknown {
        store.mark_operation_unknown_with_outcome(parent, &shared.owner, &value)?
    } else {
        store.settle_operation(parent, &shared.owner, status, &value)?
    };
    Ok(Reply::SourceReproduction {
        operation,
        result: Some(outcome),
        duplicate: false,
    })
}
#[allow(clippy::too_many_arguments)]
async fn run(
    shared: &Arc<Shared>,
    session: &str,
    parent: &str,
    source: &str,
    frozen: FrozenPlan,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    let mut outcome = ReproductionOutcome {
        assessment: None,
        artifacts: Default::default(),
        children: vec![],
        external_effects_started: false,
        stop_reason: None,
        error: None,
    };
    let preflight = (|| {
        validate_source(shared, session, source, &frozen)?;
        retain(
            shared,
            parent,
            &mut outcome,
            "reproduction.plan",
            &serde_json::to_vec(frozen.plan())?,
        )
    })();
    if let Err(error) = preflight {
        outcome.error = Some(error.to_string());
        return settle(shared, parent, outcome, OperationStatus::Failed);
    }
    let mut evidence = vec![];
    let mut index = vec![];
    let mut forced = None;
    'matrix: for (case_index, case) in frozen.plan().cases.iter().enumerate() {
        for repeat in 0..frozen.plan().repeats {
            if cancel.is_cancelled() {
                outcome.stop_reason = Some(ReproductionStop::Cancelled);
                forced = Some(OperationStatus::Cancelled);
                break 'matrix;
            }
            let request = frozen
                .request(
                    &case.id,
                    repeat,
                    &format!("repro-{parent}-{case_index}-{repeat}"),
                )
                .map_err(state)?;
            let child = {
                let mut store = lock(&shared.store)?;
                let admission=store.admit_command(session,&format!("{parent}:case:{case_index}:{repeat}"),&json!({"parent_operation":parent,"kind":"reproduction_case","plan_digest":frozen.digest(),"case_id":case.id,"repeat":repeat,"execution_id":request.execution_id}))?;
                if admission.duplicate {
                    return Err(state(
                        "reproduction child already admitted; recovery required",
                    ));
                }
                store.begin_operation(&admission.operation.id, &shared.owner)?
            };
            outcome.children.push(child.id.clone());
            let mut guard = ChildGuard {
                shared,
                operation: child.id.clone(),
                settled: false,
            };
            let request_bytes = serde_json::to_vec(&request)?;
            let retained_request = lock(&shared.store)?.retain_operation_artifact(
                &child.id,
                &shared.owner,
                "reproduction.request",
                &request_bytes,
            );
            let request_digest = match retained_request {
                Ok(d) => d,
                Err(error) => {
                    lock(&shared.store)?.settle_operation(&child.id,&shared.owner,OperationStatus::Failed,&json!({"error":"request retention failed","external_effects_started":false}))?;
                    guard.settled = true;
                    outcome.error = Some(error.to_string());
                    outcome.stop_reason = Some(ReproductionStop::SetupFailed);
                    forced = Some(OperationStatus::Failed);
                    break 'matrix;
                }
            };
            if cancel.is_cancelled() {
                lock(&shared.store)?.settle_operation(
                    &child.id,
                    &shared.owner,
                    OperationStatus::Cancelled,
                    &json!({"external_effects_started":false,"request_artifact":request_digest}),
                )?;
                guard.settled = true;
                outcome.stop_reason = Some(ReproductionStop::Cancelled);
                forced = Some(OperationStatus::Cancelled);
                break 'matrix;
            }
            outcome.external_effects_started = true;
            let (result, event_lost) =
                execute(shared, request.clone(), cancel.clone(), events.clone()).await;
            let mut result = match result {
                Ok(result) => result,
                Err(error) => {
                    lock(&shared.store)?.mark_operation_unknown(
                        &child.id,
                        &shared.owner,
                        "reproduction sandbox supervisor stopped",
                    )?;
                    guard.settled = true;
                    outcome.error = Some(error.to_string());
                    outcome.stop_reason = Some(ReproductionStop::SupervisorFailed);
                    forced = Some(OperationStatus::Unknown);
                    break 'matrix;
                }
            };
            if event_lost {
                result.error = Some("event consumer unavailable; owned execution cancelled".into());
                if result.status == ExecutionStatus::Exited {
                    result.status = ExecutionStatus::Cancelled;
                }
            }
            let unknown = matches!(
                result.cleanup,
                SandboxCleanup::Unknown { .. } | SandboxCleanup::Unconfirmed { .. }
            );
            let cancelled = result.status == ExecutionStatus::Cancelled;
            let unavailable = (!matches!(result.status, ExecutionStatus::Exited)
                && !(result.status == ExecutionStatus::Failed
                    && result.exit_code.is_some_and(|n| n != 0)))
                || result.error.is_some()
                || !matches!(result.cleanup, SandboxCleanup::Confirmed);
            let item = Evidence {
                case_id: case.id.clone(),
                repeat,
                request,
                result,
            };
            let evidence_digest = lock(&shared.store)?.retain_operation_artifact(
                &child.id,
                &shared.owner,
                "reproduction.evidence",
                &serde_json::to_vec(&item)?,
            )?;
            let child_outcome = json!({"request_artifact":request_digest,"evidence_artifact":evidence_digest,"status":item.result.status,"exit_code":item.result.exit_code,"cleanup":item.result.cleanup});
            {
                let mut store = lock(&shared.store)?;
                if unknown {
                    store.mark_operation_unknown_with_outcome(
                        &child.id,
                        &shared.owner,
                        &child_outcome,
                    )?;
                } else {
                    store.settle_operation(
                        &child.id,
                        &shared.owner,
                        if cancelled {
                            OperationStatus::Cancelled
                        } else if unavailable {
                            OperationStatus::Failed
                        } else {
                            OperationStatus::Succeeded
                        },
                        &child_outcome,
                    )?;
                }
            }
            guard.settled = true;
            index.push(json!({"child_operation":child.id,"case_id":case.id,"repeat":repeat,"request_artifact":request_digest,"evidence_artifact":evidence_digest}));
            evidence.push(item);
            if unknown {
                forced = Some(OperationStatus::Unknown);
                outcome.error =
                    Some("sandbox cleanup uncertain; remaining cases not dispatched".into());
                break 'matrix;
            }
            if cancelled || event_lost || cancel.is_cancelled() {
                forced = Some(OperationStatus::Cancelled);
                outcome.stop_reason = Some(if event_lost {
                    ReproductionStop::EventConsumerUnavailable
                } else {
                    ReproductionStop::Cancelled
                });
                break 'matrix;
            }
            if unavailable {
                forced = Some(OperationStatus::Failed);
                outcome.stop_reason = Some(ReproductionStop::SetupFailed);
                outcome.error =
                    Some("case execution unavailable; remaining cases not dispatched".into());
                break 'matrix;
            }
        }
    }
    let assessment = zero_verification::assess(&frozen, &evidence).map_err(state)?;
    let status = forced.unwrap_or(match assessment.disposition {
        Disposition::ObservedForPlan | Disposition::NotObserved => OperationStatus::Succeeded,
        Disposition::Inconclusive => OperationStatus::Failed,
        Disposition::Cancelled => OperationStatus::Cancelled,
        Disposition::Unknown => OperationStatus::Unknown,
    });
    retain(
        shared,
        parent,
        &mut outcome,
        "reproduction.evidence_index",
        &serde_json::to_vec(&index)?,
    )?;
    retain(
        shared,
        parent,
        &mut outcome,
        "reproduction.assessment",
        &serde_json::to_vec(&assessment)?,
    )?;
    outcome.assessment = Some(assessment);
    settle(shared, parent, outcome, status)
}
async fn execute(
    shared: &Arc<Shared>,
    request: SandboxRequest,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> (
    Result<zero_protocol::sandbox::SandboxResult, tokio::task::JoinError>,
    bool,
) {
    let lost = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = lost.clone();
    let stop = cancel.clone();
    let sink = Arc::new(move |event| {
        if events.try_send(ExecutionEvent::Sandbox { event }).is_err() {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            stop.cancel();
        }
    });
    let executor = shared.sandbox.clone();
    let result = tokio::spawn(async move { executor.execute(request, cancel, sink).await }).await;
    (result, lost.load(std::sync::atomic::Ordering::Relaxed))
}
struct ChildGuard<'a> {
    shared: &'a Shared,
    operation: String,
    settled: bool,
}
impl Drop for ChildGuard<'_> {
    fn drop(&mut self) {
        if !self.settled {
            if let Ok(mut store) = self.shared.store.lock() {
                let _ = store.mark_operation_unknown(
                    &self.operation,
                    &self.shared.owner,
                    "reproduction child owner stopped before settlement",
                );
            }
        }
    }
}
