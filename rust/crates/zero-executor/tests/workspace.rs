#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]
use std::{
    cell::{Cell, RefCell},
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
};
use zero_executor::{
    SnapshotLimits, capture_workspace, pin_snapshot, stage_snapshot, verify_snapshot,
};
use zero_protocol::workspace::WorkspaceSelectionPolicy;

fn limits() -> SnapshotLimits {
    SnapshotLimits {
        max_files: 4096,
        max_bytes: 64 * 1024 * 1024,
    }
}
fn native(path: &str) -> WorkspaceSelectionPolicy {
    WorkspaceSelectionPolicy::ExcludeNativeState {
        state_relative_path: path.into(),
    }
}
fn paths(pin: &zero_protocol::SnapshotPin) -> Vec<&str> {
    pin.files.iter().map(|f| f.path.as_str()).collect()
}

#[test]
fn repeated_native_state_changes_keep_selected_source_identity_and_all_adjacent_files() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".0sec/native")).unwrap();
    fs::create_dir_all(dir.path().join(".git")).unwrap();
    for (path, bytes) in [
        ("app.rs", "dirty original source"),
        (".0sec/native/notes.rs", "keep notes"),
        (".0sec/native/state.db.backup", "explicit backup"),
        (".git/config", "no implicit gitignore"),
    ] {
        fs::write(dir.path().join(path), bytes).unwrap();
    }
    let policy = native(".0sec/native/state.db");
    let (first, pin, receipt) =
        capture_workspace(dir.path(), &policy, limits(), &|| Ok(())).unwrap();
    assert_eq!(receipt.original_root, dir.path().to_str().unwrap());
    assert_ne!(receipt.original_root, pin.root);
    assert_eq!(receipt.exclusions, policy.exclusions().unwrap());
    assert_eq!(receipt.file_count, 4);
    assert_eq!(
        receipt.bytes,
        pin.files.iter().map(|f| f.bytes).sum::<u64>()
    );
    assert_eq!(
        paths(&pin),
        vec![
            ".0sec/native/notes.rs",
            ".0sec/native/state.db.backup",
            ".git/config",
            "app.rs"
        ]
    );
    for (index, path) in policy.exclusions().unwrap().iter().enumerate() {
        let file = fs::File::create(dir.path().join(path)).unwrap();
        // A sparse database larger than the entire selected-source allowance
        // must be skipped before content reads or selected byte accounting.
        file.set_len(128 * 1024 * 1024 + index as u64).unwrap();
    }
    let (second, again, again_receipt) = capture_workspace(
        dir.path(),
        &policy,
        SnapshotLimits {
            max_files: 4,
            max_bytes: receipt.bytes,
        },
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(again.digest, pin.digest);
    assert_eq!(again_receipt.exclusions, receipt.exclusions);
    assert_eq!(again_receipt.bytes, receipt.bytes);
    assert_eq!(
        fs::read_to_string(dir.path().join("app.rs")).unwrap(),
        "dirty original source"
    );
    verify_snapshot(&again, &|| Ok(())).unwrap();
    // Ordinary verification still checks every staged entry, with no ignores.
    fs::write(second.source().join("unexpected"), b"not selected").unwrap();
    assert!(verify_snapshot(&again, &|| Ok(())).is_err());
    fs::write(dir.path().join("app.rs"), b"later local edit").unwrap();
    fs::write(dir.path().join("untracked.rs"), b"included untracked").unwrap();
    assert_eq!(
        fs::read_to_string(first.source().join("app.rs")).unwrap(),
        "dirty original source"
    );
    let (third, changed, _) = capture_workspace(dir.path(), &policy, limits(), &|| Ok(())).unwrap();
    assert_ne!(changed.digest, pin.digest);
    assert!(paths(&changed).contains(&"untracked.rs"));
    assert_eq!(
        fs::read_to_string(dir.path().join("app.rs")).unwrap(),
        "later local edit"
    );
    first.remove().unwrap();
    second.remove().unwrap();
    third.remove().unwrap();
}

#[test]
fn custom_native_names_do_not_hide_default_names_and_full_tree_has_no_implicit_rules() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("runtime")).unwrap();
    fs::write(dir.path().join("runtime/custom.sqlite"), b"control").unwrap();
    fs::write(dir.path().join("runtime/custom.sqlite-wal"), b"control wal").unwrap();
    fs::write(dir.path().join("runtime/custom.sqlite.extra"), b"source").unwrap();
    fs::write(dir.path().join("state.db"), b"not configured state").unwrap();
    let (stage, pin, receipt) = capture_workspace(
        dir.path(),
        &native("runtime/custom.sqlite"),
        limits(),
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(paths(&pin), vec!["runtime/custom.sqlite.extra", "state.db"]);
    receipt.validate_pin(&pin).unwrap();
    stage.remove().unwrap();
    let full = pin_snapshot(dir.path()).unwrap();
    let (stage, pin, receipt) = capture_workspace(
        dir.path(),
        &WorkspaceSelectionPolicy::FullTree,
        limits(),
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(pin.digest, full.digest);
    assert!(receipt.exclusions.is_empty());
    // An external state path is represented by FullTree, not an outside-root rule.
    assert!(native("../external.db").exclusions().is_err());
    let copied = stage_snapshot(&pin, &|| Ok(())).unwrap();
    copied.remove().unwrap();
    stage.remove().unwrap();
}

#[test]
fn native_exclusions_reject_directories_links_and_special_entries_instead_of_pruning() {
    for name in native("state.db").exclusions().unwrap() {
        for kind in 0..4 {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join("app.rs"), b"source").unwrap();
            let entry = dir.path().join(&name);
            match kind {
                0 => {
                    fs::create_dir(&entry).unwrap();
                    fs::write(entry.join("must-not-hide.rs"), b"source").unwrap();
                }
                1 => symlink(dir.path().join("app.rs"), &entry).unwrap(),
                2 => fs::hard_link(dir.path().join("app.rs"), &entry).unwrap(),
                _ => nix::unistd::mkfifo(&entry, nix::sys::stat::Mode::from_bits_truncate(0o600))
                    .unwrap(),
            }
            assert!(
                capture_workspace(dir.path(), &native("state.db"), limits(), &|| Ok(())).is_err(),
                "{name} kind {kind}"
            );
        }
    }
}

