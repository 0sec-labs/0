//! Explicit Git acquisition into a new private directory. No checkout or hooks.
mod credential;
mod process;
pub use credential::RepositoryCredential;
use std::{
    collections::BTreeSet,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use zero_protocol::source_acquisition::{
    GitSource, RepositoryReceipt, git_oid, validate_ref, validate_repository_path,
};

#[derive(Debug, Clone)]
pub struct RepositoryRequest {
    pub source: GitSource,
    pub reference: String,
    /// Absolute, absent output directory. Source and receipt publish atomically.
    pub output: PathBuf,
    /// Explicit host executable, never selected by repository data.
    pub git_binary: PathBuf,
    pub timeout_ms: u64,
    pub limits: crate::SnapshotLimits,
}

pub async fn acquire_repository(
    request: RepositoryRequest,
    cancel: CancellationToken,
) -> Result<RepositoryReceipt, String> {
    acquire_repository_with_credential(request, None, cancel).await
}

/// Resolve only an explicitly selected host credential; public acquisition remains anonymous.
pub async fn acquire_repository_with_credential(
    request: RepositoryRequest,
    credential: Option<RepositoryCredential>,
    cancel: CancellationToken,
) -> Result<RepositoryReceipt, String> {
    let token = cancel.child_token();
    let _on_drop = token.clone().drop_guard();
    // Dropping the public future requests cancellation without dropping the
    // supervisor responsible for process-group teardown and private cleanup.
    tokio::spawn(async move { acquire_owned(request, credential, token).await })
        .await
        .map_err(|_| "repository acquisition supervisor failed".to_owned())?
}
fn check(cancel: &CancellationToken, deadline: Instant) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("repository acquisition cancelled".into())
    } else if Instant::now() >= deadline {
        Err("repository acquisition deadline exceeded".into())
    } else {
        Ok(())
    }
}

fn safe_absolute(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path.to_str().is_none()
        || path.as_os_str().len() > 4096
        || path
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return Err("acquisition paths must be absolute and normalized".into());
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|_| "acquisition path ancestor unavailable")?;
        if metadata.file_type().is_symlink() {
            return Err("acquisition paths cannot contain symbolic links".into());
        }
    }
    Ok(())
}

