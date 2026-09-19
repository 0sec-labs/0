#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};
use zero_protocol::source_archive::{ArchiveChunk, ArchiveFile, ArchiveManifest};
use zero_workspace_host::{Bundle, apply, hash, inspect_application, rollback};

type Files<'a> = &'a [(&'a str, &'a [u8])];
fn manifest(files: Files<'_>) -> ArchiveManifest {
    let mut files: Vec<_> = files
        .iter()
        .map(|(path, content)| ArchiveFile {
            path: (*path).into(),
            sha256: hash(content),
            bytes: content.len() as u64,
            executable: false,
            chunks: vec![ArchiveChunk {
                sha256: hash(content),
                bytes: content.len() as u64,
            }],
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let snapshot: Vec<_> = files
        .iter()
        .map(|f| json!({"path":f.path,"digest":f.sha256,"bytes":f.bytes}))
        .collect();
    ArchiveManifest {
        schema_version: 1,
        snapshot_sha256: hash(&serde_json::to_vec(&snapshot).unwrap()),
        files,
    }
}
fn state(file: Option<&ArchiveFile>) -> Value {
    file.map(|f| json!({"sha256":f.sha256,"bytes":f.bytes,"executable":f.executable}))
        .unwrap_or(Value::Null)
}
fn fixture(before: Files<'_>, after: Files<'_>) -> (tempfile::TempDir, tempfile::TempDir) {
    // Archives require a nonempty tree; this unchanged file carries no edit authority.
    let mut before_files = before.to_vec();
    let mut after_files = after.to_vec();
    before_files.push(("unchanged-control", b"control\n"));
    after_files.push(("unchanged-control", b"control\n"));
    let before = before_files.as_slice();
    let after = after_files.as_slice();
    let baseline = manifest(before);
    let current = manifest(after);
    let mut paths: Vec<_> = baseline
        .files
        .iter()
        .chain(&current.files)
        .map(|f| f.path.clone())
        .collect();
    paths.sort();
    paths.dedup();
    let mut changes = vec![];
    let mut allowed = vec![];
    for path in paths {
        let old = baseline.files.iter().find(|f| f.path == path);
        let new = current.files.iter().find(|f| f.path == path);
        if state(old) == state(new) {
            continue;
        }
        allowed
            .push(json!({"path":path,"baseline_sha256":old.map(|f|&f.sha256),"executable":false}));
        changes.push(json!({"path":path,"before":state(old),"after":state(new)}));
    }
    let value = json!({"schema_version":1,"assessment":"unverified","session_id":"recovery","operation_id":"actor","actor_status":"succeeded",
        "baseline_generation":hash(&baseline.canonical_bytes().unwrap()),"final_generation":hash(&current.canonical_bytes().unwrap()),
        "baseline":baseline,"current":current,"policy":{"paths":allowed},"changes":changes,
        "edit_and_test_receipts":[],"tests":[],"host_apply":"not_performed"});
    let export = tempfile::tempdir().unwrap();
    let checkout = tempfile::tempdir().unwrap();
    std::fs::create_dir(export.path().join("blobs")).unwrap();
    std::fs::write(
        export.path().join("bundle.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    let blobs: BTreeMap<_, _> = before
        .iter()
        .chain(after)
        .map(|(_, v)| (hash(v), *v))
        .collect();
    for (sha, bytes) in blobs {
        std::fs::write(export.path().join("blobs").join(&sha[7..]), bytes).unwrap();
    }
    for (path, bytes) in before {
        let path = checkout.path().join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    (export, checkout)
}

#[test]
fn add_delete_replace_interruption_at_each_entry_recovers_without_replay() {
    let before: Files<'_> = &[("b-delete", b"remove me\n"), ("c-replace", b"old\n")];
    let after: Files<'_> = &[("a-new/deeper/add", b"added\n"), ("c-replace", b"new\n")];
    for stop in 2..=4 {
        let (export, checkout) = fixture(before, after);
        let journal = checkout.path().join("journal");
        std::fs::write(checkout.path().join("unrelated"), b"user work").unwrap();
        let calls = std::cell::Cell::new(0);
        let result = apply(export.path(), checkout.path(), &journal, &|| {
            calls.set(calls.get() + 1);
            calls.get() == stop
        });
        assert!(result.is_err(), "stop {stop}");
        let observed = inspect_application(&journal).unwrap();
        assert_eq!(observed.phase, "interrupted");
        assert_eq!(observed.applied_files, stop - 2);
        // Retry inspects the journal without completing the remaining edits.
        assert_eq!(
            apply(export.path(), checkout.path(), &journal, &|| false)
                .unwrap()
                .applied_files,
            stop - 2
        );
        // Interrupt recovery after one entry; the next call resumes it.
        let calls = std::cell::Cell::new(0);
        assert!(
            rollback(&journal, &|| {
                calls.set(calls.get() + 1);
                calls.get() == 2
            })
            .is_err()
        );
        assert_eq!(
            inspect_application(&journal).unwrap().phase,
            "recovery_interrupted"
        );
        let restored = rollback(&journal, &|| false).unwrap();
        assert_eq!(restored.phase, "rolled_back");
        assert_eq!(restored.restored_files, 3);
        assert!(!checkout.path().join("a-new/deeper/add").exists());
        for (path, bytes) in before {
            assert_eq!(std::fs::read(checkout.path().join(path)).unwrap(), *bytes);
        }
        assert_eq!(
            std::fs::read(checkout.path().join("unrelated")).unwrap(),
            b"user work"
        );
        if stop > 2 {
            assert!(checkout.path().join("a-new/deeper").is_dir());
        }
        std::fs::write(checkout.path().join("c-replace"), b"later user work").unwrap();
        rollback(&journal, &|| false).unwrap();
        assert_eq!(
            std::fs::read(checkout.path().join("c-replace")).unwrap(),
            b"later user work"
        );
    }
}

#[test]
fn addition_installed_before_receipt_and_recovery_before_receipt_are_recoverable() {
    let (export, checkout) = fixture(&[], &[("new/deep/file", b"candidate\n")]);
    let journal = checkout.path().join("journal");
    apply(export.path(), checkout.path(), &journal, &|| false).unwrap();
    std::fs::remove_file(journal.join("complete")).unwrap();
    std::fs::remove_file(journal.join("applied-0")).unwrap();
    rollback(&journal, &|| false).unwrap();
    assert!(!checkout.path().join("new/deep/file").exists());
    assert!(checkout.path().join("new/deep").is_dir());
    assert_eq!(
        std::fs::read(journal.join("removed-0")).unwrap(),
        b"candidate\n"
    );
    std::fs::remove_file(journal.join("rolled-back")).unwrap();
    std::fs::remove_file(journal.join("restored-0")).unwrap();
    assert_eq!(rollback(&journal, &|| false).unwrap().phase, "rolled_back");
}

#[test]
fn deletion_before_receipt_restores_original_and_refuses_recreated_user_file() {
    for recreate in [false, true] {
        let (export, checkout) = fixture(&[("delete", b"original\n")], &[]);
        let journal = checkout.path().join("journal");
        apply(export.path(), checkout.path(), &journal, &|| false).unwrap();
        std::fs::remove_file(journal.join("complete")).unwrap();
        std::fs::remove_file(journal.join("applied-0")).unwrap();
        if recreate {
            std::fs::write(checkout.path().join("delete"), b"user file\n").unwrap();
            assert!(rollback(&journal, &|| false).is_err());
            assert_eq!(
                std::fs::read(checkout.path().join("delete")).unwrap(),
                b"user file\n"
            );
            assert_eq!(
                std::fs::read(journal.join("original-0")).unwrap(),
                b"original\n"
            );
        } else {
            assert_eq!(rollback(&journal, &|| false).unwrap().phase, "rolled_back");
            assert_eq!(
                std::fs::read(checkout.path().join("delete")).unwrap(),
                b"original\n"
            );
        }
    }
}

#[test]
#[ignore = "requires preserved actual Docker workspace export; set ZERO_WORKSPACE_HOST_REAL_EXPORT"]
fn actual_actor_export_reads_applies_and_recovers_without_success_claim() {
    let export = std::env::var_os("ZERO_WORKSPACE_HOST_REAL_EXPORT").expect("real export path");
    let bundle = Bundle::read(Path::new(&export)).unwrap();
    assert_eq!(bundle.changes.len(), 2);
    let checkout = tempfile::tempdir().unwrap();
    for file in &bundle.baseline.manifest.files {
        let path = checkout.path().join(&file.path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes: Vec<u8> = file
            .chunks
            .iter()
            .flat_map(|c| bundle.baseline.blobs[&c.sha256].iter().copied())
            .collect();
        std::fs::write(path, bytes).unwrap();
    }
    assert_eq!(
        std::fs::read(checkout.path().join("app.py")).unwrap(),
        b"print('old')\n"
    );
    let journal = checkout.path().join("journal");
    let status = apply(Path::new(&export), checkout.path(), &journal, &|| false).unwrap();
    assert_eq!(status.assessment, "unverified");
    assert_eq!(status.phase, "completed");
    assert_eq!(
        std::fs::read(checkout.path().join("app.py")).unwrap(),
        b"print('final')\n"
    );
    assert!(checkout.path().join("notes.txt").is_file());
    rollback(&journal, &|| false).unwrap();
    assert_eq!(
        std::fs::read(checkout.path().join("app.py")).unwrap(),
        b"print('old')\n"
    );
    assert!(!checkout.path().join("notes.txt").exists());
}

#[test]
fn unpublished_addition_preserves_file_created_by_user_after_interruption() {
    let (export, checkout) = fixture(&[], &[("new/file", b"candidate\n")]);
    let journal = checkout.path().join("journal");
    apply(export.path(), checkout.path(), &journal, &|| false).unwrap();
    // Restore the exact journal/checkout state before the candidate rename.
    std::fs::rename(checkout.path().join("new/file"), journal.join("new-0")).unwrap();
    std::fs::remove_file(journal.join("complete")).unwrap();
    std::fs::remove_file(journal.join("applied-0")).unwrap();
    std::fs::write(checkout.path().join("new/file"), b"later user file\n").unwrap();
    assert_eq!(rollback(&journal, &|| false).unwrap().phase, "rolled_back");
    assert_eq!(
        std::fs::read(checkout.path().join("new/file")).unwrap(),
        b"later user file\n"
    );
    assert_eq!(
        std::fs::read(journal.join("new-0")).unwrap(),
        b"candidate\n"
    );
}
