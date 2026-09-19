//! Host-captured source acquisition identity, not an upstream authenticity signature.
mod npm;
use crate::{SnapshotPin, is_sha256};
pub use npm::{NpmReceipt, NpmReceiptRef, NpmSource, validate_npm_name, validate_npm_version};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

pub const MAX_REPOSITORY_FILES: usize = 4096;
pub const MAX_REPOSITORY_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GitSource {
    Https {
        url: String,
    },
    /// Explicit local transport; never inferred from an unrecognized URL.
    Local {
        path: String,
    },
}
impl GitSource {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Https { url } => {
                let parsed = url::Url::parse(url).map_err(|_| "invalid Git HTTPS URL")?;
                if url.len() > 2048
                    || parsed.scheme() != "https"
                    || parsed.host_str().is_none()
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.query().is_some()
                    || parsed.fragment().is_some()
                    || parsed.as_str() != url
                    || url.contains('\\')
                    || url.chars().any(char::is_control)
                {
                    return Err(
                        "Git URL must be canonical HTTPS without credentials, query or fragment"
                            .into(),
                    );
                }
            }
            Self::Local { path } => validate_absolute(path)?,
        }
        Ok(())
    }
}
pub fn validate_ref(reference: &str) -> Result<(), String> {
    if git_oid(reference) {
        return Ok(());
    }
    if reference.len() > 256
        || !(reference.starts_with("refs/heads/") || reference.starts_with("refs/tags/"))
        || reference.contains("..")
        || reference.contains("//")
        || reference.ends_with('/')
        || reference.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || part.ends_with('.')
                || part.ends_with(".lock")
        })
        || !reference
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
    {
        return Err("Git ref must be a full branch/tag ref or lowercase SHA-1 commit ID".into());
    }
    Ok(())
}
pub fn git_oid(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn validate_repository_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\\')
        || path.contains(':')
        || path.chars().any(char::is_control)
        || path.starts_with('/')
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.eq_ignore_ascii_case(".git"))
    {
        return Err("unsafe repository file path".into());
    }
    Ok(())
}
fn validate_absolute(path: &str) -> Result<(), String> {
    if path.len() > 4096
        || !Path::new(path).is_absolute()
        || path.chars().any(char::is_control)
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return Err("repository path must be absolute and normalized".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepositoryReceipt {
    pub schema_version: u32,
    pub object_format: String,
    pub source: GitSource,
    pub requested_ref: String,
    pub commit_oid: String,
    pub tree_oid: String,
    pub snapshot: SnapshotPin,
    /// Sorted executable paths; SnapshotPin's historical digest excludes modes.
    pub executable_paths: Vec<String>,
}
impl RepositoryReceipt {
    pub fn validate(&self) -> Result<(), String> {
        self.source.validate()?;
        validate_ref(&self.requested_ref)?;
        validate_absolute(&self.snapshot.root)?;
        if self.schema_version != 1
            || self.object_format != "sha1"
            || !git_oid(&self.commit_oid)
            || !git_oid(&self.tree_oid)
            || (git_oid(&self.requested_ref) && self.requested_ref != self.commit_oid)
            || self.snapshot.files.len() > MAX_REPOSITORY_FILES
            || self.executable_paths.len() > self.snapshot.files.len()
            || self.snapshot.id.is_empty()
            || self.snapshot.id.len() > 256
            || self.snapshot.id.chars().any(char::is_control)
        {
            return Err("invalid repository receipt identity".into());
        }
        validate_snapshot(&self.snapshot, &self.executable_paths)
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        serde_json::to_vec(&serde_json::to_value(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }
}

fn validate_snapshot(snapshot: &SnapshotPin, executable_paths: &[String]) -> Result<(), String> {
    validate_absolute(&snapshot.root)?;
    if snapshot.files.len() > MAX_REPOSITORY_FILES
        || executable_paths.len() > snapshot.files.len()
        || snapshot.id.is_empty()
        || snapshot.id.len() > 256
        || snapshot.id.chars().any(char::is_control)
    {
        return Err("invalid acquired snapshot bounds".into());
    }
    let mut total = 0u64;
    let mut previous: Option<&str> = None;
    for file in &snapshot.files {
        validate_repository_path(&file.path)?;
        if previous.is_some_and(|p| p >= file.path.as_str()) || !is_sha256(&file.digest) {
            return Err("repository manifest order or digest differs".into());
        }
        previous = Some(&file.path);
        total = total
            .checked_add(file.bytes)
            .ok_or("repository size overflow")?;
    }
    let manifest: Vec<_> = snapshot
        .files
        .iter()
        .map(|f| serde_json::json!({"path":f.path,"digest":f.digest,"bytes":f.bytes}))
        .collect();
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&manifest).map_err(|e| e.to_string())?)
    );
    if total > MAX_REPOSITORY_BYTES || snapshot.digest != digest {
        return Err("repository snapshot digest or size differs".into());
    }
    let mut last: Option<&str> = None;
    for path in executable_paths {
        if last.is_some_and(|p| p >= path.as_str())
            || !snapshot.files.iter().any(|f| &f.path == path)
        {
            return Err("repository executable index differs".into());
        }
        last = Some(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_ref_and_url_grammar_reject_hidden_authority() {
        for reference in ["refs/heads/main", "refs/tags/v1.0", &"a".repeat(40)] {
            validate_ref(reference).unwrap();
        }
        for reference in [
            "main",
            "HEAD",
            "refs/heads/x:refs/heads/y",
            "refs/heads/x^{commit}",
            "refs/tags/a.lock",
            "refs/heads/../a",
            "refs/heads/.secret",
        ] {
            assert!(validate_ref(reference).is_err(), "{reference}");
        }
        for url in [
            "http://example.test/repo",
            "https://u:p@example.test/repo",
            "https://example.test/repo?token=secret",
            "https://example.test/repo#main",
            "https://example.test/../repo",
            "https://EXAMPLE.test/repo",
        ] {
            assert!(
                GitSource::Https { url: url.into() }.validate().is_err(),
                "{url}"
            );
        }
        GitSource::Https {
            url: "https://example.test/repo.git".into(),
        }
        .validate()
        .unwrap();
    }
    #[test]
    fn path_grammar_forbids_git_metadata_and_traversal() {
        for path in [
            "../secret",
            "a/../../b",
            "/absolute",
            "a//b",
            "a/./b",
            ".git/config",
            "a/.GiT/config",
            "a\\b",
            "a\nb",
            "a:b",
        ] {
            assert!(validate_repository_path(path).is_err(), "{path}");
        }
        validate_repository_path("src/file with spaces.rs").unwrap();
    }
    #[test]
    fn receipts_bind_content_modes_and_strict_schema() {
        let mut receipt = RepositoryReceipt {
            schema_version: 1,
            object_format: "sha1".into(),
            source: GitSource::Https {
                url: "https://example.test/repo".into(),
            },
            requested_ref: "refs/heads/main".into(),
            commit_oid: "a".repeat(40),
            tree_oid: "b".repeat(40),
            snapshot: SnapshotPin {
                id: "capture".into(),
                root: "/private/source".into(),
                digest: format!("sha256:{:x}", Sha256::digest(b"[]")),
                files: vec![],
            },
            executable_paths: vec![],
        };
        receipt.validate().unwrap();
        let mut json = serde_json::to_value(&receipt).unwrap();
        json["credentials"] = serde_json::json!("not allowed");
        assert!(serde_json::from_value::<RepositoryReceipt>(json).is_err());
        receipt.executable_paths.push("absent".into());
        assert!(receipt.validate().is_err());
        receipt.executable_paths.clear();
        receipt.snapshot.digest = format!("sha256:{}", "a".repeat(64));
        assert!(receipt.validate().is_err());
    }
}

/// Explicit host-selected provenance. This is neither a publisher signature nor
/// proof that arbitrary caller-supplied upstream identities were acquired.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionReceiptInput {
    /// Absolute normalized host selector; consumers never discover or open it.
    pub input_path: String,
    pub receipt: SourceReceipt,
}
/// Compact retained provenance, derived only from the complete captured receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GitReceiptRef {
    pub input_path: String,
    pub receipt_sha256: String,
    pub source: GitSource,
    pub requested_ref: String,
    pub commit_oid: String,
    pub tree_oid: String,
}
pub const MAX_RECEIPT_BYTES: usize = 2 * 1024 * 1024;
impl AcquisitionReceiptInput {
    pub fn reference(&self) -> Result<AcquisitionReceiptRef, String> {
        validate_absolute(&self.input_path)?;
        if self.input_path == "/" {
            return Err("acquisition receipt selector must name a file".into());
        }
        let bytes = self.receipt.canonical_bytes()?;
        if bytes.len() > MAX_RECEIPT_BYTES {
            return Err("acquisition receipt byte bound".into());
        }
        if let SourceReceipt::Npm(receipt) = &self.receipt {
            return Ok(AcquisitionReceiptRef::Npm(NpmReceiptRef {
                input_path: self.input_path.clone(),
                receipt_sha256: format!("sha256:{:x}", Sha256::digest(bytes)),
                source: receipt.source.clone(),
                tarball_url: receipt.tarball_url.clone(),
                integrity: receipt.integrity.clone(),
                tarball_sha256: receipt.tarball_sha256.clone(),
                metadata_sha256: receipt.metadata_sha256.clone(),
            }));
        }
        let SourceReceipt::Git(receipt) = &self.receipt else {
            unreachable!()
        };
        Ok(AcquisitionReceiptRef::Git(GitReceiptRef {
            input_path: self.input_path.clone(),
            receipt_sha256: format!("sha256:{:x}", Sha256::digest(bytes)),
            source: receipt.source.clone(),
            requested_ref: receipt.requested_ref.clone(),
            commit_oid: receipt.commit_oid.clone(),
            tree_oid: receipt.tree_oid.clone(),
        }))
    }
    /// Compare the original selected root and exact captured content identity.
    /// Only the private execution location is allowed to differ from the receipt.
    pub fn validate_capture(&self, pin: &SnapshotPin, original_root: &str) -> Result<(), String> {
        self.reference()?;
        if self.receipt.snapshot().root != original_root
            || self.receipt.snapshot().id != pin.id
            || self.receipt.snapshot().digest != pin.digest
            || serde_json::to_value(&self.receipt.snapshot().files).map_err(|e| e.to_string())?
                != serde_json::to_value(&pin.files).map_err(|e| e.to_string())?
        {
            return Err("acquisition receipt differs from captured root or source".into());
        }
        Ok(())
    }
    /// The archive carries real executable flags; SnapshotPin alone does not.
    pub fn validate_archive(
        &self,
        manifest: &crate::source_archive::ArchiveManifest,
    ) -> Result<(), String> {
        self.reference()?;
        let files = &self.receipt.snapshot().files;
        if manifest.snapshot_sha256 != self.receipt.snapshot().digest
            || manifest.files.len() != files.len()
            || manifest
                .files
                .iter()
                .zip(files)
                .any(|(a, p)| a.path != p.path || a.sha256 != p.digest || a.bytes != p.bytes)
            || manifest
                .files
                .iter()
                .filter(|f| f.executable)
                .map(|f| &f.path)
                .ne(self.receipt.executable_paths().iter())
        {
            return Err(
                "acquisition receipt differs from archived source or executable modes".into(),
            );
        }
        Ok(())
    }
}

/// Untagged for exact backwards compatibility: historical Git receipts gain no
/// discriminator or default field. Each variant denies unknown fields.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum SourceReceipt {
    Git(RepositoryReceipt),
    Npm(NpmReceipt),
}
impl From<RepositoryReceipt> for SourceReceipt {
    fn from(value: RepositoryReceipt) -> Self {
        Self::Git(value)
    }
}
impl From<NpmReceipt> for SourceReceipt {
    fn from(value: NpmReceipt) -> Self {
        Self::Npm(value)
    }
}
impl SourceReceipt {
    pub fn snapshot(&self) -> &SnapshotPin {
        match self {
            Self::Git(r) => &r.snapshot,
            Self::Npm(r) => &r.snapshot,
        }
    }
    pub fn executable_paths(&self) -> &[String] {
        match self {
            Self::Git(r) => &r.executable_paths,
            Self::Npm(r) => &r.executable_paths,
        }
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        match self {
            Self::Git(r) => r.canonical_bytes(),
            Self::Npm(r) => r.canonical_bytes(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum AcquisitionReceiptRef {
    Git(GitReceiptRef),
    Npm(NpmReceiptRef),
}
impl AcquisitionReceiptRef {
    pub fn input_path(&self) -> &str {
        match self {
            Self::Git(r) => &r.input_path,
            Self::Npm(r) => &r.input_path,
        }
    }
    pub fn receipt_sha256(&self) -> &str {
        match self {
            Self::Git(r) => &r.receipt_sha256,
            Self::Npm(r) => &r.receipt_sha256,
        }
    }
}
