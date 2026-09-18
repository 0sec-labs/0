//! Source discovery data: no finding is behaviorally verified here.
use crate::SnapshotPin;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewRequest {
    pub snapshot: SnapshotPin,
    pub selected_files: Vec<String>,
    pub question: String,
    pub max_hypotheses: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Citation {
    pub path: String,
    pub sha256: String,
    pub start_line: u32,
    pub end_line: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaimedSeverity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    pub title: String,
    pub claimed_severity: ClaimedSeverity,
    pub explanation: String,
    pub citations: Vec<Citation>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationState {
    Unverified,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Hypothesis {
    pub id: String,
    pub state: VerificationState,
    pub claim: Claim,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ReviewResult {
    pub version: u32,
    pub bundle_sha256: String,
    pub snapshot_sha256: String,
    pub request_sha256: String,
    pub completion_sha256: String,
    pub model: String,
    pub provider_response_id: Option<String>,
    pub submission_call_id: String,
    pub hypotheses: Vec<Hypothesis>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceReviewRequest {
    pub provider: String,
    pub model: String,
    pub reservation: u64,
    pub source: ReviewRequest,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SourceReviewOutcome {
    pub review: Option<ReviewResult>,
    pub artifacts: std::collections::BTreeMap<String, String>,
    pub inference_operation: Option<String>,
    pub external_effects_started: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceReportKind {
    SourceHypotheses,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SecurityConclusion {
    NotEstablished,
}

/// Native source-hypothesis report; not a legacy scan/finding report.
/// Content identities do not confer verification or disclosure authority.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceReport {
    pub schema_version: u32,
    pub report_kind: SourceReportKind,
    pub verification_state: VerificationState,
    pub security_conclusion: SecurityConclusion,
    pub session_id: String,
    pub operation_id: String,
    pub snapshot_sha256: String,
    pub review: ReviewResult,
    pub artifacts: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reproductions: Vec<ReproductionReport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub repairs: Vec<RepairReport>,
}

/// Re-assessed retained observations, limited to an explicit frozen plan.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReproductionReport {
    pub operation_id: String,
    pub operation_status: crate::OperationStatus,
    pub assessment: crate::verification::Assessment,
    pub stop_reason: Option<crate::verification::ReproductionStop>,
    pub children: Vec<String>,
    pub artifacts: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepairPhaseReport {
    pub name: String,
    pub assessment: crate::verification::Assessment,
    pub children: Vec<String>,
    pub artifacts: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepairReport {
    pub operation_id: String,
    pub reproduction_operation_id: String,
    pub operation_status: crate::OperationStatus,
    pub status: crate::repair::RepairValidationStatus,
    pub original_plan_digest: String,
    pub candidate_receipt: Option<crate::repair::CandidateReceipt>,
    pub phases: Vec<RepairPhaseReport>,
    pub cleanup_recovery_count: usize,
    pub artifacts: std::collections::BTreeMap<String, String>,
}
