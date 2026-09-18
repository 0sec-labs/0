use crate::{ObservationMatrix, Result, invalid, plan::digest};
use std::collections::{BTreeMap, BTreeSet};
use zero_protocol::{
    OperationStatus,
    verification::Disposition,
    web::{WebCaseRole, WebVerificationAssessment, WebVerificationAttempt, WebVerificationStop},
};
/// Caller must authenticate every attempt against its retained execution journal.
/// This pure scorer cannot turn a caller-authored observation into proof.
pub fn assess(
    plan: &impl ObservationMatrix,
    attempts: &[WebVerificationAttempt],
    stop: Option<WebVerificationStop>,
) -> Result<WebVerificationAssessment> {
    if attempts.len() > 24 || serde_json::to_vec(attempts).map_err(invalid)?.len() > 262144 {
        return Err(invalid("web observation matrix exceeds bound"));
    }
    let cases = plan.cases();
    let repeats = plan.repeats();
    let expected = repeats * cases.len() as u32;
    let mut reasons = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut cells = BTreeSet::new();
    let mut outputs = BTreeMap::new();
    let mut complete = 0;
    let mut observed = 0;
    let mut controls = 0;
    let mut mismatch = false;
    let mut invalid_identity = false;
    let mut bad_control = false;
    let mut unavailable = false;
    let mut unstable = false;
    let mut unknown = stop == Some(WebVerificationStop::Unknown);
    let mut cancelled = stop == Some(WebVerificationStop::Cancelled);
    for (position, a) in attempts.iter().enumerate() {
        unknown |=
            a.operation_status == OperationStatus::Unknown || a.possible_dispatch && !a.complete;
        cancelled |= a.operation_status == OperationStatus::Cancelled;
        let index = cases.iter().position(|c| c.name == a.case_name);
        if !ids.insert(&a.operation_id)
            || a.operation_id.is_empty()
            || a.operation_id.len() > 256
            || !cells.insert((&a.case_name, a.repeat_index))
        {
            invalid_identity = true;
            reasons.insert("duplicate_or_invalid_execution_identity");
        }
        let Some(index) = index else {
            invalid_identity = true;
            reasons.insert("unexpected_case");
            continue;
        };
        if a.repeat_index >= repeats
            || position != a.repeat_index as usize * cases.len() + index
            || plan.request_sha256(index, a.repeat_index).ok().as_deref() != Some(&a.request_sha256)
        {
            invalid_identity = true;
            reasons.insert("request_or_matrix_identity_mismatch");
        }
        let usable = a.operation_status == OperationStatus::Succeeded
            && a.complete
            && a.possible_dispatch
            && a.status.is_some_and(|s| (100..=599).contains(&s))
            && a.body_sha256.as_ref().is_some_and(|s| digest(s))
            && a.response_manifest_sha256
                .as_ref()
                .is_some_and(|s| digest(s));
        if !usable {
            unavailable = true;
            reasons.insert("incomplete_or_unavailable_response");
            continue;
        }
        complete += 1;
        let output = (a.status, a.body_sha256.as_ref());
        if outputs
            .insert(&a.case_name, output)
            .is_some_and(|old| old != output)
        {
            unstable = true;
            reasons.insert("unstable_repetitions");
        }
        let matched = a.status == Some(cases[index].expected.status)
            && a.body_sha256.as_ref() == Some(&cases[index].expected.body_sha256);
        match cases[index].role {
            WebCaseRole::Attack => {
                if matched {
                    observed += 1
                } else {
                    mismatch = true;
                    reasons.insert("attack_expectation_not_observed");
                }
            }
            WebCaseRole::LegitimateControl => {
                if matched {
                    controls += 1
                } else {
                    bad_control = true;
                    reasons.insert("legitimate_control_failed");
                }
            }
        }
    }
    let missing = attempts.len() != expected as usize || cells.len() != expected as usize;
    if missing {
        reasons.insert("incomplete_matrix");
    }
    if stop == Some(WebVerificationStop::PreparationFailed) {
        unavailable = true;
        reasons.insert("preparation_failed");
    }
    let disposition = if unknown {
        reasons.insert("uncertain_target_effect");
        Disposition::Unknown
    } else if cancelled {
        reasons.insert("controller_cancelled");
        Disposition::Cancelled
    } else if invalid_identity || missing || unavailable || bad_control || unstable {
        Disposition::Inconclusive
    } else if mismatch {
        Disposition::NotObserved
    } else {
        reasons.insert("complete_stable_exact_observation");
        Disposition::ObservedForPlan
    };
    Ok(WebVerificationAssessment {
        schema_version: 1,
        disposition,
        oracle_version: crate::ORACLE_VERSION.into(),
        plan_sha256: plan.matrix_sha256().into(),
        expected_attempts: expected,
        completed_attempts: complete,
        observed_attempts: observed,
        control_attempts: controls,
        reasons: reasons.into_iter().map(str::to_owned).collect(),
        vulnerability_reportable: false,
    })
}
