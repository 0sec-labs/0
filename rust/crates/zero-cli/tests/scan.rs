#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::{process::Stdio, time::Duration};
#[path = "http/mod.rs"]
mod support;
#[tokio::test]
async fn standalone_scan_retains_real_claims_partial_budgets_signals_and_offline_retries() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        serde_json::to_vec(&support::policy("http://127.0.0.1:1/target/")).unwrap(),
    )
    .unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/scan_driver.py"))
        .arg(env!("CARGO_BIN_EXE_0sec-native"))
        .arg(dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(100), child.wait_with_output())
        .await
        .expect("bounded local scan fixture")
        .unwrap();
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
fn repository_targets_reject_before_state_or_provider_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    for target in [
        "https://github.com/owner/repo",
        "https://example.test/repo.git",
        "https://example.test/repo.git?ref=main",
    ] {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .args([
                "--scan-profiles",
                "/missing/scans",
                "--providers",
                "/missing/providers",
                "--http-profiles",
                "/missing/http",
                "scan",
                "--profile",
                "p",
                "--target",
                target,
            ])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2));
        assert!(
            String::from_utf8_lossy(&out.stderr)
                .contains("Repository targets require a source workflow")
        );
        assert!(!state.parent().unwrap().exists());
    }
}
#[test]
fn scan_reads_and_invalid_profiles_do_not_claim_owner_or_leak_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    for command in ["show", "list", "report"] {
        let mut p = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        p.arg("--state").arg(&state).args([
            "--scan-profiles",
            "/missing/scans",
            "--providers",
            "/missing/providers",
            "--http-profiles",
            "/missing/http",
            "scan",
            command,
        ]);
        if command != "list" {
            p.args(["--scan", "missing"]);
        }
        let out = p.output().unwrap();
        assert!(!out.status.success());
        assert!(!state.parent().unwrap().exists());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("profile configuration"));
    }
    let profiles = dir.path().join("profiles.json");
    std::fs::write(&profiles, r#"{"p":{"private":"SECRET_SCAN_SENTINEL"}}"#).unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .arg("--scan-profiles")
        .arg(&profiles)
        .args([
            "scan",
            "--profile",
            "p",
            "--target",
            "https://example.test",
            "--format",
            "json",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(!state.parent().unwrap().exists());
    assert!(!String::from_utf8_lossy(&out.stderr).contains("SECRET_SCAN_SENTINEL"));
}
