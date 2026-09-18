#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "http/mod.rs"]
mod support;
use serde_json::json;
use std::{process::Stdio, time::Duration};
#[tokio::test]
async fn metadata_and_readonly_http_bypass_profiles_and_never_create_missing_state() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    for args in [
        vec!["schema"],
        vec!["http", "--help"],
        vec![
            "http",
            "show",
            "--session",
            "missing",
            "--operation",
            "missing",
        ],
    ] {
        let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .arg("--http-profiles")
            .arg("/must-not-read-http-config")
            .args(&args)
            .env_remove("HTTP_FIXTURE_AUTH")
            .output()
            .await
            .unwrap();
        assert_eq!(
            output.status.success(),
            args[0] == "schema" || args[1] == "--help"
        );
        assert!(!state.exists());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("must-not-read"));
    }
}
#[tokio::test]
async fn strict_http_configuration_and_missing_auth_fail_before_state_or_network() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("http.json");
    let base = json!({"target":{"policy":support::policy("http://127.0.0.1:1/target/")}});
    let mut unknown = base.clone();
    unknown["target"]["policy"]["insecure_tls"] = true.into();
    let mut auth = base.clone();
    auth["target"]["auth"] =
        json!({"revision":"credential-v1","headers_env":{"authorization":"HTTP_FIXTURE_AUTH"}});
    let mut collision = base.clone();
    collision["target"]["policy"]["allowed_headers"] = json!(["X-Test", "x-test"]);
    let mut env_invalid = auth.clone();
    env_invalid["target"]["auth"]["headers_env"]["authorization"] = "$(print secret)".into();
    let profile = serde_json::to_string(&base["target"]).unwrap();
    let duplicate = format!("{{\"target\":{profile},\"target\":{profile}}}");
    for (i, value) in [
        unknown.to_string(),
        auth.to_string(),
        collision.to_string(),
        env_invalid.to_string(),
        duplicate,
    ]
    .iter()
    .enumerate()
    {
        std::fs::write(&config, value).unwrap();
        let state = dir.path().join(format!("state-{i}.db"));
        let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .arg("--http-profiles")
            .arg(&config)
            .args([
                "session",
                "create",
                "--generation",
                "baseline",
                "--budget-limit",
                "100",
            ])
            .env_remove("HTTP_FIXTURE_AUTH")
            .output()
            .await
            .unwrap();
        assert!(!output.status.success());
        assert!(
            !state.exists(),
            "bad HTTP config should fail before opening the owner"
        );
        assert!(!String::from_utf8_lossy(&output.stderr).contains("$(print secret)"));
    }
}
#[tokio::test]
async fn nonregular_http_configuration_is_rejected_without_waiting_for_a_writer() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("profiles.fifo");
    let state = dir.path().join("state.db");
    nix::unistd::mkfifo(&config, nix::sys::stat::Mode::S_IRUSR).unwrap();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    command
        .arg("--state")
        .arg(&state)
        .arg("--http-profiles")
        .arg(&config)
        .args([
            "session",
            "create",
            "--generation",
            "baseline",
            "--budget-limit",
            "100",
        ])
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(3), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("regular JSON file"));
    assert!(!state.exists());
}
async fn fixture(mode: &str) {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("file"), "unchanged\n").unwrap();
    let state = dir.path().join("state.db");
    let session = zero_store::Store::open(&state)
        .unwrap()
        .create_session("baseline", 100)
        .unwrap()
        .id;
    let request = dir.path().join("request.json");
    std::fs::write(&request,json!({"provider":"fixture","model":"fixture","instructions":"Host HTTP scope is immutable","prompt":"Use the explicit target profile","http_profile":"target","max_turns":2,"reservation_per_turn":10,"execution":{"execution_id":"fixture","image":"never:execute","snapshot":zero_executor::pin_snapshot(&source).unwrap(),"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}}).to_string()).unwrap();
    let config = dir.path().join("driver.json");
    std::fs::write(&config,json!({"mode":mode,"binary":env!("CARGO_BIN_EXE_0sec-native"),"root":dir.path(),"state":state,"session":session,"request":request,"source":source,"policy":support::policy("http://127.0.0.1:1/target/")}).to_string()).unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/http/driver.py"))
        .arg(config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(40), child.wait_with_output())
        .await
        .expect("bounded local HTTP CLI fixture")
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[tokio::test]
async fn scoped_http_default_post_redaction_and_exact_restart_retry() {
    fixture("complete").await;
}
#[tokio::test]
async fn dispatched_http_timeout_remains_unknown_without_replay() {
    fixture("unknown").await;
}
#[tokio::test]
async fn denied_path_has_no_target_socket_or_implicit_scope_expansion() {
    fixture("denied").await;
}

#[tokio::test]
async fn console_uses_explicit_target_profile_with_unicode_queued_prompt() {
    fixture("console").await;
}
#[tokio::test]
async fn real_terminal_forwards_target_profile_to_owned_app_server() {
    fixture("tui").await;
}
