use std::process::Command;

#[test]
fn findings_help_and_read_errors_do_not_initialize_state() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("absent.db");
    for args in [
        vec!["findings", "--help"],
        vec!["findings", "reviews", "--help"],
        vec!["findings", "show", "--help"],
        vec!["findings", "accept", "--help"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!state.exists());
    }
    for action in ["reviews", "list", "show"] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        command
            .arg("--state")
            .arg(&state)
            .args(["findings", action, "--session", "missing"]);
        if action != "reviews" {
            command.args(["--operation", "missing"]);
        }
        if action == "show" {
            command.args(["--hypothesis", "missing"]);
        }
        let output = command.output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!state.exists());
    }
    let output = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .args([
            "findings",
            "accept",
            "--session",
            "missing",
            "--operation",
            "missing",
            "--hypothesis",
            "missing",
            "--command-id",
            "test",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--expected-revision"));
    assert!(!state.exists());
}

#[test]
fn review_discovery_reads_while_owned_without_provider_or_harness_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.db");
    let mut store = zero_store::Store::open(&state).unwrap();
    let session = store.create_session("discovery", 100).unwrap();
    let _owner = zero_engine::Engine::open(&state, None).unwrap();
    let before = store.events(&session.id, 0, 100).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .arg("--providers")
        .arg(dir.path().join("missing-providers.json"))
        .arg("--harness-config")
        .arg(dir.path().join("missing-harness.json"))
        .args(["findings", "reviews", "--session", &session.id])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["type"], "source_reviews");
    assert_eq!(reply["page"]["reviews"], serde_json::json!([]));
    assert!(reply["page"]["next_before_sequence"].is_null());
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(store.events(&session.id, 0, 100).unwrap()).unwrap()
    );
    let budget = store.budget(&session.id).unwrap();
    assert_eq!((budget.charged, budget.reserved, budget.limit), (0, 0, 100));
}
