//! Host-owned read-only investigation of an entire verified private snapshot.
use crate::investigation::{
    MAX_INVESTIGATION_OUTPUT_BYTES, MAX_READ_LINES, MAX_SEARCH_QUERY_BYTES, MAX_SEARCH_RESULTS,
    SearchHit,
};
use crate::{Citation, hash, path_valid};
use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
use zero_executor::StagedSnapshot;
use zero_protocol::{SnapshotFile, SnapshotPin};

pub const MAX_SNAPSHOT_FILES: usize = 4096;
pub const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_LIST_RESULTS: usize = 200;
type Result<T> = std::result::Result<T, SnapshotError>;
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("invalid snapshot investigation: {0}")]
    Invalid(&'static str),
    #[error("snapshot staging failed or was cancelled")]
    Staging,
    #[error("private snapshot read failed")]
    Io,
    #[error("private snapshot content no longer matches its manifest")]
    Integrity,
    #[error("snapshot investigation encoding failed")]
    Encoding,
    #[error("snapshot cleanup failed; recovery path: {path}")]
    Cleanup { path: PathBuf },
}
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotFileSummary {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotListing {
    pub snapshot_digest: String,
    pub files: Vec<SnapshotFileSummary>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotRead {
    pub snapshot_digest: String,
    pub citation: Citation,
    pub total_lines: usize,
    pub text: String,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    Oversized,
    NonUtf8,
    Nul,
}
#[derive(Debug, Clone, Serialize)]
pub struct SkippedFile {
    pub path: String,
    pub reason: SkipReason,
}
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotSearch {
    pub snapshot_digest: String,
    pub matches: Vec<SearchHit>,
    pub skipped: Vec<SkippedFile>,
    /// Files visited, including skipped files. This is not a count of searched text files.
    pub scanned_files: usize,
    /// True when result, exclusion, or output limits prevented exhaustive traversal.
    pub truncated: bool,
}
/// Only the host may prepare this authority. No deserialization, cloning, host
/// writes, or execution. Drop is best effort; cleanup reports a recovery path.
pub struct SnapshotInvestigation {
    stage: Option<StagedSnapshot>,
    directory: Option<File>,
    files: Vec<SnapshotFile>,
    digest: String,
}
impl Drop for SnapshotInvestigation {
    fn drop(&mut self) {
        self.directory.take();
        if let Some(stage) = self.stage.take() {
            let _ = stage.remove();
        }
    }
}
impl SnapshotInvestigation {
    pub fn prepare(pin: &SnapshotPin) -> Result<Self> {
        Self::prepare_checked(pin, &|| Ok(()))
    }
    /// Blocking; call outside runtime workers. The check is invoked throughout
    /// anchored verification/copy and may stop preparation for cancellation.
    pub fn prepare_checked(
        pin: &SnapshotPin,
        check: &dyn Fn() -> std::result::Result<(), String>,
    ) -> Result<Self> {
        if pin.files.is_empty() || pin.files.len() > MAX_SNAPSHOT_FILES {
            return Err(SnapshotError::Invalid("snapshot requires 1..4096 files"));
        }
        let mut total = 0u64;
        let mut seen = std::collections::BTreeSet::new();
        for file in &pin.files {
            if !path_valid(&file.path)
                || !zero_protocol::is_sha256(&file.digest)
                || !seen.insert(&file.path)
            {
                return Err(SnapshotError::Invalid("invalid manifest path or digest"));
            }
            total = total
                .checked_add(file.bytes)
                .ok_or(SnapshotError::Invalid("snapshot size overflow"))?;
            if total > MAX_SNAPSHOT_BYTES {
                return Err(SnapshotError::Invalid("snapshot exceeds 64 MiB"));
            }
        }
        let stage =
            zero_executor::stage_snapshot(pin, check).map_err(|_| SnapshotError::Staging)?;
        let mut owner = Self {
            stage: Some(stage),
            directory: None,
            files: pin.files.clone(),
            digest: pin.digest.clone(),
        };
        // Keep original array order for canonical catalog identity; listing/search
        // sort borrowed entries rather than changing the manifest.
        let source = owner.root().join("source");
        let opened = open_directory(&source).and_then(|file| {
            check().map_err(|_| SnapshotError::Staging)?;
            Ok(file)
        });
        match opened {
            Ok(file) => {
                owner.directory = Some(file);
                Ok(owner)
            }
            Err(error) => {
                owner.cleanup()?;
                Err(error)
            }
        }
    }
    /// Host recovery metadata; never include this private path in model tool output.
    pub fn root(&self) -> &Path {
        self.stage
            .as_ref()
            .map(|s| s.root())
            .unwrap_or(Path::new(""))
    }
    pub fn snapshot_digest(&self) -> &str {
        &self.digest
    }
    /// Exact canonical manifest bytes. SHA-256 equals snapshot_digest; no private
    /// or original root path is included. Hash identity does not confer authority.
    pub fn catalog_bytes(&self) -> Result<Vec<u8>> {
        let files: Vec<_> = self
            .files
            .iter()
            .map(|f| serde_json::json!({"bytes":f.bytes,"digest":f.digest,"path":f.path}))
            .collect();
        serde_json::to_vec(&files).map_err(|_| SnapshotError::Encoding)
    }
    pub fn cleanup(mut self) -> Result<()> {
        self.directory.take();
        if let Some(stage) = self.stage.take() {
            let path = stage.root().to_path_buf();
            stage
                .remove()
                .map_err(|_| SnapshotError::Cleanup { path })?;
        }
        Ok(())
    }
    fn scoped(&self, prefix: &str) -> Vec<&SnapshotFile> {
        let mut files: Vec<_> = self
            .files
            .iter()
            .filter(|f| {
                prefix.is_empty()
                    || f.path == prefix
                    || f.path
                        .strip_prefix(prefix)
                        .is_some_and(|s| s.starts_with('/'))
            })
            .collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files
    }
    pub fn list_files(&self, path: Option<&str>, limit: usize) -> Result<SnapshotListing> {
        if !(1..=MAX_LIST_RESULTS).contains(&limit) {
            return Err(SnapshotError::Invalid("list limit must be 1..200"));
        }
        let mut result = SnapshotListing {
            snapshot_digest: self.digest.clone(),
            files: vec![],
            truncated: false,
        };
        for file in self.scoped(scope(path)?) {
            if result.files.len() == limit {
                result.truncated = true;
                break;
            }
            result.files.push(SnapshotFileSummary {
                path: file.path.clone(),
                sha256: file.digest.clone(),
                bytes: file.bytes,
            });
            if !fits(&result)? {
                result.files.pop();
                result.truncated = true;
                break;
            }
        }
        bounded(result)
    }
    fn text(&self, file: &SnapshotFile) -> Result<std::result::Result<String, SkipReason>> {
        if file.bytes > crate::MAX_FILE_BYTES as u64 {
            return Ok(Err(SkipReason::Oversized));
        }
        let directory = self.directory.as_ref().ok_or(SnapshotError::Io)?;
        let mut handle = open_file(directory, &file.path)?;
        let metadata = handle.metadata().map_err(|_| SnapshotError::Io)?;
        if !metadata.is_file() || metadata.len() != file.bytes {
            return Err(SnapshotError::Integrity);
        }
        let mut bytes = Vec::new();
        (&mut handle)
            .take(crate::MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| SnapshotError::Io)?;
        if bytes.len() as u64 != file.bytes || hash(&bytes) != file.digest {
            return Err(SnapshotError::Integrity);
        }
        let Ok(text) = String::from_utf8(bytes) else {
            return Ok(Err(SkipReason::NonUtf8));
        };
        if text.contains('\0') {
            return Ok(Err(SkipReason::Nul));
        }
        Ok(Ok(text))
    }
    pub fn read_file(&self, path: &str, start_line: u32, end_line: u32) -> Result<SnapshotRead> {
        let path = normalized(path, false)?;
        if start_line == 0 || end_line < start_line || end_line - start_line >= MAX_READ_LINES {
            return Err(SnapshotError::Invalid(
                "read requires an inclusive range of 1..200 lines",
            ));
        }
        let file = self
            .files
            .iter()
            .find(|f| f.path == path)
            .ok_or(SnapshotError::Invalid("file is not pinned"))?;
        let text = self
            .text(file)?
            .map_err(|_| SnapshotError::Invalid("file exceeds text size or encoding limits"))?;
        let total_lines = text.split_inclusive('\n').count();
        if end_line as usize > total_lines {
            return Err(SnapshotError::Invalid("read range exceeds file lines"));
        }
        bounded(SnapshotRead {
            snapshot_digest: self.digest.clone(),
            citation: citation(file, start_line, end_line),
            total_lines,
            text: text
                .split_inclusive('\n')
                .skip(start_line as usize - 1)
                .take((end_line - start_line + 1) as usize)
                .collect(),
        })
    }
    pub fn search_files(
        &self,
        query: &str,
        path: Option<&str>,
        limit: usize,
    ) -> Result<SnapshotSearch> {
        if query.is_empty()
            || query.len() > MAX_SEARCH_QUERY_BYTES
            || query.contains(['\r', '\n', '\0'])
        {
            return Err(SnapshotError::Invalid(
                "search requires 1..256 UTF-8 bytes without line breaks or NUL",
            ));
        }
        if !(1..=MAX_SEARCH_RESULTS).contains(&limit) {
            return Err(SnapshotError::Invalid("search result limit must be 1..200"));
        }
        let mut result = SnapshotSearch {
            snapshot_digest: self.digest.clone(),
            matches: vec![],
            skipped: vec![],
            scanned_files: 0,
            truncated: false,
        };
        'files: for file in self.scoped(scope(path)?) {
            result.scanned_files += 1;
            let text = match self.text(file)? {
                Ok(text) => text,
                Err(reason) => {
                    if result.skipped.len() == MAX_SEARCH_RESULTS {
                        result.truncated = true;
                        break;
                    }
                    result.skipped.push(SkippedFile {
                        path: file.path.clone(),
                        reason,
                    });
                    if !fits(&result)? {
                        result.skipped.pop();
                        result.truncated = true;
                        break;
                    }
                    continue;
                }
            };
            for (index, line) in text.split_inclusive('\n').enumerate() {
                if !line.contains(query) {
                    continue;
                }
                if result.matches.len() == limit {
                    result.truncated = true;
                    break 'files;
                }
                result.matches.push(SearchHit {
                    citation: citation(file, index as u32 + 1, index as u32 + 1),
                    text: line.into(),
                });
                if !fits(&result)? {
                    result.matches.pop();
                    result.truncated = true;
                    break 'files;
                }
            }
        }
        bounded(result)
    }
}
fn citation(file: &SnapshotFile, start_line: u32, end_line: u32) -> Citation {
    Citation {
        path: file.path.clone(),
        sha256: file.digest.clone(),
        start_line,
        end_line,
    }
}
fn normalized(path: &str, directory: bool) -> Result<&str> {
    if directory && path == "." {
        return Ok("");
    }
    let path = path.strip_prefix("./").unwrap_or(path);
    let path = if directory {
        path.strip_suffix('/').unwrap_or(path)
    } else {
        path
    };
    if !path_valid(path) {
        return Err(SnapshotError::Invalid("path must be normal and relative"));
    }
    Ok(path)
}
fn scope(path: Option<&str>) -> Result<&str> {
    path.map_or(Ok(""), |p| normalized(p, true))
}
fn fits(value: &impl Serialize) -> Result<bool> {
    Ok(serde_json::to_vec(value)
        .map_err(|_| SnapshotError::Encoding)?
        .len()
        <= MAX_INVESTIGATION_OUTPUT_BYTES)
}
fn bounded<T: Serialize>(value: T) -> Result<T> {
    if fits(&value)? {
        Ok(value)
    } else {
        Err(SnapshotError::Invalid(
            "output exceeds 64 KiB serialized limit",
        ))
    }
}
#[cfg(target_os = "linux")]
fn open_directory(path: &Path) -> Result<File> {
    use nix::{
        fcntl::{OFlag, open, openat},
        sys::stat::Mode,
    };
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let mut directory =
        File::from(open(Path::new("/"), flags, Mode::empty()).map_err(|_| SnapshotError::Io)?);
    for part in path.components() {
        match part {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(name) => {
                directory = File::from(
                    openat(&directory, name, flags, Mode::empty())
                        .map_err(|_| SnapshotError::Io)?,
                )
            }
            _ => return Err(SnapshotError::Io),
        }
    }
    Ok(directory)
}
#[cfg(target_os = "linux")]
fn open_file(directory: &File, path: &str) -> Result<File> {
    use nix::{
        fcntl::{OFlag, openat},
        sys::stat::Mode,
    };
    let mut parent = directory.try_clone().map_err(|_| SnapshotError::Io)?;
    let mut components = path.split('/').peekable();
    while let Some(name) = components.next() {
        let mut flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK;
        if components.peek().is_some() {
            flags |= OFlag::O_DIRECTORY;
        }
        parent =
            File::from(openat(&parent, name, flags, Mode::empty()).map_err(|_| SnapshotError::Io)?);
    }
    Ok(parent)
}
#[cfg(not(target_os = "linux"))]
fn open_directory(_: &Path) -> Result<File> {
    Err(SnapshotError::Io)
}
#[cfg(not(target_os = "linux"))]
fn open_file(_: &File, _: &str) -> Result<File> {
    Err(SnapshotError::Io)
}
