use crate::{
    Assessment, Disposition, Evidence, ExactOutput, FrozenPlan, MAX_EVIDENCE_BYTES, Mode,
    ORACLE_VERSION, Reason, Result, hash, invalid,
};
use std::collections::{BTreeMap, BTreeSet};
use zero_protocol::{
    ExecutionStatus,
    sandbox::{SandboxArtifact, SandboxBackend, SandboxCleanup},
};
/// Only trusted executor-journal observations may be supplied. This pure oracle
/// cannot authenticate a caller, execute probes, or establish independent truth.
pub fn assess(frozen: &FrozenPlan, evidence: &[Evidence]) -> Result<Assessment> {
    if evidence.len() > 256 {
        return Err(invalid("evidence attempt count bound"));
    }
    let evidence_digest = hash(evidence, MAX_EVIDENCE_BYTES)?;
    let plan = frozen.plan();
    let mut reasons = vec![];
    let mut matrix = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut observed: BTreeMap<&str, Vec<ExactOutput>> = BTreeMap::new();
    let mut unknown = false;
    let mut cancelled = false;
    let mut invalid_identity = false;
    let mut invalid_matrix = false;
    let mut unavailable = false;
    let mut attack_mismatch = false;
    let mut control_mismatch = false;
    let mut unstable = false;
    for item in evidence {
        if matches!(
            item.result.cleanup,
            SandboxCleanup::Unknown { .. } | SandboxCleanup::Unconfirmed { .. }
        ) {
            unknown = true;
            reason(&mut reasons, Reason::UnconfirmedCleanup);
        }
        let case = plan.cases.iter().find(|c| c.id == item.case_id);
        if case.is_none()
            || item.repeat >= plan.repeats
            || !matrix.insert((&item.case_id, item.repeat))
        {
            invalid_matrix = true;
            reason(&mut reasons, Reason::MissingOrDuplicateMatrix);
        }
        if !ids.insert(&item.request.execution_id) {
            invalid_identity = true;
            reason(&mut reasons, Reason::ReusedExecutionIdentity);
        }
        let expected_request =
            frozen.request(&item.case_id, item.repeat, &item.request.execution_id);
        let matches_request = match expected_request {
            Ok(expected) => {
                serde_json::to_vec(&expected)? == serde_json::to_vec(&item.request)?
                    && item.result.execution_id == item.request.execution_id
            }
            Err(_) => false,
        };
        if !matches_request {
            invalid_identity = true;
            reason(&mut reasons, Reason::RequestIdentityMismatch);
        }
        let matches_backend = match (&plan.backend, &item.result.artifact) {
            (
                SandboxBackend::Docker { image },
                SandboxArtifact::Docker {
                    image_reference,
                    resolved_image_id: Some(actual),
                },
            ) => image == actual && image == image_reference,
            (
                SandboxBackend::Smolvm { archive_digest, .. },
                SandboxArtifact::SmolvmArchive { digest },
            ) => archive_digest == digest,
            (
                SandboxBackend::Docker { image },
                SandboxArtifact::Docker {
                    image_reference,
                    resolved_image_id: None,
                },
            ) if item.result.status == ExecutionStatus::Cancelled
                && matches!(item.result.cleanup, SandboxCleanup::NotCreated) =>
            {
                image == image_reference
            }
            _ => false,
        };
        if !matches_backend {
            invalid_identity = true;
            reason(&mut reasons, Reason::BackendIdentityMismatch);
        }
        if item.result.status == ExecutionStatus::Cancelled {
            cancelled = true;
            reason(&mut reasons, Reason::Cancelled);
        }
        if item.result.status == ExecutionStatus::OutputLimit
            || item.result.stdout.len() > plan.limits.max_output_bytes
            || item.result.stderr.len() > plan.limits.max_output_bytes
        {
            unavailable = true;
            reason(&mut reasons, Reason::OutputLimit);
            continue;
        }
        let valid_exit = matches!(item.result.status, ExecutionStatus::Exited)
            || (item.result.status == ExecutionStatus::Failed
                && item.result.exit_code.is_some_and(|n| n != 0));
        if !valid_exit
            || !matches!(item.result.cleanup, SandboxCleanup::Confirmed)
            || item.result.error.is_some()
            || item
                .result
                .exit_code
                .is_none_or(|n| !(0..=255).contains(&n))
        {
            unavailable = true;
            reason(&mut reasons, Reason::ExecutionUnavailable);
            continue;
        }
        if let (Some(case), Some(exit_code)) = (case, item.result.exit_code) {
            let output = ExactOutput {
                exit_code,
                stdout: item.result.stdout.clone(),
                stderr: item.result.stderr.clone(),
            };
            let repeats = observed.entry(&case.id).or_default();
            if repeats.first().is_some_and(|first| first != &output) {
                unstable = true;
                reason(&mut reasons, Reason::UnstableRepeatedOutput);
            }
            if output != case.expected {
                match case.mode {
                    Mode::Attack => attack_mismatch = true,
                    Mode::LegitimateControl => control_mismatch = true,
                }
            }
            repeats.push(output);
        }
    }
    let required = plan.cases.len() * plan.repeats;
    let missing = matrix.len() != required || evidence.len() != required;
    if missing {
        reason(&mut reasons, Reason::MissingOrDuplicateMatrix);
    }
    if control_mismatch {
        reason(&mut reasons, Reason::LegitimateControlMismatch);
    }
    let disposition = if unknown {
        Disposition::Unknown
    } else if invalid_identity || invalid_matrix {
        Disposition::Inconclusive
    } else if cancelled {
        Disposition::Cancelled
    } else if missing || unavailable || unstable || control_mismatch {
        Disposition::Inconclusive
    } else if attack_mismatch {
        reason(&mut reasons, Reason::StableAttackMismatch);
        Disposition::NotObserved
    } else {
        reason(&mut reasons, Reason::CompleteExactObservation);
        Disposition::ObservedForPlan
    };
    let mut result = Assessment {
        schema_version: 1,
        oracle_version: ORACLE_VERSION.into(),
        plan_digest: frozen.digest().into(),
        hypothesis_id: plan.hypothesis_id.clone(),
        source_bundle_digest: plan.source_bundle_digest.clone(),
        snapshot_digest: plan.snapshot.digest.clone(),
        evidence_digest,
        disposition,
        reasons,
        observed_attempts: evidence.len(),
        required_attempts: required,
        vulnerability_reportable: false,
        assessment_digest: String::new(),
    };
    result.assessment_digest = hash(&result, 64 * 1024)?;
    Ok(result)
}
fn reason(reasons: &mut Vec<Reason>, reason: Reason) {
    if !reasons.contains(&reason) {
        reasons.push(reason);
    }
}
