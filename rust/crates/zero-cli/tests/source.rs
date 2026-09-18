#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    time::{Duration, Instant},
};
use tempfile::TempDir;

fn cli(dir: &TempDir) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    command.arg("--state").arg(dir.path().join("state.db"));
    command
}
fn exercise(mode: &str) {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("app.js"),
        "const SOURCE_BYTES_PRIVATE = 1;\nreturn SOURCE_BYTES_PRIVATE;\n",
    )
    .unwrap();
    fs::write(source.join("excluded.txt"), "UNSELECTED_BYTES_PRIVATE").unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    let digest = snapshot
        .files
        .iter()
        .find(|f| f.path == "app.js")
        .unwrap()
        .digest
        .clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let claim = json!({"title":"Possible missing check","claimed_severity":"low","explanation":"Requires behavioral verification","citations":[{"path":"app.js","sha256":digest,"start_line":1,"end_line":if mode == "bad_citation" {99} else {2}}]});
    let hypotheses = if mode == "empty" {
        json!([])
    } else {
        json!([claim])
    };
    let output = if mode == "prose" {
        json!([{"type":"message","content":[{"type":"output_text","text":"This source is definitely safe"}]}])
    } else {
        json!([{"type":"function_call","id":"fc1","call_id":"submission-1","name":"submit_source_hypotheses","arguments":json!({"hypotheses":hypotheses}).to_string()}])
    };
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("{e}"),
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let request = loop {
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).unwrap();
            assert_ne!(n, 0);
            bytes.extend_from_slice(&buf[..n]);
            if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..end]);
                let len: usize = header
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + len {
                    break serde_json::from_slice::<Value>(&bytes[end + 4..end + 4 + len]).unwrap();
                }
            }
        };
        assert!(request.to_string().contains("SOURCE_BYTES_PRIVATE"));
        assert!(!request.to_string().contains("UNSELECTED_BYTES_PRIVATE"));
        assert_eq!(request["tools"][0]["name"], "submit_source_hypotheses");
        let event = json!({"type":"response.completed","response":{"id":"review-response","status":"completed","output":output,"usage":{"input_tokens":2,"output_tokens":1}}});
        let body = format!("data: {event}\n\n");
        write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        listener
    });
    let config = dir.path().join("providers.json");
    fs::write(&config,json!({"fixture":{"url":url,"api_key_env":"SOURCE_TEST_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":3000,"max_response_bytes":32768}}).to_string()).unwrap();
    let request = dir.path().join("request.json");
    fs::write(&request,json!({"provider":"fixture","model":"fixture-model","reservation":10,"source":{"snapshot":snapshot,"selected_files":["app.js"],"question":"Find potential missing checks","max_hypotheses":2}}).to_string()).unwrap();
    let created = cli(&dir)
        .args(["session", "create", "--budget-limit", "100"])
        .output()
        .unwrap();
    assert!(created.status.success());
    let created: Value = serde_json::from_slice(&created.stdout).unwrap();
    let session = created["session"]["id"].as_str().unwrap();
    let mut first = None;
    for duplicate in [false, true] {
        let output = cli(&dir)
            .arg("--providers")
            .arg(&config)
            .args([
                "source-review",
                "--session",
                session,
                "--command-id",
                "source-one",
                "--request",
            ])
            .arg(&request)
            .env("SOURCE_TEST_KEY", "fixture-secret")
            .output()
            .unwrap();
        let success = mode == "valid" || mode == "empty";
        assert_eq!(
            output.status.success(),
            success,
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(!text.contains("SOURCE_BYTES_PRIVATE"));
        assert!(!text.contains("fixture-secret"));
        assert!(!text.contains("definitely safe"));
        let reply: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(reply["duplicate"], duplicate);
        assert_eq!(
            reply["operation"]["status"],
            if success { "succeeded" } else { "failed" }
        );
        if success {
            assert!(
                reply["result"]["artifacts"]
                    .as_object()
                    .unwrap()
                    .values()
                    .all(|v| v.as_str().unwrap().starts_with("sha256:"))
            );
            let hypotheses = reply["result"]["review"]["hypotheses"].as_array().unwrap();
            assert_eq!(hypotheses.len(), if mode == "empty" { 0 } else { 1 });
            for hypothesis in hypotheses {
                assert_eq!(hypothesis["state"], "unverified");
            }
        } else {
            assert!(reply["result"]["review"].is_null());
        }
        if duplicate {
            assert_eq!(first.as_ref().unwrap(), &reply["operation"]["id"]);
        } else {
            first = Some(reply["operation"]["id"].clone());
            fs::remove_dir_all(&source).unwrap();
        }
    }
    if mode == "valid" {
        triage_roundtrip(&dir, session, first.as_ref().unwrap().as_str().unwrap());
    }
    // Reports are read-only exports after the original source has disappeared.
    // Missing provider/harness/backend inputs must never be consulted.
    for format in ["json", "markdown", "html"] {
        let output = cli(&dir)
            .args([
                "--providers",
                "/missing/providers.json",
                "--harness-config",
                "/missing/harness.json",
                "--docker-bin",
                "/missing/docker",
                "source-report",
                "--session",
                session,
                "--operation",
                first.as_ref().unwrap().as_str().unwrap(),
                "--format",
                format,
            ])
            .env_remove("SOURCE_TEST_KEY")
            .output()
            .unwrap();
        let success = mode == "valid" || mode == "empty";
        assert_eq!(
            output.status.success(),
            success,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(!text.contains("SOURCE_BYTES_PRIVATE"));
        assert!(!text.contains("UNSELECTED_BYTES_PRIVATE"));
        assert!(!text.contains("fixture-secret"));
        if success {
            assert!(text.to_lowercase().contains("unverified"));
            assert!(text.contains(first.as_ref().unwrap().as_str().unwrap()));
            if format == "json" {
                let report: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(report["security_conclusion"], "not_established");
                assert_eq!(
                    report["review"]["hypotheses"].as_array().unwrap().len(),
                    if mode == "empty" { 0 } else { 1 }
                );
            }
        } else {
            assert!(text.is_empty());
        }
    }
    let denied = cli(&dir)
        .args([
            "source-report",
            "--session",
            "another-session",
            "--operation",
            first.as_ref().unwrap().as_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!denied.status.success());
    assert!(denied.stdout.is_empty());
    let listener = server.join().unwrap();
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "exact retry must not dispatch another provider call"
    );
}
#[test]
fn grounded_submission_remains_unverified_and_retries_after_source_deletion() {
    exercise("valid");
}
#[test]
fn empty_submission_is_not_a_safety_verdict() {
    exercise("empty");
}
#[test]
fn citation_outside_retained_lines_fails() {
    exercise("bad_citation");
}
#[test]
fn terminal_prose_without_submission_fails() {
    exercise("prose");
}

#[test]
fn source_review_metadata_bypasses_provider_harness_and_database() {
    let dir = tempfile::tempdir().unwrap();
    for args in [vec!["source-review", "--help"], vec!["schema"]] {
        let output = cli(&dir)
            .args([
                "--providers",
                "/missing/providers.json",
                "--harness-config",
                "/missing/harness.json",
            ])
            .args(args)
            .env_remove("SOURCE_TEST_KEY")
            .output()
            .unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("source-review") || text.contains("review_source"));
        assert!(!dir.path().join("state.db").exists());
    }
}

