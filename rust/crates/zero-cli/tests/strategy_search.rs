#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::{process::Stdio, time::Duration};
#[path = "http/mod.rs"]
mod support;

#[tokio::test]
async fn executable_proposals_share_evaluation_account_and_cancel_without_replay() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("http-policy.json"),
        serde_json::to_vec(&support::policy("http://127.0.0.1:1/target/")).unwrap(),
    )
    .unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/strategy_search_driver.py"
        ))
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
        .expect("bounded local search executable fixture")
        .unwrap();
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn readonly_search_does_not_create_state_or_load_unrelated_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    for command in ["status", "candidates", "candidate", "report"] {
        let mut args = vec![
            "--providers",
            "/missing/provider",
            "--strategy-host",
            "/missing/host",
            "strategy",
            "search",
            command,
            "--campaign",
            "unknown",
        ];
        if command == "candidate" {
            args.extend(["--candidate", "unknown"]);
        }
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .args(args)
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(!state.parent().unwrap().exists());
        let error = String::from_utf8_lossy(&out.stderr);
        assert!(
            !error.contains("provider configuration") && !error.contains("host configuration"),
            "{error}"
        );
    }
}

#[test]
fn malformed_private_search_plan_fails_before_state_and_does_not_echo_values() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    let plan = dir.path().join("private.json");
    std::fs::write(&plan, r#"{"private_marker":"SEARCH_PRIVATE_SENTINEL"}"#).unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .args([
            "--providers",
            "/missing/providers",
            "strategy",
            "search",
            "create",
            "--command-id",
            "invalid",
            "--plan",
        ])
        .arg(&plan)
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(!state.parent().unwrap().exists());
    let error = String::from_utf8_lossy(&out.stderr);
    assert!(
        error.contains("Invalid private strategy search plan JSON"),
        "{error}"
    );
    assert!(!error.contains("SEARCH_PRIVATE_SENTINEL"));
}
