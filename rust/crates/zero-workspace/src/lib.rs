//! Pure private workspace generations. No filesystem or execution authority.
mod patch;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use zero_protocol::{
    source_archive::{ArchiveChunk, ArchiveFile, SourceArchive},
    workspace_edit::{WorkspaceCall, WorkspacePolicy},
};
pub fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub fn generation(archive: &SourceArchive) -> Result<String, String> {
    Ok(hash(&archive.manifest.canonical_bytes()?))
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileState {
    pub sha256: String,
    pub bytes: u64,
    pub executable: bool,
}
impl From<&ArchiveFile> for FileState {
    fn from(f: &ArchiveFile) -> Self {
        Self {
            sha256: f.sha256.clone(),
            bytes: f.bytes,
            executable: f.executable,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub path: String,
    pub before: Option<FileState>,
    pub after: Option<FileState>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditReceipt {
    pub before_generation: String,
    pub after_generation: String,
    pub changes: Vec<Change>,
    pub changed_bytes: u64,
}
pub struct Transition {
    pub archive: SourceArchive,
    pub receipt: EditReceipt,
}
pub fn validate_baseline(archive: &SourceArchive, policy: &WorkspacePolicy) -> Result<(), String> {
    archive.validate()?;
    policy.validate().map_err(|e| e.to_string())?;
    for p in &policy.paths {
        let found = archive.manifest.files.iter().find(|f| f.path == p.path);
        if found.map(|f| &f.sha256) != p.baseline_sha256.as_ref()
            || found.is_some_and(|f| f.executable != p.executable)
        {
            return Err(format!(
                "workspace baseline content/mode precondition differs: {}",
                p.path
            ));
        }
    }
    Ok(())
}
pub fn bytes(archive: &SourceArchive, path: &str) -> Result<Vec<u8>, String> {
    let file = archive
        .manifest
        .files
        .iter()
        .find(|f| f.path == path)
        .ok_or("workspace path absent")?;
    let mut bytes = Vec::with_capacity(file.bytes as usize);
    for chunk in &file.chunks {
        bytes.extend_from_slice(
            archive
                .blobs
                .get(&chunk.sha256)
                .ok_or("workspace chunk absent")?,
        );
    }
    if bytes.len() as u64 != file.bytes || hash(&bytes) != file.sha256 {
        return Err("workspace file integrity differs".into());
    }
    Ok(bytes)
}
fn text(archive: &SourceArchive, path: &str) -> Result<String, String> {
    String::from_utf8(bytes(archive, path)?).map_err(|_| "workspace file is not UTF-8".into())
}
fn changed(before: &SourceArchive, after: &SourceArchive) -> Vec<Change> {
    let paths: BTreeSet<_> = before
        .manifest
        .files
        .iter()
        .chain(after.manifest.files.iter())
        .map(|f| &f.path)
        .collect();
    paths
        .into_iter()
        .filter_map(|path| {
            let a = before
                .manifest
                .files
                .iter()
                .find(|f| &f.path == path)
                .map(FileState::from);
            let b = after
                .manifest
                .files
                .iter()
                .find(|f| &f.path == path)
                .map(FileState::from);
            (a != b).then(|| Change {
                path: path.clone(),
                before: a,
                after: b,
            })
        })
        .collect()
}
pub fn changes(before: &SourceArchive, after: &SourceArchive) -> Result<Vec<Change>, String> {
    before.validate()?;
    after.validate()?;
    Ok(changed(before, after))
}
fn put(
    archive: &mut SourceArchive,
    policy: &WorkspacePolicy,
    path: &str,
    content: Option<&str>,
) -> Result<(), String> {
    let allowed = policy
        .paths
        .iter()
        .find(|p| p.path == path)
        .ok_or("path is not host-authorized for editing")?;
    if content.is_some_and(|s| s.len() > 1024 * 1024 || s.contains('\0')) {
        return Err("workspace file exceeds1MiB or contains NUL".into());
    }
    archive.manifest.files.retain(|f| f.path != path);
    if let Some(content) = content {
        let sha = hash(content.as_bytes());
        let chunks = if content.is_empty() {
            vec![]
        } else {
            archive
                .blobs
                .insert(sha.clone(), content.as_bytes().to_vec());
            vec![ArchiveChunk {
                sha256: sha.clone(),
                bytes: content.len() as u64,
            }]
        };
        archive.manifest.files.push(ArchiveFile {
            path: path.into(),
            sha256: sha,
            bytes: content.len() as u64,
            executable: allowed.executable,
            chunks,
        });
    }
    Ok(())
}
fn finalize(archive: &mut SourceArchive) -> Result<(), String> {
    archive.manifest.files.sort_by(|a, b| a.path.cmp(&b.path));
    let files: Vec<_> = archive
        .manifest
        .files
        .iter()
        .map(|f| json!({"bytes":f.bytes,"digest":f.sha256,"path":f.path}))
        .collect();
    archive.manifest.snapshot_sha256 =
        hash(&serde_json::to_vec(&files).map_err(|e| e.to_string())?);
    let used: BTreeSet<_> = archive
        .manifest
        .files
        .iter()
        .flat_map(|f| f.chunks.iter().map(|c| c.sha256.clone()))
        .collect();
    archive.blobs.retain(|sha, _| used.contains(sha));
    archive.validate()
}
pub fn propose(
    archive: &SourceArchive,
    policy: &WorkspacePolicy,
    call: &WorkspaceCall,
) -> Result<Transition, String> {
    WorkspaceCall::parse(call.name(), &call.arguments())?;
    archive.validate()?;
    let before = generation(archive)?;
    if call.expected_generation() != Some(before.as_str()) {
        return Err("workspace generation changed; read current bytes before retrying".into());
    }
    let mut after = archive.clone();
    match call {
        WorkspaceCall::Write { path, content, .. } => put(&mut after, policy, path, Some(content))?,
        WorkspaceCall::Replace {
            path,
            old_string,
            new_string,
            replace_all,
            ..
        } => {
            let old = text(archive, path)?;
            let count = old.matches(old_string).count();
            if old_string.is_empty() || count == 0 || (!replace_all && count != 1) {
                return Err("workspace old_string absent or ambiguous".into());
            }
            let replacement = if *replace_all {
                old.replace(old_string, new_string)
            } else {
                old.replacen(old_string, new_string, 1)
            };
            put(&mut after, policy, path, Some(&replacement))?;
        }
        WorkspaceCall::Patch { patch, .. } => {
            for operation in patch::parse(patch)? {
                match operation {
                    patch::Op::Add {
                        path,
                        content,
                        replace,
                    } => {
                        if !replace && after.manifest.files.iter().any(|f| f.path == path) {
                            return Err("Add File refuses existing path".into());
                        }
                        put(&mut after, policy, &path, Some(&content))?;
                    }
                    patch::Op::Delete { path } => {
                        if !after.manifest.files.iter().any(|f| f.path == path) {
                            return Err("Delete File requires existing path".into());
                        }
                        put(&mut after, policy, &path, None)?;
                    }
                    patch::Op::Update { path, hunks } => {
                        let old = text(&after, &path)?;
                        let updated = patch::update(&old, &hunks)?;
                        put(&mut after, policy, &path, Some(&updated))?;
                    }
                }
            }
        }
        _ => return Err("call is not a workspace edit".into()),
    }
    finalize(&mut after)?;
    let changes = changed(archive, &after);
    if changes.is_empty() {
        return Err("workspace edit has no change".into());
    }
    let changed_bytes = changes
        .iter()
        .filter_map(|c| c.after.as_ref().map(|f| f.bytes))
        .sum();
    Ok(Transition {
        receipt: EditReceipt {
            before_generation: before,
            after_generation: generation(&after)?,
            changes,
            changed_bytes,
        },
        archive: after,
    })
}
pub fn observe(archive: &SourceArchive, call: &WorkspaceCall) -> Result<Value, String> {
    WorkspaceCall::parse(call.name(), &call.arguments())?;
    let generation = generation(archive)?;
    match call {
        WorkspaceCall::List {
            prefix,
            after,
            max_results,
        } => {
            let all: Vec<_> = archive
                .manifest
                .files
                .iter()
                .filter(|f| f.path.starts_with(prefix) && f.path.as_str() > after.as_str())
                .collect();
            let files:Vec<_>=all.iter().take(*max_results as usize).map(|f|json!({"path":f.path,"sha256":f.sha256,"bytes":f.bytes,"executable":f.executable})).collect();
            Ok(
                json!({"generation":generation,"files":files,"truncated":all.len()>files.len(),"next_after":files.last().and_then(|f|f["path"].as_str())}),
            )
        }
        WorkspaceCall::Read {
            path,
            offset,
            max_bytes,
        } => {
            let text = text(archive, path)?;
            let start = usize::try_from(*offset).map_err(|_| "workspace offset")?;
            if start > text.len() || !text.is_char_boundary(start) {
                return Err("workspace offset is not a valid UTF-8 byte boundary".into());
            }
            let mut end = text.len().min(start + *max_bytes as usize);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            if end == start && start < text.len() {
                return Err("workspace page is too small for next UTF-8 character".into());
            }
            Ok(
                json!({"generation":generation,"path":path,"sha256":hash(text.as_bytes()),"offset":offset,"next_offset":end,"text":&text[start..end],"truncated":end<text.len()}),
            )
        }
        WorkspaceCall::Search {
            query,
            prefix,
            max_results,
        } => {
            let mut results = vec![];
            let mut used = 0usize;
            let mut skipped = 0usize;
            let mut truncated = false;
            'files: for file in archive
                .manifest
                .files
                .iter()
                .filter(|f| f.path.starts_with(prefix))
            {
                let Ok(text) = text(archive, &file.path) else {
                    skipped += 1;
                    continue;
                };
                for (index, line) in text.lines().enumerate() {
                    if line.contains(query) {
                        if results.len() >= *max_results as usize
                            || used + line.len() + file.path.len() > 65536
                        {
                            truncated = true;
                            break 'files;
                        }
                        used += line.len() + file.path.len();
                        results.push(json!({"path":file.path,"line":index+1,"text":line,"sha256":file.sha256}));
                    }
                }
            }
            Ok(
                json!({"generation":generation,"results":results,"truncated":truncated,"skipped_non_utf8":skipped}),
            )
        }
        _ => Err("call is not a workspace observation".into()),
    }
}
