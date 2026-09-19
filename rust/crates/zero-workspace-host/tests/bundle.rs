use serde_json::{Value, json};
use std::collections::BTreeMap;
use zero_protocol::source_archive::{ArchiveChunk, ArchiveFile, ArchiveManifest};
use zero_workspace_host::{Bundle, hash};

fn manifest(content: &[u8]) -> ArchiveManifest {
    let sha = hash(content);
    ArchiveManifest {
        schema_version: 1,
        snapshot_sha256: hash(
            &serde_json::to_vec(
                &json!([{"bytes":content.len(),"digest":sha,"path":"src/main.py"}]),
            )
            .unwrap(),
        ),
        files: vec![ArchiveFile {
            path: "src/main.py".into(),
            sha256: sha.clone(),
            bytes: content.len() as u64,
            executable: false,
            chunks: vec![ArchiveChunk {
                sha256: sha,
                bytes: content.len() as u64,
            }],
        }],
    }
}
fn fixture() -> (Value, BTreeMap<String, Vec<u8>>) {
    let baseline = manifest(b"before\n");
    let current = manifest(b"after\n");
    let value = json!({"schema_version":1,"assessment":"unverified","session_id":"session","operation_id":"actor","actor_status":"succeeded",
        "baseline_generation":hash(&baseline.canonical_bytes().unwrap()),"final_generation":hash(&current.canonical_bytes().unwrap()),
        "baseline":baseline,"current":current,
        "policy":{"paths":[{"path":"src/main.py","baseline_sha256":hash(b"before\n"),"executable":false}]},
        "changes":[{"path":"src/main.py","before":{"sha256":hash(b"before\n"),"bytes":7,"executable":false},
            "after":{"sha256":hash(b"after\n"),"bytes":6,"executable":false}}],
        "edit_and_test_receipts":[],"tests":[],"host_apply":"not_performed"});
    (
        value,
        [
            (hash(b"before\n"), b"before\n".to_vec()),
            (hash(b"after\n"), b"after\n".to_vec()),
        ]
        .into(),
    )
}
fn decode(value: &Value, blobs: &BTreeMap<String, Vec<u8>>) -> Result<Bundle, String> {
    Bundle::decode(&serde_json::to_vec(value).unwrap(), |sha, _| {
        blobs.get(sha).cloned().ok_or("missing blob".into())
    })
}
#[test]
fn reconstructs_both_archives_without_trusting_exported_source_tree() {
    let (value, blobs) = fixture();
    let bundle = decode(&value, &blobs).unwrap();
    assert_eq!(bundle.changes.len(), 1);
    assert_eq!(bundle.current.blobs[&hash(b"after\n")], b"after\n");
    assert_eq!(bundle.baseline.blobs[&hash(b"before\n")], b"before\n");
}
#[test]
fn rejects_invented_change_list_and_path_authority() {
    for field in ["changes", "policy", "actor_status", "assessment"] {
        let (mut value, blobs) = fixture();
        value[field] = match field {
            "changes" => json!([]),
            "policy" => json!({"paths":[]}),
            "actor_status" => json!("running"),
            _ => json!("verified"),
        };
        assert!(decode(&value, &blobs).is_err(), "{field}");
    }
}
#[test]
fn rejects_mode_drift_and_corrupted_raw_chunks() {
    let (mut value, mut blobs) = fixture();
    value["current"]["files"][0]["executable"] = json!(true);
    assert!(decode(&value, &blobs).is_err());
    let (value, _) = fixture();
    blobs.insert(hash(b"after\n"), b"changed".to_vec());
    assert!(decode(&value, &blobs).is_err());
}

#[cfg(unix)]
#[test]
fn preflight_preserves_unrelated_files_and_rejects_changed_content_or_modes() {
    use std::os::unix::fs::PermissionsExt;
    let (value, blobs) = fixture();
    let bundle = decode(&value, &blobs).unwrap();
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("src")).unwrap();
    let target = root.path().join("src/main.py");
    std::fs::write(&target, b"before\n").unwrap();
    std::fs::write(root.path().join("unrelated"), b"user changes").unwrap();
    let preview = zero_workspace_host::preflight(root.path(), &bundle).unwrap();
    assert_eq!(preview.changes.len(), 1);
    assert_eq!(std::fs::read(&target).unwrap(), b"before\n");
    assert_eq!(
        std::fs::read(root.path().join("unrelated")).unwrap(),
        b"user changes"
    );
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(zero_workspace_host::preflight(root.path(), &bundle).is_err());
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(&target, b"user's later edit\n").unwrap();
    assert!(zero_workspace_host::preflight(root.path(), &bundle).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"user's later edit\n");
}

