#![cfg(unix)]
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    process::Command,
    time::{Duration, Instant},
};
use tempfile::TempDir;
fn executable(dir: &TempDir, name: &str, script: &str) -> std::path::PathBuf {
    let path = dir.path().join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}
fn command(dir: &TempDir) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    c.arg("--state").arg(dir.path().join("absent/state.db"));
    c
}
fn check<'a>(report: &'a Value, name: &str) -> &'a str {
    report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()["status"]
        .as_str()
        .unwrap()
}
#[test]
fn doctor_checks_prerequisites_without_database_or_secret_output() {
    let dir = TempDir::new().unwrap();
    let docker = executable(&dir, "docker", "echo fixture-secret; exit 0");
    let smolvm = executable(&dir, "smolvm", "echo 'smolvm 1.14.6'");
    let profile = dir.path().join("profile.json");
    std::fs::write(&profile,json!({"fixture":{"url":"http://127.0.0.1:9/responses","api_key_env":"DOCTOR_FIXTURE_SECRET","rates":{"input":1,"cached_input":0,"output":1},"timeout_ms":1000,"max_response_bytes":8192}}).to_string()).unwrap();
    let output = command(&dir)
        .arg("--providers")
        .arg(&profile)
        .arg("--docker-bin")
        .arg(docker)
        .args(["doctor", "--smolvm-bin"])
        .arg(smolvm)
        .env("DOCTOR_FIXTURE_SECRET", "fixture-secret")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-secret"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("fixture-secret"));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(check(&report, "providers"), "ok");
    assert_eq!(check(&report, "smolvm_version"), "ok");
    assert_eq!(check(&report, "docker_server"), "ok");
    assert!(!dir.path().join("absent").exists());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3);
}
#[test]
fn doctor_timeout_and_bad_credentials_are_nonzero_and_redacted() {
    let dir = TempDir::new().unwrap();
    let docker = executable(&dir, "docker", "exec sleep 10");
    let smolvm = executable(&dir, "smolvm", "echo fixture-secret >&2; exit 1");
    let profile = dir.path().join("profile.json");
    std::fs::write(&profile, b"{\"fixture-secret\": malformed").unwrap();
    let start = Instant::now();
    let output = command(&dir)
        .arg("--providers")
        .arg(profile)
        .arg("--docker-bin")
        .arg(docker)
        .args(["doctor", "--timeout-ms", "50", "--smolvm-bin"])
        .arg(smolvm)
        .output()
        .unwrap();
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(output.status.code(), Some(1));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-secret"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("fixture-secret"));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(check(&report, "providers"), "error");
    assert_eq!(check(&report, "docker_client"), "unavailable");
    assert!(!dir.path().join("absent").exists());
}
#[test]
fn doctor_help_never_reads_provider_config() {
    let dir = TempDir::new().unwrap();
    let output = command(&dir)
        .args(["--providers", "/nonexistent/secret", "doctor", "--help"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(!dir.path().join("absent").exists());
}
