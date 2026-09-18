#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Real executable, pipe, HTTP and PTY fixtures; no external providers or containers.
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use zero_protocol::steering::AgentSteeringStatus;
async fn exercise(mode: &str) {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.db");
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("fixture"), "pinned offline\n").unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    let session = zero_store::Store::open(&state)
        .unwrap()
        .create_session("baseline", 100)
        .unwrap()
        .id;
    let profile = dir.path().join("request.json");
    std::fs::write(&profile,json!({"provider":"fixture","model":"fixture","instructions":"Fixed host authority","prompt":"do not submit profile placeholder","max_turns":3,"reservation_per_turn":10,"execution":{"execution_id":"fixture","image":"local:never-executed","snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}}).to_string()).unwrap();
    let config = dir.path().join("driver.json");
    std::fs::write(&config,json!({"mode":mode,"binary":env!("CARGO_BIN_EXE_0sec-native"),"root":dir.path(),"state":state,"session":session,"profile":profile}).to_string()).unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/steering_driver.py"
        ))
        .arg(config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(45), child.wait_with_output())
        .await
        .expect("bounded steering fixture")
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let operation = result["operation"].as_str().unwrap();
    let receipts = zero_engine::read_agent_steering(&state, &session, operation, 0, 50).unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(
        receipts[0].prompt,
        if mode == "tui" {
            "Direction λ\nsecond line"
        } else {
            "Direction λ"
        }
    );
    let store = zero_store::Store::open_read_only(&state).unwrap();
    let budget = store.budget(&session).unwrap();
    if mode == "cancel" {
        assert_eq!(receipts[0].status, AgentSteeringStatus::Undelivered);
        assert_eq!(
            store.get_operation(operation).unwrap().status,
            zero_protocol::OperationStatus::Unknown
        );
        assert_eq!(budget.reserved, 10);
        assert_eq!(budget.charged, 0);
        assert_eq!(result["requests"], 1);
    } else {
        assert_eq!(receipts[0].status, AgentSteeringStatus::Captured);
        assert!(receipts[0].inference_operation_id.is_some());
        assert_eq!(budget.reserved, 0);
        assert_eq!(budget.charged, if mode == "console" { 9 } else { 6 });
        assert_eq!(result["requests"], if mode == "console" { 3 } else { 2 });
    }
    let queue = store.queued_agents(&session, 0, 100).unwrap();
    assert_eq!(queue.len(), if mode == "console" { 2 } else { 1 });
    if mode == "console" {
        assert_eq!(queue[1].request.prompt, "/steer literal followup");
    }
    if mode == "tui" {
        assert_eq!(result["restored"], true);
    }
}
#[tokio::test]
async fn console_steering_captures_at_boundary_and_literal_escape_stays_queued() {
    exercise("console").await;
}
#[tokio::test]
async fn console_interrupt_preserves_undelivered_receipt_and_uncertain_usage() {
    exercise("cancel").await;
}
#[tokio::test]
async fn terminal_paste_is_inert_ctrl_t_targets_root_and_restores_terminal() {
    exercise("tui").await;
}
#[tokio::test]
async fn readonly_list_and_metadata_never_create_state_or_load_provider_authority() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    for args in [
        vec!["steer", "--help"],
        vec!["schema"],
        vec![
            "steer",
            "list",
            "--session",
            "missing",
            "--operation",
            "missing",
        ],
    ] {
        let result = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .arg("--providers")
            .arg(dir.path().join("absent-providers"))
            .arg("--harness-config")
            .arg(dir.path().join("absent-harness"))
            .args(&args)
            .output()
            .await
            .unwrap();
        assert_eq!(
            result.status.success(),
            args[0] == "schema" || args[1] == "--help"
        );
        assert!(!state.exists());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("absent-providers"));
    }
}
