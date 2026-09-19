//! Explicit local credential removal, with no token reads or remote requests.
use std::{
    error::Error,
    path::{Path, PathBuf},
};

pub async fn run(explicit: Option<&Path>, token_env: &str) -> Result<bool, Box<dyn Error>> {
    let paths = if let Some(path) = explicit {
        vec![path.to_owned()]
    } else {
        let home = std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .ok_or("Hosted credential home is unavailable")?;
        let home = PathBuf::from(home);
        vec![
            home.join(".0sec/cloud.env"),
            home.join(".0cloud/credentials.json"),
        ]
    };
    for path in &paths {
        if !path.is_absolute()
            || path.to_str().is_none()
            || path.file_name().is_none()
            || path.components().any(|v| {
                matches!(
                    v,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err("Hosted credential destination must be a normal absolute file path".into());
        }
    }
    let environment_override = std::env::var(token_env)
        .ok()
        .is_some_and(|v| !v.trim().is_empty());
    let mut worker = tokio::task::spawn_blocking(move || remove(&paths));
    let (deleted, interrupted) = tokio::select! {
        result = &mut worker => (result?.map_err(std::io::Error::other)?, false),
        _ = crate::server::shutdown_signal() => (worker.await?.map_err(std::io::Error::other)?, true),
    };
    crate::write_json(&serde_json::json!({
        "saved_credentials_removed":true,"deleted_files":deleted,
        "environment_override":environment_override,"remote_sessions_revoked":false,
        "cancellation_requested":interrupted,
        "credential_precedence":"Environment tokens remain active; local removal does not revoke remote tokens."
    }),false).await?;
    Ok(!interrupted)
}

#[cfg(not(unix))]
fn remove(_: &[PathBuf]) -> Result<Vec<PathBuf>, &'static str> {
    Err("Hosted logout currently requires Unix filesystem support")
}
#[cfg(unix)]
fn remove(paths: &[PathBuf]) -> Result<Vec<PathBuf>, &'static str> {
    use nix::{
        fcntl::{Flock, FlockArg, OFlag, open, openat},
        sys::stat::{Mode, SFlag, fstat},
        unistd::{UnlinkatFlags, geteuid, unlinkat},
    };
    use std::{fs::File, path::Component};
    fn directory(path: &Path) -> Result<Option<File>, &'static str> {
        let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut dir = File::from(
            open(Path::new("/"), flags, Mode::empty())
                .map_err(|_| "Cannot open credential directory root")?,
        );
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => match openat(&dir, name, flags, Mode::empty()) {
                    Ok(fd) => dir = File::from(fd),
                    Err(nix::errno::Errno::ENOENT) => return Ok(None),
                    Err(_) => {
                        return Err("Credential directory is inaccessible or contains a symlink");
                    }
                },
                _ => return Err("Credential directory path is not normal"),
            }
        }
        let stat = fstat(&dir).map_err(|_| "Credential directory metadata unavailable")?;
        if stat.st_uid != geteuid().as_raw() || stat.st_mode & 0o022 != 0 {
            return Err(
                "Credential directory must be owned by the current user and not writable by others",
            );
        }
        Ok(Some(dir))
    }
    let mut prepared = Vec::new();
    // Check every candidate before deleting any. Keep locks and file identities pinned.
    for path in paths {
        let parent = path.parent().ok_or("Credential parent unavailable")?;
        let Some(dir) = directory(parent)? else {
            continue;
        };
        let dir = Flock::lock(dir, FlockArg::LockExclusiveNonblock)
            .map_err(|_| "Credential directory is busy")?;
        let name = path.file_name().ok_or("Credential name unavailable")?;
        let file = match openat(
            &*dir,
            name,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
            Mode::empty(),
        ) {
            Ok(fd) => File::from(fd),
            Err(nix::errno::Errno::ENOENT) => continue,
            Err(_) => return Err("Credential file is inaccessible or a symlink; no files removed"),
        };
        let stat = fstat(&file).map_err(|_| "Credential metadata unavailable")?;
        if SFlag::from_bits_truncate(stat.st_mode) & SFlag::S_IFMT != SFlag::S_IFREG
            || stat.st_uid != geteuid().as_raw()
            || stat.st_nlink != 1
        {
            return Err(
                "Credential file must be owned, regular and singly linked; no files removed",
            );
        }
        prepared.push((path.clone(), dir, file, stat));
    }
    let mut deleted = Vec::new();
    for (path, dir, _file, original) in prepared {
        let current = directory(path.parent().ok_or("Credential parent unavailable")?)?
            .ok_or("Credential parent disappeared; removal may be partial")?;
        let a = fstat(&current).map_err(|_| "Credential directory metadata unavailable")?;
        let b = fstat(&*dir).map_err(|_| "Credential directory metadata unavailable")?;
        if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino) {
            return Err("Credential directory changed; removal may be partial");
        }
        let name = path.file_name().ok_or("Credential name unavailable")?;
        let current = openat(
            &*dir,
            name,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
            Mode::empty(),
        )
        .map_err(|_| "Credential file changed; removal may be partial")?;
        let stat = fstat(current).map_err(|_| "Credential metadata unavailable")?;
        if (stat.st_dev, stat.st_ino, stat.st_nlink) != (original.st_dev, original.st_ino, 1) {
            return Err("Credential file changed; removal may be partial");
        }
        unlinkat(&*dir, name, UnlinkatFlags::NoRemoveDir)
            .map_err(|_| "Cannot remove credential file; removal may be partial")?;
        dir.sync_all().map_err(
            |_| "Credential removed but directory synchronization failed; removal may be partial",
        )?;
        deleted.push(path);
    }
    Ok(deleted)
}