#[cfg(unix)]
#[test]
fn preflight_rejects_symlink_parent_and_hardlinked_files() {
    use std::os::unix::fs::symlink;
    let (value, blobs) = fixture();
    let bundle = decode(&value, &blobs).unwrap();
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("main.py"), b"before\n").unwrap();
    symlink(outside.path(), root.path().join("src")).unwrap();
    assert!(zero_workspace_host::preflight(root.path(), &bundle).is_err());
    std::fs::remove_file(root.path().join("src")).unwrap();
    std::fs::create_dir(root.path().join("src")).unwrap();
    std::fs::hard_link(
        outside.path().join("main.py"),
        root.path().join("src/main.py"),
    )
    .unwrap();
    assert!(zero_workspace_host::preflight(root.path(), &bundle).is_err());
    assert_eq!(
        std::fs::read(outside.path().join("main.py")).unwrap(),
        b"before\n"
    );
}

#[cfg(unix)]
#[test]
fn filesystem_bundle_reader_uses_verified_blobs_and_rejects_symlink_substitution() {
    use std::os::unix::fs::symlink;
    let (value, blobs) = fixture();
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("blobs")).unwrap();
    std::fs::write(
        root.path().join("bundle.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    for (sha, bytes) in &blobs {
        std::fs::write(root.path().join("blobs").join(&sha[7..]), bytes).unwrap();
    }
    Bundle::read(root.path()).unwrap();
    let selected = root.path().join("blobs").join(&hash(b"after\n")[7..]);
    let other = root.path().join("untrusted");
    std::fs::rename(&selected, &other).unwrap();
    symlink(&other, &selected).unwrap();
    assert!(Bundle::read(root.path()).is_err());
}

#[cfg(target_os = "linux")]
fn exported_fixture() -> (tempfile::TempDir, tempfile::TempDir) {
    let (value, blobs) = fixture();
    let export = tempfile::tempdir().unwrap();
    std::fs::create_dir(export.path().join("blobs")).unwrap();
    std::fs::write(
        export.path().join("bundle.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    for (sha, bytes) in blobs {
        std::fs::write(export.path().join("blobs").join(&sha[7..]), bytes).unwrap();
    }
    let checkout = tempfile::tempdir().unwrap();
    std::fs::create_dir(checkout.path().join("src")).unwrap();
    std::fs::write(checkout.path().join("src/main.py"), b"before\n").unwrap();
    (export, checkout)
}

#[cfg(target_os = "linux")]
#[test]
fn journaled_apply_retains_original_and_retry_never_reapplies() {
    let (export, checkout) = exported_fixture();
    let journal = checkout.path().join(".0sec-application");
    let target = checkout.path().join("src/main.py");
    std::fs::write(checkout.path().join("other"), b"untouched").unwrap();
    let result =
        zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| false).unwrap();
    assert_eq!(result.phase, "completed");
    assert_eq!(std::fs::read(&target).unwrap(), b"after\n");
    assert_eq!(
        std::fs::read(journal.join("original-0")).unwrap(),
        b"before\n"
    );
    assert_eq!(
        std::fs::read(checkout.path().join("other")).unwrap(),
        b"untouched"
    );
    std::fs::write(&target, b"later user changes\n").unwrap();
    assert_eq!(
        zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| false)
            .unwrap()
            .phase,
        "completed"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"later user changes\n");
}

#[cfg(target_os = "linux")]
#[test]
fn conflict_and_initial_cancellation_do_not_create_journal_or_touch_checkout() {
    let (export, checkout) = exported_fixture();
    let journal = checkout.path().join(".0sec-application");
    let target = checkout.path().join("src/main.py");
    assert!(
        zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| true).is_err()
    );
    assert!(!journal.exists());
    std::fs::write(&target, b"user changes\n").unwrap();
    assert!(
        zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| false).is_err()
    );
    assert!(!journal.exists());
    assert_eq!(std::fs::read(&target).unwrap(), b"user changes\n");
}

#[cfg(target_os = "linux")]
#[test]
fn concurrent_permission_change_is_not_undone_by_staged_replacement() {
    use std::{cell::Cell, os::unix::fs::PermissionsExt};
    let (export, checkout) = exported_fixture();
    let journal = checkout.path().join(".0sec-application");
    let target = checkout.path().join("src/main.py");
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
    let calls = Cell::new(0);
    let result = zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| {
        calls.set(calls.get() + 1);
        if calls.get() == 2 {
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        false
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"before\n");
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!journal.join("original-0").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn recovery_restores_original_and_is_inert_after_later_user_edits() {
    let (export, checkout) = exported_fixture();
    let journal = checkout.path().join(".0sec-application");
    let target = checkout.path().join("src/main.py");
    zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| false).unwrap();
    // Simulate interruption after the install rename but before receipts.
    std::fs::remove_file(journal.join("complete")).unwrap();
    std::fs::remove_file(journal.join("applied-0")).unwrap();
    assert_eq!(
        zero_workspace_host::rollback(&journal, &|| false)
            .unwrap()
            .phase,
        "rolled_back"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"before\n");
    assert_eq!(
        std::fs::read(journal.join("removed-0")).unwrap(),
        b"after\n"
    );
    // A second recovery may be interrupted after the restore but before its marker.
    std::fs::remove_file(journal.join("rolled-back")).unwrap();
    std::fs::remove_file(journal.join("restored-0")).unwrap();
    zero_workspace_host::rollback(&journal, &|| false).unwrap();
    std::fs::write(&target, b"later user edit").unwrap();
    zero_workspace_host::rollback(&journal, &|| false).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"later user edit");
}

