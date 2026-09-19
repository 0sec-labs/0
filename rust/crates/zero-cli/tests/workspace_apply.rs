#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    process::{Command, Output},
};
use zero_protocol::source_archive::{ArchiveChunk, ArchiveFile, ArchiveManifest};
use zero_workspace_host::hash;

fn manifest(bytes: &[u8]) -> ArchiveManifest {
    let sha = hash(bytes);
    ArchiveManifest {
        schema_version: 1,
        snapshot_sha256: hash(
            &serde_json::to_vec(&json!([{"path":"app.py","bytes":bytes.len(),"digest":sha}]))
                .unwrap(),
        ),
        files: vec![ArchiveFile {
            path: "app.py".into(),
            sha256: sha.clone(),
            bytes: bytes.len() as u64,
            executable: false,
            chunks: vec![ArchiveChunk {
                sha256: sha,
                bytes: bytes.len() as u64,
            }],
        }],
    }
}
fn fixture(dir: &Path) {
    std::fs::create_dir(dir.join("blobs")).unwrap();
    let before = manifest(b"before\n");
    let after = manifest(b"after\n");
    let bundle = json!({"schema_version":1,"assessment":"unverified","session_id":"original-session","operation_id":"original-actor","actor_status":"succeeded",
        "baseline_generation":hash(&before.canonical_bytes().unwrap()),"final_generation":hash(&after.canonical_bytes().unwrap()),
        "baseline":before,"current":after,"policy":{"paths":[{"path":"app.py","baseline_sha256":hash(b"before\n"),"executable":false}]},
        "changes":[{"path":"app.py","before":{"sha256":hash(b"before\n"),"bytes":7,"executable":false},"after":{"sha256":hash(b"after\n"),"bytes":6,"executable":false}}],
        "edit_and_test_receipts":[],"tests":[],"host_apply":"not_performed"});
    std::fs::write(
        dir.join("bundle.json"),
        serde_json::to_vec(&bundle).unwrap(),
    )
    .unwrap();
    let blobs: BTreeMap<_, _> = [
        (hash(b"before\n"), b"before\n".as_slice()),
        (hash(b"after\n"), b"after\n".as_slice()),
    ]
    .into();
    for (sha, bytes) in blobs {
        std::fs::write(dir.join("blobs").join(&sha[7..]), bytes).unwrap();
    }
}
fn cli(state: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(state)
        .args(["workspace-apply"])
        .args(args)
        .output()
        .unwrap()
}
fn report(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn offline_preview_apply_retry_status_and_rollback_preserve_user_files() {
    let export = tempfile::tempdir().unwrap();
    fixture(export.path());
    let checkout = tempfile::tempdir().unwrap();
    let root = checkout.path().to_str().unwrap();
    let bundle = export.path().to_str().unwrap();
    let target = checkout.path().join("app.py");
    std::fs::write(&target, b"before\n").unwrap();
    std::fs::write(checkout.path().join("user.txt"), b"private user edits").unwrap();
    let journal = checkout.path().join(".apply-journal");
    let journal_arg = journal.to_str().unwrap();
    let state = checkout.path().join("must-not-open.sqlite");
    let preview = report(cli(
        &state,
        &["preview", "--bundle", bundle, "--root", root],
    ));
    assert_eq!(preview["changes"].as_array().unwrap().len(), 1);
    assert!(!journal.exists());
    let applied = report(cli(
        &state,
        &[
            "run",
            "--bundle",
            bundle,
            "--root",
            root,
            "--journal",
            journal_arg,
        ],
    ));
    assert_eq!(applied["phase"], "completed");
    assert_eq!(std::fs::read(&target).unwrap(), b"after\n");
    report(cli(
        &state,
        &[
            "run",
            "--bundle",
            bundle,
            "--root",
            root,
            "--journal",
            journal_arg,
        ],
    ));
    report(cli(&state, &["status", "--journal", journal_arg]));
    drop(export); // Recovery needs neither original export nor provider/state.
    let restored = report(cli(&state, &["rollback", "--journal", journal_arg]));
    assert_eq!(restored["phase"], "rolled_back");
    assert_eq!(std::fs::read(&target).unwrap(), b"before\n");
    assert_eq!(
        std::fs::read(checkout.path().join("user.txt")).unwrap(),
        b"private user edits"
    );
    assert!(!state.exists());
}
#[test]
fn cli_conflict_fails_without_overwriting_or_opening_engine_state() {
    let export = tempfile::tempdir().unwrap();
    fixture(export.path());
    let checkout = tempfile::tempdir().unwrap();
    let state = checkout.path().join("state.sqlite");
    let journal = checkout.path().join("journal");
    std::fs::write(checkout.path().join("app.py"), b"newer user changes").unwrap();
    let output = cli(
        &state,
        &[
            "run",
            "--bundle",
            export.path().to_str().unwrap(),
            "--root",
            checkout.path().to_str().unwrap(),
            "--journal",
            journal.to_str().unwrap(),
        ],
    );
    assert!(!output.status.success());
    assert!(!journal.exists());
    assert!(!state.exists());
    assert_eq!(
        std::fs::read(checkout.path().join("app.py")).unwrap(),
        b"newer user changes"
    );
}
