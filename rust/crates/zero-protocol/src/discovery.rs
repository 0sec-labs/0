//! Attachment discovery metadata, never a finding or validation receipt.
use crate::OperationStatus;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceReviewCandidate {
    pub sequence: u64,
    pub operation_id: String,
    pub command_id: String,
    pub operation_status: OperationStatus,
    pub source_review_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceReviewPage {
    pub reviews: Vec<SourceReviewCandidate>,
    /// Exclusive cursor at the last consumed JOURNAL row, not necessarily a
    /// returned candidate. An empty page with a cursor is not exhausted.
    pub next_before_sequence: Option<u64>,
}
