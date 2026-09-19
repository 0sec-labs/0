use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use zero_protocol::source_archive::{ArchiveFile, ArchiveManifest, SourceArchive};

pub fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileState {
    pub sha256: String,
    pub bytes: u64,
    pub executable: bool,
}
impl From<&ArchiveFile> for FileState {
    fn from(file: &ArchiveFile) -> Self {
        Self {
            sha256: file.sha256.clone(),
            bytes: file.bytes,
            executable: file.executable,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub path: String,
    pub before: Option<FileState>,
    pub after: Option<FileState>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    schema_version: u32,
    assessment: String,
    session_id: String,
    operation_id: String,
    actor_status: zero_protocol::OperationStatus,
    baseline_generation: String,
    final_generation: String,
    baseline: ArchiveManifest,
    current: ArchiveManifest,
    policy: Value,
    changes: Vec<Change>,
    edit_and_test_receipts: Value,
    tests: Value,
    host_apply: String,
}

/// Validated bytes and exact changes, still unverified as a software repair.
pub struct Bundle {
    pub digest: String,
    pub baseline: SourceArchive,
    pub current: SourceArchive,
    pub changes: Vec<Change>,
}
impl Bundle {
    /// The loader supplies bounded raw chunks; filesystem access belongs to the
    /// host reader, not a model tool. No provided source tree is trusted.
    pub fn decode(
        raw: &[u8],
        mut load: impl FnMut(&str, u64) -> Result<Vec<u8>, String>,
    ) -> Result<Self, String> {
        if raw.len() > 32 * 1024 * 1024 {
            return Err("workspace bundle exceeds 32MiB".into());
        }
        let e: Envelope = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
        if e.schema_version != 1
            || e.assessment != "unverified"
            || e.host_apply != "not_performed"
            || e.session_id.is_empty()
            || e.session_id.len() > 256
            || e.operation_id.is_empty()
            || e.operation_id.len() > 256
            || matches!(
                e.actor_status,
                zero_protocol::OperationStatus::Admitted | zero_protocol::OperationStatus::Running
            )
        {
            return Err("workspace bundle identity or terminal state differs".into());
        }
        e.baseline.validate()?;
        e.current.validate()?;
        if hash(&e.baseline.canonical_bytes()?) != e.baseline_generation
            || hash(&e.current.canonical_bytes()?) != e.final_generation
        {
            return Err("workspace generation differs from content and modes".into());
        }
        let mut loaded = BTreeMap::new();
        for manifest in [&e.baseline, &e.current] {
            for chunk in manifest.files.iter().flat_map(|f| &f.chunks) {
                if !loaded.contains_key(&chunk.sha256) {
                    let bytes = load(&chunk.sha256, chunk.bytes)?;
                    if bytes.len() as u64 != chunk.bytes || hash(&bytes) != chunk.sha256 {
                        return Err("workspace chunk content differs".into());
                    }
                    loaded.insert(chunk.sha256.clone(), bytes);
                }
            }
        }
        let archive = |manifest: ArchiveManifest| -> Result<SourceArchive, String> {
            let ids: BTreeSet<_> = manifest
                .files
                .iter()
                .flat_map(|f| f.chunks.iter().map(|c| c.sha256.clone()))
                .collect();
            let blobs = loaded
                .iter()
                .filter(|(id, _)| ids.contains(*id))
                .map(|(id, b)| (id.clone(), b.clone()))
                .collect();
            let archive = SourceArchive { manifest, blobs };
            archive.validate()?;
            Ok(archive)
        };
        let baseline = archive(e.baseline)?;
        let current = archive(e.current)?;
        let paths: BTreeSet<_> = baseline
            .manifest
            .files
            .iter()
            .chain(&current.manifest.files)
            .map(|f| &f.path)
            .collect();
        let changes: Vec<_> = paths
            .into_iter()
            .filter_map(|path| {
                let before = baseline
                    .manifest
                    .files
                    .iter()
                    .find(|f| &f.path == path)
                    .map(FileState::from);
                let after = current
                    .manifest
                    .files
                    .iter()
                    .find(|f| &f.path == path)
                    .map(FileState::from);
                (before != after).then(|| Change {
                    path: path.clone(),
                    before,
                    after,
                })
            })
            .collect();
        if changes != e.changes || changes.len() > 256 {
            return Err("workspace change list differs from archives".into());
        }
        let allowed = e.policy["paths"]
            .as_array()
            .ok_or("workspace path policy absent")?;
        for change in &changes {
            if change
                .path
                .split('/')
                .any(|part| matches!(part, ".git" | ".hg" | ".svn"))
            {
                return Err("workspace apply refuses repository control files".into());
            }
            let entries: Vec<_> = allowed
                .iter()
                .filter(|p| p["path"].as_str() == Some(&change.path))
                .collect();
            if entries.len() != 1 {
                return Err("workspace change lacks unique path authority".into());
            }
            let p = entries[0];
            if p["baseline_sha256"]
                != serde_json::to_value(change.before.as_ref().map(|s| &s.sha256))
                    .map_err(|e| e.to_string())?
                || change
                    .before
                    .iter()
                    .chain(change.after.iter())
                    .any(|s| p["executable"].as_bool() != Some(s.executable))
            {
                return Err("workspace change differs from path preconditions".into());
            }
        }
        // Retained outcomes are evidence for human review, never apply authority
        // or an independent success verdict.
        let _unverified = (e.edit_and_test_receipts, e.tests);
        Ok(Self {
            digest: hash(raw),
            baseline,
            current,
            changes,
        })
    }
}
