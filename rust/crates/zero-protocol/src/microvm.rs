//! Low-level offline microVM batch values. Archive bytes and Docker images have distinct identities.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Host-authorized read-only directory mapping; not a source snapshot attestation.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadOnlyMount {
    pub source: PathBuf,
    pub target: String,
}
/// Batch-only, offline execution. The digest identifies archive bytes, not OCI metadata.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SmolvmRequest {
    pub execution_id: String,
    pub image_archive: PathBuf,
    pub archive_digest: String,
    pub argv: Vec<String>,
    #[serde(default)]
    #[serde(with = "crate::binary")]
    #[schemars(with = "String")]
    pub stdin: Vec<u8>,
    #[serde(default)]
    pub mounts: Vec<ReadOnlyMount>,
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpus: u16,
    pub storage_gb: u16,
    pub max_output_bytes: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SmolvmStatus {
    Exited,
    Failed,
    Cancelled,
    TimedOut,
    OutputLimit,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum VmCleanup {
    NotCreated,
    Confirmed,
    Unknown { reason: String },
    Unconfirmed { recovery_dir: PathBuf },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SmolvmResult {
    pub execution_id: String,
    pub archive_digest: String,
    pub status: SmolvmStatus,
    pub exit_code: Option<i32>,
    #[serde(with = "crate::binary")]
    #[schemars(with = "String")]
    pub stdout: Vec<u8>,
    #[serde(with = "crate::binary")]
    #[schemars(with = "String")]
    pub stderr: Vec<u8>,
    pub cleanup: VmCleanup,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_bytes_are_base64_in_wire_and_schema() {
        let result = SmolvmResult {
            execution_id: "e".into(),
            archive_digest: format!("sha256:{}", "0".repeat(64)),
            status: SmolvmStatus::Exited,
            exit_code: Some(0),
            stdout: vec![0, 255],
            stderr: vec![],
            cleanup: VmCleanup::Confirmed,
            duration_ms: 1,
            error: None,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["stdout"], "AP8=");
        assert_eq!(
            serde_json::from_value::<SmolvmResult>(value)
                .unwrap()
                .stdout,
            vec![0, 255]
        );
        let schema = serde_json::to_value(schemars::schema_for!(SmolvmResult)).unwrap();
        assert_eq!(schema["properties"]["stdout"]["type"], "string");
    }
}
