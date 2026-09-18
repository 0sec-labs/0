#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use zero_protocol::approvals::ToolApprovalStatus;
async fn fixture(mode: &str) {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.db");
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("fixture"), "untouched\n").unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    let session = zero_store::Store::open(&state)
        .unwrap()
        .create_session("baseline", 100)
        .unwrap()
        .id;
    let profile = dir.path().join("profile.json");
    std::fs::write(&profile,json!({"provider":"fixture","model":"fixture","instructions":"Fixed approval authority","prompt":"unused profile prompt","tool_approval_policy":{"require_approval":["execute_snapshot"]},"max_turns":2,"reservation_per_turn":10,"execution":{"execution_id":"fixture","image":format!("sha256:{}","a".repeat(64)),"snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}}).to_string()).unwrap();
    let config = dir.path().join("driver.json");
    std::fs::write(&config,json!({"mode":mode,"binary":env!("CARGO_BIN_EXE_0sec-native"),"root":dir.path(),"state":state,"session":session,"profile":profile}).to_string()).unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/approvals_driver.py"
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
        .expect("bounded approval fixture")
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    let records = zero_engine::read_tool_approvals(&state, &session, None, 0, 20).unwrap();
    assert_eq!(records.len(), 1);
    let expected = if mode.starts_with("eof") || mode == "tui_cancel" {
        ToolApprovalStatus::Cancelled
    } else if mode == "deny" || mode == "tui_deny" {
        ToolApprovalStatus::Denied
    } else {
        ToolApprovalStatus::Consumed
    };
    assert_eq!(records[0].status, expected);
    if expected == ToolApprovalStatus::Consumed {
        assert!(records[0].consumption.is_some());
        assert_eq!(
            records[0].effect_status,
            Some(zero_protocol::OperationStatus::Succeeded)
        );
    } else {
        assert!(records[0].consumption.is_none());
    }
    let store = zero_store::Store::open_read_only(&state).unwrap();
    let budget = store.budget(&session).unwrap();
    assert_eq!(budget.reserved, 0);
    assert_eq!(
        budget.charged,
        if expected == ToolApprovalStatus::Cancelled {
            3
        } else {
            6
        }
    );
    assert_eq!(
        store.queued_agents(&session, 0, 100).unwrap().len(),
        1,
        "answers must never enqueue followups"
    );
    assert_eq!(
        std::fs::read_to_string(source.join("fixture")).unwrap(),
        "untouched\n"
    );
    if mode.starts_with("tui") {
        assert_eq!(report["restored"], true);
    }
}
#[tokio::test]
async fn console_explicit_approval_is_one_exact_invocation() {
    fixture("console").await;
}
#[tokio::test]
async fn console_denial_never_creates_backend() {
    fixture("deny").await;
}
#[tokio::test]
async fn eof_pending_approval_cancels_without_grant() {
    fixture("eof_after").await;
}
#[tokio::test]
async fn approval_first_arriving_after_eof_cancels() {
    fixture("eof_before").await;
}
#[tokio::test]
async fn real_terminal_paste_enter_and_question_submit_cannot_approve() {
    fixture("tui").await;
}
#[tokio::test]
async fn real_terminal_explicit_denial_executes_nothing() {
    fixture("tui_deny").await;
}
#[tokio::test]
async fn real_terminal_cancel_preserves_no_grant() {
    fixture("tui_cancel").await;
}
#[tokio::test]
async fn batch_approval_policy_rejects_before_admission_and_metadata_bypasses_configs() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.db");
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("x"), "x").unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    let session = zero_store::Store::open(&state)
        .unwrap()
        .create_session("baseline", 10)
        .unwrap()
        .id;
    let request:zero_protocol::agent::AgentRequest=serde_json::from_value(json!({"provider":"fixture","model":"fixture","instructions":"host","prompt":"test","tool_approval_policy":{"require_approval":["execute_snapshot"]},"max_turns":2,"reservation_per_turn":10,"execution":{"execution_id":"fixture","image":format!("sha256:{}","a".repeat(64)),"snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}})).unwrap();
    let file = dir.path().join("request.json");
    std::fs::write(&file, serde_json::to_vec(&request).unwrap()).unwrap();
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .arg("--providers")
        .arg("/not-a-provider-config")
        .args([
            "agent",
            "--session",
            &session,
            "--command-id",
            "batch",
            "--request",
        ])
        .arg(&file)
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("cannot receive answers or tool approvals")
    );
    let input = zero_store::Store::open(&state)
        .unwrap()
        .enqueue_agent(&session, "queued", &request, &None)
        .unwrap()
        .0;
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .args(["queue", "run", "--session", &session, "--input", &input.id])
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("cannot receive answers or tool approvals")
    );
    assert!(
        zero_store::Store::open_read_only(&state)
            .unwrap()
            .get_operation_by_command(&session, &input.run_command_id)
            .is_err()
    );
    let missing = dir.path().join("missing/state.db");
    for command in [
        vec!["approvals", "--help"],
        vec!["approvals", "list", "--session", "missing"],
        vec![
            "approvals",
            "show",
            "--session",
            "missing",
            "--approval",
            "missing",
        ],
    ] {
        let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&missing)
            .args(["--providers", "/absent", "--harness-config", "/absent"])
            .args(&command)
            .output()
            .await
            .unwrap();
        assert_eq!(out.status.success(), command[1] == "--help");
        assert!(!missing.exists());
    }
}
