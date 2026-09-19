//! Bounded raw source retention. These private copies are never guest-mounted.
use crate::StagedSnapshot;
use zero_protocol::{SnapshotPin, source_archive::SourceArchive};

/// Capture exact retained bytes from a freshly verified private copy. The copy
/// is explicitly removed on success or error; caller cancellation is cooperative.
pub fn capture_source_archive(
    pin: &SnapshotPin,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<SourceArchive, String> {
    #[cfg(target_os = "linux")]
    {
        native::capture(pin, check)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (pin, check);
        Err("source archives are currently supported only on Linux".into())
    }
}

/// Validate and reconstruct a controller-owned private source tree. The returned
/// handle follows StagedSnapshot's explicit cleanup contract. No guest runs here.
pub fn stage_source_archive(
    archive: &SourceArchive,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(StagedSnapshot, SnapshotPin), String> {
    #[cfg(target_os = "linux")]
    {
        native::stage(archive, check)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (archive, check);
        Err("source archives are currently supported only on Linux".into())
    }
}

#[cfg(target_os = "linux")]
mod native {
    use super::*;
    use crate::{SnapshotLimits, stage_snapshot, verify_snapshot};
    use nix::{
        fcntl::{OFlag, open, openat},
        sys::stat::{Mode, mkdirat},
    };
    use sha2::{Digest, Sha256};
    use std::{
        collections::BTreeMap,
        fs::{self, File},
        io::{Read, Write},
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::{Component, Path},
    };
    use zero_protocol::{
        SnapshotFile,
        source_archive::{ArchiveChunk, ArchiveFile, ArchiveManifest},
    };

    const CHUNK: usize = 8 * 1024 * 1024;
    const IO_CHUNK: usize = 64 * 1024;
    fn digest(hasher: Sha256) -> String {
        format!("sha256:{:x}", hasher.finalize())
    }
    fn directory(root: &Path, check: &dyn Fn() -> Result<(), String>) -> Result<File, String> {
        check()?;
        if !root.is_absolute() || fs::canonicalize(root).map_err(|e| e.to_string())? != root {
            return Err("archive root must be canonical and absolute".into());
        }
        let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut dir =
            File::from(open(Path::new("/"), flags, Mode::empty()).map_err(|e| e.to_string())?);
        for part in root.components() {
            check()?;
            match part {
                Component::RootDir => {}
                Component::Normal(name) => {
                    dir = File::from(
                        openat(&dir, name, flags, Mode::empty()).map_err(|e| e.to_string())?,
                    )
                }
                _ => return Err("archive root contains non-normal components".into()),
            }
        }
        Ok(dir)
    }
    fn file(
        root: &Path,
        relative: &str,
        create: bool,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<File, String> {
        let mut dir = directory(root, check)?;
        let mut parts = Path::new(relative).components().peekable();
        while let Some(part) = parts.next() {
            check()?;
            let Component::Normal(name) = part else {
                return Err("archive path is not relative and normalized".into());
            };
            if parts.peek().is_none() {
                let flags = OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC
                    | OFlag::O_NONBLOCK
                    | if create {
                        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL
                    } else {
                        OFlag::O_RDONLY
                    };
                let result = File::from(
                    openat(&dir, name, flags, Mode::from_bits_truncate(0o600))
                        .map_err(|e| e.to_string())?,
                );
                let meta = result.metadata().map_err(|e| e.to_string())?;
                if !meta.is_file() || meta.nlink() != 1 {
                    return Err("archive contains a link or special file".into());
                }
                return Ok(result);
            }
            if create {
                match mkdirat(&dir, name, Mode::from_bits_truncate(0o700)) {
                    Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            dir = File::from(
                openat(
                    &dir,
                    name,
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|e| e.to_string())?,
            );
        }
        Err("archive file path is empty".into())
    }
    pub(super) fn capture(
        pin: &SnapshotPin,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<SourceArchive, String> {
        check()?;
        let total = pin
            .files
            .iter()
            .try_fold(0u64, |sum, f| sum.checked_add(f.bytes));
        if pin.files.is_empty()
            || pin.files.len() > SnapshotLimits::MAX_FILES
            || total.is_none_or(|n| n > SnapshotLimits::MAX_BYTES)
        {
            return Err("source archive exceeds file or byte limits".into());
        }
        let stage = stage_snapshot(pin, check)?;
        let result = capture_private(pin, &stage, check);
        let removed = stage.remove();
        match (result, removed) {
            (Ok(archive), Ok(())) => Ok(archive),
            (Err(error), Ok(())) => Err(error),
            (_, Err(error)) => Err(format!(
                "source archive private-copy cleanup failed: {error}"
            )),
        }
    }
    fn capture_private(
        pin: &SnapshotPin,
        stage: &StagedSnapshot,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<SourceArchive, String> {
        let mut files = Vec::with_capacity(pin.files.len());
        let mut blobs = BTreeMap::new();
        for expected in &pin.files {
            check()?;
            let mut input = file(&stage.source(), &expected.path, false, check)?;
            let metadata = input.metadata().map_err(|e| e.to_string())?;
            if metadata.len() != expected.bytes {
                return Err("archive file size differs from pin".into());
            }
            let executable = metadata.permissions().mode() & 0o111 != 0;
            let mut remaining = expected.bytes;
            let mut file_hash = Sha256::new();
            let mut chunks = Vec::new();
            let mut buffer = [0; IO_CHUNK];
            while remaining > 0 {
                check()?;
                let size = remaining.min(CHUNK as u64) as usize;
                let mut bytes = Vec::with_capacity(size);
                let mut chunk_hash = Sha256::new();
                while bytes.len() < size {
                    check()?;
                    let requested = buffer.len().min(size - bytes.len());
                    let n = input
                        .read(&mut buffer[..requested])
                        .map_err(|e| e.to_string())?;
                    if n == 0 {
                        return Err("archive file shortened during capture".into());
                    }
                    file_hash.update(&buffer[..n]);
                    chunk_hash.update(&buffer[..n]);
                    bytes.extend_from_slice(&buffer[..n]);
                }
                let sha256 = digest(chunk_hash);
                chunks.push(ArchiveChunk {
                    sha256: sha256.clone(),
                    bytes: size as u64,
                });
                blobs.entry(sha256).or_insert(bytes);
                remaining -= size as u64;
            }
            check()?;
            if input.read(&mut buffer[..1]).map_err(|e| e.to_string())? != 0
                || digest(file_hash) != expected.digest
            {
                return Err("archive content differs from pin".into());
            }
            files.push(ArchiveFile {
                path: expected.path.clone(),
                sha256: expected.digest.clone(),
                bytes: expected.bytes,
                executable,
                chunks,
            });
        }
        check()?;
        let archive = SourceArchive {
            manifest: ArchiveManifest {
                schema_version: 1,
                snapshot_sha256: pin.digest.clone(),
                files,
            },
            blobs,
        };
        archive.validate_pin_checked(pin, check)?;
        check()?;
        Ok(archive)
    }
    pub(super) fn stage(
        archive: &SourceArchive,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(StagedSnapshot, SnapshotPin), String> {
        check()?;
        archive.validate_checked(check)?;
        check()?;
        let stage = tempfile::Builder::new()
            .prefix("0sec-archive-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let source = stage.path().join("source");
        fs::create_dir(&source).map_err(|e| e.to_string())?;
        let mut files = Vec::with_capacity(archive.manifest.files.len());
        for retained in &archive.manifest.files {
            check()?;
            let mut output = file(&source, &retained.path, true, check)?;
            for chunk in &retained.chunks {
                let bytes = archive
                    .blobs
                    .get(&chunk.sha256)
                    .ok_or("missing archive blob")?;
                for part in bytes.chunks(IO_CHUNK) {
                    check()?;
                    output.write_all(part).map_err(|e| e.to_string())?;
                }
            }
            check()?;
            output
                .set_permissions(fs::Permissions::from_mode(if retained.executable {
                    0o555
                } else {
                    0o444
                }))
                .map_err(|e| e.to_string())?;
            files.push(SnapshotFile {
                path: retained.path.clone(),
                digest: retained.sha256.clone(),
                bytes: retained.bytes,
            });
        }
        let pin = SnapshotPin {
            id: archive.manifest.snapshot_sha256.clone(),
            root: source
                .to_str()
                .ok_or("archive staging path must be UTF-8")?
                .into(),
            digest: archive.manifest.snapshot_sha256.clone(),
            files,
        };
        verify_snapshot(&pin, check)?;
        check()?;
        Ok((StagedSnapshot { root: stage.keep() }, pin))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::{pin_snapshot, verify_snapshot};
    use std::{
        cell::{Cell, RefCell},
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        path::{Path, PathBuf},
    };

    #[test]
    fn raw_chunk_roundtrip_deduplicates_and_preserves_empty_nested_and_executable_files() {
        let source = tempfile::tempdir().unwrap();
        fs::create_dir(source.path().join("nested")).unwrap();
        let bytes = vec![73u8; 8 * 1024 * 1024 + 17];
        fs::write(source.path().join("large"), &bytes).unwrap();
        fs::write(source.path().join("nested/copy"), &bytes).unwrap();
        fs::write(source.path().join("empty"), []).unwrap();
        fs::write(
            source.path().join("nested/run.sh"),
            b"#!/bin/sh\nprintf retained\n",
        )
        .unwrap();
        fs::set_permissions(
            source.path().join("nested/run.sh"),
            fs::Permissions::from_mode(0o751),
        )
        .unwrap();
        let pin = pin_snapshot(source.path()).unwrap();
        let archive = capture_source_archive(&pin, &|| Ok(())).unwrap();
        assert_eq!(archive.manifest.files.len(), 4);
        assert_eq!(archive.blobs.len(), 3);
        let large = archive
            .manifest
            .files
            .iter()
            .find(|f| f.path == "large")
            .unwrap();
        assert_eq!(
            large.chunks.iter().map(|c| c.bytes).collect::<Vec<_>>(),
            vec![8 * 1024 * 1024, 17]
        );
        assert!(
            archive
                .manifest
                .files
                .iter()
                .find(|f| f.path == "empty")
                .unwrap()
                .chunks
                .is_empty()
        );
        archive.validate_pin(&pin).unwrap();
        source.close().unwrap();
        let (stage, restored) = stage_source_archive(&archive, &|| Ok(())).unwrap();
        assert_eq!(restored.digest, pin.digest);
        assert_eq!(
            serde_json::to_value(&restored.files).unwrap(),
            serde_json::to_value(&pin.files).unwrap()
        );
        verify_snapshot(&restored, &|| Ok(())).unwrap();
        assert_eq!(fs::read(stage.source().join("large")).unwrap(), bytes);
        assert_eq!(
            fs::metadata(stage.source().join("nested/run.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o555
        );
        assert_eq!(
            fs::metadata(stage.source().join("large"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o444
        );
        let path = stage.root().to_path_buf();
        stage.remove().unwrap();
        assert!(!path.exists());
    }

    fn small() -> (tempfile::TempDir, SnapshotPin, SourceArchive) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("data"), b"retained source bytes").unwrap();
        let pin = pin_snapshot(dir.path()).unwrap();
        let archive = capture_source_archive(&pin, &|| Ok(())).unwrap();
        (dir, pin, archive)
    }
    #[test]
    fn reconstruction_rejects_corrupt_missing_extra_blobs_and_unsafe_paths() {
        let (_source, _pin, archive) = small();
        for case in 0..7 {
            let mut altered = archive.clone();
            let digest = altered.manifest.files[0].chunks[0].sha256.clone();
            match case {
                0 => altered.blobs.get_mut(&digest).unwrap()[0] ^= 1,
                1 => {
                    altered.blobs.remove(&digest);
                }
                2 => {
                    altered
                        .blobs
                        .insert(format!("sha256:{}", "0".repeat(64)), vec![0]);
                }
                3 => altered.manifest.files[0].path = "../escape".into(),
                4 => altered.manifest.files[0].path = "/absolute".into(),
                5 => altered.manifest.files[0].bytes += 1,
                _ => altered.manifest.files[0].chunks[0].bytes += 1,
            }
            assert!(
                stage_source_archive(&altered, &|| Ok(())).is_err(),
                "mutation {case}"
            );
        }
    }
    #[test]
    fn capture_rejects_limits_before_filesystem_access_and_changed_or_linked_source() {
        let (dir, pin, _) = small();
        let mut oversized = pin.clone();
        oversized.root = "/definitely-absent-archive-source".into();
        oversized.files[0].bytes = 64 * 1024 * 1024 + 1;
        assert!(
            capture_source_archive(&oversized, &|| Ok(()))
                .unwrap_err()
                .contains("limits")
        );
        oversized.files = vec![pin.files[0].clone(); 4097];
        assert!(
            capture_source_archive(&oversized, &|| Ok(()))
                .unwrap_err()
                .contains("limits")
        );
        fs::write(dir.path().join("data"), b"changed source bytes!").unwrap();
        assert!(capture_source_archive(&pin, &|| Ok(())).is_err());
        fs::remove_file(dir.path().join("data")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("data"), b"retained source bytes").unwrap();
        symlink(outside.path().join("data"), dir.path().join("data")).unwrap();
        assert!(capture_source_archive(&pin, &|| Ok(())).is_err());
        fs::remove_file(dir.path().join("data")).unwrap();
        fs::hard_link(outside.path().join("data"), dir.path().join("data")).unwrap();
        assert!(capture_source_archive(&pin, &|| Ok(())).is_err());
    }

    // Inspect only our uniquely named file's open descriptor. This observes a
    // partial private read/write without exposing a staging path in the API.
    fn partial_private_file(name: &str, prefix: &str) -> Option<PathBuf> {
        for entry in fs::read_dir("/proc/self/fd").ok()? {
            let entry = entry.ok()?;
            let Ok(path) = fs::read_link(entry.path()) else {
                continue;
            };
            if path.file_name() != Some(std::ffi::OsStr::new(name)) {
                continue;
            }
            let root = path.parent()?.parent()?;
            if !root.file_name()?.to_str()?.starts_with(prefix) {
                continue;
            }
            let info =
                fs::read_to_string(Path::new("/proc/self/fdinfo").join(entry.file_name())).ok()?;
            let position: u64 = info.lines().find_map(|line| {
                line.strip_prefix("pos:")
                    .and_then(|v| v.trim().parse().ok())
            })?;
            if position >= 65536 {
                return Some(root.to_path_buf());
            }
        }
        None
    }
    #[test]
    fn cancellation_during_private_capture_and_reconstruction_removes_partial_copies() {
        let dir = tempfile::tempdir().unwrap();
        let name = format!("archive-cancel-{}", uuid::Uuid::new_v4());
        fs::write(dir.path().join(&name), vec![9; 256 * 1024]).unwrap();
        let pin = pin_snapshot(dir.path()).unwrap();
        let observed = RefCell::new(None);
        let cancelled = || {
            if let Some(path) = partial_private_file(&name, "0sec-snapshot-") {
                *observed.borrow_mut() = Some(path);
                Err("cancelled capture".into())
            } else {
                Ok(())
            }
        };
        assert_eq!(
            capture_source_archive(&pin, &cancelled).unwrap_err(),
            "cancelled capture"
        );
        assert!(!observed.borrow().as_ref().unwrap().exists());
        let archive = capture_source_archive(&pin, &|| Ok(())).unwrap();
        *observed.borrow_mut() = None;
        let result = stage_source_archive(&archive, &|| {
            if let Some(path) = partial_private_file(&name, "0sec-archive-") {
                *observed.borrow_mut() = Some(path);
                Err("cancelled reconstruction".into())
            } else {
                Ok(())
            }
        });
        assert!(matches!(result, Err(e) if e == "cancelled reconstruction"));
        assert!(!observed.borrow().as_ref().unwrap().exists());
        assert!(capture_source_archive(&pin, &|| Err("cancelled before capture".into())).is_err());
        assert!(
            stage_source_archive(&archive, &|| Err("cancelled before reconstruction".into()))
                .is_err()
        );
    }
    #[test]
    fn cancellation_at_reconstruction_finish_does_not_return_a_live_stage() {
        let (_dir, _pin, archive) = small();
        let count = Cell::new(0usize);
        let (stage, _) = stage_source_archive(&archive, &|| {
            count.set(count.get() + 1);
            Ok(())
        })
        .unwrap();
        stage.remove().unwrap();
        let total = count.get();
        assert!(total > 5);
        count.set(0);
        let result = stage_source_archive(&archive, &|| {
            count.set(count.get() + 1);
            if count.get() == total {
                Err("cancelled at finish".into())
            } else {
                Ok(())
            }
        });
        assert!(matches!(result, Err(e) if e == "cancelled at finish"));
    }
}
