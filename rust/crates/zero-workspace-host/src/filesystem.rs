use crate::{Bundle, Change, FileState, hash};
use nix::{
    errno::Errno,
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};

fn directory_flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}
/// Pin every directory component; neither symlinks nor `..` can redirect access.
pub(crate) fn directory(path: &Path) -> Result<File, String> {
    if !path.is_absolute() || path.as_os_str().len() > 4096 {
        return Err("workspace directory must be a bounded absolute path".into());
    }
    let mut current = File::from(
        open(Path::new("/"), directory_flags(), Mode::empty()).map_err(|e| e.to_string())?,
    );
    for component in path.components() {
        match component {
            Component::RootDir => (),
            Component::Normal(name) => {
                current = File::from(
                    openat(&current, name, directory_flags(), Mode::empty())
                        .map_err(|e| e.to_string())?,
                )
            }
            _ => return Err("workspace directory contains non-normal components".into()),
        }
    }
    Ok(current)
}
pub(crate) fn parent(root: &File, path: &str) -> Result<Option<(File, String)>, String> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains(['\\', ':'])
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err("workspace relative path invalid".into());
    }
    let parts: Vec<_> = path.split('/').collect();
    let mut current = root.try_clone().map_err(|e| e.to_string())?;
    for part in &parts[..parts.len() - 1] {
        match openat(&current, *part, directory_flags(), Mode::empty()) {
            Ok(fd) => current = File::from(fd),
            Err(Errno::ENOENT) => return Ok(None),
            Err(e) => return Err(format!("workspace parent is not a safe directory: {e}")),
        }
    }
    Ok(Some((current, parts[parts.len() - 1].into())))
}
pub(crate) struct Observed {
    #[cfg(target_os = "linux")]
    pub metadata: crate::metadata::FileMetadata,
    pub bytes: Vec<u8>,
    pub state: FileState,
    pub identity: (u64, u64),
    pub mode: u32,
}
pub(crate) fn read(root: &File, path: &str, max: u64) -> Result<Option<Observed>, String> {
    let Some((parent, leaf)) = parent(root, path)? else {
        return Ok(None);
    };
    let fd = match openat(
        &parent,
        leaf.as_str(),
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(Errno::ENOENT) => return Ok(None),
        Err(e) => return Err(format!("workspace file cannot be opened safely: {e}")),
    };
    let mut file = File::from(fd);
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() || before.nlink() != 1 || before.len() > max {
        return Err("workspace file must be bounded, regular and single-link".into());
    }
    let mut bytes = Vec::new();
    #[cfg(target_os = "linux")]
    let preserved_metadata = crate::metadata::FileMetadata::capture(&file)?;
    (&mut file)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let after = file.metadata().map_err(|e| e.to_string())?;
    let stamp = |m: &std::fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mode(),
            m.nlink(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    if bytes.len() as u64 > max
        || bytes.len() as u64 != before.len()
        || stamp(&before) != stamp(&after)
    {
        return Err("workspace file changed while being read".into());
    }
    Ok(Some(Observed {
        #[cfg(target_os = "linux")]
        metadata: {
            preserved_metadata.verify(&file)?;
            preserved_metadata
        },
        identity: (before.dev(), before.ino()),
        mode: before.mode() & 0o777,
        state: FileState {
            sha256: hash(&bytes),
            bytes: bytes.len() as u64,
            executable: before.mode() & 0o111 != 0,
        },
        bytes,
    }))
}
impl Bundle {
    /// Read immutable chunk identities via pinned directory handles. Exported
    /// `source/` files are deliberately not inputs to application.
    pub fn read(path: &Path) -> Result<Self, String> {
        let root = directory(path)?;
        let raw = read(&root, "bundle.json", 32 * 1024 * 1024)?.ok_or("workspace bundle absent")?;
        Self::decode(&raw.bytes, |sha, size| {
            if !zero_protocol::is_sha256(sha) {
                return Err("workspace chunk digest invalid".into());
            }
            let file = read(&root, &format!("blobs/{}", &sha[7..]), size)?
                .ok_or("workspace chunk absent")?;
            Ok(file.bytes)
        })
    }
}
#[derive(Serialize)]
pub struct Preflight {
    pub assessment: &'static str,
    pub bundle_sha256: String,
    pub root: PathBuf,
    pub root_device: u64,
    pub root_inode: u64,
    pub changes: Vec<Change>,
}
/// Validate only the intended changed paths, preserving unrelated user edits.
/// A preflight is a preview, not a reusable write permit: apply must recheck it.
pub fn preflight(path: &Path, bundle: &Bundle) -> Result<Preflight, String> {
    let root = directory(path)?;
    let identity = root.metadata().map_err(|e| e.to_string())?;
    for change in &bundle.changes {
        let observed = read(
            &root,
            &change.path,
            zero_protocol::source_archive::MAX_BYTES,
        )?;
        if observed.as_ref().map(|f| &f.state) != change.before.as_ref() {
            return Err(format!("workspace baseline conflict: {}", change.path));
        }
    }
    let again = directory(path)?.metadata().map_err(|e| e.to_string())?;
    if (identity.dev(), identity.ino()) != (again.dev(), again.ino()) {
        return Err("workspace root changed during preflight".into());
    }
    Ok(Preflight {
        assessment: "unverified",
        bundle_sha256: bundle.digest.clone(),
        root: path.into(),
        root_device: identity.dev(),
        root_inode: identity.ino(),
        changes: bundle.changes.clone(),
    })
}
