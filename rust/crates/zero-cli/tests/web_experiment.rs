#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "http/mod.rs"]
mod support;
use serde_json::json;
use std::{process::Stdio, time::Duration};
#[tokio::test]
async fn adaptive_predictions_revise_after_feedback_and_export_offline() {
    exercise("cli").await;
}
#[tokio::test]
async fn terminal_browses_experiment_predictions_measurements_and_evidence_without_dispatch() {
    exercise("pty").await;
}
async fn exercise(mode: &str) {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("driver.json");
    std::fs::write(&config,json!({"mode":mode,"binary":env!("CARGO_BIN_EXE_0sec-native"),"root":dir.path(),"policy":support::policy("http://127.0.0.1:1/target/")}).to_string()).unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/web_experiment_driver.py"
        ))
        .arg(config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(70), child.wait_with_output())
        .await
        .expect("local experiment deadline")
        .unwrap();
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
