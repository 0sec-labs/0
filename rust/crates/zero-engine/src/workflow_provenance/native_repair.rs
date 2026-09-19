//! Independent assessment of both fresh repair matrices and their original source.
use super::*;
use zero_protocol::{
    repair::{RepairValidationOutcome, RepairValidationStatus},
    verification::Mode,
};

/// The caller supplies the Store's bounded, pinned three-session read view.
/// Neither a worker's terminal status nor its claimed assessment grants success.
pub(crate) fn native_repair(store: &Store, key: &str) -> Result<Reply, EngineError> {
    let admitted = store.native_repair(key)?;
    let op = admitted.operation;
    let authorization = store.native_repair_authorization(key)?;
    let baseline = review_repair::assess(store, &authorization)?;
    if baseline.reproduction_operation_id != admitted.record.reproduction_operation_id
        || baseline.reproduction_evidence_sha256 != admitted.record.reproduction_evidence_sha256
    {
        return Err(error("native repair original evidence identity differs"));
    }
    let original = store.native_reproduction_authorization(&authorization.reproduction_id)?;
    let logical = FrozenPlan::new(original.plan).map_err(error)?;
    // Owner recovery deliberately retains an opaque Unknown reason. Do not
    // manufacture a RepairValidationOutcome or erase that operation status.
    let outcome = match op.outcome.clone().map(serde_json::from_value).transpose() {
        Ok(value) => value,
        Err(_) if op.status == OperationStatus::Unknown => None,
        Err(cause) => return Err(cause.into()),
    };
    let Some(outcome): Option<RepairValidationOutcome> = outcome else {
        if matches!(
            op.status,
            OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled
        ) {
            return Err(error("terminal native repair outcome absent"));
        }
        return Ok(Reply::SourceRepair {
            operation: op,
            result: None,
            duplicate: true,
        });
    };
    terminal(&op, &admitted.record.session_id, "native_source_repair")?;
    if outcome.vulnerability_reportable
        || outcome.phases.len() > 2
        || outcome
            .original_plan_digest
            .as_deref()
            .is_some_and(|digest| digest != logical.digest())
    {
        return Err(error(
            "native repair logical identity or qualification differs",
        ));
    }
    let source = store.native_repair_bound_source(key)?;
    let expected = zero_repair::expected_receipt(&authorization.materialize).map_err(error)?;
    let mut roots = std::collections::BTreeSet::from([logical.plan().snapshot.root.clone()]);
    let (observed_baseline, _) = store
        .native_reproduction_bound_source(&authorization.reproduction_id)?
        .ok_or_else(|| error("original observed baseline has no source binding"))?;
    roots.insert(observed_baseline.snapshot.root);
    if let Some((plan, binding, materialize)) = &source {
        let frozen = FrozenPlan::new(plan.clone()).map_err(error)?;
        review_repair::validate_binding(store, &authorization, &frozen, materialize, binding)?;
        if outcome.original_plan_digest.as_deref() != Some(logical.digest()) {
            return Err(error("bound repair omitted its logical baseline"));
        }
        roots.insert(plan.snapshot.root.clone());
    } else if !outcome.phases.is_empty() || outcome.candidate_receipt.is_some() {
        return Err(error("native repair observations lack bound source"));
    }
    if outcome
        .candidate_receipt
        .as_ref()
        .is_some_and(|receipt| receipt != &expected)
    {
        return Err(error(
            "native repair receipt differs from original host authority",
        ));
    }
    let attachments = store.operation_artifacts(&op.id)?;
    let mut attributed = outcome.artifacts.clone();
    for (name, digest) in &outcome.artifacts {
        if !name.starts_with("repair.") || attachments.get(name) != Some(digest) {
            return Err(error("native repair public artifact attribution differs"));
        }
        store.artifact(digest)?;
    }
    let summary_digest = outcome
        .artifacts
        .get("repair.validation_summary")
        .ok_or_else(|| error("native repair terminal summary absent"))?;
    let summary: Value = artifact(store, summary_digest)?;
    if summary
        != json!({"status":outcome.status,"original_plan_digest":outcome.original_plan_digest,
        "candidate_receipt":outcome.candidate_receipt,"phases":outcome.phases,"vulnerability_reportable":false})
    {
        return Err(error("native repair summary contradicts terminal outcome"));
    }
    let mut statuses = Vec::new();
    let mut observed: Vec<bool> = Vec::new();
    for (index, name) in ["candidate", "reconstructed"].into_iter().enumerate() {
        let bound = store.native_repair_bound_candidate(key, name)?;
        let Some(phase) = outcome.phases.get(index) else {
            // A bound candidate may fail before retaining a complete matrix.
            // It remains partial; its receipt must still be attributed below.
            if let Some((plan, receipt)) = bound {
                validate_candidate(
                    &logical,
                    &authorization.materialize,
                    &plan,
                    &receipt,
                    &mut roots,
                )?;
                if outcome.candidate_receipt.as_ref() != Some(&receipt) {
                    return Err(error("native repair omitted a bound candidate receipt"));
                }
            }
            continue;
        };
        if phase.name != name {
            return Err(error("native repair phase order differs"));
        }
        let (plan, receipt) =
            bound.ok_or_else(|| error("native repair phase has no bound candidate"))?;
        validate_candidate(
            &logical,
            &authorization.materialize,
            &plan,
            &receipt,
            &mut roots,
        )?;
        if outcome.candidate_receipt.as_ref() != Some(&receipt) {
            return Err(error("native repair phase receipt differs"));
        }
        // Failure to retain the first matrix plan is a known zero-effect
        // setup failure, not an observation or an empty successful matrix.
        if phase.observations.assessment.is_none()
            && phase.observations.children.is_empty()
            && phase.observations.artifacts.is_empty()
            && !phase.observations.external_effects_started
            && phase.observations.stop_reason.is_none()
            && phase.observations.error.is_some()
        {
            let frozen = FrozenPlan::new(plan).map_err(error)?;
            if phase.derived_plan_digest != frozen.digest() {
                return Err(error("unstarted native matrix plan differs"));
            }
            match store
                .get_operation_by_command(&op.session_id, &format!("{}:{name}:case:0:0", op.id))
            {
                Err(zero_store::Error::NotFound(_)) => {}
                Err(cause) => return Err(cause.into()),
                Ok(_) => return Err(error("unstarted native matrix omitted admitted child")),
            }
            statuses.push(OperationStatus::Failed);
            observed.push(false);
            continue;
        }
        let validated = matrix::validate_native_repair(
            store,
            &op.session_id,
            &op.id,
            name,
            &phase.observations,
        )?;
        if !same(validated.frozen.plan(), &plan)?
            || phase.derived_plan_digest != validated.frozen.digest()
        {
            return Err(error(
                "native repair measured plan differs from bound candidate",
            ));
        }
        if index == 1 && (statuses[0] != OperationStatus::Succeeded || !observed[0]) {
            return Err(error(
                "native repair reconstructed after unsuccessful first matrix",
            ));
        }
        statuses.push(validated.status);
        observed.push(validated.assessment.disposition == Disposition::ObservedForPlan);
        for (name, digest) in &phase.observations.artifacts {
            if attributed.insert(name.clone(), digest.clone()).is_some() {
                return Err(error("native repair duplicate artifact attribution"));
            }
        }
    }
    // Store validates the exact internal start/bind/complete receipt inventory.
    // Here all public source, receipt and matrix artifacts must be represented.
    let public: std::collections::BTreeMap<_, _> = attachments
        .into_iter()
        .filter(|(name, _)| !name.starts_with("native_repair."))
        .collect();
    if attributed != public {
        return Err(error(
            "native repair outcome omitted or invented retained evidence",
        ));
    }
    let expected_status = match outcome.status {
        RepairValidationStatus::ValidatedCandidateForPlan => {
            if statuses.len() != 2
                || statuses.iter().any(|s| *s != OperationStatus::Succeeded)
                || observed.iter().any(|value| !value)
                || outcome.error.is_some()
                || !outcome.cleanup_recovery.is_empty()
            {
                return Err(error(
                    "native repair success requires two clean independent matrices",
                ));
            }
            OperationStatus::Succeeded
        }
        RepairValidationStatus::NotValidated => {
            if statuses
                .iter()
                .any(|s| matches!(s, OperationStatus::Unknown | OperationStatus::Cancelled))
                || !outcome.cleanup_recovery.is_empty()
            {
                return Err(error("native repair failure hides uncertain execution"));
            }
            OperationStatus::Failed
        }
        RepairValidationStatus::Cancelled => {
            if statuses.contains(&OperationStatus::Unknown) || !outcome.cleanup_recovery.is_empty()
            {
                return Err(error("native repair cancellation hides uncertain teardown"));
            }
            OperationStatus::Cancelled
        }
        RepairValidationStatus::Unknown => OperationStatus::Unknown,
    };
    if op.status != expected_status {
        return Err(error(
            "native repair operation and reassessed outcome disagree",
        ));
    }
    Ok(Reply::SourceRepair {
        operation: op,
        result: Some(outcome),
        duplicate: true,
    })
}

