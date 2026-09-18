use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Immutable complete generation; every artifact digest refers to retained bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub engine_artifact: String,
    pub components: BTreeMap<String, String>,
    pub protocol_version: u32,
    pub state_schema: String,
    pub compatible_state_schemas: Vec<String>,
    pub configuration: Value,
    pub policy_artifact: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationDecision {
    Eligible,
    Rejected,
    Inconclusive,
}
/// Trusted-controller supplied report, not cryptographic proof evaluation ran.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluationReceipt {
    pub candidate: String,
    pub baseline: String,
    pub evaluator_artifact: String,
    pub policy_artifact: String,
    pub evidence_artifacts: BTreeMap<String, String>,
    pub decision: EvaluationDecision,
    pub observations: Value,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeState {
    pub epoch: u64,
    pub generation: Option<String>,
    pub state_schema: String,
    pub state_digest: String,
    pub state: Value,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreparedState {
    pub state_schema: String,
    pub state: Value,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreparedActivation {
    pub id: String,
    pub generation: String,
    pub expected_epoch: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationLease {
    pub id: String,
    pub generation: String,
    pub owner: String,
    pub epoch: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuntimeLifecycle {
    Active,
    Draining { leases: u64 },
    Inactive,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Eligibility {
    pub generation: String,
    pub receipt: Option<String>,
    pub bootstrap_reason: Option<String>,
}
