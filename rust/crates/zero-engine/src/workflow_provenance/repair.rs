use super::*;
use zero_protocol::{
    repair::{
        CandidateReceipt, MaterializeRequest, RepairValidationOutcome, RepairValidationRequest,
        RepairValidationStatus,
    },
    source::{RepairPhaseReport, RepairReport},
    verification::Mode,
};
pub(crate) fn repair(
    store: &Store,
    session: &str,
    source_id: &str,
    id: &str,
    reproduction: &ReproductionReport,
) -> Result<RepairReport, EngineError> {
    // Revalidate the referenced baseline rather than treating a caller DTO as authority.
    let (baseline_report, baseline) =
        reproduction_plan(store, session, source_id, &reproduction.operation_id)?;
    if !same(&baseline_report, reproduction)?
        || baseline_report.operation_status != OperationStatus::Succeeded
        || baseline_report.assessment.disposition != Disposition::ObservedForPlan
    {
        return Err(error(
            "repair baseline must be retained observed-for-plan evidence",
        ));
    }
    let op = store.get_operation(id)?;
    terminal(&op, session, "plan_qualified_source_repair")?;
    if op.payload["reproduction_operation_id"] != reproduction.operation_id {
        return Err(error("repair reproduction operation mismatch"));
    }
    let outcome: RepairValidationOutcome = serde_json::from_value(
        op.outcome
            .clone()
            .ok_or_else(|| error("repair outcome absent"))?,
    )?;
    if outcome.vulnerability_reportable
        || outcome.original_plan_digest.as_deref() != Some(baseline.digest())
        || outcome.phases.len() > 2
    {
        return Err(error("repair baseline/status identity mismatch"));
    }
    let attachments = store.operation_artifacts(id)?;
    for (name, digest) in &outcome.artifacts {
        if attachments.get(name) != Some(digest) {
            return Err(error("repair artifact attribution mismatch"));
        }
        store.artifact(digest)?;
    }
    let get = |name: &str| {
        outcome
            .artifacts
            .get(name)
            .ok_or_else(|| error("repair retained evidence unavailable"))
    };
    let materialize: MaterializeRequest = artifact(store, get("repair.materialize_request")?)?;
    if !same(&materialize.baseline, &baseline.plan().snapshot)?
        || materialize.replacement.as_bytes() != store.artifact(get("repair.replacement")?)?
    {
        return Err(error(
            "repair materialization snapshot/replacement mismatch",
        ));
    }
    let request = RepairValidationRequest {
        reproduction_operation_id: reproduction.operation_id.clone(),
        materialize: materialize.clone(),
    };
    let digest = format!(
        "sha256:{}",
        zero_plugin::sha256(&serde_json::to_vec(&request)?)
    );
    if op.payload["request_digest"] != digest {
        return Err(error("repair admitted request identity mismatch"));
    }
    let source = source_provenance::load(store, session, source_id)?;
    if !source
        .review
        .hypotheses
        .iter()
        .filter(|h| h.id == baseline.plan().hypothesis_id)
        .any(|h| {
            h.claim.citations.iter().any(|c| {
                c.path == materialize.target && c.sha256 == materialize.expected_preimage_sha256
            })
        })
    {
        return Err(error("repair target is not cited by the source hypothesis"));
    }
    if baseline
        .plan()
        .cases
        .iter()
        .any(|c| c.mode == Mode::Attack && c.safe_expected.is_none())
    {
        return Err(error("repair lacks frozen safe expectations"));
    }
    let expected = zero_repair::expected_receipt(&materialize).map_err(error)?;
    if outcome
        .candidate_receipt
        .as_ref()
        .is_some_and(|r| *r != expected)
    {
        return Err(error("repair receipt differs from host request"));
    }
    let summary: Value = artifact(store, get("repair.validation_summary")?)?;
    if summary
        != json!({"status":outcome.status,"original_plan_digest":outcome.original_plan_digest,"candidate_receipt":outcome.candidate_receipt,"phases":outcome.phases,"vulnerability_reportable":false})
    {
        return Err(error("repair summary differs from terminal outcome"));
    }
    let mut phases: Vec<RepairPhaseReport> = Vec::new();
    let mut roots = std::collections::BTreeSet::new();
    let mut statuses = Vec::new();
    for (index, phase) in outcome.phases.iter().enumerate() {
        let name = ["candidate", "reconstructed"][index];
        if phase.name != name {
            return Err(error("repair phase order mismatch"));
        }
        let receipt: CandidateReceipt = artifact(store, get(&format!("repair.{name}.receipt"))?)?;
        if receipt != expected || outcome.candidate_receipt.as_ref() != Some(&receipt) {
            return Err(error("repair phase receipt mismatch"));
        }
        let validated = matrix::validate(store, session, id, name, &phase.observations)?;
        let snapshot = &validated.frozen.plan().snapshot;
        if !roots.insert(snapshot.root.clone())
            || snapshot.root == materialize.baseline.root
            || snapshot.digest != expected.candidate_snapshot_sha256
            || snapshot.id != snapshot.digest
        {
            return Err(error("repair candidate copy identity mismatch"));
        }
        let mut derived = baseline.plan().clone();
        derived.snapshot.root = snapshot.root.clone();
        derived.snapshot.id = expected.candidate_snapshot_sha256.clone();
        derived.snapshot.digest = expected.candidate_snapshot_sha256.clone();
        for file in &mut derived.snapshot.files {
            if file.path == materialize.target {
                file.digest = expected.replacement_sha256.clone();
                file.bytes = expected.replacement_bytes;
            }
        }
        derived.snapshot.files.sort_by(|a, b| a.path.cmp(&b.path));
        for case in &mut derived.cases {
            if case.mode == Mode::Attack {
                case.expected = case
                    .safe_expected
                    .take()
                    .ok_or_else(|| error("repair missing frozen safe expectation"))?;
            }
        }
        if !same(&derived, validated.frozen.plan())?
            || phase.derived_plan_digest != validated.frozen.digest()
        {
            return Err(error("repair derived plan differs from frozen policy"));
        }
        if index == 1
            && (statuses[0] != OperationStatus::Succeeded
                || phases[0].assessment.disposition != Disposition::ObservedForPlan)
        {
            return Err(error("repair reconstructed after unsuccessful candidate"));
        }
        statuses.push(validated.status);
        phases.push(RepairPhaseReport {
            name: name.into(),
            assessment: validated.assessment,
            children: phase.observations.children.clone(),
            artifacts: phase.observations.artifacts.clone(),
        });
    }
    let mut attributed = outcome.artifacts.clone();
    for phase in &outcome.phases {
        for (name, digest) in &phase.observations.artifacts {
            if attributed.insert(name.clone(), digest.clone()).is_some() {
                return Err(error("repair artifact has duplicate phase attribution"));
            }
        }
    }
    if attributed != attachments {
        return Err(error("repair outcome omitted retained phase evidence"));
    }
    for (index, name) in ["candidate", "reconstructed"].iter().enumerate() {
        if outcome
            .artifacts
            .contains_key(&format!("repair.{name}.receipt"))
            != (index < phases.len())
        {
            return Err(error("repair phase receipt attribution mismatch"));
        }
    }
    let expected_status = match outcome.status {
        RepairValidationStatus::ValidatedCandidateForPlan => {
            if phases.len() != 2
                || statuses.iter().any(|s| *s != OperationStatus::Succeeded)
                || phases
                    .iter()
                    .any(|p| p.assessment.disposition != Disposition::ObservedForPlan)
                || !outcome.cleanup_recovery.is_empty()
                || outcome.error.is_some()
            {
                return Err(error(
                    "repair validation lacks two complete clean observation matrices",
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
                return Err(error("repair failure hides unsettled execution"));
            }
            OperationStatus::Failed
        }
        RepairValidationStatus::Cancelled => {
            if statuses.contains(&OperationStatus::Unknown) || !outcome.cleanup_recovery.is_empty()
            {
                return Err(error("repair cancellation hides uncertain cleanup"));
            }
            OperationStatus::Cancelled
        }
        RepairValidationStatus::Unknown => {
            if outcome.cleanup_recovery.is_empty() {
                return Err(error("uncertain repair has no retained recovery identity"));
            }
            OperationStatus::Unknown
        }
    };
    if op.status != expected_status {
        return Err(error("repair operation/outcome status mismatch"));
    }
    Ok(RepairReport {
        operation_id: id.into(),
        reproduction_operation_id: reproduction.operation_id.clone(),
        operation_status: op.status,
        status: outcome.status,
        original_plan_digest: baseline.digest().into(),
        candidate_receipt: outcome.candidate_receipt,
        phases,
        cleanup_recovery_count: outcome.cleanup_recovery.len(),
        artifacts: outcome.artifacts,
    })
}
