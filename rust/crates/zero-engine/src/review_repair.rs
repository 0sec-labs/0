//! Archive-backed repair preparation; never an execution or host-apply permit.
use super::*;
use zero_protocol::{
    repair::{CandidateReceipt, MaterializeRequest},
    review_repair::{ReviewRepairBinding, ReviewRepairPlan},
    review_reproduction::ReviewReproductionPlan,
    verification::{Disposition, Mode},
};
use zero_verification::FrozenPlan;
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn hash(value: &impl serde::Serialize) -> Result<String, EngineError> {
    Ok(format!(
        "sha256:{}",
        zero_plugin::sha256(&serde_json::to_vec(&serde_json::to_value(value)?)?)
    ))
}
struct Baseline {
    authorization: ReviewReproductionPlan,
    operation_id: String,
    logical: FrozenPlan,
    receipt: CandidateReceipt,
}
fn baseline(store: &Store, request: &ReviewRepairPlan) -> Result<Baseline, EngineError> {
    validate_request(request)?;
    let view = store.native_reproduction_read_snapshot(&request.reproduction_id)?;
    baseline_view(&view, request)
}
fn validate_request(request: &ReviewRepairPlan) -> Result<(), EngineError> {
    request.validate_envelope().map_err(error)?;
    if serde_json::to_vec(request)?.len() > zero_protocol::MAX_FRAME_BYTES {
        return Err(error("native repair authorization byte bound"));
    }
    Ok(())
}
fn baseline_view(view: &Store, request: &ReviewRepairPlan) -> Result<Baseline, EngineError> {
    let Reply::SourceReproduction {
        operation,
        result: Some(result),
        ..
    } = workflow_provenance::native_reproduction(view, &request.reproduction_id)?
    else {
        return Err(error(
            "native repair requires retained observed reproduction",
        ));
    };
    if operation.status != OperationStatus::Succeeded
        || result.error.is_some()
        || !result.assessment.as_ref().is_some_and(|a| {
            a.disposition == Disposition::ObservedForPlan && !a.vulnerability_reportable
        })
    {
        return Err(error(
            "native repair requires independently observed baseline",
        ));
    }
    let authorization = view.native_reproduction_authorization(&request.reproduction_id)?;
    let logical = FrozenPlan::new(authorization.plan.clone()).map_err(error)?;
    if serde_json::to_value(&request.materialize.baseline)?
        != serde_json::to_value(&logical.plan().snapshot)?
    {
        return Err(error(
            "repair baseline differs from original logical snapshot",
        ));
    }
    let executions = logical
        .plan()
        .cases
        .len()
        .checked_mul(logical.plan().repeats)
        .and_then(|n| n.checked_mul(2))
        .ok_or_else(|| error("repair execution count overflow"))?;
    if executions > request.max_executions as usize {
        return Err(error(
            "two fresh repair matrices exceed execution authorization",
        ));
    }
    if logical
        .plan()
        .cases
        .iter()
        .any(|c| c.mode == Mode::Attack && c.safe_expected.is_none())
    {
        return Err(error(
            "safe attack expectations must already be frozen in the observed baseline",
        ));
    }
    let record = view.native_reproduction(&request.reproduction_id)?.record;
    let source =
        source_provenance::load(view, &record.source_session_id, &record.source_operation_id)?;
    let hypothesis = source
        .review
        .hypotheses
        .iter()
        .find(|h| h.id == logical.plan().hypothesis_id)
        .ok_or_else(|| error("baseline hypothesis absent"))?;
    if !hypothesis.claim.citations.iter().any(|c| {
        c.path == request.materialize.target
            && c.sha256 == request.materialize.expected_preimage_sha256
    }) {
        return Err(error(
            "repair target and preimage must be cited by original source hypothesis",
        ));
    }
    let receipt = zero_repair::expected_receipt(&request.materialize).map_err(error)?;
    Ok(Baseline {
        authorization,
        operation_id: operation.id,
        logical,
        receipt,
    })
}

/// Independently assessed baseline identity, not a dispatch or promotion permit.
/// Admission must compare this fingerprint with a fresh capture inside its own
/// write transaction before recording the repair's authorization.
pub struct AssessedReviewRepair {
    pub reproduction_operation_id: String,
    pub reproduction_evidence_sha256: String,
}

