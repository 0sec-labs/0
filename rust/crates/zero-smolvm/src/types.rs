use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Host-authorized read-only directory mapping; not a source snapshot attestation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadOnlyMount {
    pub source: PathBuf,
    pub target: String,
}
/// Batch-only, offline execution. The digest identifies archive bytes, not OCI metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SmolvmRequest {
    pub execution_id: String,
    pub image_archive: PathBuf,
    pub archive_digest: String,
    pub argv: Vec<String>,
    #[serde(default)]
    pub stdin: Vec<u8>,
    #[serde(default)]
    pub mounts: Vec<ReadOnlyMount>,
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpus: u16,
    pub storage_gb: u16,
    pub max_output_bytes: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SmolvmStatus {
    Exited,
    Failed,
    Cancelled,
    TimedOut,
    OutputLimit,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum VmCleanup {
    NotCreated,
    Confirmed,
    Unknown { reason: String },
    Unconfirmed { recovery_dir: PathBuf },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmolvmResult {
    pub execution_id: String,
    pub archive_digest: String,
    pub status: SmolvmStatus,
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub cleanup: VmCleanup,
    pub duration_ms: u64,
    pub error: Option<String>,
}
/// Trusted host configuration, never inferred from guest output.
#[derive(Debug, Clone)]
pub struct SmolvmConfig {
    pub binary: PathBuf,
    pub setpriv: PathBuf,
}
impl Default for SmolvmConfig {
    fn default() -> Self {
        Self {
            binary: "smolvm".into(),
            setpriv: "setpriv".into(),
        }
    }
}
