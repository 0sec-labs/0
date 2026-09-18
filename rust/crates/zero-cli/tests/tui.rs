#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Real PTY fixtures exercise the installed terminal lifecycle and durable journal.
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;
use zero_protocol::{agent::AgentRequest, queue::QueuedAgentStatus};

struct Fixture {
    dir: tempfile::TempDir,
    state: PathBuf,
    session: String,
    request: AgentRequest,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state.db");
        let source = dir.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("fixture.txt"), "offline fixture\n").unwrap();
        let snapshot = zero_executor::pin_snapshot(&source).unwrap();
        let request = serde_json::from_value(json!({
            "provider":"fixture","model":"fixture","instructions":"Local terminal fixture",
            "prompt":"profile template must not auto-run","max_turns":2,"reservation_per_turn":10,
            "execution":{"execution_id":"pty-fixture","image":"local:never-executed",
                "snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,
                "cpus":0.5,"max_output_bytes":1024}
        }))
        .unwrap();
        let session = zero_store::Store::open(&state)
            .unwrap()
            .create_session("baseline", 100)
            .unwrap()
            .id;
        Self {
            dir,
            state,
            session,
            request,
        }
    }
    fn store(&self) -> zero_store::Store {
        zero_store::Store::open_read_only(&self.state).unwrap()
    }
    async fn drive(&self, mode: &str) -> Value {
        let profile = self.dir.path().join("profile.json");
        let providers = self.dir.path().join("providers.json");
        std::fs::write(&profile, serde_json::to_vec(&self.request).unwrap()).unwrap();
        let config = self.dir.path().join("driver.json");
        std::fs::write(
            &config,
            json!({
                "mode":mode,"state":self.state,"providers":providers,
                "argv":[env!("CARGO_BIN_EXE_0sec-native"),"--state",self.state,
                    "--providers",providers,"tui","--session",self.session,"--request",profile]
            })
            .to_string(),
        )
        .unwrap();
        let child = Command::new("python3")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/tui_driver.py"))
            .arg(config)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let output = tokio::time::timeout(Duration::from_secs(40), child.wait_with_output())
            .await
            .expect("PTY driver exceeded its bounded deadlines")
            .unwrap();
        assert!(
            output.status.success(),
            "PTY {mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["restored"], true);
        result
    }
}

#[tokio::test]
async fn non_terminal_rejection_precedes_profile_loading_and_state_creation() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("must-not-exist/state.db");
    let output = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .args(["tui", "--request"])
        .arg(dir.path().join("missing-profile.json"))
        .stdin(Stdio::null())
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr).to_lowercase();
    assert!(
        error.contains("terminal") || error.contains("tty"),
        "{error}"
    );
    assert!(!state.parent().unwrap().exists());
}

#[tokio::test]
async fn unicode_bracketed_paste_resize_and_quit_restore_terminal_without_enqueuing() {
    let f = Fixture::new();
    assert_eq!(f.drive("paste").await["requests"], json!([]));
    assert!(
        f.store()
            .queued_agents(&f.session, 0, 100)
            .unwrap()
            .is_empty()
    );
    assert_eq!(f.store().budget(&f.session).unwrap().charged, 0);
}

#[tokio::test]
async fn termination_signal_restores_terminal_and_reaps_app_server() {
    let f = Fixture::new();
    assert_eq!(f.drive("signal").await["requests"], json!([]));
    assert!(
        f.store()
            .queued_agents(&f.session, 0, 100)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn app_server_eof_restores_terminal_on_error() {
    let f = Fixture::new();
    let result = f.drive("backend_error").await;
    assert_eq!(result["requests"], json!([]));
    assert_ne!(result["exit_code"], 0);
}

#[tokio::test]
async fn explicit_enter_streams_before_completion_and_settles_exact_pasted_prompt() {
    let f = Fixture::new();
    let result = f.drive("stream").await;
    assert_eq!(result["requests"].as_array().unwrap().len(), 1);
    let store = f.store();
    let queue = store.queued_agents(&f.session, 0, 100).unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].status, QueuedAgentStatus::Succeeded);
    assert_eq!(queue[0].request.prompt, "héllo λ\nsecond line");
    let operation = store
        .get_operation(queue[0].operation_id.as_ref().unwrap())
        .unwrap();
    assert_eq!(
        operation.outcome.unwrap()["text"],
        "stream-visible final-answer"
    );
    let budget = store.budget(&f.session).unwrap();
    assert_eq!(budget.charged, 3);
    assert_eq!(budget.reserved, 0);
}

#[tokio::test]
async fn cancel_after_live_text_retains_unknown_usage_hold_and_restores_terminal() {
    let f = Fixture::new();
    assert_eq!(
        f.drive("cancel").await["requests"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let store = f.store();
    let queue = store.queued_agents(&f.session, 0, 100).unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].status, QueuedAgentStatus::Unknown);
    let budget = store.budget(&f.session).unwrap();
    assert_eq!(budget.charged, 0);
    assert_eq!(budget.reserved, 10);
}

#[tokio::test]
async fn quit_during_live_inference_waits_for_durable_uncertainty_and_child_cleanup() {
    let f = Fixture::new();
    assert_eq!(
        f.drive("quit_active").await["requests"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let store = f.store();
    let queue = store.queued_agents(&f.session, 0, 100).unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].status, QueuedAgentStatus::Unknown);
    assert_eq!(store.budget(&f.session).unwrap().reserved, 10);
    assert_eq!(store.budget(&f.session).unwrap().charged, 0);
}

#[tokio::test]
async fn preexisting_pending_queue_survives_repeated_ui_restarts_without_dispatch() {
    let f = Fixture::new();
    let pending = zero_store::Store::open(&f.state)
        .unwrap()
        .enqueue_agent(&f.session, "preexisting", &f.request, &None)
        .unwrap()
        .0;
    for _ in 0..2 {
        assert_eq!(f.drive("pending").await["requests"], json!([]));
        let restored = f.store().queued_agent(&f.session, &pending.id).unwrap();
        assert_eq!(restored.status, QueuedAgentStatus::Pending);
        assert!(restored.operation_id.is_none());
    }
}

#[tokio::test]
async fn live_budget_snapshot_and_separate_readonly_command_work_while_owner_is_active() {
    let f = Fixture::new();
    let result = f.drive("budget").await;
    assert_eq!(result["exit_code"], 0);
    assert_eq!(result["requests"].as_array().unwrap().len(), 1);
    let budget = f.store().budget(&f.session).unwrap();
    assert_eq!(budget.charged, 3);
    assert_eq!(budget.reserved, 0);
}
#[tokio::test]
async fn cancellation_under_fullscreen_help_keeps_unknown_lifecycle_and_usage_hold_visible() {
    let f = Fixture::new();
    let result = f.drive("budget_cancel").await;
    assert_eq!(result["exit_code"], 0);
    assert_eq!(result["requests"].as_array().unwrap().len(), 1);
    let budget = f.store().budget(&f.session).unwrap();
    assert_eq!(budget.charged, 0);
    assert_eq!(budget.reserved, 10);
}
