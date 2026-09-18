use crate::{anthropic::encode, anthropic_stream::Accumulator, *};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
fn request(input: Vec<Value>) -> ResponsesRequest {
    ResponsesRequest {
        model: "fixture".into(),
        instructions: "trusted system".into(),
        input,
        tools: vec![ToolDefinition {
            name: "inspect".into(),
            description: "read fixture".into(),
            parameters: json!({"type":"object"}),
        }],
        max_output_tokens: 128,
    }
}
fn initial() -> Value {
    json!({"role":"user","content":"inspect fixture"})
}
fn start(usage: Value) -> Value {
    json!({"type":"message_start","message":{"id":"message-1","type":"message","model":"resolved-fixture","role":"assistant","content":[],"stop_reason":null,"usage":usage}})
}
fn block(index: u64, value: Value) -> Value {
    json!({"type":"content_block_start","index":index,"content_block":value})
}
fn delta(index: u64, value: Value) -> Value {
    json!({"type":"content_block_delta","index":index,"delta":value})
}
fn stop(index: u64) -> Value {
    json!({"type":"content_block_stop","index":index})
}
fn terminal(reason: &str) -> Value {
    json!({"type":"message_delta","delta":{"stop_reason":reason,"stop_sequence":null},"usage":{"output_tokens":3}})
}
fn done() -> Value {
    json!({"type":"message_stop"})
}
fn text_events() -> Vec<Value> {
    vec![
        start(json!({"input_tokens":5,"output_tokens":1})),
        block(0, json!({"type":"text","text":""})),
        delta(0, json!({"type":"text_delta","text":"fixture ✓"})),
        stop(0),
        terminal("end_turn"),
        done(),
    ]
}
fn events() -> Vec<Value> {
    vec![
        start(
            json!({"input_tokens":5,"output_tokens":1,"cache_read_input_tokens":7,"cache_creation_input_tokens":0}),
        ),
        block(0, json!({"type":"thinking","thinking":"","signature":""})),
        delta(
            0,
            json!({"type":"thinking_delta","thinking":"opaque reasoning ✓"}),
        ),
        delta(0, json!({"type":"signature_delta","signature":"sig-a"})),
        delta(0, json!({"type":"signature_delta","signature":"-b"})),
        stop(0),
        block(
            1,
            json!({"type":"redacted_thinking","data":"encrypted-fixture"}),
        ),
        stop(1),
        block(2, json!({"type":"text","text":""})),
        delta(2, json!({"type":"text_delta","text":"checking"})),
        stop(2),
        block(
            3,
            json!({"type":"tool_use","id":"call-1","name":"inspect","input":{}}),
        ),
        delta(
            3,
            json!({"type":"input_json_delta","partial_json":"{\"path\":"}),
        ),
        delta(
            3,
            json!({"type":"input_json_delta","partial_json":"\"README\"}"}),
        ),
        stop(3),
        terminal("tool_use"),
        done(),
    ]
}
fn consume(values: Vec<Value>) -> Completion {
    let mut a = Accumulator::new("fixture");
    for v in values {
        a.event(&serde_json::to_vec(&v).unwrap()).unwrap();
    }
    a.finish(None)
}
fn frames(values: Vec<Value>) -> String {
    values
        .into_iter()
        .map(|v| format!("event: {}\ndata: {v}\n\n", v["type"].as_str().unwrap()))
        .collect()
}
#[test]
fn signed_thinking_and_parallel_tool_context_replay_is_exact() {
    let result = consume(events());
    assert_eq!(result.status, CompletionStatus::Completed);
    assert!(result.usage_is_final);
    assert_eq!(
        result.usage,
        Some(Usage {
            input_tokens: 12,
            output_tokens: 3,
            cached_input_tokens: 7
        })
    );
    assert_eq!(
        result.content,
        vec![
            Content::Text {
                text: "checking".into()
            },
            Content::ToolCall {
                id: "call-1".into(),
                name: "inspect".into(),
                arguments: json!({"path":"README"})
            }
        ]
    );
    let raw = result.replay[0]["message"].clone();
    assert_eq!(raw["content"][0]["signature"], "sig-a-b");
    assert_eq!(raw["content"][1]["data"], "encrypted-fixture");
    let mut input = vec![initial()];
    input.extend(result.replay);
    input.push(json!({"type":"function_call_output","call_id":"call-1","output":"evidence"}));
    let body = encode(&request(input)).unwrap();
    assert_eq!(body["messages"][1], raw);
    assert_eq!(
        body["messages"][2],
        json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":"evidence"}]})
    );
    assert_eq!(body["system"], "trusted system");
    assert_eq!(body["tools"][0]["input_schema"], json!({"type":"object"}));
    assert_eq!(body["max_tokens"], 128);
    assert!(body.get("thinking").is_none());
}
#[test]
fn missing_terminal_usage_and_truncation_never_authorize_partial_tools() {
    let mut v = events();
    v.pop();
    let partial = consume(v);
    assert_eq!(partial.status, CompletionStatus::Incomplete);
    assert!(partial.content.is_empty());
    assert!(!partial.usage_is_final);
    let mut input = vec![initial()];
    input.extend(partial.replay);
    assert!(encode(&request(input)).is_err());
    let mut v = text_events();
    v[0]["message"].as_object_mut().unwrap().remove("usage");
    v[4].as_object_mut().unwrap().remove("usage");
    let absent = consume(v);
    assert!(absent.usage.is_none());
    assert!(!absent.usage_is_final);
    let mut v = text_events();
    v[4] = terminal("max_tokens");
    let capped = consume(v);
    assert_eq!(capped.status, CompletionStatus::Incomplete);
    assert!(capped.content.is_empty());
}
#[test]
fn cache_write_costs_are_retained_but_never_charged_as_plain_input() {
    let mut v = text_events();
    v[0]["message"]["usage"] = json!({"input_tokens":5,"output_tokens":1,"cache_read_input_tokens":7,"cache_creation_input_tokens":9,"cache_creation":{"ephemeral_5m_input_tokens":9,"ephemeral_1h_input_tokens":0}});
    let result = consume(v);
    assert_eq!(result.status, CompletionStatus::Completed);
    assert_eq!(result.usage.unwrap().input_tokens, 21);
    assert!(!result.usage_is_final);
    assert_eq!(result.replay[0]["usage"]["cache_creation_input_tokens"], 9);
    assert!(result.error.unwrap().contains("billing dimensions"));
    let mut v = text_events();
    v[0]["message"]["usage"] =
        json!({"input_tokens":u64::MAX,"output_tokens":1,"cache_read_input_tokens":1});
    let overflow = consume(v);
    assert!(overflow.usage.is_none());
    assert!(!overflow.usage_is_final);
}
#[test]
fn invalid_block_order_signatures_or_conflicting_reasons_fail_closed() {
    for bad in [
        block(1, json!({"type":"text","text":""})),
        delta(0, json!({"type":"text_delta","text":"not started"})),
        json!({"type":"server_future_action"}),
    ] {
        let mut a = Accumulator::new("fixture");
        a.event(
            start(json!({"input_tokens":1,"output_tokens":0}))
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        assert!(a.event(bad.to_string().as_bytes()).is_err());
        assert_eq!(a.finish(None).status, CompletionStatus::Failed);
    }
    let mut a = Accumulator::new("fixture");
    for v in [
        start(json!({})),
        block(0, json!({"type":"thinking","thinking":"x","signature":""})),
    ] {
        a.event(v.to_string().as_bytes()).unwrap();
    }
    assert!(a.event(stop(0).to_string().as_bytes()).is_err());
    let mut v = events();
    let end = v.len() - 2;
    v[end] = terminal("end_turn");
    let contradiction = consume(v);
    assert_eq!(contradiction.status, CompletionStatus::Failed);
    assert!(contradiction.content.is_empty());
}
#[test]
fn unsupported_media_foreign_replay_and_unpaired_tools_are_rejected_before_dispatch() {
    for item in [
        json!({"role":"user","content":[{"type":"input_image","image_url":"https://example.com/image"}]}),
        json!({"type":"chat_completion_message","model":"fixture","message":{}}),
        json!({"type":"function_call_output","call_id":"missing","output":"x"}),
    ] {
        assert!(encode(&request(vec![initial(), item])).is_err());
    }
    let complete = consume(events());
    let mut replay = complete.replay[0].clone();
    replay["model"] = json!("other-model");
    assert!(encode(&request(vec![initial(), replay])).is_err());
    assert!(encode(&request(vec![initial(), complete.replay[0].clone()])).is_err());
    let calls = vec![
        initial(),
        json!({"type":"function_call","call_id":"c1","name":"inspect","arguments":"{}"}),
        json!({"type":"function_call","call_id":"c2","name":"inspect","arguments":"{}"}),
        json!({"type":"function_call_output","call_id":"c1","output":"a"}),
        json!({"type":"function_call_output","call_id":"c2","output":"b"}),
    ];
    let encoded = encode(&request(calls)).unwrap();
    assert_eq!(
        encoded["messages"][1]["content"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        encoded["messages"][2]["content"].as_array().unwrap().len(),
        2
    );
}
async fn server(
    body: String,
    hold: bool,
) -> (
    String,
    tokio::task::JoinHandle<String>,
    tokio::sync::oneshot::Receiver<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/gateway/prefix/v1/messages",
        listener.local_addr().unwrap()
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                let len = String::from_utf8_lossy(&bytes[..end])
                    .lines()
                    .find_map(|line| {
                        let (k, v) = line.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + len {
                    break;
                }
            }
        }
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        // Exercise actual fragmented UTF-8 and JSON boundaries on the wire.
        for chunk in body.as_bytes().chunks(7) {
            socket.write_all(chunk).await.unwrap();
        }
        let _ = tx.send(());
        if hold {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        String::from_utf8(bytes).unwrap()
    });
    (url, task, rx)
}
fn client(url: &str, max: usize) -> ProviderClient {
    ProviderClient::with_wire(
        Endpoint::responses(url, Some("local-test-key")).unwrap(),
        WireApi::AnthropicMessages,
        Duration::from_secs(2),
        max,
    )
    .unwrap()
}
#[tokio::test]
async fn loopback_exact_url_key_version_and_request_roundtrip() {
    let (url, task, _) = server(frames(events()), false).await;
    let provider = client(&url, 65536);
    let result = provider
        .complete(&request(vec![initial()]), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.status, CompletionStatus::Completed);
    assert!(result.usage_is_final);
    let raw = task.await.unwrap();
    let headers = raw.split("\r\n\r\n").next().unwrap().to_lowercase();
    assert!(headers.starts_with("post /gateway/prefix/v1/messages "));
    assert!(headers.contains("x-api-key: local-test-key"));
    assert!(headers.contains("anthropic-version: 2023-06-01"));
    assert!(!headers.contains("authorization:"));
    let mut input = vec![initial()];
    let message = result.replay[0]["message"].clone();
    input.extend(result.replay);
    input.push(
        json!({"type":"function_call_output","call_id":"call-1","output":"fixture evidence"}),
    );
    let (url, task, _) = server(frames(text_events()), false).await;
    assert_eq!(
        client(&url, 65536)
            .complete(&request(input), CancellationToken::new())
            .await
            .unwrap()
            .status,
        CompletionStatus::Completed
    );
    let raw = task.await.unwrap();
    let body: Value = serde_json::from_str(raw.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["messages"][1], message);
}
#[tokio::test]
async fn loopback_cancellation_retains_provisional_usage_and_never_executes_tool_fragments() {
    let mut stream = events();
    stream.truncate(14);
    let (url, task, ready) = server(frames(stream), true).await;
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let provider = client(&url, 65536);
    let pending =
        tokio::spawn(async move { provider.complete(&request(vec![initial()]), token).await });
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    cancel.cancel();
    let result = pending.await.unwrap().unwrap();
    assert_eq!(result.status, CompletionStatus::Incomplete);
    assert!(result.content.is_empty());
    assert!(!result.usage_is_final);
    assert_eq!(result.usage.unwrap().input_tokens, 12);
    task.await.unwrap();
}
#[tokio::test]
async fn loopback_errors_are_sanitized_and_stream_bounds_fail_closed() {
    let body = format!(
        "{}data: {}\n\n",
        frames(vec![start(json!({"input_tokens":5,"output_tokens":1}))]),
        json!({"type":"error","error":{"message":"SECRET-GATEWAY-DETAIL","type":"overloaded_error"}})
    );
    let (url, task, _) = server(body, false).await;
    let result = client(&url, 65536)
        .complete(&request(vec![initial()]), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.status, CompletionStatus::Failed);
    assert!(
        !serde_json::to_string(&result)
            .unwrap()
            .contains("SECRET-GATEWAY-DETAIL")
    );
    task.await.unwrap();
    let body = frames(vec![
        start(json!({"input_tokens":5,"output_tokens":1})),
        block(0, json!({"type":"text","text":"x".repeat(2000)})),
    ]);
    let (url, task, _) = server(body, false).await;
    let result = client(&url, 1024)
        .complete(&request(vec![initial()]), CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(result.status, CompletionStatus::Completed);
    assert!(result.content.is_empty());
    let _ = task.await;
}

#[test]
fn ordinary_usage_metadata_is_billable_but_nonzero_extra_dimensions_are_not() {
    let ordinary = json!({"input_tokens":5,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"server_tool_use":{"web_fetch_requests":0,"web_search_requests":0},"service_tier":"standard","inference_geo":"global","output_tokens_details":{"thinking_tokens":1}});
    let mut values = text_events();
    values[0]["message"]["usage"] = ordinary.clone();
    assert!(consume(values).usage_is_final);
    for (field, value) in [
        ("cache_creation", json!({"ephemeral_5m_input_tokens":2})),
        ("server_tool_use", json!({"web_search_requests":1})),
        ("service_tier", json!("priority")),
        ("inference_geo", json!("us")),
        ("future_charge", json!(1)),
    ] {
        let mut usage = ordinary.clone();
        usage[field] = value;
        let mut values = text_events();
        values[0]["message"]["usage"] = usage;
        let result = consume(values);
        assert_eq!(result.status, CompletionStatus::Completed);
        assert!(!result.usage_is_final, "{field}");
        assert!(result.replay[0]["usage"].get(field).is_some());
    }
}
#[tokio::test]
async fn rejected_http_request_is_not_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/messages", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 4096];
        assert!(socket.read(&mut bytes).await.unwrap() > 0);
        socket
            .write_all(b"HTTP/1.1 529 overloaded\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        drop(socket);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    assert!(matches!(
        client(&url, 4096)
            .complete(&request(vec![initial()]), CancellationToken::new())
            .await,
        Err(TransportError::Http(529))
    ));
    task.await.unwrap();
}
#[tokio::test]
async fn unsupported_request_is_rejected_without_http_dispatch() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/messages", listener.local_addr().unwrap());
    let invalid = request(vec![
        json!({"role":"user","content":[{"type":"image","source":{}}]}),
    ]);
    assert!(matches!(
        client(&url, 4096)
            .complete(&invalid, CancellationToken::new())
            .await,
        Err(TransportError::InvalidRequest)
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
}
