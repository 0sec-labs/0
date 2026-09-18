#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::{process::Stdio, time::Duration};

#[tokio::test]
async fn executable_campaign_lanes_live_inspection_offline_reports_and_joined_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/strategy_driver.py"
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
        .expect("bounded local strategy executable fixture")
        .unwrap();
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn readonly_strategy_missing_state_never_creates_or_loads_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    for command in ["status", "runs", "report", "dev-feedback"] {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .args([
                "--providers",
                "/missing/providers",
                "strategy",
                command,
                "--campaign",
                "unknown",
            ])
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(!state.parent().unwrap().exists());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("provider configuration"));
    }
}

#[test]
fn malformed_private_plan_is_rejected_before_configuration_or_state_and_not_echoed() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    let plan = dir.path().join("private.json");
    std::fs::write(&plan, r#"{"private_marker":"do-not-echo-this-value"}"#).unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .args([
            "--providers",
            "/missing/providers",
            "strategy",
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
    let diagnostic = String::from_utf8_lossy(&out.stderr);
    assert!(diagnostic.contains("Invalid private strategy plan JSON"));
    assert!(!diagnostic.contains("do-not-echo-this-value"));
}
