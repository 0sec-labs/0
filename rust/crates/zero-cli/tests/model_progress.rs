use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::Command,
    sync::oneshot,
};

fn wire(wire: &str) -> (String, String) {
    let sse = |value: Value| format!("data: {value}\n\n");
    match wire {
        "responses" => (
            sse(json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"stream-visible"})),
            sse(json!({"type":"response.completed","response":{"id":"progress-response","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"stream-visible"}]}],"usage":{"input_tokens":2,"output_tokens":1}}})),
        ),
        "chat_completions" => (
            sse(json!({"id":"progress-response","choices":[{"index":0,"delta":{"role":"assistant","content":"stream-visible"},"finish_reason":null}]})),
            format!("{}{}data: [DONE]\n\n",sse(json!({"id":"progress-response","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})),sse(json!({"id":"progress-response","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}))),
        ),
        "anthropic_messages" => (
            [
                json!({"type":"message_start","message":{"id":"progress-response","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"usage":{"input_tokens":2,"output_tokens":0}}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"stream-visible"}}),
            ].into_iter().map(sse).collect(),
            [
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}),
                json!({"type":"message_stop"}),
            ].into_iter().map(sse).collect(),
        ),
        _ => unreachable!(),
    }
}
async fn read(reader: &mut BufReader<tokio::process::ChildStdout>) -> Value {
    let mut line = String::new();
    let n = tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_ne!(n, 0);
    serde_json::from_str(&line).unwrap()
}
async fn send(writer: &mut tokio::process::ChildStdin, id: u64, command: Value) {
    writer
        .write_all(
            format!(
                "{}\n",
                json!({"protocol_version":1,"id":id,"command":command})
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}
async fn response(reader: &mut BufReader<tokio::process::ChildStdout>, id: u64) -> Value {
    loop {
        let value = read(reader).await;
        if value["kind"] == "response" && value["id"] == id {
            return value["reply"].clone();
        }
    }
}
async fn exercise(api: &str, cancel: bool) {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/fixture", listener.local_addr().unwrap());
    let (prefix, suffix) = wire(api);
    let (finish_tx, finish_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let n = socket.read(&mut chunk).await.unwrap();
            assert_ne!(n, 0);
            request.extend_from_slice(&chunk[..n]);
            if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if request.len() >= end + 4 + length {
                    break;
                }
            }
            assert!(request.len() < 1024 * 1024);
        }
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{prefix}",prefix.len()+suffix.len()).as_bytes()).await.unwrap();
        // The terminal response is withheld until the CLI has exposed progress.
        if tokio::time::timeout(Duration::from_secs(10), finish_rx)
            .await
            .unwrap()
            .unwrap()
        {
            socket.write_all(suffix.as_bytes()).await.unwrap();
        }
        listener
    });
    let profiles = dir.path().join("providers.json");
    std::fs::write(&profiles,json!({"fixture":{"url":url,"wire_api":api,"api_key_env":"PROGRESS_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":15000,"max_response_bytes":32768}}).to_string()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(dir.path().join("state.db"))
        .arg("--providers")
        .arg(&profiles)
        .arg("app-server")
        .env("PROGRESS_KEY", "fixture-secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    send(&mut input, 1, json!({"method":"initialize"})).await;
    assert_eq!(response(&mut output, 1).await["type"], "initialized");
    send(
        &mut input,
        2,
        json!({"method":"session_create","params":{"generation":"baseline","budget_limit":100}}),
    )
    .await;
    let session = response(&mut output, 2).await["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let command = json!({"method":"infer","params":{"session_id":session,"command_id":"progress-one","provider":"fixture","reservation":10,"request":{"model":"fixture","instructions":"fixture","input":[{"role":"user","content":"fixture"}],"tools":[],"max_output_tokens":32}}});
    send(&mut input, 3, command.clone()).await;
    let mut operation = None;
    loop {
        let value = read(&mut output).await;
        assert_ne!(
            value["kind"], "response",
            "inference returned before terminal gate: {value}"
        );
        let event = &value["event"];
        if event["type"] == "admitted" {
            operation = Some(event["operation_id"].clone());
        }
        if event["type"] == "model_progress" {
            assert_eq!(event["session_id"], session);
            assert!(event["parent_operation_id"].is_null());
            assert_eq!(event["sequence"], 1);
            assert_eq!(event["progress"]["type"], "text_delta");
            assert_eq!(event["progress"]["text"], "stream-visible");
            assert!(!event.to_string().contains("fixture-secret"));
            if let Some(id) = &operation {
                assert_eq!(&event["operation_id"], id);
            }
            operation = Some(event["operation_id"].clone());
            break;
        }
    }
    let mut early_result = None;
    if cancel {
        send(&mut input,4,json!({"method":"cancel","params":{"session_id":session,"execution_id":"progress-one"}})).await;
        loop {
            let value = read(&mut output).await;
            if value["id"] == 3 {
                early_result = Some(value["reply"].clone());
            }
            if value["id"] == 4 {
                assert_eq!(value["reply"]["accepted"], true);
                break;
            }
        }
    }
    finish_tx.send(!cancel).unwrap();
    let result = match early_result {
        Some(value) => value,
        None => response(&mut output, 3).await,
    };
    assert_eq!(result["operation"]["id"], operation.unwrap());
    assert_eq!(
        result["operation"]["status"],
        if cancel { "unknown" } else { "succeeded" }
    );
    if !cancel {
        assert_eq!(result["completion"]["content"][0]["text"], "stream-visible");
    }
    send(&mut input, 5, command).await;
    loop {
        let value = read(&mut output).await;
        assert_ne!(
            value["event"]["type"], "model_progress",
            "retry generated progress"
        );
        if value["id"] == 5 {
            assert_eq!(value["reply"]["duplicate"], true);
            assert_eq!(value["reply"]["operation"]["id"], result["operation"]["id"]);
            break;
        }
    }
    send(
        &mut input,
        6,
        json!({"method":"session_budget","params":{"session_id":session}}),
    )
    .await;
    let budget = response(&mut output, 6).await;
    assert_eq!(budget["budget"]["reserved"], if cancel { 10 } else { 0 });
    assert_eq!(budget["budget"]["charged"], if cancel { 0 } else { 3 });
    drop(input);
    let end = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        end.status.success(),
        "{}",
        String::from_utf8_lossy(&end.stderr)
    );
    let listener = server.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn responses_progress_precedes_completion_and_retry_is_inert() {
    exercise("responses", false).await;
}
#[tokio::test]
async fn chat_progress_precedes_completion_and_retry_is_inert() {
    exercise("chat_completions", false).await;
}
#[tokio::test]
async fn anthropic_progress_precedes_completion_and_retry_is_inert() {
    exercise("anthropic_messages", false).await;
}
#[tokio::test]
async fn cancellation_after_visible_progress_retains_unknown_usage() {
    exercise("responses", true).await;
}
