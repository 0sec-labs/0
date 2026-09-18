#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Real terminal acceptance; fixtures use one local model response for seeding.
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};

#[tokio::test]
async fn retained_review_navigation_and_explicit_triage_are_offline_and_restore_the_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.db");
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("app.js"), "return user_input;\n").unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    let session = zero_store::Store::open(&state)
        .unwrap()
        .create_session("baseline", 100)
        .unwrap()
        .id;
    let config = dir.path().join("driver.json");
    std::fs::write(
        &config,
        json!({
            "binary":env!("CARGO_BIN_EXE_0sec-native"),"state":state,
            "session":session,"source":source,"root":dir.path(),
            "request":{"provider":"fixture","model":"fixture","reservation":10,
                "source":{"snapshot":snapshot,"selected_files":["app.js"],
                    "question":"Inspect input trust","max_hypotheses":2}}
        })
        .to_string(),
    )
    .unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/tui_findings_driver.py"
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
        .expect("findings PTY driver deadline")
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["restored"], true);
    assert_eq!(
        result["requests"], 1,
        "only fixture seeding may call provider"
    );
    let operation = result["operation"].as_str().unwrap();
    let hypothesis = result["hypothesis"].as_str().unwrap();
    let (record, history) =
        zero_engine::read_source_finding(&state, &session, operation, hypothesis, 0, 50).unwrap();
    assert_eq!(record.revision, 1);
    assert_eq!(
        record.status,
        zero_protocol::triage::SourceFindingStatus::Accepted
    );
    assert_eq!(history.len(), 1);
    assert_eq!(
        history[0].note,
        "Operator note λ\na/s/r are inert pasted text\n"
    );
    assert_eq!(
        serde_json::to_value(&record.hypothesis).unwrap()["state"],
        "unverified"
    );
    let store = zero_store::Store::open_read_only(&state).unwrap();
    assert_eq!(store.budget(&session).unwrap().charged, 3);
    assert_eq!(store.budget(&session).unwrap().reserved, 0);
    assert!(store.queued_agents(&session, 0, 100).unwrap().is_empty());
    assert!(!source.exists());
}
