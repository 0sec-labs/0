use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

pub(crate) async fn copy_archive(
    source: &Path,
    destination: &Path,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<String, String> {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(source)
        .await
        .map_err(|e| format!("archive open: {e}"))?;
    let meta = file.metadata().await.map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 8 * 1024_u64.pow(3) {
        return Err("archive must be a regular nonempty file <=8 GiB".into());
    }
    let mut target = tokio::fs::OpenOptions::new();
    target.write(true).create_new(true);
    #[cfg(unix)]
    {
        target.mode(0o600);
    }
    let mut target = target.open(destination).await.map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut count = 0_u64;
    let mut buf = vec![0; 65536];
    loop {
        let n = tokio::select! {biased;_=cancel.cancelled()=>return Err("cancelled during archive copy".into()),_=tokio::time::sleep_until(deadline)=>return Err("deadline during archive copy".into()),n=file.read(&mut buf)=>n.map_err(|e|e.to_string())?};
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > 8 * 1024_u64.pow(3) {
            return Err("archive grew beyond limit".into());
        }
        hash.update(&buf[..n]);
        tokio::select! {biased;_=cancel.cancelled()=>return Err("cancelled during archive write".into()),_=tokio::time::sleep_until(deadline)=>return Err("deadline during archive write".into()),v=target.write_all(&buf[..n])=>v.map_err(|e|e.to_string())?};
    }
    if count != meta.len() {
        return Err("archive size changed during copy".into());
    }
    target.flush().await.map_err(|e| e.to_string())?;
    Ok(format!("sha256:{:x}", hash.finalize()))
}
pub(crate) async fn owned_processes(root: &Path) -> Result<Vec<u32>, String> {
    owned_processes_at(root, Path::new("/proc")).await
}
async fn owned_processes_at(root: &Path, proc_root: &Path) -> Result<Vec<u32>, String> {
    use std::os::unix::fs::MetadataExt;
    let mut entries = tokio::fs::read_dir(proc_root)
        .await
        .map_err(|e| e.to_string())?;
    let mut found = vec![];
    let marker = format!("{}/", root.display());
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|v| v.parse::<u32>().ok())
        else {
            continue;
        };
        // Non-root execution cannot create a different host-UID descendant.
        // Ignore other users, but inspection failures for our UID are UNKNOWN.
        let meta = match entry.metadata().await {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("process ownership inspection failed: {e}")),
        };
        if meta.uid() != nix::unistd::Uid::current().as_raw() {
            continue;
        }
        let command = match tokio::fs::read(entry.path().join("cmdline")).await {
            Ok(v) => v,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound) => {
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let contains = command
            .windows(marker.len())
            .any(|v| v == marker.as_bytes());
        let cwd = if command.windows(6).any(|v| v == b"smolvm") {
            match tokio::fs::read_link(entry.path().join("cwd")).await {
                Ok(v) => Some(v),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(format!("runtime working-directory inspection failed: {e}")),
            }
        } else {
            None
        };
        if !contains && cwd.as_deref() != Some(root) {
            continue;
        }
        let stat = match tokio::fs::read_to_string(entry.path().join("stat")).await {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        if stat
            .rsplit_once(") ")
            .is_some_and(|(_, rest)| rest.starts_with("Z "))
        {
            continue;
        }
        found.push(pid);
    }
    Ok(found)
}
pub(crate) async fn cleanup(root: &Path) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut quiet = false;
    loop {
        if owned_processes(root).await?.is_empty() {
            if quiet {
                tokio::fs::remove_dir_all(root)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            quiet = true
        } else {
            quiet = false
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "VM termination unconfirmed; recovery state retained at {}",
                root.display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
pub(crate) fn private_root() -> Result<PathBuf, String> {
    let dir = tempfile::Builder::new()
        .prefix("0sec-smol-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    for sub in ["h", "c", "d", "f", "r", "t"] {
        std::fs::create_dir(dir.path().join(sub)).map_err(|e| e.to_string())?;
    }
    Ok(dir.keep())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn scan_failures_are_not_absence_proof() {
        let root = tempfile::tempdir().unwrap();
        let proc = tempfile::tempdir().unwrap();
        let pid = proc.path().join("123");
        std::fs::create_dir(&pid).unwrap();
        // An unreadable/unexpected cmdline must invalidate the scan.
        std::fs::create_dir(pid.join("cmdline")).unwrap();
        assert!(owned_processes_at(root.path(), proc.path()).await.is_err());
        std::fs::remove_dir(pid.join("cmdline")).unwrap();
        std::fs::write(pid.join("cmdline"), b"smolvm\0").unwrap();
        if !nix::unistd::Uid::current().is_root() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(pid.join("cmdline"), std::fs::Permissions::from_mode(0))
                .unwrap();
            assert!(owned_processes_at(root.path(), proc.path()).await.is_err());
            std::fs::set_permissions(pid.join("cmdline"), std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        std::fs::write(pid.join("cwd"), b"not a symlink").unwrap();
        assert!(owned_processes_at(root.path(), proc.path()).await.is_err());
        std::fs::remove_file(pid.join("cwd")).unwrap();
        std::os::unix::fs::symlink(root.path(), pid.join("cwd")).unwrap();
        std::fs::write(pid.join("stat"), "123 (smolvm) S 1 2 3").unwrap();
        assert_eq!(
            owned_processes_at(root.path(), proc.path()).await.unwrap(),
            vec![123]
        );
    }
}
