//! Shared no-replace publication of checked archive bundles; no checkout mutation.
use std::path::{Path, PathBuf};
use zero_protocol::source_archive::SourceArchive;
#[cfg(not(target_os = "linux"))]
pub(crate) fn publish(
    _: &Path,
    _: &SourceArchive,
    _: &SourceArchive,
    _: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    Err("archive bundle export currently requires Linux".into())
}
#[cfg(target_os = "linux")]
pub(crate) fn publish(
    output: &Path,
    baseline: &SourceArchive,
    current: &SourceArchive,
    bundle: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    use nix::{
        fcntl::{OFlag, RenameFlags, open, openat, renameat2},
        sys::stat::{Mode, mkdirat},
    };
    use std::{
        fs::File,
        io::Write,
        os::{
            fd::AsRawFd,
            unix::fs::{MetadataExt, PermissionsExt},
        },
        path::Component,
    };
    fn parent(path: &Path) -> Result<File, String> {
        let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut fd =
            File::from(open(Path::new("/"), flags, Mode::empty()).map_err(|e| e.to_string())?);
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => {
                    fd = File::from(
                        openat(&fd, name, flags, Mode::empty()).map_err(|e| e.to_string())?,
                    )
                }
                _ => return Err("export parent must have normal absolute components".into()),
            }
        }
        Ok(fd)
    }
    fn write(root: &File, path: &str, bytes: &[u8], executable: bool) -> Result<(), String> {
        if !zero_protocol::workspace_edit::valid_path(path) {
            return Err("export path invalid".into());
        }
        let mut current = root.try_clone().map_err(|e| e.to_string())?;
        let mut dirs = vec![current.try_clone().map_err(|e| e.to_string())?];
        let parts: Vec<_> = path.split('/').collect();
        for component in &parts[..parts.len() - 1] {
            match mkdirat(&current, *component, Mode::from_bits_truncate(0o700)) {
                Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                Err(e) => return Err(e.to_string()),
            }
            current = File::from(
                openat(
                    &current,
                    *component,
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|e| e.to_string())?,
            );
            dirs.push(current.try_clone().map_err(|e| e.to_string())?);
        }
        let mut file = File::from(
            openat(
                &current,
                *parts.last().ok_or("missing path leaf")?,
                OFlag::O_WRONLY
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(if executable { 0o700 } else { 0o600 }),
            )
            .map_err(|e| e.to_string())?,
        );
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.set_permissions(std::fs::Permissions::from_mode(if executable {
            0o700
        } else {
            0o600
        }))
        .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        for dir in dirs.into_iter().rev() {
            dir.sync_all().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    baseline.validate()?;
    current.validate()?;
    let mut blobs = baseline.blobs.clone();
    for (sha, bytes) in &current.blobs {
        if let Some(prior) = blobs.insert(sha.clone(), bytes.clone()) {
            if prior != *bytes {
                return Err("archive identity collision".into());
            }
        }
    }
    let encoded = serde_json::to_vec_pretty(bundle).map_err(|e| e.to_string())?;
    zero_workspace_host::Bundle::decode(&encoded, |sha, _| {
        blobs
            .get(sha)
            .cloned()
            .ok_or_else(|| "export chunk absent".into())
    })?;
    if !output.is_absolute() || output.to_str().is_none() || output.as_os_str().len() > 4096 {
        return Err("workspace export requires a new absolute UTF-8 output directory".into());
    }
    let parent_path = output.parent().ok_or("output parent absent")?;
    let leaf = output.file_name().ok_or("output leaf absent")?;
    let anchored = parent(parent_path)?;
    let before = anchored.metadata().map_err(|e| e.to_string())?;
    let proc = PathBuf::from(format!("/proc/self/fd/{}", anchored.as_raw_fd()));
    let temporary = tempfile::Builder::new()
        .prefix(".0sec-workspace-export-")
        .tempdir_in(&proc)
        .map_err(|e| e.to_string())?;
    let directory = File::from(
        openat(
            &anchored,
            temporary.path().file_name().ok_or("staging name absent")?,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| e.to_string())?,
    );
    for (sha, bytes) in blobs {
        write(
            &directory,
            &format!(
                "blobs/{}",
                sha.strip_prefix("sha256:").ok_or("blob digest invalid")?
            ),
            &bytes,
            false,
        )?;
    }
    for file in &current.manifest.files {
        write(
            &directory,
            &format!("source/{}", file.path),
            &zero_workspace::bytes(&current, &file.path)?,
            file.executable,
        )?;
    }
    write(&directory, "bundle.json", &encoded, false)?;
    directory.sync_all().map_err(|e| e.to_string())?;
    let unchanged = parent(parent_path)?.metadata().map_err(|e| e.to_string())?;
    if (unchanged.dev(), unchanged.ino()) != (before.dev(), before.ino()) {
        return Err("workspace export parent changed".into());
    }
    renameat2(
        &anchored,
        temporary.path().file_name().ok_or("staging name absent")?,
        &anchored,
        leaf,
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|e| e.to_string())?;
    let _old = temporary.keep();
    anchored
        .sync_all()
        .map_err(|e| format!("workspace exported but parent sync failed: {e}"))?;
    let after = parent(parent_path)?.metadata().map_err(|e| e.to_string())?;
    if (after.dev(), after.ino()) != (before.dev(), before.ino()) {
        return Err(
            "complete workspace export published in original parent, but path changed".into(),
        );
    }
    Ok(
        serde_json::json!({"assessment":"unverified","operation_id":bundle["operation_id"],"output_dir":output,"final_generation":bundle["final_generation"],"host_apply":"not_performed"}),
    )
}