pub(crate) fn open_parent(path: &Path) -> Result<std::fs::File, String> {
    use nix::{
        fcntl::{OFlag, open, openat},
        sys::stat::Mode,
    };
    if !path.is_absolute() || path.to_str().is_none() || path.as_os_str().len() > 4096 {
        return Err("output parent must be an absolute UTF-8 directory".into());
    }
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let mut directory =
        std::fs::File::from(open(Path::new("/"), flags, Mode::empty()).map_err(|e| e.to_string())?);
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                directory = std::fs::File::from(
                    openat(&directory, name, flags, Mode::empty()).map_err(|e| e.to_string())?,
                )
            }
            _ => return Err("output parent contains non-normal components".into()),
        }
    }
    Ok(directory)
}
pub(crate) fn parent_unchanged(path: &Path, anchor: &std::fs::File) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let current = open_parent(path)?.metadata().map_err(|e| e.to_string())?;
    let captured = anchor.metadata().map_err(|e| e.to_string())?;
    if (current.dev(), current.ino()) != (captured.dev(), captured.ino()) {
        return Err("acquisition output parent changed".into());
    }
    Ok(())
}
struct Git<'a> {
    request: &'a RepositoryRequest,
    private: &'a Path,
    deadline: Instant,
    cancel: &'a CancellationToken,
    credential: Option<&'a credential::ResolvedCredential>,
}
impl Git<'_> {
    async fn run(&self, args: &[&str], cap: usize, authenticate: bool) -> Result<Vec<u8>, String> {
        let mut command = vec!["--no-pager".into(), "--no-replace-objects".into()];
        for config in [
            "core.hooksPath=/dev/null",
            "credential.helper=",
            "http.followRedirects=false",
            "protocol.allow=never",
            "protocol.https.allow=always",
            "gc.auto=0",
            "maintenance.auto=false",
            "fetch.unpackLimit=0",
            "transfer.unpackLimit=0",
            "fetch.fsckObjects=true",
            "transfer.fsckObjects=true",
            "fetch.recurseSubmodules=false",
            "submodule.recurse=false",
            "pack.threads=1",
            "core.deltaBaseCacheLimit=16m",
            "pack.windowMemory=16m",
            "http.maxRequests=1",
            "core.alternateRefsCommand=",
            "uploadpack.packObjectsHook=",
            "core.attributesFile=/dev/null",
        ] {
            command.extend(["-c".into(), config.into()]);
        }
        if matches!(self.request.source, GitSource::Local { .. }) {
            command.extend(["-c".into(), "protocol.file.allow=always".into()]);
        }
        command.extend(args.iter().map(|s| (*s).to_owned()));
        process::run(
            &self.request.git_binary,
            &command,
            self.private,
            matches!(self.request.source, GitSource::Local { .. }),
            self.deadline,
            self.cancel,
            cap,
            if authenticate { self.credential } else { None },
        )
        .await
    }
    async fn repo(&self, args: &[&str], cap: usize) -> Result<Vec<u8>, String> {
        let mut full = vec!["--git-dir=repository.git"];
        full.extend_from_slice(args);
        self.run(&full, cap, args.first() == Some(&"fetch")).await
    }
}
struct Entry {
    path: String,
    oid: String,
    bytes: u64,
    executable: bool,
}
fn parse_tree(bytes: &[u8], limits: crate::SnapshotLimits) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    let mut total = 0u64;
    let mut paths = BTreeSet::new();
    if !bytes.is_empty() && bytes.last() != Some(&0) {
        return Err("Git tree framing incomplete".into());
    }
    for raw in bytes.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        if entries.len() >= limits.max_files {
            return Err("repository file count exceeds bound".into());
        }
        let line = std::str::from_utf8(raw).map_err(|_| "repository paths must be UTF-8")?;
        let (header, path) = line.split_once('\t').ok_or("invalid Git tree entry")?;
        validate_repository_path(path)?;
        let fields: Vec<_> = header.split_ascii_whitespace().collect();
        if fields.len() != 4
            || !matches!(fields[0], "100644" | "100755")
            || fields[1] != "blob"
            || !git_oid(fields[2])
        {
            return Err(
                "repository symlinks, submodules or unsupported object modes are forbidden".into(),
            );
        }
        let size = fields[3]
            .parse::<u64>()
            .map_err(|_| "invalid Git blob size")?;
        total = total
            .checked_add(size)
            .ok_or("repository source size overflow")?;
        if total > limits.max_bytes || !paths.insert(path.to_owned()) {
            return Err("repository byte bound or duplicate path".into());
        }
        entries.push(Entry {
            path: path.into(),
            oid: fields[2].into(),
            bytes: size,
            executable: fields[0] == "100755",
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    // A file must never become a directory while materializing a later path.
    for entry in &entries {
        for (offset, _) in entry.path.match_indices('/') {
            if paths.contains(&entry.path[..offset]) {
                return Err("repository file/directory overlap".into());
            }
        }
    }
    Ok(entries)
}
fn oid(bytes: Vec<u8>) -> Result<String, String> {
    let value = String::from_utf8(bytes).map_err(|_| "invalid Git object ID")?;
    let value = value.strip_suffix('\n').ok_or("Git object ID framing")?;
    if !git_oid(value) {
        return Err("only SHA-1 Git repositories are supported".into());
    }
    Ok(value.into())
}

async fn acquire_owned(
    request: RepositoryRequest,
    credential: Option<RepositoryCredential>,
    cancel: CancellationToken,
) -> Result<RepositoryReceipt, String> {
    request.source.validate()?;
    let credential = credential.map(|c| c.resolve(&request.source)).transpose()?;
    validate_ref(&request.reference)?;
    if !(1..=120_000).contains(&request.timeout_ms)
        || request.limits.max_files == 0
        || request.limits.max_files > 4096
        || request.limits.max_bytes == 0
        || request.limits.max_bytes > 64 * 1024 * 1024
    {
        return Err("repository acquisition limits outside supported bounds".into());
    }
    safe_absolute(&request.git_binary)?;
    let parent = request.output.parent().ok_or("output parent absent")?;
    let parent_fd = open_parent(parent)?;
    if request.output.file_name().is_none()
        || request.output.to_str().is_none()
        || !request.output.is_absolute()
        || request
            .output
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        || std::fs::symlink_metadata(&request.output).is_ok()
    {
        return Err("acquisition output must be a new absolute directory".into());
    }
    if let GitSource::Local { path } = &request.source {
        safe_absolute(Path::new(path))?;
        if !Path::new(path).is_dir() {
            return Err("local repository must be a directory".into());
        }
        let dotgit = Path::new(path).join(".git");
        let gitdir = if std::fs::symlink_metadata(&dotgit).is_ok() {
            dotgit
        } else {
            PathBuf::from(path)
        };
        safe_absolute(&gitdir)?;
        if !gitdir.is_dir()
            || ["objects/info/alternates", "objects/info/http-alternates"]
                .iter()
                .any(|p| std::fs::symlink_metadata(gitdir.join(p)).is_ok())
        {
            return Err(
                "local linked worktrees and alternate object stores are unsupported".into(),
            );
        }
    }
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    check(&cancel, deadline)?;
    let private = tempfile::Builder::new()
        .prefix("0sec-git-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let output = tempfile::Builder::new()
        .prefix(".0sec-acquire-")
        // Keep all private source writes and cleanup anchored to the original
        // directory even if its pathname is renamed/replaced during a fetch.
        .tempdir_in(format!(
            "/proc/self/fd/{}",
            std::os::fd::AsRawFd::as_raw_fd(&parent_fd)
        ))
        .map_err(|e| e.to_string())?;
    let git = Git {
        request: &request,
        private: private.path(),
        deadline,
        cancel: &cancel,
        credential: credential.as_ref(),
    };
    let result = async {
        git.run(
            &[
                "init",
                "--bare",
                "--object-format=sha1",
                "--template=",
                "repository.git",
            ],
            4096,
            false,
        )
        .await?;
        let remote = match &request.source {
            GitSource::Https { url } => url.clone(),
            GitSource::Local { path } => path.clone(),
        };
        git.repo(
            &[
                "fetch",
                "--depth=1",
                "--no-tags",
                "--no-recurse-submodules",
                "--no-auto-maintenance",
                "--",
                &remote,
                &request.reference,
            ],
            65536,
        )
        .await?;
        if git.repo(&["rev-parse", "--show-object-format"], 32).await? != b"sha1\n" {
            return Err("unsupported Git object format".into());
        }
        let commit = oid(git
            .repo(&["rev-parse", "--verify", "FETCH_HEAD^{commit}"], 64)
            .await?)?;
        if git_oid(&request.reference) && request.reference != commit {
            return Err("resolved Git commit differs from requested ID".into());
        }
        let tree = oid(git
            .repo(
                &["rev-parse", "--verify", &format!("{commit}^{{tree}}")],
                64,
            )
            .await?)?;
        let listing = git
            .repo(
                &["ls-tree", "-r", "-z", "-l", "--full-tree", &tree],
                2 * 1024 * 1024,
            )
            .await?;
        let entries = parse_tree(&listing, request.limits)?;
        let source = output.path().join("source");
        std::fs::create_dir(&source).map_err(|e| e.to_string())?;
        let mut executable_paths = Vec::new();
        let mut expected_files = Vec::new();
        let mut directories = BTreeSet::new();
        for entry in entries {
            check(&cancel, deadline)?;
            let bytes = git
                .repo(&["cat-file", "blob", &entry.oid], entry.bytes as usize)
                .await?;
            if bytes.len() as u64 != entry.bytes {
                return Err("Git blob differs from tree size".into());
            }
            let path = source.join(&entry.path);
            let mut directory = path.parent().ok_or("file parent absent")?;
            loop {
                directories.insert(directory.to_path_buf());
                if directory == source {
                    break;
                }
                directory = directory.parent().ok_or("source directory escaped")?;
            }
            std::fs::create_dir_all(path.parent().ok_or("file parent absent")?)
                .map_err(|e| e.to_string())?;
            use std::io::Write;
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(if entry.executable { 0o700 } else { 0o600 })
                .custom_flags(libc::O_NOFOLLOW)
                .open(path)
                .map_err(|e| e.to_string())?;
            // umask must not silently change the executable inventory retained
            // in the receipt (SnapshotPin hashes source bytes, not mode bits).
            file.set_permissions(std::fs::Permissions::from_mode(if entry.executable {
                0o700
            } else {
                0o600
            }))
            .map_err(|e| e.to_string())?;
            for chunk in bytes.chunks(65536) {
                check(&cancel, deadline)?;
                file.write_all(chunk).map_err(|e| e.to_string())?;
            }
            file.sync_all().map_err(|e| e.to_string())?;
            use sha2::{Digest, Sha256};
            expected_files.push(zero_protocol::SnapshotFile {
                path: entry.path.clone(),
                digest: format!("sha256:{:x}", Sha256::digest(&bytes)),
                bytes: entry.bytes,
            });
            if entry.executable {
                executable_paths.push(entry.path);
            }
        }
        let pin_cancel = cancel.clone();
        let limits = request.limits;
        for directory in directories.iter().rev() {
            check(&cancel, deadline)?;
            std::fs::File::open(directory)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        parent_unchanged(parent, &parent_fd)?;
        let source = std::fs::canonicalize(source).map_err(|e| e.to_string())?;
        let pin_parent = parent.to_owned();
        let pin_parent_fd = parent_fd.try_clone().map_err(|e| e.to_string())?;
        let mut snapshot = tokio::task::spawn_blocking(move || {
            crate::pin_snapshot_checked(&source, limits, &|| {
                check(&pin_cancel, deadline)?;
                parent_unchanged(&pin_parent, &pin_parent_fd)
            })
        })
        .await
        .map_err(|_| "repository pin task failed")??;
        if serde_json::to_vec(&snapshot.files).map_err(|e| e.to_string())?
            != serde_json::to_vec(&expected_files).map_err(|e| e.to_string())?
        {
            return Err("captured source differs from fetched Git blobs".into());
        }
        snapshot.root = request
            .output
            .join("source")
            .to_str()
            .ok_or("output path UTF-8")?
            .into();
        let receipt = RepositoryReceipt {
            schema_version: 1,
            object_format: "sha1".into(),
            source: request.source.clone(),
            requested_ref: request.reference.clone(),
            commit_oid: commit,
            tree_oid: tree,
            snapshot,
            executable_paths,
        };
        let bytes = receipt.canonical_bytes()?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("repository receipt exceeds bound".into());
        }
        std::fs::write(output.path().join("receipt.json"), bytes).map_err(|e| e.to_string())?;
        std::fs::File::open(output.path().join("receipt.json"))
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        check(&cancel, deadline)?;
        parent_unchanged(parent, &parent_fd)?;
        std::fs::File::open(output.path())
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        // Atomic, no-replace publication. No partial destination becomes usable.
        nix::fcntl::renameat2(
            &parent_fd,
            output
                .path()
                .file_name()
                .ok_or("private staging name absent")?,
            &parent_fd,
            request.output.file_name().ok_or("output name absent")?,
            nix::fcntl::RenameFlags::RENAME_NOREPLACE,
        )
        .map_err(|e| e.to_string())?;
        parent_fd.sync_all().map_err(|e| e.to_string())?;
        parent_unchanged(parent, &parent_fd)?;
        Ok(receipt)
    }
    .await;
    if result
        .as_ref()
        .is_err_and(|e: &String| e == "Git process cleanup unconfirmed")
    {
        let recovery = private.keep();
        return Err(format!(
            "Git process cleanup unconfirmed; retained private directory {}",
            recovery.display()
        ));
    }
    result
}
