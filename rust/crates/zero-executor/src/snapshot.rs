use sha2::{Digest, Sha256};
use std::path::Path;
use zero_protocol::{SnapshotFile, SnapshotPin};

pub fn snapshot_digest(files: &[SnapshotFile]) -> Result<String, String> {
    // Sorted object keys, original array order: existing TS snapshot contract.
    let values: Vec<_> = files
        .iter()
        .map(|f| {
            serde_json::json!({
                "bytes": f.bytes, "digest": f.digest, "path": f.path
            })
        })
        .collect();
    let bytes = serde_json::to_vec(&values).map_err(|e| e.to_string())?;
    Ok(hash(&bytes))
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// Pins source through nofollow directory handles. The caller chooses the
/// authorized source root. Call off an async thread for large trees.
pub fn pin_snapshot(root: &Path) -> Result<SnapshotPin, String> {
    #[cfg(target_os = "linux")]
    {
        anchored::pin(root)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = root;
        Err("snapshot pinning is currently supported only on Linux".into())
    }
}

/// Controller-owned verified source copy. Dropping this handle intentionally
/// retains it: only a caller that confirms guest teardown may remove the tree.
/// This favors recoverable leakage over deleting a still-mounted source.
pub struct StagedSnapshot {
    root: std::path::PathBuf,
}
impl StagedSnapshot {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn source(&self) -> std::path::PathBuf {
        self.root.join("source")
    }
    pub fn remove(self) -> Result<(), String> {
        std::fs::remove_dir_all(&self.root).map_err(|e| e.to_string())
    }
}
/// Creates the private destination itself; callers cannot supply a symlinked or
/// guest-writable copy target. Call off async runtime threads for large trees.
pub fn stage_snapshot(
    pin: &SnapshotPin,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<StagedSnapshot, String> {
    check()?;
    let stage = tempfile::Builder::new()
        .prefix("0sec-snapshot-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let source = stage.path().join("source");
    std::fs::create_dir(&source).map_err(|e| e.to_string())?;
    verify_and_copy(pin, Some(&source), check)?;
    Ok(StagedSnapshot { root: stage.keep() })
}
/// Rechecks the authorized source against its pinned manifest without copying.
pub fn verify_snapshot(
    pin: &SnapshotPin,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    verify_and_copy(pin, None, check)
}

pub(crate) fn verify_and_copy(
    pin: &SnapshotPin,
    destination: Option<&Path>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        anchored::verify(pin, destination, check)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (pin, destination, check);
        Err("snapshot verification is currently supported only on Linux".into())
    }
}

#[cfg(target_os = "linux")]
mod anchored {
    use super::*;
    use nix::{
        dir::Dir,
        fcntl::{OFlag, open, openat},
        sys::stat::Mode,
        unistd::dup,
    };
    use std::{
        collections::{BTreeMap, BTreeSet},
        ffi::OsStr,
        fs::{self, File},
        io::Read,
        os::unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, PermissionsExt},
        },
        path::Component,
    };

    // Open EVERY ancestor without following links; a path-based metadata check
    // followed by ordinary open is vulnerable to directory replacement races.
    fn open_root(root: &Path) -> Result<File, String> {
        if !root.is_absolute() || fs::canonicalize(root).map_err(|e| e.to_string())? != root {
            return Err("snapshot root must be a canonical absolute directory".into());
        }
        let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut dir =
            File::from(open(Path::new("/"), flags, Mode::empty()).map_err(|e| e.to_string())?);
        for part in root.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => {
                    dir = File::from(
                        openat(&dir, name, flags, Mode::empty()).map_err(|e| e.to_string())?,
                    );
                }
                _ => return Err("snapshot root contains non-normal path components".into()),
            }
        }
        Ok(dir)
    }

    type Visitor<'a> = dyn FnMut(String, File) -> Result<(), String> + 'a;
    fn walk(
        dir: &File,
        prefix: &str,
        visitor: &mut Visitor<'_>,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        check()?;
        let make_frame = |file: File, prefix: String| -> Result<_, String> {
            let fd = dup(&file).map_err(|e| e.to_string())?;
            let listing = Dir::from_fd(fd).map_err(|e| e.to_string())?.into_iter();
            Ok((file, listing, prefix))
        };
        let first = File::from(dup(dir).map_err(|e| e.to_string())?);
        let mut stack = vec![make_frame(first, prefix.to_owned())?];
        while let Some((dir, listing, prefix)) = stack.last_mut() {
            check()?;
            let Some(entry) = listing.next() else {
                stack.pop();
                continue;
            };
            let entry = entry.map_err(|e| e.to_string())?;
            let bytes = entry.file_name().to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            let name = std::str::from_utf8(bytes).map_err(|_| "snapshot names must be UTF-8")?;
            if name.contains('\\') {
                return Err("snapshot names cannot contain backslashes".into());
            }
            let relative = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            if relative.len() > 4096 {
                return Err("snapshot relative path exceeds 4096 bytes".into());
            }
            let fd = openat(
                dir,
                OsStr::from_bytes(bytes),
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                Mode::empty(),
            )
            .map_err(|e| format!("cannot open snapshot entry without following links: {e}"))?;
            let file = File::from(fd);
            let metadata = file.metadata().map_err(|e| e.to_string())?;
            if metadata.is_dir() {
                stack.push(make_frame(file, relative)?);
            } else if metadata.is_file() && metadata.nlink() == 1 {
                visitor(relative, file)?;
            } else {
                return Err("snapshot contains a special file or hard link".into());
            }
        }
        Ok(())
    }

    fn read(
        mut file: File,
        expected: Option<u64>,
        remaining: u64,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(Vec<u8>, bool), String> {
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if metadata.len() > remaining || expected.is_some_and(|n| n != metadata.len()) {
            return Err("snapshot file size mismatch or total exceeds 512 MiB".into());
        }
        let executable = metadata.permissions().mode() & 0o111 != 0;
        let mut bytes = Vec::new();
        let mut chunk = [0; 65536];
        loop {
            check()?;
            let n = file.read(&mut chunk).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            if bytes.len() as u64 + n as u64 > metadata.len() {
                return Err("snapshot file grew during read".into());
            }
            bytes.extend_from_slice(&chunk[..n]);
        }
        if bytes.len() as u64 != metadata.len() {
            return Err("snapshot file changed size during read".into());
        }
        Ok((bytes, executable))
    }

    pub(super) fn pin(root: &Path) -> Result<SnapshotPin, String> {
        let dir = open_root(root)?;
        let mut files = Vec::new();
        let mut total = 0;
        walk(
            &dir,
            "",
            &mut |path, file| {
                let (bytes, _) = read(file, None, 512 * 1024 * 1024 - total, &|| Ok(()))?;
                total += bytes.len() as u64;
                files.push(SnapshotFile {
                    path,
                    digest: hash(&bytes),
                    bytes: bytes.len() as u64,
                });
                Ok(())
            },
            &|| Ok(()),
        )?;
        files.sort_by(|a, b| a.path.cmp(&b.path));
        if files.is_empty() {
            return Err("snapshot requires at least one file".into());
        }
        let digest = snapshot_digest(&files)?;
        Ok(SnapshotPin {
            id: digest.clone(),
            root: root.to_str().ok_or("root must be UTF-8")?.into(),
            digest,
            files,
        })
    }

    pub(super) fn verify(
        pin: &SnapshotPin,
        destination: Option<&Path>,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        check()?;
        if pin.files.is_empty() {
            return Err("snapshot requires at least one file".into());
        }
        if snapshot_digest(&pin.files)? != pin.digest {
            return Err("snapshot manifest digest mismatch".into());
        }
        let dir = open_root(Path::new(&pin.root))?;
        let expected: BTreeMap<_, _> = pin.files.iter().map(|f| (f.path.as_str(), f)).collect();
        if expected.len() != pin.files.len() {
            return Err("duplicate snapshot file paths".into());
        }
        let mut seen = BTreeSet::new();
        let mut total = 0;
        walk(
            &dir,
            "",
            &mut |path, file| {
                let f = expected
                    .get(path.as_str())
                    .ok_or("snapshot contains an unindexed file")?;
                let (bytes, executable) =
                    read(file, Some(f.bytes), 512 * 1024 * 1024 - total, check)?;
                total += bytes.len() as u64;
                if hash(&bytes) != f.digest {
                    return Err(format!("snapshot file digest mismatch: {path}"));
                }
                if !seen.insert(path.clone()) {
                    return Err("snapshot traversal repeated a file".into());
                }
                if let Some(dest) = destination {
                    let target = dest.join(&path);
                    fs::create_dir_all(target.parent().ok_or("missing snapshot parent")?)
                        .map_err(|e| e.to_string())?;
                    // Destination is a controller-owned private directory; it is
                    // never writable by the guest and is mounted only after copy.
                    fs::write(&target, bytes).map_err(|e| e.to_string())?;
                    fs::set_permissions(
                        target,
                        fs::Permissions::from_mode(if executable { 0o555 } else { 0o444 }),
                    )
                    .map_err(|e| e.to_string())?;
                }
                Ok(())
            },
            check,
        )?;
        if seen.len() != expected.len() {
            return Err("snapshot file index is incomplete".into());
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn public_staging_is_private_verified_and_retained_until_explicit_disposal() {
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("main"), b"original").unwrap();
        let pin = pin_snapshot(source.path()).unwrap();
        let staged = stage_snapshot(&pin, &|| Ok(())).unwrap();
        let recovery = staged.root().to_path_buf();
        fs::write(source.path().join("main"), b"changed").unwrap();
        assert_eq!(fs::read(staged.source().join("main")).unwrap(), b"original");
        assert!(verify_snapshot(&pin, &|| Ok(())).is_err());
        drop(staged);
        assert!(
            recovery.exists(),
            "uncertain teardown must retain staged bytes"
        );
        fs::remove_dir_all(recovery).unwrap();
        let pin = pin_snapshot(source.path()).unwrap();
        let staged = stage_snapshot(&pin, &|| Ok(())).unwrap();
        let root = staged.root().to_path_buf();
        staged.remove().unwrap();
        assert!(!root.exists());
        assert!(stage_snapshot(&pin, &|| Err("cancelled".into())).is_err());
    }
    #[test]
    fn pin_and_tampering() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a"), b"ok").unwrap();
        let pin = pin_snapshot(root.path()).unwrap();
        verify_and_copy(&pin, None, &|| Ok(())).unwrap();
        fs::write(root.path().join("a"), b"no").unwrap();
        assert!(verify_and_copy(&pin, None, &|| Ok(())).is_err());
    }
    #[test]
    fn rejects_symlinks_and_unindexed_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a"), b"ok").unwrap();
        let pin = pin_snapshot(root.path()).unwrap();
        fs::write(root.path().join("extra"), b"x").unwrap();
        assert!(verify_and_copy(&pin, None, &|| Ok(())).is_err());
        std::os::unix::fs::symlink("a", root.path().join("link")).unwrap();
        assert!(pin_snapshot(root.path()).is_err());
    }
    #[test]
    fn rejects_replaced_directory_symlink() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("dir")).unwrap();
        fs::write(root.path().join("dir/a"), b"inside").unwrap();
        fs::write(outside.path().join("a"), b"outside").unwrap();
        let pin = pin_snapshot(root.path()).unwrap();
        fs::rename(root.path().join("dir"), root.path().join("old")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("dir")).unwrap();
        assert!(verify_and_copy(&pin, None, &|| Ok(())).is_err());
    }
}
