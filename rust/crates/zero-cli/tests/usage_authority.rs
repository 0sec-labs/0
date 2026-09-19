#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    time::{Duration, Instant},
};
use tempfile::TempDir;
fn cli(dir: &TempDir) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    command.arg("--state").arg(dir.path().join("state.db"));
    command
}
fn read_request(stream: &mut TcpStream) -> Value {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut bytes = Vec::new();
    loop {
        let mut b = [0; 4096];
        let n = stream.read(&mut b).unwrap();
        assert_ne!(n, 0);
        bytes.extend_from_slice(&b[..n]);
        if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]);
            assert!(headers.starts_with("POST /"));
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            if bytes.len() >= end + 4 + length {
                return serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
            }
        }
    }
}
#[derive(Clone, Copy, PartialEq)]
enum Accounting {
    Missing,
    Overflow,
    OverBudget,
}
fn exercise(wire: &str, accounting: Accounting) {
    let over_budget = accounting == Accounting::OverBudget;
    let dir = TempDir::new().unwrap();
    let docker = dir.path().join("docker");
    std::fs::write(&docker, "#!/usr/bin/env python3\nfrom pathlib import Path\nPath(__file__ + '.called').touch()\nraise SystemExit(77)\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o700)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/fixture", listener.local_addr().unwrap());
    let body = match wire {
        "responses" => {
            let mut event = json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"function_call","call_id":"call1","name":"execute_snapshot","arguments":"{\"argv\":[\"true\"]}"}]}});
            if accounting == Accounting::Overflow { event["response"]["usage"] = json!({"input_tokens":u64::MAX,"output_tokens":1}); }
            if over_budget { event["response"]["usage"] = json!({"input_tokens":200,"output_tokens":1}); }
            format!("data: {event}\n\n")
        }
        "chat_completions" => format!("data: {}\n\ndata: [DONE]\n\n", json!({"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call1","type":"function","function":{"name":"execute_snapshot","arguments":"{\"argv\":[\"true\"]}"}}]},"finish_reason":"tool_calls"}]})),
        "anthropic_messages" => [
            json!({"type":"message_start","message":{"id":"a1","type":"message","role":"assistant","model":"fixture","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call1","name":"execute_snapshot","input":{}}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"argv\":[\"true\"]}"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
            json!({"type":"message_stop"}),
        ].iter().map(|v| format!("data: {v}\n\n")).collect(),
        _ => unreachable!(),
    };
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((s, _)) => break s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("{e}"),
            }
        };
        let _request = read_request(&mut stream);
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        listener
    });
    let config = dir.path().join("providers.json");
    std::fs::write(&config,json!({"fixture":{"url":url,"wire_api":wire,"api_key_env":"GOOGLE_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":1000,"max_response_bytes":8192}}).to_string()).unwrap();
    let created = cli(&dir)
        .args(["session", "create", "--budget-limit", "100"])
        .output()
        .unwrap();
    assert!(created.status.success());
    let created: Value = serde_json::from_slice(&created.stdout).unwrap();
    let session = created["session"]["id"].as_str().unwrap();
    let request = {
        let source = dir.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("fixture"), b"fixture").unwrap();
        let snapshot = zero_executor::pin_snapshot(&source).unwrap();
        json!({"provider":"fixture","model":"fixture","instructions":"test","prompt":"test","max_turns":2,"context_policy":{"schema_version":1,"max_input_bytes":65536,"keep_recent_rounds":1},"reservation_per_turn":10,"execution":{"execution_id":"fixture","image":"fixture:local","snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}})
    };
    let path = dir.path().join("request.json");
    std::fs::write(&path, request.to_string()).unwrap();
    for duplicate in [false, true] {
        let mut command = cli(&dir);
        command
            .arg("--docker-bin")
            .arg(&docker)
            .arg("--providers")
            .arg(&config)
            .arg("agent")
            .args([
                "--session",
                session,
                "--command-id",
                "usage-one",
                "--request",
            ])
            .arg(&path)
            .env("GOOGLE_FIXTURE_KEY", "fixture-secret");
        let output = command.output().unwrap();
        assert!(
            !output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["duplicate"], duplicate);
        let expected = if over_budget { "failed" } else { "unknown" };
        assert_eq!(reply["operation"]["status"], expected, "{reply}");
        assert_eq!(reply["result"]["status"], expected);
        assert!(
            !dir.path().join("docker.called").exists(),
            "over-budget/uncertain response launched a tool"
        );
        assert_eq!(reply["result"]["turns"], 1);
        assert_eq!(reply["result"]["tool_calls"], 0);
        let store = zero_store::Store::open_read_only(dir.path().join("state.db")).unwrap();
        let parent = reply["operation"]["id"].as_str().unwrap();
        let child = store
            .get_operation_by_command(session, &format!("{parent}:model:0"))
            .unwrap();
        let outcome = child.outcome.unwrap();
        if over_budget {
            assert_eq!(child.status, zero_protocol::OperationStatus::Succeeded);
            assert_eq!(outcome["status"], "completed");
            assert_eq!(outcome["content"].as_array().unwrap().len(), 1);
            assert!(outcome["error"].is_null());
        } else {
            assert_eq!(outcome["status"], "incomplete");
            assert_eq!(outcome["content"], json!([]));
            assert_eq!(
                outcome["error"],
                "provider completion lacks final representable accounting; reservation retained"
            );
        }

        assert!(
            store
                .get_operation_by_command(session, &format!("{parent}:tool:0:0"))
                .is_err()
        );
        assert_eq!(
            store
                .events(session, 0, 100)
                .unwrap()
                .iter()
                .filter(|event| event.kind == "command_admitted")
                .count(),
            2
        );
    }
    let listener = server.join().unwrap();
    assert!(matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
    let budget = cli(&dir)
        .args(["session", "budget", session])
        .output()
        .unwrap();
    let budget: Value = serde_json::from_slice(&budget.stdout).unwrap();
    assert_eq!(
        budget["budget"]["reserved"],
        if over_budget { 0 } else { 10 }
    );
    assert_eq!(
        budget["budget"]["charged"],
        if over_budget { 201 } else { 0 }
    );
}
#[test]
fn responses_missing_usage_blocks_tool_admission_and_retry() {
    exercise("responses", Accounting::Missing);
}
#[test]
fn chat_missing_usage_blocks_tool_admission_and_retry() {
    exercise("chat_completions", Accounting::Missing);
}
#[test]
fn anthropic_provisional_usage_blocks_tool_admission_and_retry() {
    exercise("anthropic_messages", Accounting::Missing);
}
#[test]
fn unrepresentable_charge_blocks_tool_admission_and_retry() {
    exercise("responses", Accounting::Overflow);
}

#[test]
fn known_provider_overage_records_charge_without_authorizing_tools_or_retry() {
    exercise("responses", Accounting::OverBudget);
}
