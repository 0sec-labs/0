#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::{process::Stdio, time::Duration};
#[path = "http/mod.rs"]
mod support;

#[tokio::test]
async fn executable_full_search_selects_final_and_imports_complete_history_offline() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("http-policy.json"),
        serde_json::to_vec(&support::policy("http://127.0.0.1:1/target/")).unwrap(),
    )
    .unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/strategy_search_final_driver.py"
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
fn full_search_evidence_reads_do_not_open_owner_or_unrelated_config() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    let registry = dir.path().join("missing/registry.db");
    for command in ["prepare", "show"] {
        let mut process = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        process
            .arg("--state")
            .arg(&state)
            .args([
                "--providers",
                "/missing/providers",
                "--strategy-host",
                "/missing/host",
                "strategy",
                "search",
                "eligibility",
                command,
                "--registry",
            ])
            .arg(&registry);
        if command == "prepare" {
            process.args(["--campaign", "unknown"]);
        } else {
            process
                .arg("--receipt")
                .arg(format!("sha256:{}", "0".repeat(64)));
        }
        let out = process.output().unwrap();
        assert!(!out.status.success());
        assert!(!state.parent().unwrap().exists());
        let error = String::from_utf8_lossy(&out.stderr);
        assert!(
            !error.contains("provider configuration") && !error.contains("host configuration"),
            "{error}"
        );
    }
}
