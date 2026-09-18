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
            assert!(headers.starts_with("POST /custom/chat/completions "));
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
fn exercise(agent: bool) {
    let dir = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!(
        "http://{}/custom/chat/completions",
        listener.local_addr().unwrap()
    );
    let server = std::thread::spawn(move || {
        for turn in 0..if agent { 2 } else { 1 } {
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
            let request = read_request(&mut stream);
            assert!(request["messages"].is_array());
            assert_eq!(request["stream_options"]["include_usage"], true);
            for forbidden in ["input", "instructions", "store", "max_output_tokens"] {
                assert!(
                    request.get(forbidden).is_none(),
                    "unexpected Responses field {forbidden}"
                );
            }
            if agent && turn == 1 {
                let messages = request["messages"].as_array().unwrap();
                let assistant = messages.iter().find(|m| m["role"] == "assistant").unwrap();
                assert_eq!(assistant["tool_calls"][0]["id"], "call-1");
                assert_eq!(assistant["reasoning_content"], "opaque fixture reasoning");
                let tool = messages.iter().find(|m| m["role"] == "tool").unwrap();
                assert_eq!(tool["tool_call_id"], "call-1");
                assert!(tool["content"].as_str().unwrap().contains("Tool rejected"));
            }
            let (delta, reason) = if agent && turn == 0 {
                (
                    json!({"role":"assistant","reasoning_content":"opaque fixture reasoning","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"not_authorized","arguments":"{}"}}]}),
                    "tool_calls",
                )
            } else {
                (
                    json!({"role":"assistant","content":"chat fixture final"}),
                    "stop",
                )
            };
            let chunks = [
                json!({"id":format!("chat-{turn}"),"choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
                json!({"id":format!("chat-{turn}"),"choices":[{"index":0,"delta":{},"finish_reason":reason}]}),
                json!({"id":format!("chat-{turn}"),"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}),
            ];
            let body = chunks
                .into_iter()
                .map(|c| format!("data: {c}\n\n"))
                .collect::<String>()
                + "data: [DONE]\n\n";
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        listener
    });
    let config = dir.path().join("providers.json");
    std::fs::write(&config,json!({"fixture":{"url":url,"wire_api":"chat_completions","api_key_env":"CHAT_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":1000,"max_response_bytes":8192}}).to_string()).unwrap();
    let created = cli(&dir)
        .args(["session", "create", "--budget-limit", "100"])
        .output()
        .unwrap();
    assert!(created.status.success());
    let created: Value = serde_json::from_slice(&created.stdout).unwrap();
    let session = created["session"]["id"].as_str().unwrap();
    let request = if agent {
        let source = dir.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("fixture"), b"fixture").unwrap();
        let snapshot = zero_executor::pin_snapshot(&source).unwrap();
        json!({"provider":"fixture","model":"fixture","instructions":"test","prompt":"test","max_turns":2,"reservation_per_turn":10,"execution":{"execution_id":"fixture","image":"fixture:local","snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}})
    } else {
        json!({"model":"fixture","instructions":"test","input":[{"role":"user","content":"test"}],"tools":[],"max_output_tokens":32})
    };
    let path = dir.path().join("request.json");
    std::fs::write(&path, request.to_string()).unwrap();
    for duplicate in [false, true] {
        let mut command = cli(&dir);
        command
            .arg("--providers")
            .arg(&config)
            .arg(if agent { "agent" } else { "infer" })
            .args([
                "--session",
                session,
                "--command-id",
                "chat-one",
                "--request",
            ])
            .arg(&path)
            .env("CHAT_FIXTURE_KEY", "fixture-secret");
        if !agent {
            command.args(["--provider", "fixture", "--reservation", "10"]);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["duplicate"], duplicate);
        assert_eq!(reply["operation"]["status"], "succeeded");
        if agent {
            assert_eq!(reply["result"]["text"], "chat fixture final");
            assert_eq!(reply["result"]["turns"], 2);
            assert_eq!(reply["result"]["tool_calls"], 0);
        } else {
            assert_eq!(reply["completion"]["usage"]["input_tokens"], 2);
        }
    }
    let listener = server.join().unwrap();
    assert!(matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
    let budget = cli(&dir)
        .args(["session", "budget", session])
        .output()
        .unwrap();
    let budget: Value = serde_json::from_slice(&budget.stdout).unwrap();
    assert_eq!(budget["budget"]["reserved"], 0);
    assert_eq!(budget["budget"]["charged"], if agent { 6 } else { 3 });
}
#[test]
fn chat_infer_settles_usage_and_exact_retry_is_local() {
    exercise(false);
}
#[test]
fn chat_agent_replays_reasoning_and_rejected_tool_into_second_turn() {
    exercise(true);
}
