//! Read-only views over already verified retained bytes; never touches a host filesystem.
use crate::{Citation, Result, SourceBundle, SourceFile, invalid, path_valid};
use serde::Serialize;
pub const MAX_INVESTIGATION_OUTPUT_BYTES: usize = 64 * 1024;
pub const MAX_READ_LINES: u32 = 200;
pub const MAX_SEARCH_RESULTS: usize = 200;
pub const MAX_SEARCH_QUERY_BYTES: usize = 256;

/// Borrowed authority cannot be fabricated by deserializing a model tool request.
/// Imported bundles prove content identity only; the host must authorize their use.
pub struct SourceInvestigation<'a> {
    bundle: &'a SourceBundle,
}
#[derive(Debug, Clone, Serialize)]
pub struct FileSummary {
    pub path: String,
    pub sha256: String,
    pub bytes: usize,
    pub lines: usize,
}
#[derive(Debug, Clone, Serialize)]
pub struct FileListing {
    pub bundle_sha256: String,
    pub files: Vec<FileSummary>,
    pub truncated: bool,
    /// Last emitted canonical path when another page remains; scoped to this manifest.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_after_path: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct SourceRead {
    pub bundle_sha256: String,
    pub citation: Citation,
    pub total_lines: usize,
    pub text: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub citation: Citation,
    pub text: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct SourceSearch {
    pub bundle_sha256: String,
    pub matches: Vec<SearchHit>,
    pub truncated: bool,
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
        return Err(invalid("investigation path must be normal and relative"));
    }
    Ok(path)
}
fn scope(path: Option<&str>) -> Result<&str> {
    path.map_or(Ok(""), |p| normalized(p, true))
}
fn included(file: &SourceFile, scope: &str) -> bool {
    scope.is_empty()
        || file.path() == scope
        || file
            .path()
            .strip_prefix(scope)
            .is_some_and(|rest| rest.starts_with('/'))
}
fn fits(value: &impl Serialize) -> Result<bool> {
    Ok(serde_json::to_vec(value)?.len() <= MAX_INVESTIGATION_OUTPUT_BYTES)
}
fn checked<T: Serialize>(value: T) -> Result<T> {
    if fits(&value)? {
        Ok(value)
    } else {
        Err(invalid(
            "investigation output exceeds 64 KiB serialized limit",
        ))
    }
}
fn citation(file: &SourceFile, start_line: u32, end_line: u32) -> Citation {
    Citation {
        path: file.path().into(),
        sha256: file.sha256().into(),
        start_line,
        end_line,
    }
}
impl<'a> SourceInvestigation<'a> {
    pub fn new(bundle: &'a SourceBundle) -> Self {
        Self { bundle }
    }
    /// List retained selected files only, sorted by path. None or '.' means the retained root.
    pub fn list_files(&self, path: Option<&str>, limit: usize) -> Result<FileListing> {
        self.list_files_page(path, limit, None)
    }
    /// Deterministic exclusive cursor over the immutable authorized manifest.
    /// Cursors must be canonical existing files inside the requested scope.
    pub fn list_files_page(
        &self,
        path: Option<&str>,
        limit: usize,
        after_path: Option<&str>,
    ) -> Result<FileListing> {
        if !(1..=32).contains(&limit) {
            return Err(invalid("list limit must be 1..32"));
        }
        let prefix = scope(path)?;
        let mut files: Vec<_> = self
            .bundle
            .files()
            .iter()
            .filter(|f| included(f, prefix))
            .collect();
        files.sort_by(|a, b| a.path().cmp(b.path()));
        let start = match after_path {
            None => 0,
            Some(after) => {
                if !path_valid(after) {
                    return Err(invalid("list cursor must be canonical and relative"));
                }
                files
                    .iter()
                    .position(|file| file.path() == after)
                    .ok_or_else(|| invalid("list cursor is outside authorized scope or manifest"))?
                    + 1
            }
        };
        let remaining = &files[start..];
        let mut result = FileListing {
            bundle_sha256: self.bundle.digest().into(),
            files: vec![],
            truncated: false,
            next_after_path: None,
        };
        for (index, file) in remaining.iter().enumerate() {
            if result.files.len() == limit {
                break;
            }
            result.files.push(FileSummary {
                path: file.path().into(),
                sha256: file.sha256().into(),
                bytes: file.text().len(),
                lines: file.line_count(),
            });
            result.truncated = index + 1 < remaining.len();
            result.next_after_path = result.truncated.then(|| file.path().to_owned());
            // Include the cursor and the true truncation flag in the byte bound.
            if !fits(&result)? {
                result.files.pop();
                result.truncated = true;
                result.next_after_path = Some(
                    result
                        .files
                        .last()
                        .ok_or_else(|| invalid("listing entry exceeds output limit"))?
                        .path
                        .clone(),
                );
                break;
            }
        }
        checked(result)
    }
    /// Exact inclusive line slice, including original line terminators. Never appends synthetic source text.
    pub fn read_file(&self, path: &str, start_line: u32, end_line: u32) -> Result<SourceRead> {
        let path = normalized(path, false)?;
        if start_line == 0 || end_line < start_line || end_line - start_line >= MAX_READ_LINES {
            return Err(invalid("read requires an inclusive range of 1..200 lines"));
        }
        let file = self
            .bundle
            .files()
            .iter()
            .find(|f| f.path() == path)
            .ok_or_else(|| invalid("file is not retained in authorized bundle"))?;
        if end_line as usize > file.line_count() {
            return Err(invalid("read range exceeds retained file lines"));
        }
        let text = file
            .text()
            .split_inclusive('\n')
            .skip(start_line as usize - 1)
            .take((end_line - start_line + 1) as usize)
            .collect::<String>();
        checked(SourceRead {
            bundle_sha256: self.bundle.digest().into(),
            citation: citation(file, start_line, end_line),
            total_lines: file.line_count(),
            text,
        })
    }
    /// Case-sensitive literal substring matching, at most one complete result per matching line.
    /// No regex, shell, multiline queries, normalization, or filesystem reads are performed.
    pub fn search_files(
        &self,
        query: &str,
        path: Option<&str>,
        limit: usize,
    ) -> Result<SourceSearch> {
        self.search_files_with_options(query, path, limit, crate::SearchMode::Literal, true)
    }
    /// Explicit literal/regex mode with Unicode case folding when requested.
    /// Regex anchors match logical lines without their LF/CRLF terminator;
    /// returned text and citations retain the exact original bytes.
    pub fn search_files_with_options(
        &self,
        query: &str,
        path: Option<&str>,
        limit: usize,
        mode: crate::SearchMode,
        case_sensitive: bool,
    ) -> Result<SourceSearch> {
        let matcher = crate::search::Matcher::new(query, mode, case_sensitive).map_err(invalid)?;
        if !(1..=MAX_SEARCH_RESULTS).contains(&limit) {
            return Err(invalid("search result limit must be 1..200"));
        }
        let prefix = scope(path)?;
        let mut result = SourceSearch {
            bundle_sha256: self.bundle.digest().into(),
            matches: vec![],
            truncated: false,
        };
        'files: for file in self.bundle.files().iter().filter(|f| included(f, prefix)) {
            for (index, line) in file.text().split_inclusive('\n').enumerate() {
                if !matcher.matches(line) {
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
                    if result.matches.is_empty() {
                        return Err(invalid("matching line exceeds investigation output limit"));
                    }
                    result.truncated = true;
                    break 'files;
                }
            }
        }
        checked(result)
    }
}
