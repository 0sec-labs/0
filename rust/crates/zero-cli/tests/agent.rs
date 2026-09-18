#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::Command,
};

fn cli(dir: &TempDir) -> Command {
    let mut cli = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    cli.arg("--state").arg(dir.path().join("state.db"));
    cli
}
async fn line(reader: &mut BufReader<tokio::process::ChildStdout>) -> Value {
    let mut text = String::new();
    let count = tokio::time::timeout(Duration::from_secs(3), reader.read_line(&mut text))
        .await
        .unwrap()
        .unwrap();
    assert_ne!(count, 0);
    serde_json::from_str(&text).unwrap()
}

async fn exercise(cancel: bool) {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("fixture.txt"), b"fixture").unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let (ready_tx, ready) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let n = stream.read(&mut chunk).await.unwrap();
            assert_ne!(n, 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length: usize = headers
                    .lines()
                    .find_map(|s| {
                        let (name, value) = s.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        if cancel {
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n: waiting\n\n").await.unwrap();
            ready_tx.send(()).unwrap();
            let mut b = [0; 1];
            let _ = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut b))
                .await
                .unwrap();
        } else {
            let event = json!({"type":"response.completed","response":{"id":"agent-final","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"fixture assessment only"}]}],"usage":{"input_tokens":2,"output_tokens":1}}});
            let body = format!("data: {event}\n\n");
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let config = dir.path().join("profiles.json");
    std::fs::write(&config,json!({"fixture":{"url":url,"api_key_env":"AGENT_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":10000,"max_response_bytes":8192}}).to_string()).unwrap();
    let created = cli(&dir)
        .args(["session", "create", "--budget-limit", "100"])
        .output()
        .await
        .unwrap();
    assert!(created.status.success());
    let created: Value = serde_json::from_slice(&created.stdout).unwrap();
    let session = created["session"]["id"].as_str().unwrap();
    let request = json!({"provider":"fixture","model":"fixture","instructions":"fixture","prompt":"Give an assessment without tool calls","max_turns":2,"reservation_per_turn":10,"execution":{"execution_id":"agent-profile","image":"fixture:local","snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}});
    if cancel {
        let mut child = cli(&dir)
            .arg("--providers")
            .arg(&config)
            .arg("app-server")
            .env("AGENT_FIXTURE_KEY", "fixture-secret")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let init = json!({"protocol_version":1,"id":1,"command":{"method":"initialize"}});
        input
            .write_all(format!("{init}\n").as_bytes())
            .await
            .unwrap();
        let _ = line(&mut output).await;
        let run = json!({"protocol_version":1,"id":2,"command":{"method":"run_agent","params":{"session_id":session,"command_id":"agent-one","request":request}}});
        input
            .write_all(format!("{run}\n").as_bytes())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), ready)
            .await
            .unwrap()
            .unwrap();
        let stop = json!({"protocol_version":1,"id":3,"command":{"method":"cancel","params":{"session_id":session,"execution_id":"agent-one"}}});
        input
            .write_all(format!("{stop}\n").as_bytes())
            .await
            .unwrap();
        let mut cancelled = false;
        let mut settled = false;
        while !cancelled || !settled {
            let response = line(&mut output).await;
            if response["id"] == 3 {
                assert_eq!(response["reply"]["accepted"], true);
                cancelled = true;
            }
            if response["id"] == 2 {
                assert_eq!(response["reply"]["operation"]["status"], "unknown");
                settled = true;
            }
        }
        drop(input);
        assert!(
            tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
    } else {
        let path = dir.path().join("request.json");
        std::fs::write(&path, request.to_string()).unwrap();
        let output = tokio::time::timeout(
            Duration::from_secs(3),
            cli(&dir)
                .arg("--providers")
                .arg(&config)
                .args([
                    "agent",
                    "--session",
                    session,
                    "--command-id",
                    "agent-one",
                    "--request",
                ])
                .arg(path)
                .env("AGENT_FIXTURE_KEY", "fixture-secret")
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["operation"]["status"], "succeeded");
        assert_eq!(reply["result"]["status"], "completed");
        assert_eq!(reply["result"]["tool_calls"], 0);
        assert_eq!(reply["result"]["text"], "fixture assessment only");
    }
    server.await.unwrap();
    if cancel {
        let budget = cli(&dir)
            .args(["session", "budget", session])
            .output()
            .await
            .unwrap();
        assert!(budget.status.success());
        let budget: Value = serde_json::from_slice(&budget.stdout).unwrap();
        assert_eq!(budget["budget"]["reserved"], 10);
        assert_eq!(budget["budget"]["charged"], 0);
    }
}
#[tokio::test]
async fn agent_no_tool_turn_completes_in_executable() {
    exercise(false).await;
}
#[tokio::test]
async fn app_server_agent_accepts_cancel_during_provider_stream() {
    exercise(true).await;
}

#[tokio::test]
async fn completed_agent_continuation_replays_history_across_processes_without_reissuing() {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("fixture"), b"fixture").unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for turn in 0..2 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut bytes = Vec::new();
            let request: Value = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let mut buf = [0; 4096];
                    let n = stream.read(&mut buf).await.unwrap();
                    assert_ne!(n, 0);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                                .unwrap();
                        }
                    }
                }
            })
            .await
            .unwrap();
            let input = request["input"].as_array().unwrap();
            assert_eq!(input[0]["content"], "first prompt");
            if turn == 0 {
                assert_eq!(input.len(), 1);
            } else {
                assert_eq!(input.len(), 3);
                assert_eq!(input[1]["role"], "assistant");
                assert_eq!(input[1]["content"][0]["text"], "first final answer");
                assert_eq!(
                    input[2],
                    json!({"role":"user","content":"follow-up prompt"})
                );
            }
            let text = if turn == 0 {
                "first final answer"
            } else {
                "second final answer"
            };
            let event = json!({"type":"response.completed","response":{"id":format!("continuation-{turn}"),"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}],"usage":{"input_tokens":2,"output_tokens":1}}});
            let body = format!("data: {event}\n\n");
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
        listener
    });
    let config = dir.path().join("profiles.json");
    std::fs::write(&config,json!({"fixture":{"url":url,"api_key_env":"AGENT_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":1000,"max_response_bytes":8192}}).to_string()).unwrap();
    let created = cli(&dir)
        .args(["session", "create", "--budget-limit", "100"])
        .output()
        .await
        .unwrap();
    assert!(created.status.success());
    let created: Value = serde_json::from_slice(&created.stdout).unwrap();
    let session = created["session"]["id"].as_str().unwrap();
    let mut request = json!({"provider":"fixture","model":"fixture","instructions":"fixture","prompt":"first prompt","max_turns":2,"reservation_per_turn":10,"execution":{"execution_id":"continuation-profile","image":"fixture:local","snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}});
    let path = dir.path().join("request.json");
    for (index, command_id) in ["first", "follow-up", "follow-up"].into_iter().enumerate() {
        std::fs::write(&path, request.to_string()).unwrap();
        // Each invocation opens the persisted database in a fresh executable.
        let output = tokio::time::timeout(
            Duration::from_secs(3),
            cli(&dir)
                .arg("--providers")
                .arg(&config)
                .args([
                    "agent",
                    "--session",
                    session,
                    "--command-id",
                    command_id,
                    "--request",
                ])
                .arg(&path)
                .env("AGENT_FIXTURE_KEY", "fixture-secret")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["duplicate"], index == 2);
        assert_eq!(reply["operation"]["status"], "succeeded");
        assert_eq!(
            reply["result"]["text"],
            if index == 0 {
                "first final answer"
            } else {
                "second final answer"
            }
        );
        if index == 0 {
            request["continuation_of"] = reply["operation"]["id"].clone();
            request["prompt"] = json!("follow-up prompt");
        }
    }
    let listener = server.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "retry issued another provider request"
    );
    let budget = cli(&dir)
        .args(["session", "budget", session])
        .output()
        .await
        .unwrap();
    let budget: Value = serde_json::from_slice(&budget.stdout).unwrap();
    assert_eq!(budget["budget"]["charged"], 6);
    assert_eq!(budget["budget"]["reserved"], 0);
}