#[test]
fn source_report_never_creates_state_and_help_needs_no_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let help = cli(&dir)
        .args([
            "--providers",
            "/missing/profiles",
            "source-report",
            "--help",
        ])
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(!dir.path().join("state.db").exists());
    let output = cli(&dir)
        .args([
            "source-report",
            "--session",
            "missing",
            "--operation",
            "missing",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!dir.path().join("state.db").exists());
}

fn triage_roundtrip(dir: &TempDir, session: &str, operation: &str) {
    let command = |action: &str| {
        let mut c = cli(dir);
        c.args([
            "--providers",
            "/missing/triage-provider",
            "--harness-config",
            "/missing/triage-harness",
            "findings",
            action,
            "--session",
            session,
            "--operation",
            operation,
        ]);
        c
    };
    let parse = |output: std::process::Output| {
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let list = parse(command("list").output().unwrap());
    assert_eq!(list["findings"].as_array().unwrap().len(), 1);
    let exhausted = parse(
        command("list")
            .args(["--offset", "1", "--limit", "1"])
            .output()
            .unwrap(),
    );
    assert_eq!(exhausted["findings"], json!([]));
    let finding = &list["findings"][0];
    assert_eq!(finding["status"], "new");
    assert_eq!(finding["revision"], 0);
    assert_eq!(finding["hypothesis"]["state"], "unverified");
    let hypothesis = finding["hypothesis"]["id"].as_str().unwrap();
    let digest = finding["source_review_sha256"].clone();
    let mutate = |action: &str, id: &str, revision: &str, note: &str| {
        command(action)
            .args([
                "--hypothesis",
                hypothesis,
                "--command-id",
                id,
                "--expected-revision",
                revision,
                "--note",
                note,
            ])
            .output()
            .unwrap()
    };
    let accepted = parse(mutate(
        "accept",
        "triage-accept",
        "0",
        "Operator follow-up, not a proof",
    ));
    assert_eq!(accepted["duplicate"], false);
    assert_eq!(accepted["finding"]["status"], "accepted");
    assert_eq!(accepted["finding"]["revision"], 1);
    assert_eq!(accepted["finding"]["hypothesis"]["state"], "unverified");
    assert!(
        !mutate("suppress", "stale", "0", "stale write")
            .status
            .success()
    );
    assert!(
        !mutate("accept", "triage-accept", "0", "changed command")
            .status
            .success()
    );
    let suppressed = parse(mutate("suppress", "triage-suppress", "1", "Deprioritized"));
    assert_eq!(suppressed["finding"]["status"], "suppressed");
    assert_eq!(suppressed["finding"]["revision"], 2);
    let duplicate = parse(mutate(
        "accept",
        "triage-accept",
        "0",
        "Operator follow-up, not a proof",
    ));
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["decision"], accepted["decision"]);
    assert_eq!(duplicate["finding"]["status"], "suppressed");
    assert_eq!(duplicate["finding"]["revision"], 2);
    let reopened = parse(mutate("reopen", "triage-reopen", "2", "Reconsider"));
    assert_eq!(reopened["finding"]["status"], "new");
    assert_eq!(reopened["finding"]["revision"], 3);
    assert_eq!(reopened["finding"]["source_review_sha256"], digest);
    assert_eq!(reopened["finding"]["hypothesis"], finding["hypothesis"]);
    // Read paths work while another engine owns the database and do not mutate it.
    let state = dir.path().join("state.db");
    let owner = zero_engine::Engine::open(&state, None).unwrap();
    let before = fs::read(&state).unwrap();
    let shown = parse(
        command("show")
            .args(["--hypothesis", hypothesis, "--limit", "2"])
            .output()
            .unwrap(),
    );
    assert_eq!(shown["finding"]["revision"], 3);
    assert_eq!(shown["history"].as_array().unwrap().len(), 2);
    assert_eq!(shown["history"][0]["revision"], 1);
    assert_eq!(shown["history"][1]["revision"], 2);
    let last = parse(
        command("show")
            .args([
                "--hypothesis",
                hypothesis,
                "--after-revision",
                "2",
                "--limit",
                "2",
            ])
            .output()
            .unwrap(),
    );
    assert_eq!(last["history"].as_array().unwrap().len(), 1);
    assert_eq!(last["history"][0]["revision"], 3);
    assert_eq!(fs::read(&state).unwrap(), before);
    assert!(
        !command("show")
            .args(["--hypothesis", "missing"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(fs::read(&state).unwrap(), before);
    drop(owner);
}
