use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use zero_protocol::SnapshotFile;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceFile {
    path: String,
    sha256: String,
    /// Exact UTF-8 text, without newline normalization. Encoding retains source bytes.
    text: String,
}
impl SourceFile {
    pub fn path(&self) -> &str {
        &self.path
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    /// Empty files have no lines; a final LF does not create an extra empty line.
    pub fn line_count(&self) -> usize {
        if self.text.is_empty() {
            0
        } else {
            self.text.bytes().filter(|b| *b == b'\n').count()
                + usize::from(!self.text.ends_with('\n'))
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleData {
    version: u32,
    snapshot_id: String,
    snapshot_digest: String,
    snapshot_files: Vec<SnapshotFile>,
    files: Vec<SourceFile>,
    question: String,
    max_hypotheses: u32,
}
/// Validated portable source bytes. Deserialization is deliberately only through
/// from_bytes: matching hashes prove identity, not the authority of an importer.
#[derive(Debug, Clone)]
pub struct SourceBundle {
    data: BundleData,
    digest: String,
}
impl SourceBundle {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(invalid("artifact exceeds 4 MiB"));
        }
        Self::validate(serde_json::from_slice(bytes)?)
    }
    fn validate(data: BundleData) -> Result<Self> {
        if !matches!(data.version, 1 | 2)
            || data.snapshot_id.is_empty()
            || data.snapshot_id.len() > 512
        {
            return Err(invalid("bundle version/identity"));
        }
        validate_options(&data.question, data.max_hypotheses)?;
        validate_index(&data.snapshot_files)?;
        if zero_executor::snapshot_digest(&data.snapshot_files).map_err(invalid)?
            != data.snapshot_digest
        {
            return Err(invalid("snapshot manifest digest mismatch"));
        }
        if data.files.len() > 32
            || (data.version == 1 && data.files.is_empty())
            || (data.version == 2 && !data.files.is_empty())
        {
            return Err(invalid(
                "file selection does not match bundle version or bounds",
            ));
        }
        let index: BTreeMap<_, _> = data
            .snapshot_files
            .iter()
            .map(|f| (f.path.as_str(), f))
            .collect();
        let mut last: Option<&str> = None;
        let mut total = 0;
        for file in &data.files {
            if last.is_some_and(|p| p >= file.path.as_str()) {
                return Err(invalid("selected files must be unique sorted paths"));
            }
            last = Some(&file.path);
            let expected = index
                .get(file.path.as_str())
                .ok_or_else(|| invalid("selected file not pinned"))?;
            total += file.text.len();
            if file.text.len() > MAX_FILE_BYTES
                || total > MAX_SOURCE_BYTES
                || file.text.contains('\0')
            {
                return Err(invalid("text size or NUL bound"));
            }
            if hash(file.text.as_bytes()) != file.sha256
                || expected.digest != file.sha256
                || expected.bytes != file.text.len() as u64
            {
                return Err(invalid("retained source digest/size mismatch"));
            }
        }
        let digest = identity(&data)?;
        Ok(Self { data, digest })
    }
    /// Build only from already hash-verified private snapshot text. Version 2
    /// represents an explicitly empty adaptive selection, never a safety verdict.
    pub(crate) fn from_selected_snapshot(
        snapshot_id: String,
        snapshot_digest: String,
        snapshot_files: Vec<SnapshotFile>,
        selected: Vec<(String, String)>,
        question: &str,
        max_hypotheses: u32,
    ) -> Result<Self> {
        Self::validate(BundleData {
            version: if selected.is_empty() { 2 } else { 1 },
            snapshot_id,
            snapshot_digest,
            snapshot_files,
            files: selected
                .into_iter()
                .map(|(path, text)| SourceFile {
                    sha256: hash(text.as_bytes()),
                    path,
                    text,
                })
                .collect(),
            question: question.into(),
            max_hypotheses,
        })
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        encoded(&self.data)
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
    pub fn files(&self) -> &[SourceFile] {
        &self.data.files
    }
    pub fn question(&self) -> &str {
        &self.data.question
    }
    pub fn max_hypotheses(&self) -> u32 {
        self.data.max_hypotheses
    }
    pub fn snapshot_digest(&self) -> &str {
        &self.data.snapshot_digest
    }
}
#[derive(Debug, Clone)]
pub struct PreparedReview {
    bundle: SourceBundle,
}
impl PreparedReview {
    pub fn from_bundle(bundle: SourceBundle) -> Self {
        Self { bundle }
    }
    pub fn bundle(&self) -> &SourceBundle {
        &self.bundle
    }
    pub fn request(&self, model: &str) -> Result<PreparedSubmission> {
        PreparedSubmission::new(self.bundle.clone(), model)
    }
}
pub(crate) fn validate_options(question: &str, max: u32) -> Result<()> {
    if question.trim().is_empty()
        || question.len() > zero_protocol::source::MAX_SOURCE_QUESTION_BYTES
        || question.contains('\0')
        || !(1..=32).contains(&max)
    {
        return Err(invalid("question or hypothesis bound"));
    }
    Ok(())
}
fn validate_index(files: &[SnapshotFile]) -> Result<()> {
    if files.is_empty() || files.len() > 4096 {
        return Err(invalid("snapshot requires 1..4096 files"));
    }
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    for file in files {
        if !path_valid(&file.path)
            || !zero_protocol::is_sha256(&file.digest)
            || !seen.insert(&file.path)
        {
            return Err(invalid("invalid snapshot file path/digest"));
        }
        total = total
            .checked_add(file.bytes)
            .ok_or_else(|| invalid("snapshot size overflow"))?;
        if total > 64 * 1024 * 1024 {
            return Err(invalid("snapshot exceeds 64 MiB staging limit"));
        }
    }
    Ok(())
}
/// Blocking local preparation, never launches a guest/provider. The anchored
/// executor verifier copies the complete pin into a new private staging tree;
/// only then are selected bytes read from that exclusively owned copy.
pub fn prepare(request: &ReviewRequest) -> Result<PreparedReview> {
    validate_options(&request.question, request.max_hypotheses)?;
    validate_index(&request.snapshot.files)?;
    if request.selected_files.is_empty() || request.selected_files.len() > 32 {
        return Err(invalid("select 1..32 files"));
    }
    let mut selected = BTreeSet::new();
    let mut total = 0u64;
    for path in &request.selected_files {
        if !path_valid(path) || !selected.insert(path) {
            return Err(invalid("invalid/duplicate selected path"));
        }
        let file = request
            .snapshot
            .files
            .iter()
            .find(|f| &f.path == path)
            .ok_or_else(|| invalid("selected file not pinned"))?;
        total += file.bytes;
        if file.bytes > MAX_FILE_BYTES as u64 || total > MAX_SOURCE_BYTES as u64 {
            return Err(invalid("selected source exceeds bounds"));
        }
    }
    let staged = zero_executor::stage_snapshot(&request.snapshot, &|| Ok(())).map_err(invalid)?;
    let retained = (|| {
        let mut files = vec![];
        for path in selected {
            let file = std::fs::File::open(staged.source().join(path))?;
            let mut bytes = Vec::new();
            file.take(MAX_FILE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > MAX_FILE_BYTES {
                return Err(invalid("staged source exceeds file bound"));
            }
            let sha256 = hash(&bytes);
            let text =
                String::from_utf8(bytes).map_err(|_| invalid("selected source must be UTF-8"))?;
            files.push(SourceFile {
                path: path.clone(),
                sha256,
                text,
            });
        }
        SourceBundle::validate(BundleData {
            version: 1,
            snapshot_id: request.snapshot.id.clone(),
            snapshot_digest: request.snapshot.digest.clone(),
            snapshot_files: request.snapshot.files.clone(),
            files,
            question: request.question.clone(),
            max_hypotheses: request.max_hypotheses,
        })
    })();
    // No guest ever owns this tree; clean up both successful and failed reads.
    staged.remove().map_err(invalid)?;
    Ok(PreparedReview { bundle: retained? })
}
