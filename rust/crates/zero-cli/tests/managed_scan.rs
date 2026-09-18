#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::{os::unix::fs::PermissionsExt, process::Stdio, time::Duration};
#[path = "http/mod.rs"]
mod support;

#[tokio::test]
async fn managed_http_publishes_bound_terminal_before_marker_and_retries_offline() {
    let dir = tempfile::tempdir().unwrap();
    let policy = zero_http::normalize_policy(
        serde_json::from_value(support::policy("http://127.0.0.1:1/target/")).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        serde_json::to_vec(&policy).unwrap(),
    )
    .unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/managed_scan_driver.py"
        ))
        .arg(env!("CARGO_BIN_EXE_0sec-native"))
        .arg(dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(100), child.wait_with_output())
        .await
        .expect("bounded managed fixture")
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn managed_help_and_rejected_grants_have_no_state_or_authority_effects() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    let grant = dir.path().join("grant.json");
    let report = dir.path().join("report.json");
    std::fs::write(&grant, "{\"secret\":\"PRIVATE_GRANT_SENTINEL\"}").unwrap();
    std::fs::set_permissions(&grant, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(&report, "existing report").unwrap();
    let invoke = |extra: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .arg("--providers")
            .arg("/missing/provider")
            .arg("managed-http")
            .arg("--grant")
            .arg(&grant)
            .arg("--report")
            .arg(&report)
            .args(extra)
            .output()
            .unwrap()
    };
    assert!(invoke(&["--help"]).status.success());
    let invalid = invoke(&[]);
    assert_eq!(invalid.status.code(), Some(2));
    assert!(!String::from_utf8_lossy(&invalid.stderr).contains("PRIVATE_GRANT_SENTINEL"));
    assert!(invalid.stdout.is_empty());
    assert_eq!(std::fs::read_to_string(&report).unwrap(), "existing report");
    assert!(!state.parent().unwrap().exists());
    std::fs::set_permissions(&grant, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(String::from_utf8_lossy(&invoke(&[]).stderr).contains("private"));
    assert!(
        String::from_utf8_lossy(&invoke(&["--hosted-model", "override"]).stderr)
            .contains("overrides")
    );
    let symlink = dir.path().join("link.json");
    std::os::unix::fs::symlink(&grant, &symlink).unwrap();
    let linked = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .arg("managed-http")
        .arg("--grant")
        .arg(&symlink)
        .arg("--report")
        .arg(&report)
        .output()
        .unwrap();
    assert_eq!(linked.status.code(), Some(2));
    assert!(linked.stdout.is_empty());
    assert!(!state.parent().unwrap().exists());
}
