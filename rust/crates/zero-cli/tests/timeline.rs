#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use std::{path::Path, process::Command};

fn cli(state: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(state)
        .args(["--providers", "/missing/providers"])
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn timeline_pages_a_live_owner_journal_without_recovery_or_payload_execution() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.db");
    let mut store = zero_store::Store::open(&state).unwrap();
    let session = store.create_session("fixture", 100).unwrap();
    drop(store);
    let engine = zero_engine::Engine::open(&state, None).unwrap();
    let mut store = zero_store::Store::open(&state).unwrap();
    let admitted = store
        .admit_command(
            &session.id,
            "hostile\u{1b}[31m<script>|label",
            &json!({"kind":"fixture"}),
        )
        .unwrap();
    // Use the real retained journal rather than invented presentation fixtures.
    let events = store.events(&session.id, 0, 100).unwrap();
    assert!(!events.is_empty());
    let before = std::fs::read(&state).unwrap();
    let mut all = Vec::new();
    let mut cursor = 0;
    loop {
        let out = cli(
            &state,
            &[
                "timeline",
                "--session",
                &session.id,
                "--limit",
                "1",
                "--after-sequence",
                &cursor.to_string(),
                "--format",
                "json",
            ],
        );
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let page: Value = serde_json::from_slice(&out.stdout).unwrap();
        let rows = page["events"].as_array().unwrap();
        if rows.is_empty() {
            assert!(page["next_after_sequence"].is_null());
            break;
        }
        all.extend(rows.clone());
        let next = page["next_after_sequence"].as_u64().unwrap();
        assert!(next > cursor);
        cursor = next;
    }
    assert_eq!(json!(all), serde_json::to_value(&events).unwrap());
    let out = cli(&state, &["timeline", "--session", &session.id]);
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(!text.contains('\u{1b}') && !text.contains("<script>"));
    assert!(text.contains("&lt;script&gt;\\|label"));
    assert_eq!(std::fs::read(&state).unwrap(), before);
    assert_eq!(
        store.get_operation(&admitted.operation.id).unwrap().status,
        zero_protocol::OperationStatus::Admitted
    );
    assert!(
        !cli(&state, &["timeline", "--session", "foreign"])
            .status
            .success()
    );
    drop(store);
    drop(engine);
}

#[test]
fn timeline_rejects_missing_state_conflicting_selectors_and_oversized_rows() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("absent/state.db");
    for args in [
        vec!["timeline", "--help"],
        vec!["timeline"],
        vec!["timeline", "scan", "--session", "session"],
        vec!["timeline", "--session", "missing"],
        vec!["timeline", "--session", "s", "--limit", "101"],
    ] {
        let out = cli(&missing, &args);
        assert_eq!(out.status.success(), args.contains(&"--help"));
        assert!(!missing.parent().unwrap().exists());
    }
    let state = dir.path().join("state.db");
    let mut store = zero_store::Store::open(&state).unwrap();
    let session = store.create_session("fixture", 0).unwrap();
    store
        .admit_command(
            &session.id,
            "large",
            &json!({"payload":"x".repeat(4*1024*1024+1)}),
        )
        .unwrap();
    drop(store);
    let out = cli(
        &state,
        &["timeline", "--session", &session.id, "--format", "json"],
    );
    assert!(out.status.success());
    let page: Value = serde_json::from_slice(&out.stdout).unwrap();
    let cursor = page["next_after_sequence"].as_u64().unwrap().to_string();
    let out = cli(
        &state,
        &[
            "timeline",
            "--session",
            &session.id,
            "--format",
            "json",
            "--after-sequence",
            &cursor,
        ],
    );
    assert!(!out.status.success());
    assert!(
        out.stdout.is_empty(),
        "oversized page must not publish a partial prefix"
    );
}
