//! Host triage disposition only: accepting a hypothesis does not verify it.
use crate::source::Hypothesis;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceFindingStatus {
    New,
    Accepted,
    Suppressed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TriageDecision {
    pub id: String,
    pub command_id: String,
    pub session_id: String,
    pub source_operation_id: String,
    pub hypothesis_id: String,
    pub source_review_sha256: String,
    pub revision: u64,
    pub expected_revision: u64,
    pub status: SourceFindingStatus,
    pub note: String,
    pub created_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceFindingRecord {
    pub session_id: String,
    pub source_operation_id: String,
    pub source_review_sha256: String,
    pub hypothesis: Hypothesis,
    pub status: SourceFindingStatus,
    pub revision: u64,
    pub last_decision: Option<TriageDecision>,
}
pub(crate) fn history_limit() -> u32 {
    50
}

pub(crate) fn finding_limit() -> u32 {
    32
}
