use super::*;
use zero_protocol::{
    ExecutionStatus,
    sandbox::SandboxCleanup,
    verification::{Assessment, Evidence, ReproductionStop},
};
pub(super) struct Validated {
    pub frozen: FrozenPlan,
    pub assessment: Assessment,
    pub status: OperationStatus,
}
fn expected_status(item: &Evidence) -> OperationStatus {
    if matches!(
        item.result.cleanup,
        SandboxCleanup::Unknown { .. } | SandboxCleanup::Unconfirmed { .. }
    ) {
        OperationStatus::Unknown
    } else if item.result.status == ExecutionStatus::Cancelled {
        OperationStatus::Cancelled
    } else if (!(item.result.status == ExecutionStatus::Exited
        || (item.result.status == ExecutionStatus::Failed
            && item.result.exit_code.is_some_and(|n| n != 0))))
        || item.result.error.is_some()
        || !matches!(item.result.cleanup, SandboxCleanup::Confirmed)
    {
        OperationStatus::Failed
    } else {
        OperationStatus::Succeeded
    }
}
pub(super) fn validate(
    store: &Store,
    session: &str,
    parent: &str,
    phase: &str,
    outcome: &ReproductionOutcome,
) -> Result<Validated, EngineError> {
    validate_inner(store, session, parent, phase, outcome, None)
}
// Native authority has already been authenticated against the Store's complete
// case/witness inventory. Its extra effect receipt never relaxes legacy proofs.
pub(super) fn validate_native(
    store: &Store,
    session: &str,
    parent: &str,
    outcome: &ReproductionOutcome,
) -> Result<Validated, EngineError> {
    validate_inner(
        store,
        session,
        parent,
        "reproduction",
        outcome,
        Some("native_reproduction.effect_start"),
    )
}
pub(super) fn validate_native_repair(
    store: &Store,
    session: &str,
    parent: &str,
    phase: &str,
    outcome: &ReproductionOutcome,
) -> Result<Validated, EngineError> {
    validate_inner(
        store,
        session,
        parent,
        phase,
        outcome,
        Some("native_repair.effect_start"),
    )
}
fn validate_inner(
    store: &Store,
    session: &str,
    parent: &str,
    phase: &str,
    outcome: &ReproductionOutcome,
    effect_receipt: Option<&str>,
) -> Result<Validated, EngineError> {
    let attachments = store.operation_artifacts(parent)?;
    let get = |suffix: &str| -> Result<&str, EngineError> {
        let key = format!("{phase}.{suffix}");
        let digest = outcome
            .artifacts
            .get(&key)
            .ok_or_else(|| error("workflow matrix evidence unavailable"))?;
        if attachments.get(&key) != Some(digest) {
            return Err(error("workflow matrix attachment mismatch"));
        }
        Ok(digest)
    };
    if outcome.artifacts.len() != 3 {
        return Err(error("workflow matrix artifact set mismatch"));
    }
    let plan: zero_protocol::verification::Plan = artifact(store, get("plan")?)?;
    let frozen = FrozenPlan::new(plan).map_err(error)?;
    let index: Vec<Value> = artifact(store, get("evidence_index")?)?;
    let retained: Assessment = artifact(store, get("assessment")?)?;
    let required = frozen.plan().cases.len() * frozen.plan().repeats;
    if outcome.children.len() > required
        || index.len() > outcome.children.len()
        || outcome.children.len() > index.len() + 1
    {
        return Err(error("workflow matrix child/index bounds"));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut evidence = Vec::new();
    let mut total = 0usize;
    let mut last_status = None;
    let mut effects = false;
    for (position, id) in outcome.children.iter().enumerate() {
        if !seen.insert(id) {
            return Err(error("workflow duplicate child"));
        }
        let case_index = position / frozen.plan().repeats;
        let repeat = position % frozen.plan().repeats;
        let case = &frozen.plan().cases[case_index];
        let request = frozen
            .request(
                &case.id,
                repeat,
                &format!("{phase}-{parent}-{case_index}-{repeat}"),
            )
            .map_err(error)?;
        let child = store.get_operation(id)?;
        terminal(&child, session, "reproduction_case")?;
        if child.command_id != format!("{parent}:{phase}:case:{case_index}:{repeat}")
            || child.payload
                != json!({"parent_operation":parent,"kind":"reproduction_case","plan_digest":frozen.digest(),"case_id":case.id,"repeat":repeat,"execution_id":request.execution_id})
        {
            return Err(error("workflow child request identity mismatch"));
        }
        let mut refs = store.operation_artifacts(id)?;
        let authorized = effect_receipt.is_some_and(|name| refs.remove(name).is_some());
        if effect_receipt.is_some()
            && (index.get(position).is_some() || child.status == OperationStatus::Unknown)
            && !authorized
        {
            return Err(error(
                "native observation lacks physical dispatch authority",
            ));
        }
        if let Some(entry) = index.get(position) {
            let req = refs
                .get("reproduction.request")
                .ok_or_else(|| error("workflow child request absent"))?;
            let obs = refs
                .get("reproduction.evidence")
                .ok_or_else(|| error("workflow child evidence absent"))?;
            if refs.len() != 2
                || *entry
                    != json!({"child_operation":id,"case_id":case.id,"repeat":repeat,"request_artifact":req,"evidence_artifact":obs})
            {
                return Err(error("workflow ordered index mismatch"));
            }
            let bytes = store.artifact(obs)?;
            total = total.saturating_add(bytes.len());
            if total > zero_verification::MAX_EVIDENCE_BYTES {
                return Err(error("workflow evidence byte bound"));
            }
            let item: Evidence = serde_json::from_slice(&bytes)?;
            if serde_json::to_vec(&item)? != bytes
                || serde_json::to_vec(&request)? != store.artifact(req)?
                || !same(&item.request, &request)?
                || item.case_id != case.id
                || item.repeat != repeat
            {
                return Err(error("workflow evidence request mismatch"));
            }
            let status = expected_status(&item);
            if child.status != status
                || child.outcome
                    != Some(
                        json!({"request_artifact":req,"evidence_artifact":obs,"status":item.result.status,"exit_code":item.result.exit_code,"cleanup":item.result.cleanup}),
                    )
            {
                return Err(error("workflow child outcome mismatch"));
            }
            if status != OperationStatus::Succeeded && position + 1 != outcome.children.len() {
                return Err(error(
                    "workflow continued after unsettled/unavailable execution",
                ));
            }
            effects = true;
            evidence.push(item);
        } else {
            // Exactly one final dispatch intent may lack an observation. Keep
            // its terminal status separate from the re-assessed evidence prefix.
            match child.status {
                OperationStatus::Failed
                    if refs.is_empty()
                        && child.outcome
                            == Some(
                                json!({"error":"request retention failed","external_effects_started":false}),
                            )
                        && matches!(outcome.stop_reason, Some(ReproductionStop::SetupFailed)) => {}
                OperationStatus::Cancelled | OperationStatus::Unknown => {
                    let req = refs
                        .get("reproduction.request")
                        .ok_or_else(|| error("workflow trailing request absent"))?;
                    if refs.len() != 1 || serde_json::to_vec(&request)? != store.artifact(req)? {
                        return Err(error("workflow trailing request mismatch"));
                    }
                    let expected = if child.status == OperationStatus::Cancelled {
                        if !matches!(outcome.stop_reason, Some(ReproductionStop::Cancelled)) {
                            return Err(error("workflow cancellation stop mismatch"));
                        }
                        json!({"external_effects_started":false,"request_artifact":req})
                    } else {
                        if !matches!(
                            outcome.stop_reason,
                            Some(ReproductionStop::SupervisorFailed)
                        ) {
                            return Err(error("workflow supervisor stop mismatch"));
                        }
                        effects = true;
                        json!({"reason":"reproduction sandbox supervisor stopped"})
                    };
                    if child.outcome != Some(expected) {
                        return Err(error("workflow trailing outcome mismatch"));
                    }
                }
                _ => return Err(error("workflow child has no retained observation")),
            }
        }
        last_status = Some(child.status);
    }
    if effects != outcome.external_effects_started {
        return Err(error("workflow effect provenance mismatch"));
    }
    // A shortened summary must not hide a later dispatch, including a child
    // whose teardown failed before it could retain an observation.
    let next = outcome.children.len();
    match store.get_operation_by_command(
        session,
        &format!(
            "{parent}:{phase}:case:{}:{}",
            next / frozen.plan().repeats,
            next % frozen.plan().repeats,
        ),
    ) {
        Err(zero_store::Error::NotFound(_)) => (),
        Err(e) => return Err(e.into()),
        Ok(_) => return Err(error("workflow summary omitted a later admitted child")),
    }
    let assessment = zero_verification::assess(&frozen, &evidence).map_err(error)?;
    if evidence.len() < required
        && outcome.stop_reason.is_none()
        && assessment.disposition != Disposition::Unknown
    {
        return Err(error(
            "incomplete workflow matrix lacks retained stop provenance",
        ));
    }
    if !same(&assessment, &retained)? || !same(&outcome.assessment, &Some(assessment.clone()))? {
        return Err(error(
            "workflow assessment differs from retained observations",
        ));
    }
    let status = match outcome.stop_reason {
        Some(ReproductionStop::Cancelled | ReproductionStop::EventConsumerUnavailable) => {
            if last_status == Some(OperationStatus::Unknown) {
                return Err(error("workflow cancellation cannot hide uncertain cleanup"));
            }
            OperationStatus::Cancelled
        }
        Some(ReproductionStop::SetupFailed) => {
            if last_status != Some(OperationStatus::Failed) {
                return Err(error("workflow setup failure lacks failed child"));
            }
            OperationStatus::Failed
        }
        Some(ReproductionStop::SupervisorFailed) => {
            if last_status != Some(OperationStatus::Unknown)
                || index.len() == outcome.children.len()
            {
                return Err(error("workflow supervisor failure mismatch"));
            }
            OperationStatus::Unknown
        }
        None => match assessment.disposition {
            Disposition::ObservedForPlan | Disposition::NotObserved => OperationStatus::Succeeded,
            Disposition::Inconclusive => OperationStatus::Failed,
            Disposition::Cancelled => OperationStatus::Cancelled,
            Disposition::Unknown => OperationStatus::Unknown,
        },
    };
    if status == OperationStatus::Succeeded && outcome.error.is_some() {
        return Err(error(
            "successful workflow matrix contradicts retained error",
        ));
    }
    Ok(Validated {
        frozen,
        assessment,
        status,
    })
}
