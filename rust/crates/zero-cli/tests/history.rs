#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::process::Command;

#[path = "http/mod.rs"]
mod support;

#[tokio::test]
async fn history_and_timeline_export_real_completed_partial_and_held_scans_offline() {
    use std::{process::Stdio, time::Duration};
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        serde_json::to_vec(&support::policy("http://127.0.0.1:1/target/")).unwrap(),
    )
    .unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/history_driver.py"
        ))
        .arg(env!("CARGO_BIN_EXE_0sec-native"))
        .arg(dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
        .await
        .expect("bounded loopback history fixture")
        .unwrap();
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn history_help_bounds_and_missing_state_never_load_config_or_create_state() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("absent/state.db");
    for options in [
        vec!["history", "--help"],
        vec!["history"],
        vec!["history", "--limit", "0"],
        vec!["history", "--limit", "33"],
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .args([
                "--providers",
                "/missing/provider",
                "--harness-config",
                "/missing/harness",
            ])
            .args(&options)
            .output()
            .unwrap();
        assert_eq!(out.status.success(), options.contains(&"--help"));
        assert!(!state.parent().unwrap().exists());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("provider configuration"));
    }
}

#[test]
fn history_empty_database_is_readable_while_engine_owns_it() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.db");
    let engine = zero_engine::Engine::open(&state, None).unwrap();
    let before = std::fs::read(&state).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .args(["history", "--format", "json"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["page"]["scans"], serde_json::json!([]));
    assert!(value["page"]["next_before_sequence"].is_null());
    assert_eq!(std::fs::read(&state).unwrap(), before);
    drop(engine);
}
