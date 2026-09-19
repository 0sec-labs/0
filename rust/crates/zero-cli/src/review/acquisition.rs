//! Explicit receipt selection and anchored bounded file reads before engine ownership.
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use std::{
    fs::File,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};
use zero_protocol::{
    SnapshotPin,
    source_acquisition::{AcquisitionReceiptInput, MAX_RECEIPT_BYTES, RepositoryReceipt},
};

pub(super) fn selector(path: &Path) -> Result<String, String> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    let mut normalized = PathBuf::from("/");
    for component in absolute.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(v) => normalized.push(v),
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("Receipt selector escapes root".into());
                }
            }
            _ => return Err("Invalid receipt selector".into()),
        }
    }
    if normalized == Path::new("/") {
        return Err("Receipt selector must name a file".into());
    }
    normalized
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "Receipt selector must be UTF-8".into())
}
fn anchored(path: &Path) -> Result<File, String> {
    if !path.is_absolute() {
        return Err("Receipt file path must be absolute".into());
    }
    let parts = path
        .components()
        .filter_map(|c| {
            if let Component::Normal(v) = c {
                Some(v)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let mut fd = open(
        "/",
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| e.to_string())?;
    for (i, part) in parts.iter().enumerate() {
        let mut flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK;
        if i + 1 < parts.len() {
            flags |= OFlag::O_DIRECTORY;
        }
        fd = openat(&fd, Path::new(part), flags, Mode::empty())
            .map_err(|e| format!("Cannot open receipt/source file safely: {e}"))?;
    }
    Ok(File::from(fd))
}
pub(super) fn load(
    selector: String,
    root: &Path,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<AcquisitionReceiptInput, String> {
    check()?;
    if Path::new(&selector).starts_with(root) {
        return Err("Acquisition receipt must be outside reviewed source".into());
    }
    let mut file = anchored(Path::new(&selector))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_RECEIPT_BYTES as u64 {
        return Err("Acquisition receipt must be a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 65536];
    loop {
        check()?;
        let n = file.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if bytes.len() + n > MAX_RECEIPT_BYTES {
            return Err("Acquisition receipt byte bound".into());
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    let receipt: RepositoryReceipt =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid acquisition receipt: {e}"))?;
    if receipt.canonical_bytes()? != bytes {
        return Err("Acquisition receipt must use exact canonical JSON bytes".into());
    }
    let input = AcquisitionReceiptInput {
        input_path: selector,
        receipt,
    };
    input.reference()?;
    check()?;
    Ok(input)
}
pub(super) fn validate_modes(
    input: &AcquisitionReceiptInput,
    pin: &SnapshotPin,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut executable = Vec::new();
    for entry in &pin.files {
        check()?;
        let file = anchored(&Path::new(&pin.root).join(&entry.path))?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() != entry.bytes {
            return Err("Captured acquisition source metadata differs".into());
        }
        if metadata.mode() & 0o111 != 0 {
            executable.push(entry.path.clone());
        }
    }
    if executable != input.receipt.executable_paths {
        return Err("Acquisition receipt executable modes differ from captured source".into());
    }
    check()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use zero_protocol::source_acquisition::GitSource;
    fn fixture() -> (tempfile::TempDir, AcquisitionReceiptInput, SnapshotPin) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("source");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("app.rs"), b"source").unwrap();
        std::fs::set_permissions(root.join("app.rs"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        let pin = zero_executor::pin_snapshot(&root).unwrap();
        let input = AcquisitionReceiptInput {
            input_path: dir.path().join("receipt.json").to_str().unwrap().into(),
            receipt: RepositoryReceipt {
                schema_version: 1,
                object_format: "sha1".into(),
                source: GitSource::Https {
                    url: "https://example.test/repo".into(),
                },
                requested_ref: "refs/heads/main".into(),
                commit_oid: "a".repeat(40),
                tree_oid: "b".repeat(40),
                snapshot: pin.clone(),
                executable_paths: vec![],
            },
        };
        std::fs::write(&input.input_path, input.receipt.canonical_bytes().unwrap()).unwrap();
        (dir, input, pin)
    }
    #[test]
    fn strict_receipt_read_and_capture_reject_content_root_modes_and_noncanonical_bytes() {
        let (_dir, input, pin) = fixture();
        let loaded = load(input.input_path.clone(), Path::new(&pin.root), &|| Ok(())).unwrap();
        loaded.validate_capture(&pin, &pin.root).unwrap();
        validate_modes(&loaded, &pin, &|| Ok(())).unwrap();
        assert!(loaded.validate_capture(&pin, "/other").is_err());
        let mut wrong = pin.clone();
        wrong.files[0].bytes += 1;
        assert!(loaded.validate_capture(&wrong, &pin.root).is_err());
        std::fs::set_permissions(
            Path::new(&pin.root).join("app.rs"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert!(validate_modes(&loaded, &pin, &|| Ok(())).is_err());
        let mut bytes = input.receipt.canonical_bytes().unwrap();
        bytes.push(b'\n');
        std::fs::write(&input.input_path, bytes).unwrap();
        assert!(load(input.input_path.clone(), Path::new(&pin.root), &|| Ok(())).is_err());
        std::fs::remove_file(&input.input_path).unwrap();
        symlink(Path::new(&pin.root).join("app.rs"), &input.input_path).unwrap();
        assert!(load(input.input_path.clone(), Path::new(&pin.root), &|| Ok(())).is_err());
    }
    #[test]
    fn receipt_bounds_cancellation_and_selector_do_not_open_source() {
        let (_dir, input, pin) = fixture();
        assert!(
            load(input.input_path.clone(), Path::new(&pin.root), &|| Err(
                "cancelled".into()
            ))
            .is_err()
        );
        std::fs::File::create(&input.input_path)
            .unwrap()
            .set_len(MAX_RECEIPT_BYTES as u64 + 1)
            .unwrap();
        assert!(load(input.input_path.clone(), Path::new(&pin.root), &|| Ok(())).is_err());
        assert_eq!(
            selector(Path::new("/abs/./missing/../receipt.json")).unwrap(),
            "/abs/receipt.json"
        );
        assert!(selector(Path::new("/../receipt.json")).is_err());
    }
}