fn validate_candidate(
    logical: &FrozenPlan,
    materialize: &zero_protocol::repair::MaterializeRequest,
    plan: &zero_protocol::verification::Plan,
    receipt: &zero_protocol::repair::CandidateReceipt,
    roots: &mut std::collections::BTreeSet<String>,
) -> Result<(), EngineError> {
    let expected = zero_repair::expected_receipt(materialize).map_err(error)?;
    if *receipt != expected
        || !roots.insert(plan.snapshot.root.clone())
        || plan.snapshot.id != expected.candidate_snapshot_sha256
        || plan.snapshot.digest != expected.candidate_snapshot_sha256
    {
        return Err(error("native repair candidate is not a fresh exact copy"));
    }
    let mut derived = logical.plan().clone();
    derived.snapshot.root = plan.snapshot.root.clone();
    derived.snapshot.id = expected.candidate_snapshot_sha256.clone();
    derived.snapshot.digest = expected.candidate_snapshot_sha256;
    let target = derived
        .snapshot
        .files
        .iter_mut()
        .find(|file| file.path == materialize.target)
        .ok_or_else(|| error("native repair target absent from original snapshot"))?;
    target.digest = expected.replacement_sha256;
    target.bytes = expected.replacement_bytes;
    derived.snapshot.files.sort_by(|a, b| a.path.cmp(&b.path));
    for case in &mut derived.cases {
        if case.mode == Mode::Attack {
            case.expected = case
                .safe_expected
                .take()
                .ok_or_else(|| error("native repair safe expectation absent"))?;
        }
    }
    if !same(&derived, plan)? {
        return Err(error(
            "native repair derived plan changed frozen observation policy",
        ));
    }
    Ok(())
}
