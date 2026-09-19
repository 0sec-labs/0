#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::{process::Stdio, time::Duration};

#[tokio::test]
async fn review_history_lists_scope_and_holds_live_and_after_source_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/review_history_driver.py"
        ))
        .arg(env!("CARGO_BIN_EXE_0sec-native"))
        .arg(dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .expect("bounded review history fixture")
        .unwrap();
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn invalid_history_kind_or_missing_native_state_has_no_effects() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("absent/state.db");
    for kind in ["review", "all", "legacy"] {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .args([
                "--review-profiles",
                "/missing/reviews",
                "--providers",
                "/missing/providers",
                "history",
                "--kind",
                kind,
                "--format",
                "json",
            ])
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(!state.parent().unwrap().exists());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("provider configuration"));
    }
}
