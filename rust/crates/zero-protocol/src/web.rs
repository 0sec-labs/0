//! Scoped web observations and unverified claims. Rendering or triage never confers proof.
use crate::{
    OperationStatus,
    agent::AgentStatus,
    http::HttpProfilePolicy,
    source::{ClaimedSeverity, SecurityConclusion, VerificationState},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum WebCitationPart {
    Status,
    Header { index: u32, expected_name: String },
    Body { offset: u64, length: u32 },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebCitation {
    pub operation_id: String,
    pub response_manifest_sha256: String,
    pub part: WebCitationPart,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebClaim {
    pub title: String,
    pub category: String,
    pub explanation: String,
    pub claimed_impact: String,
    pub claimed_severity: ClaimedSeverity,
    pub citations: Vec<WebCitation>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebHypothesis {
    pub id: String,
    pub state: VerificationState,
    pub claim: WebClaim,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebEvidenceReference {
    pub operation_id: String,
    pub response_manifest_sha256: String,
    pub retained_body_sha256: String,
    pub retained_bytes: u64,
    pub status: u16,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebReviewResult {
    pub schema_version: u32,
    pub request_sha256: String,
    pub completion_sha256: String,
    pub submission_call_id: String,
    pub model: String,
    pub provider_response_id: Option<String>,
    pub hypotheses: Vec<WebHypothesis>,
    pub evidence: Vec<WebEvidenceReference>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebReviewOutcome {
    pub review: WebReviewResult,
    pub artifacts: BTreeMap<String, String>,
    pub inference_operation: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebRunCandidate {
    pub sequence: u64,
    pub operation_id: String,
    pub command_id: String,
    pub operation_status: OperationStatus,
    pub web_review_sha256: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebRunsPage {
    pub runs: Vec<WebRunCandidate>,
    pub next_before_sequence: Option<u64>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WebTriageStatus {
    New,
    Accepted,
    Suppressed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebTriageDecision {
    pub id: String,
    pub command_id: String,
    pub session_id: String,
    pub web_operation_id: String,
    pub hypothesis_id: String,
    pub web_review_sha256: String,
    pub revision: u64,
    pub expected_revision: u64,
    pub status: WebTriageStatus,
    pub note: String,
    pub created_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebFindingRecord {
    pub session_id: String,
    pub web_operation_id: String,
    pub web_review_sha256: String,
    pub hypothesis: WebHypothesis,
    pub status: WebTriageStatus,
    pub revision: u64,
    pub last_decision: Option<WebTriageDecision>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebHttpAuthority {
    pub profile_name: String,
    pub profile_sha256: String,
    pub account_id: String,
    pub profile: HttpProfilePolicy,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebRun {
    pub session_id: String,
    pub operation_id: String,
    pub command_id: String,
    pub operation_status: OperationStatus,
    pub agent_status: Option<AgentStatus>,
    pub error: Option<String>,
    pub authority: WebHttpAuthority,
    pub review: Option<WebReviewResult>,
    pub artifacts: BTreeMap<String, String>,
}
/// Metadata remains visible when an incomplete effect has no retained response manifest.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebHttpOperation {
    pub sequence: u64,
    pub operation_id: String,
    pub actor_operation_id: String,
    pub operation_status: OperationStatus,
    pub response_manifest_sha256: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebHttpOperationsPage {
    pub operations: Vec<WebHttpOperation>,
    pub next_after_sequence: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpEvidenceMetadata {
    pub session_id: String,
    pub operation_id: String,
    pub operation_status: OperationStatus,
    pub response_manifest_sha256: String,
    pub retained_body_sha256: String,
    pub retained_bytes: u64,
    pub complete: bool,
    pub url: Option<String>,
    pub status: Option<u16>,
    pub headers: Vec<(String, String)>,
    pub wire_bytes: u64,
    pub decoded_bytes: u64,
    pub artifacts: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpEvidenceRange {
    pub session_id: String,
    pub operation_id: String,
    pub response_manifest_sha256: String,
    pub retained_body_sha256: String,
    pub offset: u64,
    pub total_bytes: u64,
    pub data_base64: String,
    pub next_offset: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WebStateMode {
    SameStaticIdentityExistingTarget,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WebCaseRole {
    Attack,
    LegitimateControl,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebExpectedResponse {
    pub status: u16,
    pub body_sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebVerificationCase {
    pub name: String,
    pub role: WebCaseRole,
    pub request: crate::http::HttpRequestArguments,
    pub expected: WebExpectedResponse,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebVerificationPlan {
    pub schema_version: u32,
    pub oracle_version: String,
    pub web_operation_id: String,
    pub web_review_sha256: String,
    pub hypothesis_id: String,
    pub state_mode: WebStateMode,
    pub repeats: u32,
    pub cases: Vec<WebVerificationCase>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebVerificationRequest {
    pub plan: WebVerificationPlan,
    pub expected_intent_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_intent_sha256: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebVerificationPreparation {
    pub intent_sha256: String,
    pub approval_required: bool,
    pub intent: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebVerificationAttempt {
    pub case_name: String,
    pub repeat_index: u32,
    pub operation_id: String,
    pub operation_status: OperationStatus,
    pub request_sha256: String,
    pub response_manifest_sha256: Option<String>,
    pub status: Option<u16>,
    pub body_sha256: Option<String>,
    pub complete: bool,
    pub possible_dispatch: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebVerificationAssessment {
    pub schema_version: u32,
    pub disposition: crate::verification::Disposition,
    pub oracle_version: String,
    pub plan_sha256: String,
    pub expected_attempts: u32,
    pub completed_attempts: u32,
    pub observed_attempts: u32,
    pub control_attempts: u32,
    pub reasons: Vec<String>,
    pub vulnerability_reportable: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WebVerificationStop {
    Cancelled,
    Unknown,
    PreparationFailed,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebVerificationOutcome {
    pub assessment: WebVerificationAssessment,
    pub attempts: Vec<WebVerificationAttempt>,
    pub stop: Option<WebVerificationStop>,
    pub artifacts: BTreeMap<String, String>,
    pub children: Vec<String>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebVerificationReport {
    pub operation_id: String,
    pub operation_status: OperationStatus,
    pub plan: WebVerificationPlan,
    pub intent_sha256: String,
    pub approved_intent_sha256: Option<String>,
    pub outcome: WebVerificationOutcome,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WebReportKind {
    WebObservations,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebReportObservation {
    pub operation: WebHttpOperation,
    pub evidence: Option<HttpEvidenceMetadata>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebWorkflowReport {
    pub schema_version: u32,
    pub report_kind: WebReportKind,
    pub verification_state: VerificationState,
    pub security_conclusion: SecurityConclusion,
    pub run: WebRun,
    pub observations: Vec<WebReportObservation>,
    pub observations_truncated: bool,
    pub verifications: Vec<WebVerificationReport>,
}
