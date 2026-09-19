//! Loopback streaming fixtures: advisory events never authorize tool execution.
#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;
use zero_provider::{
    CompletionStatus, Content, Endpoint, ProviderClient, ProviderProgress, ResponsesRequest,
    WireApi,
};
const OPAQUE: &str = "never-publish-encrypted-signature-or-auth";
fn sse(events: Vec<Value>) -> String {
    events
        .into_iter()
        .map(|v| format!("data: {v}\n\n"))
        .collect()
}
fn chat(delta: Value, finish: Value) -> Value {
    json!({"id":"c1","model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":finish}],"usage":null})
}
fn transcript(wire: WireApi) -> (String, String) {
    match wire {
    WireApi::GoogleGenerateContent | WireApi::OllamaChat => unreachable!("Google progress has its own native fixture"),
    WireApi::Responses=>(sse(vec![
        json!({"type":"response.created","response":{"id":"r1","status":"in_progress"}}),
        json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hello €"}),
        json!({"type":"response.refusal.delta","output_index":0,"content_index":1,"delta":"refusal"}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"reasoning","encrypted_content":OPAQUE}}),
        json!({"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"exposed summary"}),
        json!({"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","call_id":"a","name":"first","arguments":""}}),
        json!({"type":"response.output_item.added","output_index":3,"item":{"type":"function_call","call_id":"b","name":"second","arguments":""}}),
        json!({"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\"x\":"}),
        json!({"type":"response.function_call_arguments.delta","output_index":3,"delta":"{}"}),
        json!({"type":"response.function_call_arguments.delta","output_index":2,"delta":"1}"}),
    ]),sse(vec![json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello €"},{"type":"refusal","refusal":"refusal"}]},{"type":"reasoning","encrypted_content":OPAQUE},{"type":"function_call","call_id":"a","name":"first","arguments":"{\"x\":1}"},{"type":"function_call","call_id":"b","name":"second","arguments":"{}"}],"usage":{"input_tokens":2,"output_tokens":9}}})])),
    WireApi::ChatCompletions=>(sse(vec![
        chat(json!({"content":"hello €","refusal":"refusal","reasoning_content":"exposed reasoning","reasoning_details":[{"encrypted_content":OPAQUE}]}),Value::Null),
        chat(json!({"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"first","arguments":"{\"x\":"}},{"index":1,"id":"b","type":"function","function":{"name":"second","arguments":"{}"}}]}),Value::Null),
        chat(json!({"tool_calls":[{"index":0,"id":"a","function":{"name":"first","arguments":"1}"}}]}),Value::Null),
    ]),format!("{}data: [DONE]\n\n",sse(vec![chat(json!({}),json!("tool_calls")),json!({"id":"c1","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":9}})]))),
    WireApi::AnthropicMessages=>(sse(vec![
        json!({"type":"message_start","message":{"id":"a1","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"usage":{"input_tokens":2,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hello "}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"€"}}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":"","signature":""}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"exposed reasoning"}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":OPAQUE}}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"redacted_thinking","data":OPAQUE}}),
        json!({"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"a","name":"first","input":{}}}),
        json!({"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\"x\":"}}),
        json!({"type":"content_block_start","index":4,"content_block":{"type":"tool_use","id":"b","name":"second","input":{}}}),
        json!({"type":"content_block_delta","index":4,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
        json!({"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"1}"}}),
    ]),sse((0..5).map(|i|json!({"type":"content_block_stop","index":i})).chain([json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":9}}),json!({"type":"message_stop"})]).collect())),
}
}
fn request() -> ResponsesRequest {
    ResponsesRequest {
        model: "fixture".into(),
        instructions: "inspect".into(),
        input: vec![json!({"role":"user","content":"hello"})],
        tools: vec![],
        max_output_tokens: 128,
    }
}
async fn read_request(socket: &mut TcpStream) {
    let mut bytes = Vec::new();
    loop {
        let mut buffer = [0u8; 2048];
        let n = socket.read(&mut buffer).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&buffer[..n]);
        if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..i]);
            let length: usize = headers
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(|v| v.parse().unwrap())
                })
                .unwrap();
            if bytes.len() >= i + 4 + length {
                break;
            }
        }
    }
}
async fn fixture(
    prefix: String,
    suffix: String,
) -> (String, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/stream", listener.local_addr().unwrap());
    let (release, wait) = oneshot::channel();
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        // Split every UTF-8 scalar across TCP writes; SSE decoder must reconstruct it.
        for byte in prefix.as_bytes() {
            if socket.write_all(&[*byte]).await.is_err() {
                return;
            }
        }
        let _ = wait.await;
        let _ = socket.write_all(suffix.as_bytes()).await;
    });
    (url, release, handle)
}
fn client(url: &str, wire: WireApi) -> ProviderClient {
    ProviderClient::with_wire(
        Endpoint::responses(url, Some(OPAQUE)).unwrap(),
        wire,
        Duration::from_secs(5),
        8 * 1024 * 1024,
    )
    .unwrap()
}
#[tokio::test]
async fn all_wires_emit_before_terminal_and_preserve_final_completion_and_opaque_replay() {
    for wire in [
        WireApi::Responses,
        WireApi::ChatCompletions,
        WireApi::AnthropicMessages,
    ] {
        let (prefix, suffix) = transcript(wire);
        let (url, release, server) = fixture(prefix.clone(), suffix.clone()).await;
        let (tx, mut rx) = mpsc::channel(100);
        let transport = client(&url, wire);
        let running = tokio::spawn(async move {
            transport
                .complete_with_progress(&request(), CancellationToken::new(), move |p| {
                    tx.try_send(p).unwrap();
                })
                .await
                .unwrap()
        });
        let first = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            !running.is_finished(),
            "completion returned before terminal release"
        );
        release.send(()).unwrap();
        let completion = running.await.unwrap();
        server.await.unwrap();
        let mut events = vec![first];
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        assert_eq!(completion.status, CompletionStatus::Completed);
        assert!(completion.usage_is_final);
        assert_eq!(
            completion
                .content
                .iter()
                .filter(|c| matches!(c, Content::ToolCall { .. }))
                .count(),
            2
        );
        assert!(
            serde_json::to_string(&completion.replay)
                .unwrap()
                .contains(OPAQUE)
        );
        assert!(!serde_json::to_string(&events).unwrap().contains(OPAQUE));
        let mut text = String::new();
        let mut tools = std::collections::BTreeMap::<u32, (String, String, String)>::new();
        let mut reasoning = false;
        for event in &events {
            match event {
                ProviderProgress::TextDelta { text: t, .. } => text.push_str(t),
                ProviderProgress::ReasoningDelta { .. } => reasoning = true,
                ProviderProgress::ToolCallDelta {
                    item_index,
                    id_delta,
                    name_delta,
                    arguments_delta,
                } => {
                    let tool = tools.entry(*item_index).or_default();
                    tool.0.push_str(id_delta);
                    tool.1.push_str(name_delta);
                    tool.2.push_str(arguments_delta);
                }
                _ => (),
            }
        }
        assert_eq!(text, "hello €");
        assert!(reasoning);
        assert_eq!(
            tools.into_values().collect::<Vec<_>>(),
            vec![
                ("a".into(), "first".into(), "{\"x\":1}".into()),
                ("b".into(), "second".into(), "{}".into())
            ]
        );
        let (url, release, server) = fixture(prefix, suffix).await;
        release.send(()).unwrap();
        let without = client(&url, wire)
            .complete(&request(), CancellationToken::new())
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(
            serde_json::to_value(completion).unwrap(),
            serde_json::to_value(without).unwrap()
        );
    }
}
#[tokio::test]
async fn cancellation_after_progress_never_authorizes_partial_calls_or_final_usage() {
    for wire in [
        WireApi::Responses,
        WireApi::ChatCompletions,
        WireApi::AnthropicMessages,
    ] {
        let (prefix, suffix) = transcript(wire);
        let (url, release, server) = fixture(prefix, suffix).await;
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let mut observed = 0;
        let result = client(&url, wire)
            .complete_with_progress(&request(), cancel, move |_| {
                observed += 1;
                if observed == 1 {
                    stop.cancel();
                }
            })
            .await
            .unwrap();
        assert_ne!(result.status, CompletionStatus::Completed);
        assert!(result.content.is_empty());
        assert!(!result.usage_is_final);
        let _ = release.send(());
        server.await.unwrap();
    }
}
#[tokio::test]
async fn malformed_authoritative_frame_never_emits_its_text_or_tools() {
    let malformed = chat(
        json!({"content":OPAQUE,"tool_calls":[{"index":999999,"id":"bad","function":{"name":"bad","arguments":"{}"}}]}),
        Value::Null,
    );
    let (url, release, server) = fixture(sse(vec![malformed]), String::new()).await;
    release.send(()).unwrap();
    let mut events = Vec::new();
    let result = client(&url, WireApi::ChatCompletions)
        .complete_with_progress(&request(), CancellationToken::new(), |p| events.push(p))
        .await
        .unwrap();
    server.await.unwrap();
    assert!(events.is_empty());
    assert_ne!(result.status, CompletionStatus::Completed);
    assert!(result.content.is_empty());
}
#[tokio::test]
async fn terminal_only_response_does_not_fabricate_duplicate_live_progress() {
    let (_, terminal) = transcript(WireApi::Responses);
    let (url, release, server) = fixture(String::new(), terminal).await;
    release.send(()).unwrap();
    let mut events = Vec::new();
    let result = client(&url, WireApi::Responses)
        .complete_with_progress(&request(), CancellationToken::new(), |p| events.push(p))
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(result.status, CompletionStatus::Completed);
    assert!(events.is_empty());
}
