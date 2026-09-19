//! Explicit host intent for repairing an independently reproduced native claim.
use crate::{managed_scan::canonical_uuid, repair::MaterializeRequest};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewRepairPlan {
    pub schema_version: u32,
    pub reproduction_id: String,
    /// Uses the original logical snapshot, never a caller-selected replacement root.
    pub materialize: MaterializeRequest,
    pub deadline_ms: u64,
    /// Must cover two complete, fresh candidate matrices, checked against the
    /// independently retained baseline rather than caller-supplied case counts.
    pub max_executions: u32,
}
impl ReviewRepairPlan {
    pub fn validate_envelope(&self) -> Result<(), String> {
        if self.schema_version != 1
            || !canonical_uuid(&self.reproduction_id)
            || !(1..=3_600_000).contains(&self.deadline_ms)
            || !(1..=512).contains(&self.max_executions)
        {
            return Err("invalid native repair version, identity or limits".into());
        }
        Ok(())
    }
}

/// Inert retained identity relation. It neither grants execution nor validates a repair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewRepairBinding {
    pub schema_version: u32,
    pub reproduction_id: String,
    pub reproduction_operation_id: String,
    pub review_id: String,
    pub source_operation_id: String,
    pub archive_manifest_sha256: String,
    pub reproduction_authorization_sha256: String,
    pub repair_authorization_sha256: String,
    pub logical_plan_sha256: String,
    pub execution_baseline_plan_sha256: String,
    pub materialize_request_sha256: String,
    pub candidate_receipt_sha256: String,
}

/// Durable identity of independently authorized native repair work. This record
/// alone neither grants a sandbox permit nor establishes a validated candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NativeRepairRecord {
    pub schema_version: u32,
    pub id: String,
    pub command_id: String,
    pub session_id: String,
    pub operation_id: String,
    pub source_reproduction_id: String,
    pub reproduction_operation_id: String,
    pub reproduction_evidence_sha256: String,
    pub authorization_sha256: String,
    pub intent_sha256: String,
    pub created_at_ms: u64,
    pub deadline_at_ms: u64,
    pub sequence: u64,
}
