//! Complete, bounded source retention. Content identity is independent of location.
use crate::{SnapshotPin, is_sha256};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_FILES: usize = 4096;
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveChunk {
    pub sha256: String,
    pub bytes: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveFile {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub executable: bool,
    pub chunks: Vec<ArchiveChunk>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveManifest {
    pub schema_version: u32,
    pub snapshot_sha256: String,
    pub files: Vec<ArchiveFile>,
}
/// Internal bytes, deliberately not a wire command or an execution permit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceArchive {
    pub manifest: ArchiveManifest,
    pub blobs: BTreeMap<String, Vec<u8>>,
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn invalid() -> String {
    "invalid source archive identity or bounds".into()
}
impl ArchiveManifest {
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        let bytes = serde_json::to_vec(&serde_json::to_value(self).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(invalid());
        }
        Ok(bytes)
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || self.files.is_empty()
            || self.files.len() > MAX_FILES
            || !is_sha256(&self.snapshot_sha256)
        {
            return Err(invalid());
        }
        let mut total = 0u64;
        let mut paths = 0usize;
        let mut previous: Option<&str> = None;
        let mut file_paths = BTreeSet::new();
        for file in &self.files {
            let path = file.path.as_str();
            if path.is_empty()
                || path.len() > 4096
                || path.contains(['\\', ':'])
                || path.chars().any(char::is_control)
                || path
                    .split('/')
                    .any(|p| p.is_empty() || p == "." || p == "..")
                || previous.is_some_and(|p| p >= path)
                || !is_sha256(&file.sha256)
            {
                return Err(invalid());
            }
            if path
                .match_indices('/')
                .any(|(i, _)| file_paths.contains(&path[..i]))
            {
                return Err(invalid());
            }
            file_paths.insert(path);
            previous = Some(path);
            paths = paths.checked_add(path.len()).ok_or_else(invalid)?;
            total = total.checked_add(file.bytes).ok_or_else(invalid)?;
            if total > MAX_BYTES || paths > 4 * 1024 * 1024 {
                return Err(invalid());
            }
            let count = file.bytes.div_ceil(CHUNK_BYTES as u64) as usize;
            if file.chunks.len() != count {
                return Err(invalid());
            }
            for (i, chunk) in file.chunks.iter().enumerate() {
                let expected =
                    (file.bytes - (i as u64 * CHUNK_BYTES as u64)).min(CHUNK_BYTES as u64);
                if chunk.bytes != expected || !is_sha256(&chunk.sha256) {
                    return Err(invalid());
                }
            }
        }
        // Preserve the existing SnapshotPin JSON identity exactly, including order.
        let files: Vec<_> = self
            .files
            .iter()
            .map(|f| {
                serde_json::json!({
                    "bytes": f.bytes, "digest": f.sha256, "path": f.path
                })
            })
            .collect();
        if hash(&serde_json::to_vec(&files).map_err(|_| invalid())?) != self.snapshot_sha256 {
            return Err(invalid());
        }
        Ok(())
    }
}
impl SourceArchive {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_checked(&|| Ok(()))
    }
    pub fn validate_checked(&self, check: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
        check()?;
        self.manifest.canonical_bytes()?;
        if self.blobs.len() > MAX_FILES + (MAX_BYTES as usize / CHUNK_BYTES) {
            return Err(invalid());
        }
        let mut referenced = BTreeSet::new();
        for file in &self.manifest.files {
            check()?;
            let mut digest = Sha256::new();
            for chunk in &file.chunks {
                let bytes = self.blobs.get(&chunk.sha256).ok_or_else(invalid)?;
                if bytes.len() as u64 != chunk.bytes {
                    return Err(invalid());
                }
                let mut chunk_digest = Sha256::new();
                for piece in bytes.chunks(65536) {
                    check()?;
                    chunk_digest.update(piece);
                    digest.update(piece);
                }
                if format!("sha256:{:x}", chunk_digest.finalize()) != chunk.sha256 {
                    return Err(invalid());
                }
                referenced.insert(chunk.sha256.as_str());
            }
            if format!("sha256:{:x}", digest.finalize()) != file.sha256 {
                return Err(invalid());
            }
        }
        check()?;
        if referenced.len() != self.blobs.len() {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn validate_pin(&self, pin: &SnapshotPin) -> Result<(), String> {
        self.validate_pin_checked(pin, &|| Ok(()))
    }
    pub fn validate_pin_checked(
        &self,
        pin: &SnapshotPin,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.validate_checked(check)?;
        if self.manifest.snapshot_sha256 != pin.digest
            || self.manifest.files.len() != pin.files.len()
            || self
                .manifest
                .files
                .iter()
                .zip(&pin.files)
                .any(|(a, p)| a.path != p.path || a.sha256 != p.digest || a.bytes != p.bytes)
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive() -> SourceArchive {
        let bytes = b"complete source\0binary".to_vec();
        let digest = hash(&bytes);
        let file = ArchiveFile {
            path: "src/app".into(),
            sha256: digest.clone(),
            bytes: bytes.len() as u64,
            executable: true,
            chunks: vec![ArchiveChunk {
                sha256: digest.clone(),
                bytes: bytes.len() as u64,
            }],
        };
        let snapshot_sha256 = hash(
            &serde_json::to_vec(&vec![
                serde_json::json!({"bytes":file.bytes,"digest":file.sha256,"path":file.path}),
            ])
            .unwrap(),
        );
        SourceArchive {
            manifest: ArchiveManifest {
                schema_version: 1,
                snapshot_sha256,
                files: vec![file],
            },
            blobs: BTreeMap::from([(digest, bytes)]),
        }
    }
    fn refresh_manifest(a: &mut SourceArchive) {
        let files: Vec<_> = a
            .manifest
            .files
            .iter()
            .map(|f| {
                serde_json::json!({
                    "bytes":f.bytes,"digest":f.sha256,"path":f.path
                })
            })
            .collect();
        a.manifest.snapshot_sha256 = hash(&serde_json::to_vec(&files).unwrap());
    }
    #[test]
    fn zero_byte_files_and_cancellation_are_explicit() {
        let mut a = archive();
        a.manifest.files[0].bytes = 0;
        a.manifest.files[0].sha256 = hash(&[]);
        a.manifest.files[0].chunks.clear();
        a.blobs.clear();
        refresh_manifest(&mut a);
        a.validate().unwrap();
        assert_eq!(
            a.validate_checked(&|| Err("cancelled".into())).unwrap_err(),
            "cancelled"
        );
        let calls = std::cell::Cell::new(0);
        assert!(
            archive()
                .validate_checked(&|| {
                    calls.set(calls.get() + 1);
                    if calls.get() >= 3 {
                        Err("cancelled during hashing".into())
                    } else {
                        Ok(())
                    }
                })
                .is_err()
        );
        assert!(calls.get() >= 3);
    }
    #[test]
    fn reject_file_directory_collisions_even_with_matching_manifest_digest() {
        let mut a = archive();
        a.manifest.files[0].path = "a".into();
        let mut child = a.manifest.files[0].clone();
        child.path = "a/b".into();
        let mut intervening = child.clone();
        intervening.path = "a-else".into();
        a.manifest.files.extend([intervening, child]);
        refresh_manifest(&mut a);
        assert!(a.validate().is_err());
    }
    #[test]
    fn content_identity_is_exact_and_location_independent() {
        let a = archive();
        let f = &a.manifest.files[0];
        let mut pin = SnapshotPin {
            id: "id".into(),
            root: "/old/deleted".into(),
            digest: a.manifest.snapshot_sha256.clone(),
            files: vec![crate::SnapshotFile {
                path: f.path.clone(),
                digest: f.sha256.clone(),
                bytes: f.bytes,
            }],
        };
        a.validate_pin(&pin).unwrap();
        pin.root = "/new/private".into();
        a.validate_pin(&pin).unwrap();
        pin.files[0].bytes += 1;
        assert!(a.validate_pin(&pin).is_err());
    }
    #[test]
    fn reject_missing_extra_corrupted_and_reordered_content() {
        let a = archive();
        for mutation in 0..5 {
            let mut b = a.clone();
            match mutation {
                0 => b.blobs.clear(),
                1 => {
                    b.blobs.insert(hash(b"extra"), b"extra".to_vec());
                }
                2 => b.blobs.values_mut().next().unwrap()[0] ^= 1,
                3 => b.manifest.files[0].chunks[0].bytes += 1,
                _ => b.manifest.files.push(b.manifest.files[0].clone()),
            }
            assert!(b.validate().is_err());
        }
    }
    #[test]
    fn rejects_traversal_and_noncanonical_chunking() {
        for path in ["../app", "/app", "a//b", "a/./b", "a\\b", "c:x", "a\0b"] {
            let mut a = archive();
            a.manifest.files[0].path = path.into();
            refresh_manifest(&mut a);
            assert!(a.validate().is_err());
        }
        let mut a = archive();
        let c = a.manifest.files[0].chunks[0].clone();
        a.manifest.files[0].chunks.push(c);
        assert!(a.validate().is_err());
        a = archive();
        a.manifest.files[0].bytes = MAX_BYTES + 1;
        assert!(a.validate().is_err());
    }
}