/// Assess and fingerprint the same immutable two-session evidence view. Taking
/// the digest from the live Store after assessment would allow a changed journal
/// to be authorized using a conclusion reached against different evidence.
pub fn assess(
    store: &Store,
    request: &ReviewRepairPlan,
) -> Result<AssessedReviewRepair, EngineError> {
    validate_request(request)?;
    let view = store.native_reproduction_read_snapshot(&request.reproduction_id)?;
    let baseline = baseline_view(&view, request)?;
    Ok(AssessedReviewRepair {
        reproduction_operation_id: baseline.operation_id,
        reproduction_evidence_sha256: view
            .native_reproduction_evidence_digest(&request.reproduction_id)?,
    })
}
fn binding(
    request: &ReviewRepairPlan,
    base: &Baseline,
    execution: &FrozenPlan,
    materialize: &MaterializeRequest,
) -> Result<ReviewRepairBinding, EngineError> {
    Ok(ReviewRepairBinding {
        schema_version: 1,
        reproduction_id: request.reproduction_id.clone(),
        reproduction_operation_id: base.operation_id.clone(),
        review_id: base.authorization.review_id.clone(),
        source_operation_id: base.authorization.source_operation_id.clone(),
        archive_manifest_sha256: base.authorization.archive_manifest_sha256.clone(),
        reproduction_authorization_sha256: hash(&base.authorization)?,
        repair_authorization_sha256: hash(request)?,
        logical_plan_sha256: base.logical.digest().into(),
        execution_baseline_plan_sha256: execution.digest().into(),
        materialize_request_sha256: hash(materialize)?,
        candidate_receipt_sha256: hash(&base.receipt)?,
    })
}
/// Owns the reconstructed baseline. Consumers must drain before explicit removal.
/// Candidate materialization and sandbox execution require separate host permits.
pub struct PreparedReviewRepair {
    source: review_reproduction::PreparedReviewReproduction,
    materialize: MaterializeRequest,
    receipt: CandidateReceipt,
    binding: ReviewRepairBinding,
}
impl PreparedReviewRepair {
    pub fn materialize_request(&self) -> &MaterializeRequest {
        &self.materialize
    }
    pub fn expected_receipt(&self) -> &CandidateReceipt {
        &self.receipt
    }
    pub fn binding(&self) -> &ReviewRepairBinding {
        &self.binding
    }
    pub fn execution_baseline(&self) -> &FrozenPlan {
        self.source.execution_plan()
    }
    /// Derive only the already frozen safe expectations for an exact private candidate.
    pub fn candidate_plan(
        &self,
        candidate: &zero_repair::Candidate,
    ) -> Result<FrozenPlan, EngineError> {
        if candidate.receipt() != &self.receipt
            || candidate.replacement_bytes() != self.materialize.replacement.as_bytes()
        {
            return Err(error("candidate differs from retained repair authority"));
        }
        let mut plan = self.source.logical_plan().plan().clone();
        plan.snapshot = candidate.snapshot().clone();
        for case in &mut plan.cases {
            if case.mode == Mode::Attack {
                case.expected = case
                    .safe_expected
                    .take()
                    .ok_or_else(|| error("frozen safe expectation absent"))?;
            }
        }
        FrozenPlan::new(plan).map_err(error)
    }
    pub fn remove(self) -> Result<(), EngineError> {
        self.source.remove()
    }
}
/// Run on a joined blocking worker after explicit preparation admission.
/// No original directory, provider or guest is accessed by this preparation.
pub fn prepare(
    store: &Store,
    request: &ReviewRepairPlan,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<PreparedReviewRepair, EngineError> {
    check().map_err(error)?;
    let base = baseline(store, request)?;
    check().map_err(error)?;
    let source = review_reproduction::prepare(store, &base.authorization, check)?;
    let derived = (|| {
        check().map_err(error)?;
        let materialize = zero_repair::reanchor_materialization(
            &request.materialize,
            &source.execution_plan().plan().snapshot,
        )
        .map_err(error)?;
        let binding = binding(request, &base, source.execution_plan(), &materialize)?;
        check().map_err(error)?;
        Ok::<_, EngineError>((materialize, binding))
    })();
    match derived {
        Ok((materialize, binding)) => Ok(PreparedReviewRepair {
            source,
            materialize,
            receipt: base.receipt,
            binding,
        }),
        Err(cause) => {
            source.remove().map_err(|cleanup| {
                EngineError::CleanupUnconfirmed(format!("{cause}; {cleanup}"))
            })?;
            Err(cause)
        }
    }
}
/// Authenticate all retained identity fields after private preparation is gone.
/// This does not authenticate any later sandbox observations or repair outcome.
pub fn validate_binding(
    store: &Store,
    request: &ReviewRepairPlan,
    execution: &FrozenPlan,
    materialize: &MaterializeRequest,
    retained: &ReviewRepairBinding,
) -> Result<(), EngineError> {
    let base = baseline(store, request)?;
    base.logical.validate_reanchored(execution).map_err(error)?;
    let expected =
        zero_repair::reanchor_materialization(&request.materialize, &execution.plan().snapshot)
            .map_err(error)?;
    if serde_json::to_value(&expected)? != serde_json::to_value(materialize)?
        || binding(request, &base, execution, &expected)? != *retained
    {
        return Err(error(
            "native repair binding or materialization authority differs",
        ));
    }
    Ok(())
}
