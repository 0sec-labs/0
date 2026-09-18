use crate::EngineError;
use std::{fs::File, path::Path};
use zero_store::Store;

#[cfg(not(unix))]
pub(super) fn open_owned_store(_: &Path) -> Result<(Store, String, File), EngineError> {
    Err(EngineError::State("native engine ownership requires Unix nofollow/link checks; this platform is not qualified".into()))
}

#[cfg(unix)]
pub(super) fn open_owned_store(path: &Path) -> Result<(Store, String, File), EngineError> {
    use fs2::FileExt;
    use std::{
        fs::{self, OpenOptions},
        os::unix::fs::OpenOptionsExt,
    };
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let canonical = if path.exists() {
        path.canonicalize()?
    } else {
        parent.canonicalize()?.join(
            path.file_name()
                .ok_or_else(|| EngineError::State("state path must name a database".into()))?,
        )
    };
    // Canonical paths unify symlink aliases. Hard links do not canonicalize to
    // one name and would create independent sidecar locks on the same database.
    if let Ok(metadata) = fs::symlink_metadata(&canonical) {
        single_link_regular(&metadata)?;
    }
    let mut lock_name = canonical.as_os_str().to_os_string();
    lock_name.push(".engine-lock");
    let open_regular = |name: &Path| -> Result<File, EngineError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(name)?;
        single_link_regular(&file.metadata()?)?;
        Ok(file)
    };
    let file = open_regular(Path::new(&lock_name))?;
    file.try_lock_exclusive()
        .map_err(|_| EngineError::State("another native engine owns this state database".into()))?;
    same_identity(&file.metadata()?, &fs::symlink_metadata(&lock_name)?)?;
    let database = open_regular(&canonical)?;
    let identity = database.metadata()?;
    let mut store = Store::open(&canonical)?;
    same_identity(&identity, &fs::symlink_metadata(&canonical)?)?;
    // The sidecar inode is never replaced and no owner text is rewritten there.
    // Epoch publication and stale-owner recovery are atomic in SQLite instead.
    let owner = uuid::Uuid::new_v4().to_string();
    store.claim_engine_epoch(&owner)?;
    Ok((store, owner, file))
}

#[cfg(unix)]
fn single_link_regular(metadata: &std::fs::Metadata) -> Result<(), EngineError> {
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(EngineError::State(
            "native database and lock must be regular files with one hard link".into(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn same_identity(opened: &std::fs::Metadata, named: &std::fs::Metadata) -> Result<(), EngineError> {
    use std::os::unix::fs::MetadataExt;
    single_link_regular(opened)?;
    single_link_regular(named)?;
    if opened.dev() != named.dev() || opened.ino() != named.ino() {
        return Err(EngineError::State(
            "native state path changed while acquiring ownership".into(),
        ));
    }
    Ok(())
}
