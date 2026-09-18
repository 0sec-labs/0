use serde::{Deserialize, Serialize};
use zero_protocol::{
    SnapshotPin,
    sandbox::{SandboxBackend, SandboxRequest, SandboxResult},
};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Attack,
    LegitimateControl,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExactOutput {
    pub exit_code: i32,
    #[serde(with = "crate::binary")]
    pub stdout: Vec<u8>,
    #[serde(with = "crate::binary")]
    pub stderr: Vec<u8>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub id: String,
    pub mode: Mode,
    pub argv: Vec<String>,
    pub stdin: Option<String>,
    pub expected: ExactOutput,
    /// Future repair expectation, frozen now. Baseline assessment does not use it.
    #[serde(default)]
    pub safe_expected: Option<ExactOutput>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpus: f64,
    pub max_output_bytes: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub schema_version: u32,
    pub oracle_version: String,
    pub hypothesis_id: String,
    pub source_bundle_digest: String,
    pub snapshot: SnapshotPin,
    pub backend: SandboxBackend,
    pub limits: Limits,
    pub repeats: usize,
    pub cases: Vec<Case>,
}
/// Supplied only by the trusted executor journal. These are retained observations,
/// not a signed attestation; deserializing bytes cannot establish their provenance.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub case_id: String,
    pub repeat: usize,
    pub request: SandboxRequest,
    pub result: SandboxResult,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    ObservedForPlan,
    NotObserved,
    Inconclusive,
    Cancelled,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    CompleteExactObservation,
    StableAttackMismatch,
    MissingOrDuplicateMatrix,
    ReusedExecutionIdentity,
    RequestIdentityMismatch,
    BackendIdentityMismatch,
    UnconfirmedCleanup,
    Cancelled,
    ExecutionUnavailable,
    OutputLimit,
    UnstableRepeatedOutput,
    LegitimateControlMismatch,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assessment {
    pub schema_version: u32,
    pub oracle_version: String,
    pub plan_digest: String,
    pub hypothesis_id: String,
    pub source_bundle_digest: String,
    pub snapshot_digest: String,
    pub evidence_digest: String,
    pub disposition: Disposition,
    pub reasons: Vec<Reason>,
    pub observed_attempts: usize,
    pub required_attempts: usize,
    /// Always false: the oracle establishes outputs under this plan, not a generic finding.
    pub vulnerability_reportable: bool,
    pub assessment_digest: String,
}
