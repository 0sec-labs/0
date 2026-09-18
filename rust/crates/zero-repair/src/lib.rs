//! Host-authorized single-file candidate copies. No behavioral validation or host apply.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};
use zero_executor::StagedSnapshot;
use zero_protocol::SnapshotPin;

pub const MAX_REPLACEMENT_BYTES: usize = 128 * 1024;
pub const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SNAPSHOT_FILES: usize = 4096;

/// These fields are supplied/approved by the host, not authority carried by a model reply.
#[derive(Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

/// Owns an unpublished private copy. Never mount it directly: executors must stage its pin.
/// Drop attempts best-effort cleanup; `cleanup` reports failures and a recovery path.
/// This owner is deliberately neither Clone nor Deserialize.
pub struct Candidate {
    stage: Option<StagedSnapshot>,
    snapshot: SnapshotPin,
    receipt: CandidateReceipt,
    replacement: String,
}
impl Candidate {
    pub fn snapshot(&self) -> &SnapshotPin {
        &self.snapshot
    }
    pub fn receipt(&self) -> &CandidateReceipt {
        &self.receipt
    }
    /// Exact proposed bytes for immutable artifact retention and fresh reconstruction.
    pub fn replacement_bytes(&self) -> &[u8] {
        self.replacement.as_bytes()
    }
    /// Remove the private copy explicitly, retaining its recovery path on failure.
    /// There are no running effects owned by this materialization handle.
    pub fn cleanup(mut self) -> Result<(), Error> {
        if let Some(stage) = self.stage.take() {
            let path = stage.root().to_path_buf();
            stage.remove().map_err(|_| Error::Cleanup { path })?;
        }
        Ok(())
    }
}
impl Drop for Candidate {
    fn drop(&mut self) {
        if let Some(stage) = self.stage.take() {
            let _ = stage.remove();
        }
    }
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid candidate request: {0}")]
    Invalid(&'static str),
    #[error("baseline staging or candidate pinning failed")]
    Snapshot,
    #[error("candidate copy I/O failed")]
    Io,
    #[error("candidate cleanup failed; private copy retained at {path}")]
    Cleanup { path: std::path::PathBuf },
    #[error("candidate receipt encoding failed")]
    Encoding,
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
fn valid_hash(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn paths(paths: &[String]) -> Result<BTreeSet<&str>, Error> {
    if paths.len() > MAX_SNAPSHOT_FILES {
        return Err(Error::Invalid("too many policy paths"));
    }
    let mut unique = BTreeSet::new();
    for path in paths {
        if !valid_path(path) {
            return Err(Error::Invalid("non-normal policy path"));
        }
        if !unique.insert(path.as_str()) {
            return Err(Error::Invalid("duplicate policy path"));
        }
    }
    Ok(unique)
}
fn validate(request: &MaterializeRequest) -> Result<String, Error> {
    if !valid_path(&request.target) {
        return Err(Error::Invalid("non-normal target"));
    }
    if request.replacement.len() > MAX_REPLACEMENT_BYTES || request.replacement.contains('\0') {
        return Err(Error::Invalid(
            "replacement must be bounded UTF-8 text without NUL",
        ));
    }
    if !valid_hash(&request.expected_preimage_sha256) {
        return Err(Error::Invalid("invalid preimage digest"));
    }
    let allowed = paths(&request.allowed_paths)?;
    let protected = paths(&request.protected_paths)?;
    if !allowed.contains(request.target.as_str()) {
        return Err(Error::Invalid("target is not explicitly allowlisted"));
    }
    if protected.iter().any(|p| {
        request.target == *p
            || request
                .target
                .strip_prefix(*p)
                .is_some_and(|rest| rest.starts_with('/'))
    }) {
        return Err(Error::Invalid("target overlaps a protected path"));
    }
    let mut files = BTreeSet::new();
    let mut bytes = 0u64;
    if request.baseline.files.is_empty() || request.baseline.files.len() > MAX_SNAPSHOT_FILES {
        return Err(Error::Invalid("snapshot file count bound"));
    }
    for file in &request.baseline.files {
        if !valid_path(&file.path) || !valid_hash(&file.digest) || !files.insert(file.path.as_str())
        {
            return Err(Error::Invalid("invalid or duplicate snapshot path/digest"));
        }
        bytes = bytes
            .checked_add(file.bytes)
            .ok_or(Error::Invalid("snapshot size overflow"))?;
        if bytes > MAX_SNAPSHOT_BYTES {
            return Err(Error::Invalid("snapshot byte bound"));
        }
    }
    let target = request
        .baseline
        .files
        .iter()
        .find(|f| f.path == request.target)
        .ok_or(Error::Invalid("target is not an existing pinned file"))?;
    if target.digest != request.expected_preimage_sha256 {
        return Err(Error::Invalid("preimage digest does not match pin"));
    }
    if target.bytes > MAX_REPLACEMENT_BYTES as u64 {
        return Err(Error::Invalid("source text byte bound"));
    }
    if bytes - target.bytes + request.replacement.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err(Error::Invalid("candidate byte bound"));
    }
    let policy = serde_json::to_vec(
        &serde_json::json!({"allowed_paths":allowed,"protected_paths":protected}),
    )
    .map_err(|_| Error::Encoding)?;
    Ok(hash(&policy))
}

/// Verify the entire pinned baseline, copy it into a private owned tree, and replace one file.
/// Call off async runtime workers: snapshot traversal is synchronous and bounded by the manifest.
pub fn materialize(request: &MaterializeRequest) -> Result<Candidate, Error> {
    let policy_sha256 = validate(request)?;
    let stage = zero_executor::stage_snapshot(&request.baseline, &|| Ok(()))
        .map_err(|_| Error::Snapshot)?;
    // Establish cleanup ownership immediately so every later error removes the private copy.
    let mut candidate = Candidate {
        stage: Some(stage),
        snapshot: request.baseline.clone(),
        replacement: request.replacement.clone(),
        receipt: CandidateReceipt {
            schema_version: 1,
            baseline_snapshot_sha256: request.baseline.digest.clone(),
            target: request.target.clone(),
            preimage_sha256: request.expected_preimage_sha256.clone(),
            replacement_sha256: hash(request.replacement.as_bytes()),
            replacement_bytes: request.replacement.len() as u64,
            candidate_snapshot_sha256: String::new(),
            policy_sha256,
        },
    };
    let root = candidate.stage.as_ref().ok_or(Error::Io)?.source();
    let target = root.join(Path::new(&request.target));
    // This tree was just created by anchored staging and has never been exposed to a guest.
    let original = std::fs::read(&target).map_err(|_| Error::Io)?;
    if hash(&original) != request.expected_preimage_sha256 {
        return Err(Error::Invalid("staged preimage mismatch"));
    }
    if std::str::from_utf8(&original).is_err() || original.contains(&0) {
        return Err(Error::Invalid("preimage is not UTF-8 source text"));
    }
    let permissions = std::fs::metadata(&target)
        .map_err(|_| Error::Io)?
        .permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            &target,
            std::fs::Permissions::from_mode(permissions.mode() | 0o200),
        )
        .map_err(|_| Error::Io)?;
    }
    std::fs::write(&target, request.replacement.as_bytes()).map_err(|_| Error::Io)?;
    std::fs::set_permissions(&target, permissions).map_err(|_| Error::Io)?;
    candidate.snapshot = zero_executor::pin_snapshot(&root).map_err(|_| Error::Snapshot)?;
    if candidate.snapshot.files.len() != request.baseline.files.len()
        || candidate.snapshot.files.iter().any(|f| {
            request
                .baseline
                .files
                .iter()
                .find(|b| b.path == f.path)
                .is_none_or(|b| {
                    if f.path == request.target {
                        f.digest != candidate.receipt.replacement_sha256
                            || f.bytes != candidate.receipt.replacement_bytes
                    } else {
                        f.digest != b.digest || f.bytes != b.bytes
                    }
                })
        })
    {
        return Err(Error::Invalid(
            "candidate changed more than the authorized file",
        ));
    }
    candidate.receipt.candidate_snapshot_sha256 = candidate.snapshot.digest.clone();
    Ok(candidate)
}
