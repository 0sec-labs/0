use serde_json::json;
use std::process::Command;
use zero_store::{OperationStatus, Store};
#[test]
fn artifact_export_is_read_only_hash_checked_and_never_overwrites_destination() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("state.db");
    let mut store = Store::open(&db).unwrap();
    let session = store.create_session("source", 1).unwrap();
    let op = store
        .admit_command(&session.id, "review", &json!({}))
        .unwrap()
        .operation
        .id;
    store.begin_operation(&op, "owner").unwrap();
    let digest = store
        .retain_operation_artifact(&op, "owner", "source.bundle", b"private exact source\n")
        .unwrap();
    let before = std::fs::read(&db).unwrap();
    let cli = |kind: &str| {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state")
            .arg(&db)
            .arg("--providers")
            .arg(dir.path().join("absent-provider"))
            .arg("--harness-config")
            .arg(dir.path().join("absent-harness"))
            .args([
                "artifact",
                kind,
                "--session",
                &session.id,
                "--operation",
                &op,
            ]);
        c
    };
    let listed = cli("list").output().unwrap();
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(value["artifacts"]["source.bundle"], digest);
    assert!(!String::from_utf8_lossy(&listed.stdout).contains("private exact"));
    let output = dir.path().join("bundle.json");
    let export = cli("export")
        .args(["--name", "source.bundle", "--output"])
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        export.status.success(),
        "{}",
        String::from_utf8_lossy(&export.stderr)
    );
    assert_eq!(std::fs::read(&output).unwrap(), b"private exact source\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let repeated = cli("export")
        .args(["--name", "source.bundle", "--output"])
        .arg(&output)
        .output()
        .unwrap();
    assert_eq!(repeated.status.code(), Some(2));
    assert_eq!(std::fs::read(&output).unwrap(), b"private exact source\n");
    assert_eq!(std::fs::read(&db).unwrap(), before);
    assert_eq!(
        store.get_operation(&op).unwrap().status,
        OperationStatus::Running
    );
    let wrong = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&db)
        .args(["artifact", "list", "--session", "wrong", "--operation", &op])
        .output()
        .unwrap();
    assert_eq!(wrong.status.code(), Some(2));
    let missing = dir.path().join("missing.db");
    let result = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&missing)
        .args(["artifact", "list", "--session", "x", "--operation", "y"])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(2));
    assert!(!missing.exists());
}
