//! Explicit host authorization for reproducing a retained native review claim.
//! Envelope validation does not authenticate source provenance or validate the
//! frozen oracle. The admitting host must also validate `plan` with FrozenPlan.
use crate::{is_sha256, managed_scan::canonical_uuid, verification::Plan};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewReproductionPlan {
    pub schema_version: u32,
    pub review_id: String,
    pub source_operation_id: String,
    pub archive_manifest_sha256: String,
    pub plan: Plan,
    pub deadline_ms: u64,
    pub max_executions: u32,
}

/// Retained logical-to-execution identity relation, never an attestation.
/// The host derives and authenticates every field against original receipts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewReproductionBinding {
    pub schema_version: u32,
    pub review_id: String,
    pub source_session_id: String,
    pub source_operation_id: String,
    pub archive_manifest_sha256: String,
    pub authorization_sha256: String,
    pub logical_plan_sha256: String,
    pub execution_plan_sha256: String,
}

impl ReviewReproductionPlan {
    /// Validate only the native identity and aggregate authorization envelope.
    /// Deep matrix, backend, snapshot and expectation checks belong to
    /// zero-verification; passing this method never authorizes execution alone.
    pub fn validate_envelope(&self) -> Result<(), String> {
        if self.schema_version != 1
            || !canonical_uuid(&self.review_id)
            || !canonical_uuid(&self.source_operation_id)
            || !is_sha256(&self.archive_manifest_sha256)
            || !(1..=3_600_000).contains(&self.deadline_ms)
            || !(1..=256).contains(&self.max_executions)
        {
            return Err("invalid review reproduction identity, version or limits".into());
        }
        let executions = self
            .plan
            .cases
            .len()
            .checked_mul(self.plan.repeats)
            .ok_or("review reproduction matrix size overflow")?;
        if executions == 0 || executions > self.max_executions as usize {
            return Err("review reproduction matrix exceeds execution authorization".into());
        }
        Ok(())
    }
}
