use crate::SnapshotPin;
use serde::{Deserialize, Serialize};
/// These fields are supplied/approved by the host, not authority carried by a model reply.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MaterializeRequest {
    pub baseline: SnapshotPin,
    pub target: String,
    pub allowed_paths: Vec<String>,
    /// Exact files or directory prefixes, using normal relative paths without trailing slash.
    pub protected_paths: Vec<String>,
    pub expected_preimage_sha256: String,
    pub replacement: String,
}

/// Inert content identity. Deserializing this record grants no authority and verifies no repair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CandidateReceipt {
    pub schema_version: u32,
    pub baseline_snapshot_sha256: String,
    pub target: String,
    pub preimage_sha256: String,
    pub replacement_sha256: String,
    pub replacement_bytes: u64,
    pub candidate_snapshot_sha256: String,
    pub policy_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepairValidationRequest {
    pub reproduction_operation_id: String,
    pub materialize: MaterializeRequest,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RepairValidationStatus {
    ValidatedCandidateForPlan,
    NotValidated,
    Cancelled,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RepairPhase {
    pub name: String,
    pub derived_plan_digest: String,
    pub observations: crate::verification::ReproductionOutcome,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RepairValidationOutcome {
    pub status: RepairValidationStatus,
    pub original_plan_digest: Option<String>,
    pub candidate_receipt: Option<CandidateReceipt>,
    pub phases: Vec<RepairPhase>,
    pub artifacts: std::collections::BTreeMap<String, String>,
    pub cleanup_recovery: Vec<String>,
    pub error: Option<String>,
    pub vulnerability_reportable: bool,
}
