//! Exact bounded metadata for host-owned staging files. Never apply to checkout FDs.
use nix::{
    sys::stat::{Mode, fchmod},
    unistd::{Gid, Uid, fchown},
};
use rustix::fs::{XattrFlags, fgetxattr, flistxattr, fremovexattr, fsetxattr};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs::File, os::unix::fs::MetadataExt};

const MAX_NAMES: usize = 16 * 1024;
const MAX_ATTRIBUTES: usize = 64;
const MAX_VALUES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FileMetadata {
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
    pub xattrs: BTreeMap<String, Vec<u8>>,
}
fn allowed(name: &str) -> bool {
    (name.starts_with("user.") && name.len() > 5 || name == "system.posix_acl_access")
        && name.len() <= 255
        && !name.bytes().any(|b| b == 0 || b.is_ascii_control())
}
fn stamp(m: &std::fs::Metadata) -> (u64, u64, u64, u32, u32, u32, u64, i64, i64, i64, i64) {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.uid(),
        m.gid(),
        m.mode(),
        m.nlink(),
        m.ctime(),
        m.ctime_nsec(),
        m.mtime(),
        m.mtime_nsec(),
    )
}
impl FileMetadata {
    fn validate(&self) -> Result<(), String> {
        if self.uid == u32::MAX
            || self.gid == u32::MAX
            || self.mode & !0o7777 != 0
            || self.xattrs.len() > MAX_ATTRIBUTES
        {
            return Err("unsupported ownership, permissions or attribute count".into());
        }
        let mut names = 0usize;
        let mut values = 0usize;
        for (name, value) in &self.xattrs {
            if !allowed(name) {
                return Err(
                    "unsupported security, trusted or filesystem extended attribute".into(),
                );
            }
            names = names
                .checked_add(name.len() + 1)
                .ok_or("metadata name bound")?;
            values = values
                .checked_add(value.len())
                .ok_or("metadata value bound")?;
        }
        if names > MAX_NAMES || values > MAX_VALUES {
            return Err("extended metadata exceeds bounded preservation limit".into());
        }
        Ok(())
    }
    pub(crate) fn capture(file: &File) -> Result<Self, String> {
        let before = file.metadata().map_err(|e| e.to_string())?;
        if !before.is_file() || before.nlink() != 1 {
            return Err("metadata requires a single-link regular file".into());
        }
        let mut names = vec![0u8; MAX_NAMES];
        let count = flistxattr(file, names.as_mut_slice())
            .map_err(|e| format!("cannot enumerate bounded extended metadata: {e}"))?;
        names.truncate(count);
        if !names.is_empty() && names.last() != Some(&0) {
            return Err("extended metadata names are malformed".into());
        }
        let mut result = Self {
            uid: before.uid(),
            gid: before.gid(),
            mode: before.mode() & 0o7777,
            xattrs: BTreeMap::new(),
        };
        let mut total = 0usize;
        for raw in names.split_inclusive(|b| *b == 0) {
            let name = std::str::from_utf8(&raw[..raw.len() - 1])
                .map_err(|_| "unsupported non-UTF8 extended metadata name")?;
            if !allowed(name) {
                return Err(
                    "unsupported security, trusted or filesystem extended attribute".into(),
                );
            }
            if result.xattrs.len() >= MAX_ATTRIBUTES {
                return Err("too many extended metadata attributes".into());
            }
            let mut value = vec![0u8; MAX_VALUES + 1];
            let bytes = fgetxattr(file, name, value.as_mut_slice())
                .map_err(|e| format!("cannot capture bounded extended metadata: {e}"))?;
            value.truncate(bytes);
            total = total.checked_add(bytes).ok_or("metadata value bound")?;
            if total > MAX_VALUES {
                return Err("extended metadata exceeds bounded preservation limit".into());
            }
            if result.xattrs.insert(name.into(), value).is_some() {
                return Err("duplicate extended metadata name".into());
            }
        }
        result.validate()?;
        let after = file.metadata().map_err(|e| e.to_string())?;
        if stamp(&before) != stamp(&after) {
            return Err("file metadata changed during capture".into());
        }
        Ok(result)
    }
    /// Apply only to an already written private staging file. Errors can leave
    /// staging metadata changed; the caller must not install it on failure.
    pub(crate) fn apply_to(&self, staged: &File) -> Result<(), String> {
        self.validate()?;
        let current = Self::capture(staged)?;
        if current.uid != self.uid || current.gid != self.gid {
            fchown(
                staged,
                (current.uid != self.uid).then(|| Uid::from_raw(self.uid)),
                (current.gid != self.gid).then(|| Gid::from_raw(self.gid)),
            )
            .map_err(|e| format!("cannot preserve file ownership: {e}"))?;
        }
        for name in current
            .xattrs
            .keys()
            .filter(|name| !self.xattrs.contains_key(*name))
        {
            fremovexattr(staged, name.as_str())
                .map_err(|e| format!("cannot remove inherited extended metadata: {e}"))?;
        }
        for (name, value) in &self.xattrs {
            fsetxattr(staged, name.as_str(), value, XattrFlags::empty())
                .map_err(|e| format!("cannot preserve extended metadata: {e}"))?;
        }
        // Ownership changes can clear special bits; ACL writes can adjust mode.
        // Restore full mode last, then prove both ACL bytes and mode remained exact.
        fchmod(staged, Mode::from_bits_truncate(self.mode))
            .map_err(|e| format!("cannot preserve file permissions: {e}"))?;
        self.verify(staged)?;
        staged.sync_all().map_err(|e| e.to_string())
    }
    pub(crate) fn verify(&self, file: &File) -> Result<(), String> {
        self.validate()?;
        if &Self::capture(file)? != self {
            return Err("file metadata differs from retained intent".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::fs::PermissionsExt};
    fn regular() -> (tempfile::NamedTempFile, File) {
        let name = tempfile::NamedTempFile::new().unwrap();
        let file = name.reopen().unwrap();
        (name, file)
    }
    #[test]
    fn preserves_owner_group_full_mode_and_binary_user_attribute() {
        let (_original_path, mut original) = regular();
        original.write_all(b"original").unwrap();
        original
            .set_permissions(std::fs::Permissions::from_mode(0o2640))
            .unwrap();
        fsetxattr(
            &original,
            "user.fixture",
            b"binary\0\xff",
            XattrFlags::empty(),
        )
        .unwrap();
        let expected = FileMetadata::capture(&original).unwrap();
        assert_eq!(expected.mode, 0o2640);
        let (_staged_path, mut staged) = regular();
        staged.write_all(b"replacement").unwrap();
        fsetxattr(&staged, "user.inherited", b"remove", XattrFlags::empty()).unwrap();
        expected.apply_to(&staged).unwrap();
        assert_eq!(FileMetadata::capture(&staged).unwrap(), expected);
        staged
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .unwrap();
        assert!(expected.verify(&staged).is_err());
        assert_eq!(FileMetadata::capture(&original).unwrap(), expected);
    }
    #[test]
    fn rejects_unsupported_security_metadata_before_touching_staging() {
        let (_staged_path, staged) = regular();
        let before = FileMetadata::capture(&staged).unwrap();
        for name in [
            "security.capability",
            "trusted.overlay.opaque",
            "system.unknown",
            "",
        ] {
            let mut bad = before.clone();
            bad.mode = 0o777;
            bad.xattrs.insert(name.into(), vec![1]);
            assert!(bad.apply_to(&staged).unwrap_err().contains("unsupported"));
            assert_eq!(FileMetadata::capture(&staged).unwrap(), before);
        }
        let mut bad = before.clone();
        bad.xattrs
            .insert("user.huge".into(), vec![0; MAX_VALUES + 1]);
        assert!(bad.apply_to(&staged).is_err());
        assert_eq!(FileMetadata::capture(&staged).unwrap(), before);
    }
    #[test]
    fn preserves_posix_acl_and_mode_together() {
        // Linux POSIX ACL xattr v2: owner, named user, group, mask, other.
        let mut acl = 2u32.to_le_bytes().to_vec();
        for (tag, perm, id) in [
            (1u16, 6u16, u32::MAX),
            (2, 4, 424242),
            (4, 0, u32::MAX),
            (16, 4, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            acl.extend(tag.to_le_bytes());
            acl.extend(perm.to_le_bytes());
            acl.extend(id.to_le_bytes());
        }
        let (_original_path, original) = regular();
        fsetxattr(
            &original,
            "system.posix_acl_access",
            &acl,
            XattrFlags::empty(),
        )
        .unwrap();
        let expected = FileMetadata::capture(&original).unwrap();
        assert_eq!(expected.xattrs["system.posix_acl_access"], acl);
        let (_staged_path, staged) = regular();
        expected.apply_to(&staged).unwrap();
        assert_eq!(FileMetadata::capture(&staged).unwrap(), expected);
    }
    #[test]
    fn preserves_nonprimary_group_when_membership_allows_it() {
        let Some(group) = nix::unistd::getgroups()
            .unwrap()
            .into_iter()
            .find(|g| *g != nix::unistd::getegid())
        else {
            return;
        };
        let (_original_path, original) = regular();
        fchown(&original, None, Some(group)).unwrap();
        let expected = FileMetadata::capture(&original).unwrap();
        let (_staged_path, staged) = regular();
        assert_ne!(expected.gid, FileMetadata::capture(&staged).unwrap().gid);
        expected.apply_to(&staged).unwrap();
        assert_eq!(FileMetadata::capture(&staged).unwrap(), expected);
    }

    #[test]
    fn rejects_nonregular_or_hardlinked_metadata_sources() {
        let dir = tempfile::tempdir().unwrap();
        assert!(FileMetadata::capture(&File::open(dir.path()).unwrap()).is_err());
        let path = dir.path().join("file");
        let file = File::create(&path).unwrap();
        std::fs::hard_link(&path, dir.path().join("alias")).unwrap();
        assert!(FileMetadata::capture(&file).is_err());
    }
}
