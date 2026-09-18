//! Batch-only offline snapshot execution. Host-selected values confer authority;
//! neither guest output nor an execution ID authorizes host access.
use crate::ValidationError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SnapshotFile {
    pub path: String,
    pub digest: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SnapshotPin {
    pub id: String,
    pub root: String,
    /// SHA-256 of canonical JSON of files, preserving array order, with each
    /// object's keys ordered bytes,digest,path (the existing TS contract).
    pub digest: String,
    pub files: Vec<SnapshotFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRequest {
    pub execution_id: String,
    pub image: String,
    pub snapshot: SnapshotPin,
    pub argv: Vec<String>,
    #[serde(default)]
    pub build_argv: Option<Vec<String>>,
    /// Already serialized input. The executor does not silently canonicalize it.
    #[serde(default)]
    pub stdin: Option<String>,
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpus: f64,
    /// Independent cap on each raw output stream, matching the TS executor.
    pub max_output_bytes: usize,
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

fn valid_argv(args: &[String]) -> bool {
    !args.is_empty()
        && args.len() <= 128
        && !args[0].is_empty()
        && args
            .iter()
            .all(|s| !s.contains('\0') && s.encode_utf16().count() <= 8192)
}

impl ExecutionRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let fail = |s: &str| Err(ValidationError(s.into()));
        if self.execution_id.is_empty()
            || self.execution_id.len() > 128
            || !self
                .execution_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return fail("execution_id must contain 1..128 ASCII letters, digits, '-', '_' or '.'");
        }
        if self.image.is_empty()
            || self.image.len() > 512
            || !self.image.as_bytes()[0].is_ascii_alphanumeric()
            || !self
                .image
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_./:@-".contains(&b))
        {
            return fail("invalid local Docker image reference");
        }
        if !valid_argv(&self.argv) || self.build_argv.as_ref().is_some_and(|a| !valid_argv(a)) {
            return fail(
                "argv must contain 1..128 NUL-free arguments of at most 8192 UTF-16 units",
            );
        }
        if !(100..=600_000).contains(&self.timeout_ms)
            || !(32..=16_384).contains(&self.memory_mb)
            || !self.cpus.is_finite()
            || self.cpus <= 0.0
            || self.cpus > 16.0
            || !(256..=16 * 1024 * 1024).contains(&self.max_output_bytes)
            || self
                .stdin
                .as_ref()
                .is_some_and(|s| s.len() > 16 * 1024 * 1024)
        {
            return fail("execution limits are outside the supported range");
        }
        let snapshot = &self.snapshot;
        if snapshot.id.is_empty()
            || snapshot.id.len() > 512
            || !std::path::Path::new(&snapshot.root).is_absolute()
            || snapshot.root.contains(['\0', ','])
            || !is_sha256(&snapshot.digest)
            || snapshot.files.is_empty()
        {
            return fail(
                "snapshot requires an absolute safe root, identity, digest and file index",
            );
        }
        let mut paths = HashSet::new();
        let mut bytes = 0_u64;
        for file in &snapshot.files {
            if file.path.is_empty()
                || file.path.len() > 4096
                || file.path.contains(['\0', '\\'])
                || file
                    .path
                    .split('/')
                    .any(|s| s.is_empty() || s == "." || s == "..")
                || !paths.insert(&file.path)
                || !is_sha256(&file.digest)
            {
                return fail("invalid or duplicate snapshot file path/digest");
            }
            bytes = bytes
                .checked_add(file.bytes)
                .ok_or_else(|| ValidationError("snapshot byte overflow".into()))?;
        }
        // Existing maxSourceBytes upper bound, before allocation or file reads.
        if bytes > 512 * 1024 * 1024 {
            return fail("snapshot exceeds 512 MiB");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutionEvent {
    Started {
        execution_id: String,
        image_id: String,
        container_id: String,
    },
    Output {
        execution_id: String,
        sequence: u64,
        stream: OutputStream,
        #[serde(with = "crate::binary")]
        #[schemars(with = "String")]
        bytes: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Exited,
    Cancelled,
    TimedOut,
    OutputLimit,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CleanupStatus {
    NotCreated,
    Confirmed,
    /// Create may have reached the daemon even when its CLI was interrupted.
    Unconfirmed {
        container_name: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExecutionResult {
    pub execution_id: String,
    pub status: ExecutionStatus,
    pub exit_code: Option<i32>,
    #[serde(with = "crate::binary")]
    #[schemars(with = "String")]
    pub stdout: Vec<u8>,
    #[serde(with = "crate::binary")]
    #[schemars(with = "String")]
    pub stderr: Vec<u8>,
    pub duration_ms: u64,
    pub cleanup: CleanupStatus,
    /// Private staged snapshot retained when container teardown is uncertain.
    pub recovery_dir: Option<String>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_limits_and_fractional_cpu() {
        let mut r: ExecutionRequest = serde_json::from_value(serde_json::json!({
            "execution_id":"test", "image":"local:tag", "argv":["true"],
            "snapshot":{"id":"s", "root":"/tmp/s", "digest":format!("sha256:{}", "a".repeat(64)),
                "files":[{"path":"a", "bytes":0,"digest":format!("sha256:{}", "b".repeat(64))}]},
            "timeout_ms":100, "memory_mb":32,"cpus":0.25,"max_output_bytes":256
        }))
        .unwrap();
        assert!(r.validate().is_ok());
        r.cpus = f64::NAN;
        assert!(r.validate().is_err());
        r.cpus = 1.0;
        r.argv = vec!["x".into(); 129];
        assert!(r.validate().is_err());
        r.argv = vec!["true".into()];
        r.snapshot.files[0].path = "../outside".into();
        assert!(r.validate().is_err());
    }
}
