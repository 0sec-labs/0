use zero_protocol::{
    source_archive::SourceArchive,
    workspace_edit::{EditablePath, WorkspaceCall, WorkspacePolicy},
};
use zero_workspace::{bytes, generation, observe, propose, validate_baseline};
fn fixture() -> (SourceArchive, WorkspacePolicy) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("app.py"),
        "def value():\n    return 'old'\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("untouched.txt"), "stable\n").unwrap();
    let pin = zero_executor::pin_snapshot(dir.path()).unwrap();
    let archive = zero_executor::capture_source_archive(&pin, &|| Ok(())).unwrap();
    let policy = WorkspacePolicy {
        paths: vec![
            EditablePath {
                path: "app.py".into(),
                baseline_sha256: Some(
                    archive
                        .manifest
                        .files
                        .iter()
                        .find(|f| f.path == "app.py")
                        .unwrap()
                        .sha256
                        .clone(),
                ),
                executable: false,
            },
            EditablePath {
                path: "nested/new.py".into(),
                baseline_sha256: None,
                executable: true,
            },
        ],
        max_edits: 16,
        max_changed_bytes: 65536,
        max_test_runs: 8,
        deadline_ms: 10000,
    };
    (archive, policy)
}
#[test]
fn iterative_replace_then_patch_changes_exact_generation_preserving_other_files_and_modes() {
    let (base, policy) = fixture();
    validate_baseline(&base, &policy).unwrap();
    let first = propose(
        &base,
        &policy,
        &WorkspaceCall::Replace {
            path: "app.py".into(),
            expected_generation: generation(&base).unwrap(),
            old_string: "'old'".into(),
            new_string: "'new'".into(),
            replace_all: false,
        },
    )
    .unwrap();
    assert_eq!(
        bytes(&first.archive, "app.py").unwrap(),
        b"def value():\n    return 'new'\n"
    );
    let second=propose(&first.archive,&policy,&WorkspaceCall::Patch{expected_generation:generation(&first.archive).unwrap(),patch:"*** Begin Patch\n*** Update File: app.py\n@@ def value\n def value():\n-    return 'new'\n+    return 'final'\n*** Add File: nested/new.py\n+print('added')\n*** End Patch\n".into()}).unwrap();
    assert_eq!(second.receipt.changes.len(), 2);
    assert_eq!(
        bytes(&second.archive, "untouched.txt").unwrap(),
        b"stable\n"
    );
    assert!(
        second
            .archive
            .manifest
            .files
            .iter()
            .find(|f| f.path == "nested/new.py")
            .unwrap()
            .executable
    );
    assert_eq!(
        bytes(&base, "app.py").unwrap(),
        b"def value():\n    return 'old'\n"
    );
    assert_ne!(
        first.receipt.before_generation,
        first.receipt.after_generation
    );
}
#[test]
fn malformed_later_patch_operation_never_partially_updates_generation() {
    let (base, policy) = fixture();
    let before = base.clone();
    let call=WorkspaceCall::Patch{expected_generation:generation(&base).unwrap(),patch:"*** Begin Patch\n*** Replace File: app.py\n+changed\n*** Delete File: forbidden\n*** End Patch\n".into()};
    assert!(propose(&base, &policy, &call).is_err());
    assert_eq!(base, before);
}
#[test]
fn stale_generation_missing_preimage_unauthorized_path_and_ambiguous_replace_reject() {
    let (base, mut policy) = fixture();
    let mut wrong = policy.clone();
    wrong.paths[0].baseline_sha256 = None;
    assert!(validate_baseline(&base, &wrong).is_err());
    wrong = policy.clone();
    wrong.paths[0].executable = true;
    assert!(validate_baseline(&base, &wrong).is_err());
    let call = WorkspaceCall::Write {
        path: "untouched.txt".into(),
        expected_generation: generation(&base).unwrap(),
        content: "bad".into(),
    };
    assert!(propose(&base, &policy, &call).is_err());
    let write = WorkspaceCall::Write {
        path: "app.py".into(),
        expected_generation: generation(&base).unwrap(),
        content: "same same".into(),
    };
    let next = propose(&base, &policy, &write).unwrap();
    assert!(propose(&next.archive, &policy, &write).is_err());
    let replace = WorkspaceCall::Replace {
        path: "app.py".into(),
        expected_generation: generation(&next.archive).unwrap(),
        old_string: "same".into(),
        new_string: "other".into(),
        replace_all: false,
    };
    assert!(propose(&next.archive, &policy, &replace).is_err());
    policy.paths[0].path = "../escape".into();
    assert!(policy.validate().is_err());
}
#[test]
fn read_search_and_list_are_bounded_and_report_current_identity() {
    let (base, policy) = fixture();
    let call = WorkspaceCall::Write {
        path: "app.py".into(),
        expected_generation: generation(&base).unwrap(),
        content: "ééé\nvalue value\n".into(),
    };
    let next = propose(&base, &policy, &call).unwrap();
    let page = observe(
        &next.archive,
        &WorkspaceCall::Read {
            path: "app.py".into(),
            offset: 0,
            max_bytes: 3,
        },
    )
    .unwrap();
    assert_eq!(page["text"], "é");
    assert_eq!(page["next_offset"], 2);
    assert_eq!(page["truncated"], true);
    assert!(
        observe(
            &next.archive,
            &WorkspaceCall::Read {
                path: "app.py".into(),
                offset: 1,
                max_bytes: 3
            }
        )
        .is_err()
    );
    let search = observe(
        &next.archive,
        &WorkspaceCall::Search {
            query: "value".into(),
            prefix: "".into(),
            max_results: 1,
        },
    )
    .unwrap();
    assert_eq!(search["results"].as_array().unwrap().len(), 1);
    let list = observe(
        &next.archive,
        &WorkspaceCall::List {
            prefix: "".into(),
            after: "".into(),
            max_results: 1,
        },
    )
    .unwrap();
    assert_eq!(list["truncated"], true);
    assert_eq!(list["generation"], page["generation"]);
}
#[test]
fn generation_covers_executable_mode_and_content() {
    let (base, _) = fixture();
    let mut other = base.clone();
    other.manifest.files[0].executable = !other.manifest.files[0].executable;
    other.validate().unwrap();
    assert_eq!(
        base.manifest.snapshot_sha256,
        other.manifest.snapshot_sha256
    );
    assert_ne!(generation(&base).unwrap(), generation(&other).unwrap());
}