#[test]
fn selected_capture_preserves_executable_mode_and_enforces_selected_file_byte_limits() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("run.sh"), b"#!/bin/sh\ntrue\n").unwrap();
    fs::set_permissions(dir.path().join("run.sh"), fs::Permissions::from_mode(0o751)).unwrap();
    let size = fs::metadata(dir.path().join("run.sh")).unwrap().len();
    let (stage, pin, _) = capture_workspace(
        dir.path(),
        &WorkspaceSelectionPolicy::FullTree,
        SnapshotLimits {
            max_files: 1,
            max_bytes: size,
        },
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(pin.files.len(), 1);
    assert_eq!(
        fs::metadata(stage.source().join("run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o555
    );
    stage.remove().unwrap();
    assert!(
        capture_workspace(
            dir.path(),
            &WorkspaceSelectionPolicy::FullTree,
            SnapshotLimits {
                max_files: 1,
                max_bytes: size - 1
            },
            &|| Ok(())
        )
        .is_err()
    );
    fs::write(dir.path().join("empty"), []).unwrap();
    assert!(
        capture_workspace(
            dir.path(),
            &WorkspaceSelectionPolicy::FullTree,
            SnapshotLimits {
                max_files: 1,
                max_bytes: size
            },
            &|| Ok(())
        )
        .is_err()
    );
    for invalid in [
        SnapshotLimits {
            max_files: 0,
            max_bytes: 1,
        },
        SnapshotLimits {
            max_files: 1,
            max_bytes: 0,
        },
        SnapshotLimits {
            max_files: 4097,
            max_bytes: 1,
        },
        SnapshotLimits {
            max_files: 1,
            max_bytes: 64 * 1024 * 1024 + 1,
        },
    ] {
        assert!(
            capture_workspace(
                Path::new("/missing-workspace"),
                &WorkspaceSelectionPolicy::FullTree,
                invalid,
                &|| Ok(())
            )
            .is_err()
        );
    }
}

fn partial_private(name: &str) -> Option<PathBuf> {
    for entry in fs::read_dir("/proc/self/fd").ok()? {
        let entry = entry.ok()?;
        let Ok(path) = fs::read_link(entry.path()) else {
            continue;
        };
        if path.file_name() != Some(std::ffi::OsStr::new(name)) {
            continue;
        }
        let root = path.parent()?.parent()?;
        if !root.file_name()?.to_str()?.starts_with("0sec-workspace-") {
            continue;
        }
        let info =
            fs::read_to_string(Path::new("/proc/self/fdinfo").join(entry.file_name())).ok()?;
        let position: u64 = info.lines().find_map(|line| {
            line.strip_prefix("pos:")
                .and_then(|v| v.trim().parse().ok())
        })?;
        if position >= 65536 {
            return Some(root.to_path_buf());
        }
    }
    None
}
#[test]
fn cancelled_selected_copy_is_removed_and_original_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let name = format!("workspace-cancel-{}", uuid::Uuid::new_v4());
    let bytes = vec![7; 256 * 1024];
    fs::write(dir.path().join(&name), &bytes).unwrap();
    let observed = RefCell::new(None);
    let result = capture_workspace(
        dir.path(),
        &WorkspaceSelectionPolicy::FullTree,
        limits(),
        &|| {
            if let Some(path) = partial_private(&name) {
                *observed.borrow_mut() = Some(path);
                Err("cancelled during write".into())
            } else {
                Ok(())
            }
        },
    );
    assert!(matches!(result,Err(e) if e == "cancelled during write"));
    assert!(!observed.borrow().as_ref().unwrap().exists());
    assert_eq!(fs::read(dir.path().join(&name)).unwrap(), bytes);
    let count = Cell::new(0usize);
    let (stage, _, _) = capture_workspace(
        dir.path(),
        &WorkspaceSelectionPolicy::FullTree,
        limits(),
        &|| {
            count.set(count.get() + 1);
            Ok(())
        },
    )
    .unwrap();
    stage.remove().unwrap();
    let total = count.get();
    count.set(0);
    let result = capture_workspace(
        dir.path(),
        &WorkspaceSelectionPolicy::FullTree,
        limits(),
        &|| {
            count.set(count.get() + 1);
            if count.get() == total {
                Err("cancelled at finish".into())
            } else {
                Ok(())
            }
        },
    );
    assert!(matches!(result,Err(e) if e == "cancelled at finish"));
    assert!(
        capture_workspace(
            dir.path(),
            &WorkspaceSelectionPolicy::FullTree,
            limits(),
            &|| Err("cancelled before traversal".into())
        )
        .is_err()
    );
}

#[test]
fn a_workspace_containing_only_control_state_never_becomes_an_empty_successful_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("state.db"), b"control state only").unwrap();
    assert!(capture_workspace(dir.path(), &native("state.db"), limits(), &|| Ok(())).is_err());
    let (stage, pin, receipt) = capture_workspace(
        dir.path(),
        &WorkspaceSelectionPolicy::FullTree,
        limits(),
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(paths(&pin), vec!["state.db"]);
    assert!(receipt.exclusions.is_empty());
    stage.remove().unwrap();
}
