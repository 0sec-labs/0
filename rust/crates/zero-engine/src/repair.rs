//! Candidate validation under a previously observed, host-frozen plan.
use super::*;
use serde_json::json;
use zero_protocol::{
    repair::*,
    verification::{Disposition, Evidence, Mode, ReproductionOutcome, SourceReproductionRequest},
};
use zero_verification::FrozenPlan;
fn state(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
impl Engine {
    pub(super) async fn validate_repair(
        &self,
        session: String,
        command: String,
        request: RepairValidationRequest,
        events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        let request_bytes = serde_json::to_vec(&request)?;
        if request_bytes.len() > zero_protocol::MAX_FRAME_BYTES {
            return Err(state("repair request byte bound"));
        }
        let request_digest = format!("sha256:{}", zero_plugin::sha256(&request_bytes));
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            if control.closing
                || control
                    .active
                    .get(&session)
                    .is_some_and(|a| a.command_id != command)
                || (control.active.len() >= 64 && !control.active.contains_key(&session))
            {
                return Err(state("engine closing, session busy or active limit"));
            }
            let operation = {
                let mut store = lock(&self.shared.store)?;
                let admission = store.admit_command(
                    &session,
                    &command,
                    &json!({"kind":"plan_qualified_source_repair","request_digest":request_digest,"reproduction_operation_id":request.reproduction_operation_id}),
                )?;
                if admission.duplicate {
                    let result = admission
                        .operation
                        .outcome
                        .clone()
                        .and_then(|v| serde_json::from_value(v).ok());
                    return Ok(Reply::SourceRepair {
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
                let result = run(&shared, &session, &operation.id, request, cancel, events).await;
                guard.settled = result.is_ok();
                drop(guard);
                let _ = sender.send(result);
            });
            receiver
        };
        receiver
            .await
            .map_err(|_| state("repair owner stopped before settlement"))?
    }
}
fn baseline(
    shared: &Shared,
    session: &str,
    request: &RepairValidationRequest,
) -> Result<FrozenPlan, EngineError> {
    let store = lock(&shared.store)?;
    let op = store.get_operation(&request.reproduction_operation_id)?;
    if op.session_id != session
        || op.status != OperationStatus::Succeeded
        || op.payload["kind"] != "host_source_reproduction"
    {
        return Err(state(
            "repair requires completed reproduction in this session",
        ));
    }
    let original: SourceReproductionRequest =
        serde_json::from_value(op.payload["request"].clone())?;
    let outcome: ReproductionOutcome = serde_json::from_value(
        op.outcome
            .ok_or_else(|| state("reproduction outcome absent"))?,
    )?;
    let artifacts = store.operation_artifacts(&op.id)?;
    for name in [
        "reproduction.plan",
        "reproduction.assessment",
        "reproduction.evidence_index",
    ] {
        if !artifacts.contains_key(name) || artifacts.get(name) != outcome.artifacts.get(name) {
            return Err(state("reproduction attachment identity mismatch"));
        }
    }
    let artifact = |name: &str| -> Result<Vec<u8>, EngineError> {
        Ok(store.artifact(
            artifacts
                .get(name)
                .ok_or_else(|| state("reproduction artifact absent"))?,
        )?)
    };
    let frozen = FrozenPlan::parse(&artifact("reproduction.plan")?).map_err(state)?;
    if serde_json::to_value(frozen.plan())? != serde_json::to_value(&original.plan)?
        || serde_json::to_value(&request.materialize.baseline)?
            != serde_json::to_value(&original.plan.snapshot)?
    {
        return Err(state("repair baseline snapshot/plan changed"));
    }
    let index: Vec<serde_json::Value> =
        serde_json::from_slice(&artifact("reproduction.evidence_index")?)?;
    if index.len() != outcome.children.len()
        || index.len() != original.plan.cases.len() * original.plan.repeats
    {
        return Err(state("baseline evidence matrix incomplete"));
    }
    let mut evidence = Vec::new();
    let mut bytes = 0usize;
    let mut seen = std::collections::BTreeSet::new();
    for (entry, id) in index.iter().zip(&outcome.children) {
        if entry["child_operation"] != *id || !seen.insert(id) {
            return Err(state("baseline child identity mismatch"));
        }
        let child = store.get_operation(id)?;
        if child.session_id != session
            || child.status != OperationStatus::Succeeded
            || child.payload["parent_operation"] != op.id
            || child.payload["plan_digest"] != frozen.digest()
        {
            return Err(state("baseline child ownership mismatch"));
        }
        let attachments = store.operation_artifacts(id)?;
        let req = attachments
            .get("reproduction.request")
            .ok_or_else(|| state("baseline request absent"))?;
        let obs = attachments
            .get("reproduction.evidence")
            .ok_or_else(|| state("baseline observation absent"))?;
        if entry["request_artifact"] != *req || entry["evidence_artifact"] != *obs {
            return Err(state("baseline index artifact mismatch"));
        }
        let raw = store.artifact(obs)?;
        bytes = bytes.saturating_add(raw.len());
        if bytes > zero_verification::MAX_EVIDENCE_BYTES {
            return Err(state("baseline evidence byte bound"));
        }
        let item: Evidence = serde_json::from_slice(&raw)?;
        if serde_json::to_vec(&item.request)? != store.artifact(req)?
            || entry["case_id"] != item.case_id
            || entry["repeat"] != item.repeat
            || child.payload["execution_id"] != item.request.execution_id
        {
            return Err(state("baseline request attribution mismatch"));
        }
        evidence.push(item);
    }
    let assessed = zero_verification::assess(&frozen, &evidence).map_err(state)?;
    if assessed.disposition != Disposition::ObservedForPlan
        || serde_json::to_value(&assessed)?
            != serde_json::from_slice::<serde_json::Value>(&artifact("reproduction.assessment")?)?
        || Some(serde_json::to_value(&assessed)?)
            != outcome.assessment.map(serde_json::to_value).transpose()?
    {
        return Err(state(
            "baseline observation not established by retained evidence",
        ));
    }
    for case in &frozen.plan().cases {
        if case.mode == Mode::Attack && case.safe_expected.is_none() {
            return Err(state(
                "safe expectations must already be frozen for every attack case",
            ));
        }
    }
    let source = store.get_operation(&original.source_operation_id)?;
    let source_outcome: zero_protocol::source::SourceReviewOutcome = serde_json::from_value(
        source
            .outcome
            .ok_or_else(|| state("source outcome absent"))?,
    )?;
    let review = source_outcome
        .review
        .ok_or_else(|| state("source review absent"))?;
    let hypothesis = review
        .hypotheses
        .iter()
        .find(|h| h.id == frozen.plan().hypothesis_id)
        .ok_or_else(|| state("hypothesis absent"))?;
    if !hypothesis.claim.citations.iter().any(|c| {
        c.path == request.materialize.target
            && c.sha256 == request.materialize.expected_preimage_sha256
    }) {
        return Err(state(
            "candidate target/preimage must be cited by the original hypothesis",
        ));
    }
    drop(store);
    reproduction::validate_source(shared, session, &original.source_operation_id, &frozen)?;
    Ok(frozen)
}
fn retain(
    shared: &Shared,
    parent: &str,
    outcome: &mut RepairValidationOutcome,
    name: &str,
    bytes: &[u8],
) -> Result<(), EngineError> {
    let id = lock(&shared.store)?.retain_operation_artifact(parent, &shared.owner, name, bytes)?;
    outcome.artifacts.insert(name.into(), id);
    Ok(())
}
fn finish(
    shared: &Shared,
    parent: &str,
    outcome: RepairValidationOutcome,
) -> Result<Reply, EngineError> {
    let mut store = lock(&shared.store)?;
    let value = serde_json::to_value(&outcome)?;
    let status = match outcome.status {
        RepairValidationStatus::ValidatedCandidateForPlan => OperationStatus::Succeeded,
        RepairValidationStatus::NotValidated => OperationStatus::Failed,
        RepairValidationStatus::Cancelled => OperationStatus::Cancelled,
        RepairValidationStatus::Unknown => OperationStatus::Unknown,
    };
    let operation = if status == OperationStatus::Unknown {
        store.mark_operation_unknown_with_outcome(parent, &shared.owner, &value)?
    } else {
        store.settle_operation(parent, &shared.owner, status, &value)?
    };
    Ok(Reply::SourceRepair {
        operation,
        result: Some(outcome),
        duplicate: false,
    })
}
async fn run(
    shared: &Arc<Shared>,
    session: &str,
    parent: &str,
    request: RepairValidationRequest,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    let mut output = RepairValidationOutcome {
        status: RepairValidationStatus::NotValidated,
        original_plan_digest: None,
        candidate_receipt: None,
        phases: vec![],
        artifacts: Default::default(),
        cleanup_recovery: vec![],
        error: None,
        vulnerability_reportable: false,
    };
    if cancel.is_cancelled() {
        output.status = RepairValidationStatus::Cancelled;
        return finish(shared, parent, output);
    }
    let baseline = match baseline(shared, session, &request) {
        Ok(p) => p,
        Err(e) => {
            output.error = Some(e.to_string());
            return finish(shared, parent, output);
        }
    };
    output.original_plan_digest = Some(baseline.digest().into());
    retain(
        shared,
        parent,
        &mut output,
        "repair.materialize_request",
        &serde_json::to_vec(&request.materialize)?,
    )?;
    retain(
        shared,
        parent,
        &mut output,
        "repair.replacement",
        request.materialize.replacement.as_bytes(),
    )?;
    for phase in ["candidate", "reconstructed"] {
        if cancel.is_cancelled() {
            output.status = RepairValidationStatus::Cancelled;
            break;
        }
        let spec = request.materialize.clone();
        let candidate =
            match tokio::task::spawn_blocking(move || zero_repair::materialize(&spec)).await {
                Ok(Ok(c)) => c,
                result => {
                    output.error = Some(match result {
                        Ok(Err(e)) => e.to_string(),
                        Err(e) => e.to_string(),
                        _ => unreachable!(),
                    });
                    break;
                }
            };
        let receipt = candidate.receipt().clone();
        if output
            .candidate_receipt
            .as_ref()
            .is_some_and(|r| *r != receipt)
        {
            cleanup(candidate, &mut output);
            output.error =
                Some("fresh candidate reconstruction changed content or policy identity".into());
            break;
        }
        let mut safe = baseline.plan().clone();
        safe.snapshot = candidate.snapshot().clone();
        for case in &mut safe.cases {
            if case.mode == Mode::Attack {
                case.expected = case
                    .safe_expected
                    .take()
                    .ok_or_else(|| state("missing frozen safe expectation"))?;
            }
        }
        let safe = match FrozenPlan::new(safe) {
            Ok(plan) => plan,
            Err(error) => {
                output.error = Some(error.to_string());
                cleanup(candidate, &mut output);
                break;
            }
        };
        let prepared = (|| {
            retain(
                shared,
                parent,
                &mut output,
                &format!("repair.{phase}.receipt"),
                &serde_json::to_vec(&receipt)?,
            )?;
            lock(&shared.store)?.append_operation_event(parent,&shared.owner,"repair.candidate_prepared",&json!({"phase":phase,"snapshot":candidate.snapshot(),"receipt_artifact":output.artifacts.get(&format!("repair.{phase}.receipt"))}))?;
            Ok::<_, EngineError>(())
        })();
        if let Err(e) = prepared {
            output.error = Some(e.to_string());
            cleanup(candidate, &mut output);
            return finish(shared, parent, output);
        }
        output.candidate_receipt = Some(receipt);
        let matrix = reproduction::matrix(
            shared,
            session,
            parent,
            &safe,
            cancel.clone(),
            events.clone(),
            phase,
        )
        .await;
        let (observations, status) = match matrix {
            Ok(v) => v,
            Err(e) => {
                output.status = RepairValidationStatus::Unknown;
                output.error = Some(e.to_string());
                if let Some(path) = candidate.retain_for_recovery() {
                    output
                        .cleanup_recovery
                        .push(path.to_string_lossy().into_owned());
                    if let Ok(mut store) = lock(&shared.store) {
                        let _ = store.append_operation_event(
                            parent,
                            &shared.owner,
                            "repair.copy_retained",
                            &json!({"phase":phase,"path":path}),
                        );
                    }
                }
                return finish(shared, parent, output);
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
            break;
        }
        if let Err(error) = candidate.cleanup() {
            if let zero_repair::Error::Cleanup { path } = &error {
                output
                    .cleanup_recovery
                    .push(path.to_string_lossy().into_owned());
            }
            output.error = Some(error.to_string());
            output.status = RepairValidationStatus::Unknown;
            break;
        }
        if status == OperationStatus::Cancelled || cancel.is_cancelled() {
            output.status = RepairValidationStatus::Cancelled;
            break;
        }
        if status != OperationStatus::Succeeded || !observed {
            output.error =
                Some("candidate did not satisfy the frozen safe observations and controls".into());
            break;
        }
        if phase == "reconstructed" {
            output.status = RepairValidationStatus::ValidatedCandidateForPlan;
        }
    }
    let summary = serde_json::to_vec(
        &json!({"status":output.status,"original_plan_digest":output.original_plan_digest,"candidate_receipt":output.candidate_receipt,"phases":output.phases,"vulnerability_reportable":false}),
    )?;
    retain(
        shared,
        parent,
        &mut output,
        "repair.validation_summary",
        &summary,
    )?;
    finish(shared, parent, output)
}

fn cleanup(candidate: zero_repair::Candidate, output: &mut RepairValidationOutcome) {
    if let Err(error) = candidate.cleanup() {
        if let zero_repair::Error::Cleanup { path } = &error {
            output
                .cleanup_recovery
                .push(path.to_string_lossy().into_owned());
        }
        output.status = RepairValidationStatus::Unknown;
        output.error = Some(error.to_string());
    }
}
