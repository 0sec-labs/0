//! Host-captured Git acquisition identity, not a repository authenticity signature.
use crate::{SnapshotPin, is_sha256};
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
        let mut total = 0u64;
        let mut previous: Option<&str> = None;
        for file in &self.snapshot.files {
            validate_repository_path(&file.path)?;
            if previous.is_some_and(|p| p >= file.path.as_str()) || !is_sha256(&file.digest) {
                return Err("repository manifest order or digest differs".into());
            }
            previous = Some(&file.path);
            total = total
                .checked_add(file.bytes)
                .ok_or("repository size overflow")?;
        }
        let manifest: Vec<_> = self
            .snapshot
            .files
            .iter()
            .map(|f| serde_json::json!({"path":f.path,"digest":f.digest,"bytes":f.bytes}))
            .collect();
        let digest = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&manifest).map_err(|e| e.to_string())?)
        );
        if total > MAX_REPOSITORY_BYTES || self.snapshot.digest != digest {
            return Err("repository snapshot digest or size differs".into());
        }
        let mut last: Option<&str> = None;
        for path in &self.executable_paths {
            if last.is_some_and(|p| p >= path.as_str())
                || !self.snapshot.files.iter().any(|f| &f.path == path)
            {
                return Err("repository executable index differs".into());
            }
            last = Some(path);
        }
        Ok(())
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        serde_json::to_vec(&serde_json::to_value(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }
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