#[cfg(target_os = "linux")]
#[test]
fn recovery_refuses_user_edits_and_substituted_parent_even_with_same_file_inode() {
    for substitute_parent in [false, true] {
        let (export, checkout) = exported_fixture();
        let journal = checkout.path().join(".0sec-application");
        let target = checkout.path().join("src/main.py");
        zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| false).unwrap();
        if substitute_parent {
            std::fs::rename(checkout.path().join("src"), checkout.path().join("old-src")).unwrap();
            std::fs::create_dir(checkout.path().join("src")).unwrap();
            std::fs::rename(checkout.path().join("old-src/main.py"), &target).unwrap();
        } else {
            std::fs::write(&target, b"user changes").unwrap();
        }
        assert!(zero_workspace_host::rollback(&journal, &|| false).is_err());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            if substitute_parent {
                b"after\n".as_slice()
            } else {
                b"user changes".as_slice()
            }
        );
        assert_eq!(
            std::fs::read(journal.join("original-0")).unwrap(),
            b"before\n"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn recovery_can_be_cancelled_without_losing_originals() {
    let (export, checkout) = exported_fixture();
    let journal = checkout.path().join(".0sec-application");
    zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| false).unwrap();
    assert!(zero_workspace_host::rollback(&journal, &|| true).is_err());
    assert_eq!(
        std::fs::read(checkout.path().join("src/main.py")).unwrap(),
        b"after\n"
    );
    assert_eq!(
        std::fs::read(journal.join("original-0")).unwrap(),
        b"before\n"
    );
    zero_workspace_host::rollback(&journal, &|| false).unwrap();
    assert_eq!(
        std::fs::read(checkout.path().join("src/main.py")).unwrap(),
        b"before\n"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn recovery_preserves_later_user_deletion_of_installed_replacement() {
    let (export, checkout) = exported_fixture();
    let journal = checkout.path().join(".0sec-application");
    let target = checkout.path().join("src/main.py");
    zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| false).unwrap();
    std::fs::remove_file(&target).unwrap();
    assert!(zero_workspace_host::rollback(&journal, &|| false).is_err());
    assert!(!target.exists());
    assert_eq!(
        std::fs::read(journal.join("original-0")).unwrap(),
        b"before\n"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn recovery_resumes_torn_pending_markers_without_trusting_them_as_receipts() {
    use std::os::unix::fs::PermissionsExt;
    let (export, checkout) = exported_fixture();
    let journal = checkout.path().join(".0sec-application");
    zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| false).unwrap();
    for (name, partial) in [
        ("rollback-started", b"".as_slice()),
        ("restored-0", b"{".as_slice()),
        ("rolled-back", b"{}".as_slice()),
    ] {
        std::fs::write(journal.join(format!("pending-{name}")), partial).unwrap();
        std::fs::set_permissions(
            journal.join(format!("pending-{name}")),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    assert_eq!(
        zero_workspace_host::inspect_application(&journal)
            .unwrap()
            .phase,
        "completed"
    );
    assert_eq!(
        zero_workspace_host::rollback(&journal, &|| false)
            .unwrap()
            .phase,
        "rolled_back"
    );
    assert_eq!(
        std::fs::read(checkout.path().join("src/main.py")).unwrap(),
        b"before\n"
    );
    assert!(!journal.join("pending-restored-0").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn recovery_does_not_destroy_unexplained_pending_file_contents() {
    use std::os::unix::fs::PermissionsExt;
    let (export, checkout) = exported_fixture();
    let journal = checkout.path().join(".0sec-application");
    zero_workspace_host::apply(export.path(), checkout.path(), &journal, &|| false).unwrap();
    let pending = journal.join("pending-rollback-started");
    std::fs::write(&pending, b"xyz").unwrap();
    std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(zero_workspace_host::rollback(&journal, &|| false).is_err());
    assert_eq!(std::fs::read(&pending).unwrap(), b"xyz");
    assert_eq!(
        std::fs::read(checkout.path().join("src/main.py")).unwrap(),
        b"after\n"
    );
}
