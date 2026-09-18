//! Shared offline snapshot program contract; backend choice never permits fallback.
use crate::{ExecutionRequest, ExecutionStatus, SnapshotPin, ValidationError, is_sha256};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SandboxBackend {
    Docker {
        image: String,
    },
    Smolvm {
        image_archive: PathBuf,
        archive_digest: String,
        storage_gb: u16,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SandboxRequest {
    pub execution_id: String,
    pub backend: SandboxBackend,
    pub snapshot: SnapshotPin,
    pub argv: Vec<String>,
    #[serde(default)]
    pub build_argv: Option<Vec<String>>,
    #[serde(default)]
    pub stdin: Option<String>,
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpus: f64,
    pub max_output_bytes: usize,
}
impl SandboxRequest {
    /// Adapter preserves the existing exact snapshot-program limits. The dummy
    /// image for microVM validation confers no Docker authority or fallback.
    pub fn docker_request(&self) -> ExecutionRequest {
        ExecutionRequest {
            execution_id: self.execution_id.clone(),
            image: match &self.backend {
                SandboxBackend::Docker { image } => image.clone(),
                _ => "unused".into(),
            },
            snapshot: self.snapshot.clone(),
            argv: self.argv.clone(),
            build_argv: self.build_argv.clone(),
            stdin: self.stdin.clone(),
            timeout_ms: self.timeout_ms,
            memory_mb: self.memory_mb,
            cpus: self.cpus,
            max_output_bytes: self.max_output_bytes,
        }
    }
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.docker_request().validate()?;
        if let SandboxBackend::Smolvm {
            image_archive,
            archive_digest,
            storage_gb,
        } = &self.backend
        {
            if self.cpus.fract() != 0.0 {
                return Err(ValidationError(
                    "smolvm requires integer CPUs; fractional values are never rounded".into(),
                ));
            }
            if !image_archive.is_absolute()
                || image_archive.to_str().is_none_or(|v| v.contains('\0'))
                || !is_sha256(archive_digest)
                || !(1..=64).contains(storage_gb)
            {
                return Err(ValidationError(
                    "smolvm requires an absolute local archive, byte SHA-256 and 1..64 GiB storage"
                        .into(),
                ));
            }
        }
        Ok(())
    }
}
impl From<ExecutionRequest> for SandboxRequest {
    fn from(r: ExecutionRequest) -> Self {
        Self {
            execution_id: r.execution_id,
            backend: SandboxBackend::Docker { image: r.image },
            snapshot: r.snapshot,
            argv: r.argv,
            build_argv: r.build_argv,
            stdin: r.stdin,
            timeout_ms: r.timeout_ms,
            memory_mb: r.memory_mb,
            cpus: r.cpus,
            max_output_bytes: r.max_output_bytes,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SandboxArtifact {
    Docker {
        image_reference: String,
        resolved_image_id: Option<String>,
    },
    SmolvmArchive {
        digest: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SandboxRecovery {
    Docker {
        container_name: String,
        snapshot_dir: Option<String>,
    },
    Smolvm {
        runtime_dir: Option<PathBuf>,
        snapshot_dir: Option<PathBuf>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SandboxCleanup {
    NotCreated,
    Confirmed,
    Unconfirmed {
        recovery: SandboxRecovery,
    },
    Unknown {
        reason: String,
        recovery: Option<SandboxRecovery>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SandboxResult {
    pub execution_id: String,
    pub artifact: SandboxArtifact,
    pub status: ExecutionStatus,
    pub exit_code: Option<i32>,
    #[serde(with = "crate::binary")]
    #[schemars(with = "String")]
    pub stdout: Vec<u8>,
    #[serde(with = "crate::binary")]
    #[schemars(with = "String")]
    pub stderr: Vec<u8>,
    pub duration_ms: u64,
    pub cleanup: SandboxCleanup,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SandboxEvent {
    Started {
        execution_id: String,
        artifact: SandboxArtifact,
    },
    Output {
        execution_id: String,
        sequence: u64,
        stream: crate::OutputStream,
        #[serde(with = "crate::binary")]
        #[schemars(with = "String")]
        bytes: Vec<u8>,
    },
}
