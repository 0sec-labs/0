use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Output, Stdio};
use tempfile::TempDir;

fn cli(state: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(state)
        .args(args)
        .output()
        .unwrap()
}

fn request(id: u64, method: &str, params: Option<Value>) -> Value {
    let command = match params {
        Some(params) => json!({"method":method,"params":params}),
        None => json!({"method":method}),
    };
    json!({"protocol_version":1,"id":id,"command":command})
}

fn serve(state: &std::path::Path, lines: &[String]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(state)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for line in lines {
        writeln!(input, "{line}").unwrap();
    }
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn schema_and_help_do_not_create_a_database() {
    let dir = TempDir::new().unwrap();
    let state = dir.path().join("absent/state.db");
    let output = cli(&state, &["schema"]);
    assert!(output.status.success());
    let schema: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(schema["protocol_version"], 1);
    assert!(schema["request"].is_object());
    assert!(!state.exists());
    assert!(cli(&state, &["--help"]).status.success());
    assert!(cli(&state, &["--version"]).status.success());
    assert!(!state.exists());
}

#[test]
fn sessions_persist_across_native_processes() {
    let dir = TempDir::new().unwrap();
    let state = dir.path().join("native/state.db");
    let created = cli(
        &state,
        &[
            "session",
            "create",
            "--generation",
            "test-generation",
            "--budget-limit",
            "42",
        ],
    );
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let created: Value = serde_json::from_slice(&created.stdout).unwrap();
    let id = created["session"]["id"].as_str().unwrap();
    let listed: Value = serde_json::from_slice(&cli(&state, &["session", "list"]).stdout).unwrap();
    assert_eq!(listed["sessions"], json!([created["session"].clone()]));
    let shown: Value =
        serde_json::from_slice(&cli(&state, &["session", "show", id]).stdout).unwrap();
    assert_eq!(shown, created);
    assert_eq!(shown["session"]["budget_limit"], 42);
    assert_eq!(shown["session"]["generation"], "test-generation");
    let budget = cli(&state, &["session", "budget", id]);
    assert!(budget.status.success());
    let budget: Value = serde_json::from_slice(&budget.stdout).unwrap();
    assert_eq!(
        budget["budget"],
        json!({"limit":42,"reserved":0,"charged":0})
    );
}

#[test]
#[cfg(target_os = "linux")]
fn snapshot_pin_is_parseable_and_does_not_create_database() {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("entry.txt"), b"snapshot fixture").unwrap();
    let state = dir.path().join("absent/state.db");
    let output = cli(&state, &["snapshot", "pin", source.to_str().unwrap()]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let pin: zero_protocol::SnapshotPin = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(pin.root, source.canonicalize().unwrap().to_str().unwrap());
    assert_eq!(pin.files.len(), 1);
    assert_eq!(pin.files[0].path, "entry.txt");
    assert_eq!(pin.files[0].bytes, 16);
    assert!(!state.exists());
    std::fs::write(source.join("entry.txt"), b"changed fixture").unwrap();
    let changed = cli(&state, &["snapshot", "pin", source.to_str().unwrap()]);
    let changed: zero_protocol::SnapshotPin = serde_json::from_slice(&changed.stdout).unwrap();
    assert_ne!(pin.digest, changed.digest);
}

#[test]
fn handshake_is_required_and_bad_frames_do_not_poison_connection() {
    let dir = TempDir::new().unwrap();
    let mut unsupported = request(2, "initialize", None);
    unsupported["protocol_version"] = json!(999);
    let messages = serve(
        &dir.path().join("state.db"),
        &[
            request(1, "session_list", None).to_string(),
            unsupported.to_string(),
            "{broken".into(),
            request(3, "initialize", None).to_string(),
            request(4, "initialize", None).to_string(),
            request(
                5,
                "session_create",
                Some(json!({"generation":"native","budget_limit":20})),
            )
            .to_string(),
            request(6, "session_list", None).to_string(),
        ],
    );
    assert_eq!(messages.len(), 7);
    assert_eq!(messages[0]["id"], 1);
    assert_eq!(messages[0]["reply"]["code"], "not_initialized");
    assert_eq!(messages[1]["reply"]["code"], "unsupported_version");
    assert_eq!(messages[2]["id"], Value::Null);
    assert_eq!(messages[2]["reply"]["code"], "invalid_request");
    assert_eq!(messages[3]["reply"]["type"], "initialized");
    assert!(messages[3]["reply"]["capabilities"].is_array());
    assert_eq!(messages[4]["reply"]["code"], "already_initialized");
    assert_eq!(
        messages[5]["reply"]["session"]["id"],
        messages[6]["reply"]["sessions"][0]["id"]
    );
}

#[test]
fn oversized_record_is_drained_before_next_request() {
    let dir = TempDir::new().unwrap();
    let messages = serve(
        &dir.path().join("state.db"),
        &[
            "x".repeat(zero_protocol::MAX_FRAME_BYTES + 1),
            request(9, "initialize", None).to_string(),
        ],
    );
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["reply"]["code"], "frame_too_large");
    assert_eq!(messages[1]["id"], 9);
    assert_eq!(messages[1]["reply"]["type"], "initialized");
}

#[test]
fn unimplemented_legacy_commands_fail_explicitly() {
    let dir = TempDir::new().unwrap();
    let output = cli(
        &dir.path().join("state.db"),
        &["scan", "https://example.test"],
    );
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unrecognized subcommand"));
}
