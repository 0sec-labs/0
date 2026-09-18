//! Model-proposed conjectures and predictions, distinct from measured matrix evidence.
use crate::{
    OperationStatus, ValidationError, is_sha256,
    web::{WebVerificationCase, WebVerificationOutcome},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebExperimentPolicy {
    pub schema_version: u32,
    pub max_experiments: u32,
    pub max_cases: u32,
    pub max_repeats: u32,
}
impl WebExperimentPolicy {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.schema_version != 1
            || !(1..=32).contains(&self.max_experiments)
            || !(2..=8).contains(&self.max_cases)
            || !(2..=3).contains(&self.max_repeats)
        {
            return Err(ValidationError("web experiment policy requires version 1, 1..32 experiments, 2..8 cases and 2..3 repeats".into()));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebPriorRevision {
    pub operation_id: String,
    pub hypothesis_sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebExperimentHypothesis {
    pub title: String,
    pub explanation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_revision: Option<WebPriorRevision>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebExperimentProposal {
    pub hypothesis: WebExperimentHypothesis,
    pub purpose: String,
    pub cases: Vec<WebVerificationCase>,
    pub repeats: u32,
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.contains('\0')
}
impl WebExperimentProposal {
    /// Structural bounds only: normalize under captured host policy and authenticate
    /// a prior revision before admission. Expected responses are model predictions.
    pub fn validate(&self) -> Result<(), ValidationError> {
        let invalid = || {
            ValidationError("web experiment proposal exceeds text, request or matrix bounds".into())
        };
        if !text(&self.hypothesis.title, 256)
            || !text(&self.hypothesis.explanation, 8192)
            || !text(&self.purpose, 4096)
            || !(2..=8).contains(&self.cases.len())
            || !(2..=3).contains(&self.repeats)
        {
            return Err(invalid());
        }
        if self
            .hypothesis
            .prior_revision
            .as_ref()
            .is_some_and(|p| !text(&p.operation_id, 256) || !is_sha256(&p.hypothesis_sha256))
        {
            return Err(invalid());
        }
        let mut names = BTreeSet::new();
        let mut attack = false;
        let mut control = false;
        for case in &self.cases {
            if !text(&case.name, 128)
                || !names.insert(&case.name)
                || !(100..=599).contains(&case.expected.status)
                || !is_sha256(&case.expected.body_sha256)
            {
                return Err(invalid());
            }
            case.request.validate()?;
            attack |= case.role == crate::web::WebCaseRole::Attack;
            control |= case.role == crate::web::WebCaseRole::LegitimateControl;
        }
        if !attack || !control {
            return Err(invalid());
        }
        Ok(())
    }
}
/// Controller-derived content identity; no model-supplied verification state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebHypothesisRevision {
    pub hypothesis_sha256: String,
    pub title: String,
    pub explanation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_revision: Option<WebPriorRevision>,
}
/// Discovery is metadata only, including interrupted admissions.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebExperimentCandidate {
    pub sequence: u64,
    pub operation_id: String,
    pub actor_operation_id: String,
    pub operation_status: OperationStatus,
    pub hypothesis_sha256: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebExperimentsPage {
    pub experiments: Vec<WebExperimentCandidate>,
    pub next_after_sequence: Option<u64>,
}
/// Validated origin plus independently reconstructed measured feedback. The
/// optional outcome is absent during execution; absence never means success.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebExperimentReport {
    pub schema_version: u32,
    pub session_id: String,
    pub web_operation_id: String,
    pub operation_id: String,
    pub operation_status: OperationStatus,
    pub actor_operation_id: String,
    pub inference_operation_id: String,
    pub call_id: String,
    pub policy: WebExperimentPolicy,
    pub proposal: WebExperimentProposal,
    pub hypothesis: WebHypothesisRevision,
    pub intent_sha256: String,
    /// For experiments, assessment.plan_sha256 identifies this frozen matrix.
    pub matrix_sha256: String,
    pub outcome: Option<WebVerificationOutcome>,
    pub artifacts: BTreeMap<String, String>,
}
#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;
    fn proposal() -> WebExperimentProposal {
        serde_json::from_value(json!({"hypothesis":{"title":"Conjecture λ","explanation":"Model-authored explanation"},"purpose":"Discriminate the predictions","repeats":2,"cases":[{"name":"attack","role":"attack","request":{"url":"https://example.test/attack"},"expected":{"status":200,"body_sha256":format!("sha256:{}","a".repeat(64))}},{"name":"control","role":"legitimate_control","request":{"url":"https://example.test/control"},"expected":{"status":403,"body_sha256":format!("sha256:{}","b".repeat(64))}}]})).unwrap()
    }
    #[test]
    fn legacy_report_command_keeps_identical_shape_without_experiment_links() {
        let legacy = json!({"method":"web_workflow_report","params":{"session_id":"session","operation_id":"root","verification_ids":[]}});
        let command: crate::Command = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(command).unwrap(), legacy);
    }
    #[test]
    fn proposal_cannot_supply_policy_truth_or_controller_revision_identity() {
        let p = proposal();
        p.validate().unwrap();
        let base = serde_json::to_value(&p).unwrap();
        for key in [
            "approved",
            "verified",
            "vulnerability_reportable",
            "http_profile",
            "policy",
            "account_id",
        ] {
            let mut v = base.clone();
            v[key] = true.into();
            assert!(serde_json::from_value::<WebExperimentProposal>(v).is_err());
        }
        let mut v = base.clone();
        v["hypothesis"]["hypothesis_sha256"] = json!(format!("sha256:{}", "a".repeat(64)));
        assert!(serde_json::from_value::<WebExperimentProposal>(v).is_err());
        assert!(base["hypothesis"].get("prior_revision").is_none());
    }
    #[test]
    fn byte_bounds_and_attack_control_requirements_are_enforced() {
        let p = proposal();
        let mut too_large = p.clone();
        too_large.hypothesis.title = "λ".repeat(129);
        assert!(too_large.validate().is_err());
        let mut duplicate = p.clone();
        duplicate.cases[1].name = duplicate.cases[0].name.clone();
        assert!(duplicate.validate().is_err());
        let mut control = p.clone();
        control.cases[1].role = crate::web::WebCaseRole::Attack;
        assert!(control.validate().is_err());
        let mut revision = p.clone();
        revision.hypothesis.prior_revision = Some(WebPriorRevision {
            operation_id: "prior".into(),
            hypothesis_sha256: "fake".into(),
        });
        assert!(revision.validate().is_err());
        for repeats in [0, 1, 4] {
            let mut v = p.clone();
            v.repeats = repeats;
            assert!(v.validate().is_err());
        }
    }
    #[test]
    fn host_policy_maxima_are_bounded_without_forcing_any_experiments() {
        for max_experiments in [1, 32] {
            WebExperimentPolicy {
                schema_version: 1,
                max_experiments,
                max_cases: 8,
                max_repeats: 3,
            }
            .validate()
            .unwrap();
        }
        for max_experiments in [0, 33] {
            assert!(
                WebExperimentPolicy {
                    schema_version: 1,
                    max_experiments,
                    max_cases: 8,
                    max_repeats: 3
                }
                .validate()
                .is_err()
            );
        }
    }
}
