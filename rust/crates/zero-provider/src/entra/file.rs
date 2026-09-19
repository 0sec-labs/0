//! Anchored private-file rotation. Writers must use the same stable lock file.
use super::{LIMIT, Snapshot, bad};
use crate::TransportError;
use nix::{
    fcntl::{Flock, FlockArg, OFlag, open, openat, renameat},
    sys::stat::Mode,
    unistd::{UnlinkatFlags, geteuid, unlinkat},
};
use std::{
    fs::File,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
    path::{Component, Path},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
pub(super) struct Source {
    directory: File,
    name: String,
    lock_name: String,
}
fn private(file: &File) -> Result<(), TransportError> {
    let meta = file.metadata().map_err(|_| bad())?;
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != geteuid().as_raw()
        || meta.mode() & 0o7777 != 0o600
    {
        return Err(bad());
    }
    Ok(())
}
fn same_file(a: &File, b: &File) -> Result<bool, TransportError> {
    let a = a.metadata().map_err(|_| bad())?;
    let b = b.metadata().map_err(|_| bad())?;
    Ok(a.dev() == b.dev() && a.ino() == b.ino())
}
impl Source {
    pub(super) fn open(path: &Path) -> Result<Self, TransportError> {
        if !path.is_absolute() || path.as_os_str().len() > 4096 {
            return Err(bad());
        }
        let mut components = path.components().peekable();
        if components.next() != Some(Component::RootDir) {
            return Err(bad());
        }
        let mut directory = File::from(
            open(
                "/",
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| bad())?,
        );
        while let Some(component) = components.next() {
            let Component::Normal(name) = component else {
                return Err(bad());
            };
            if components.peek().is_none() {
                let name = name.to_str().ok_or_else(bad)?.to_owned();
                if name.is_empty() || name.len() > 200 {
                    return Err(bad());
                }
                let meta = directory.metadata().map_err(|_| bad())?;
                if meta.uid() != geteuid().as_raw() || meta.mode() & 0o022 != 0 {
                    return Err(bad());
                }
                return Ok(Self {
                    directory,
                    lock_name: format!("{name}.oauth-lock"),
                    name,
                });
            }
            directory = File::from(
                openat(
                    &directory,
                    name,
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| bad())?,
            );
        }
        Err(bad())
    }
    fn open_file(&self, name: &str, flags: OFlag) -> Result<File, TransportError> {
        let directory = self.directory.metadata().map_err(|_| bad())?;
        if directory.uid() != geteuid().as_raw() || directory.mode() & 0o022 != 0 {
            return Err(bad());
        }
        let file = File::from(
            openat(
                &self.directory,
                name,
                flags | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| bad())?,
        );
        private(&file)?;
        Ok(file)
    }
    pub(super) fn read(&self) -> Result<Snapshot, TransportError> {
        let file = self.open_file(&self.name, OFlag::O_RDONLY)?;
        if file.metadata().map_err(|_| bad())?.len() > LIMIT as u64 {
            return Err(bad());
        }
        let mut bytes = Vec::new();
        file.take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| bad())?;
        if bytes.len() > LIMIT {
            return Err(bad());
        }
        let snapshot: Snapshot = serde_json::from_slice(&bytes).map_err(|_| bad())?;
        snapshot.validate()?;
        Ok(snapshot)
    }
    pub(super) fn try_lock(&self) -> Result<Option<Flock<File>>, TransportError> {
        let file = self.open_file(&self.lock_name, OFlag::O_RDWR | OFlag::O_CREAT)?;
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => {
                self.check_lock(&lock)?;
                Ok(Some(lock))
            }
            Err((_, nix::errno::Errno::EAGAIN)) => Ok(None),
            Err(_) => Err(bad()),
        }
    }
    fn check_lock(&self, lock: &Flock<File>) -> Result<(), TransportError> {
        private(lock)?;
        let current = self.open_file(&self.lock_name, OFlag::O_RDONLY)?;
        if !same_file(lock, &current)? {
            return Err(bad());
        }
        Ok(())
    }
    pub(super) fn replace(
        &self,
        lock: &Flock<File>,
        expected: &Snapshot,
        replacement: &Snapshot,
    ) -> Result<(), TransportError> {
        self.check_lock(lock)?;
        if self.read()? != *expected {
            return Err(bad());
        }
        let bytes = serde_json::to_vec(&serde_json::to_value(replacement).map_err(|_| bad())?)
            .map_err(|_| bad())?;
        if bytes.len() > LIMIT {
            return Err(bad());
        }
        let name = format!(
            ".0sec-oauth-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        );
        let mut file = File::from(
            openat(
                &self.directory,
                name.as_str(),
                OFlag::O_WRONLY
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| bad())?,
        );
        let result = (|| {
            private(&file)?;
            file.write_all(&bytes).map_err(|_| bad())?;
            file.sync_all().map_err(|_| bad())?;
            self.check_lock(lock)?;
            if self.read()? != *expected {
                return Err(bad());
            }
            renameat(
                &self.directory,
                name.as_str(),
                &self.directory,
                self.name.as_str(),
            )
            .map_err(|_| bad())?;
            self.directory.sync_all().map_err(|_| bad())?;
            Ok(())
        })();
        // Successful rename removed this name; failed writes remove only our file.
        let _ = unlinkat(&self.directory, name.as_str(), UnlinkatFlags::NoRemoveDir);
        result
    }
}
