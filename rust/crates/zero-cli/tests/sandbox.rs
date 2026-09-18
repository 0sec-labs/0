#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, process::Command};
use tempfile::TempDir;
fn cli(dir: &TempDir) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    c.arg("--state").arg(dir.path().join("state.db"));
    c
}
fn exercise(smolvm: bool) {
    if !smolvm {
        let uid = Command::new("id").arg("-u").output().unwrap();
        if String::from_utf8_lossy(&uid.stdout).trim() == "0" {
            eprintln!("Docker fixture requires executor qualified nonroot host");
            return;
        }
    }
    let dir = TempDir::new().unwrap();
    let docker = dir.path().join("docker");
    std::fs::write(
        &docker,
        include_bytes!("../../zero-executor/tests/fixtures/fake-docker.py"),
    )
    .unwrap();
    std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(dir.path().join("scenario.txt"), "echo").unwrap();
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("fixture"), b"fixture").unwrap();
    let pin = zero_executor::pin_snapshot(&source).unwrap();
    let backend = if smolvm {
        json!({"type":"smolvm","image_archive":dir.path().join("missing.tar"),"archive_digest":format!("sha256:{}","a".repeat(64)),"storage_gb":1})
    } else {
        json!({"type":"docker","image":"fixture:local"})
    };
    let request = json!({"execution_id":"sandbox-fixture","backend":backend,"snapshot":pin,"argv":["cat"],"stdin":"fixture input","timeout_ms":1000,"memory_mb":128,"cpus":1.0,"max_output_bytes":1024});
    let path = dir.path().join("request.json");
    std::fs::write(&path, request.to_string()).unwrap();
    let created = cli(&dir).args(["session", "create"]).output().unwrap();
    assert!(created.status.success());
    let created: Value = serde_json::from_slice(&created.stdout).unwrap();
    let session = created["session"]["id"].as_str().unwrap();
    let output = cli(&dir)
        .arg("--docker-bin")
        .arg(&docker)
        .arg("--smolvm-bin")
        .arg(dir.path().join("missing-smolvm"))
        .args([
            "sandbox",
            "--session",
            session,
            "--command-id",
            "shared-fixture",
            "--request",
        ])
        .arg(&path)
        .output()
        .unwrap();
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["type"], "sandbox", "{reply}");
    if smolvm {
        assert!(!output.status.success());
        assert_ne!(reply["operation"]["status"], "succeeded");
        assert!(
            !dir.path().join("calls.jsonl").exists(),
            "smolvm request fell back to Docker"
        );
    } else {
        assert!(output.status.success(), "{reply}");
        assert_eq!(reply["operation"]["status"], "succeeded");
        assert_eq!(reply["result"]["artifact"]["type"], "docker");
        assert_eq!(reply["result"]["stdout"], "Zml4dHVyZSBpbnB1dA==");
        assert_eq!(reply["result"]["cleanup"]["status"], "confirmed");
    }
}
#[test]
fn sandbox_explicit_docker_uses_shared_request() {
    exercise(false);
}
#[test]
fn sandbox_unavailable_smolvm_never_falls_back() {
    exercise(true);
}
#[test]
fn global_smolvm_flag_does_not_initialize_metadata_commands() {
    let dir = TempDir::new().unwrap();
    for action in ["schema", "--help", "--version"] {
        let output = cli(&dir)
            .args(["--smolvm-bin", "/nonexistent/smolvm", action])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!dir.path().join("state.db").exists());
        if action == "schema" {
            let schema: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert!(schema.to_string().contains("run_sandbox"));
        }
    }
}
