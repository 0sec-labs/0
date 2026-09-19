//! Deterministic loopback Ollama wire fixtures, never live or paid inference.
#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;
use zero_provider::{
    CompletionStatus, Content, Endpoint, ProviderClient, ProviderProgress, ResponsesRequest,
    WireApi,
};
fn request() -> ResponsesRequest {
    ResponsesRequest {
        model: "fixture".into(),
        instructions: "host instructions".into(),
        input: vec![json!({"role":"user","content":"inspect"})],
        tools: vec![zero_provider::ToolDefinition {
            name: "read_source".into(),
            description: "read exact source".into(),
            parameters: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
        }],
        max_output_tokens: 64,
    }
}
async fn wire(socket: &mut TcpStream) -> (String, Value) {
    let mut bytes = Vec::new();
    loop {
        let mut b = [0; 4096];
        let n = socket.read(&mut b).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&b[..n]);
        if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8(bytes[..i].to_vec()).unwrap();
            let len: usize = head
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(|s| s.parse().unwrap())
                })
                .unwrap();
            if bytes.len() >= i + 4 + len {
                return (
                    head,
                    serde_json::from_slice(&bytes[i + 4..i + 4 + len]).unwrap(),
                );
            }
        }
    }
}
async fn server(bytes: Vec<u8>) -> (ProviderClient, tokio::task::JoinHandle<(String, Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api/chat", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let req = wire(&mut socket).await;
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).as_bytes()).await.unwrap();
        for chunk in bytes.chunks(7) {
            if socket.write_all(chunk).await.is_err() {
                break;
            }
        }
        req
    });
    (
        ProviderClient::with_wire(
            Endpoint::responses(&url, Some("private-key")).unwrap(),
            WireApi::OllamaChat,
            Duration::from_secs(5),
            1024 * 1024,
        )
        .unwrap(),
        task,
    )
}

fn frame(message: Value, done: bool) -> Value {
    let mut v = json!({"model":"fixture:latest","message":message,"done":done});
    if done {
        v["done_reason"] = json!("stop");
        v["prompt_eval_count"] = json!(10);
        v["prompt_eval_cached_count"] = json!(2);
        v["eval_count"] = json!(4);
    }
    v
}
fn ndjson(events: &[Value]) -> Vec<u8> {
    events
        .iter()
        .map(|v| format!("{v}\n"))
        .collect::<String>()
        .into_bytes()
}
#[tokio::test]
async fn fragmented_native_calls_reasoning_usage_and_ordered_continuation() {
    let frames = vec![
        frame(
            json!({"role":"assistant","content":"hel","thinking":"private € "}),
            false,
        ),
        frame(
            json!({"role":"assistant","content":"lo","thinking":"reasoning","tool_calls":[{"function":{"index":0,"name":"read_source","arguments":{"path":"a"}}}]}),
            false,
        ),
        frame(
            json!({"role":"assistant","tool_calls":[{"function":{"index":1,"name":"read_source","arguments":"{\"path\":\"b\"}"}}]}),
            true,
        ),
    ];
    let (client, task) = server(ndjson(&frames)).await;
    let mut progress = vec![];
    let result = client
        .complete_with_progress(&request(), CancellationToken::new(), |p| progress.push(p))
        .await
        .unwrap();
    assert_eq!(result.status, CompletionStatus::Completed);
    assert!(result.usage_is_final);
    let u = result.usage.as_ref().unwrap();
    assert_eq!(
        (u.input_tokens, u.cached_input_tokens, u.output_tokens),
        (10, 2, 4)
    );
    assert_eq!(
        result.content[0],
        Content::Text {
            text: "hello".into()
        }
    );
    assert!(!format!("{:?}", result.content).contains("private €"));
    assert!(
        progress
            .iter()
            .any(|p| matches!(p,ProviderProgress::ReasoningDelta{text,..} if text=="private € "))
    );
    let (headers, body) = task.await.unwrap();
    assert!(headers.starts_with("POST /api/chat "));
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("authorization: bearer private-key")
    );
    assert_eq!(body["options"]["num_predict"], 64);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(
        body["tools"][0]["function"]["parameters"],
        request().tools[0].parameters
    );
    assert!(body.get("stream_options").is_none());
    let ids: Vec<_> = result
        .content
        .iter()
        .filter_map(|c| match c {
            Content::ToolCall { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
    let mut next = request();
    next.input.extend(result.replay.clone());
    for id in &ids {
        next.input
            .push(json!({"type":"function_call_output","call_id":id,"output":"result"}));
    }
    let (client, task) = server(ndjson(&[frame(
        json!({"role":"assistant","content":"done"}),
        true,
    )]))
    .await;
    let final_reply = client
        .complete(&next, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(final_reply.status, CompletionStatus::Completed);
    let (_, wire) = task.await.unwrap();
    assert_eq!(wire["messages"][2]["thinking"], "private € reasoning");
    assert_eq!(
        wire["messages"][2]["tool_calls"][1]["function"]["arguments"],
        json!({"path":"b"})
    );
    assert_eq!(
        wire["messages"][3],
        json!({"role":"tool","tool_name":"read_source","content":"result"})
    );
    assert_eq!(wire["messages"][4]["tool_name"], "read_source");
    for mutation in 0..6 {
        let mut bad = next.clone();
        match mutation {
            0 => bad.model = "other".into(),
            1 => bad.input[1]["call_ids"][0] = json!("forged"),
            2 => bad.input[1]["message"]["images"] = json!(["forbidden"]),
            3 => bad.input.swap(2, 3),
            4 => {
                bad.input.pop();
            }
            _ => {
                bad.input[1]["message"]["tool_calls"][0]["function"]["arguments"] =
                    json!("bad json")
            }
        };
        assert!(client.validate(&bad).is_err(), "{mutation}");
    }
}
#[tokio::test]
async fn malformed_terminal_usage_and_trailing_frames_never_authorize_calls() {
    let valid = frame(
        json!({"role":"assistant","tool_calls":[{"function":{"name":"read_source","arguments":{}}}]}),
        true,
    );
    let mut cases = vec![
        ndjson(&[valid.clone(), valid.clone()]),
        ndjson(&[frame(
            json!({"role":"assistant","content":"unfinished"}),
            false,
        )]),
        serde_json::to_vec(&valid).unwrap(),
        ndjson(&[json!({"error":"server-side failure"})]),
    ];
    for key in ["prompt_eval_count", "eval_count"] {
        let mut v = valid.clone();
        v.as_object_mut().unwrap().remove(key);
        cases.push(ndjson(&[v]));
        let mut v = valid.clone();
        v[key] = json!(-1);
        cases.push(ndjson(&[v]));
    }
    for (key, value) in [
        ("done_reason", json!("length")),
        ("done_reason", json!("unknown")),
        ("prompt_eval_cached_count", json!(11)),
    ] {
        let mut v = valid.clone();
        v[key] = value;
        cases.push(ndjson(&[v]));
    }
    let mut bad = valid.clone();
    bad["message"]["tool_calls"][0]["function"]["arguments"] = json!("{bad}");
    cases.push(ndjson(&[bad]));
    let indexed = frame(
        json!({"role":"assistant","tool_calls":[{"function":{"index":0,"name":"read_source","arguments":{}}}]}),
        false,
    );
    let mut duplicated = valid.clone();
    duplicated["message"]["tool_calls"][0]["function"]["index"] = json!(0);
    cases.push(ndjson(&[indexed, duplicated]));
    for bytes in cases {
        let (client, task) = server(bytes).await;
        let result = client
            .complete(&request(), CancellationToken::new())
            .await
            .unwrap();
        assert_ne!(result.status, CompletionStatus::Completed);
        assert!(!result.usage_is_final);
        assert!(result.content.is_empty());
        task.await.unwrap();
    }
}
#[tokio::test]
async fn repeated_same_call_in_later_round_gets_distinct_local_id() {
    let event = frame(
        json!({"role":"assistant","tool_calls":[{"function":{"name":"read_source","arguments":{}}}]}),
        true,
    );
    let (client, task) = server(ndjson(&[event.clone()])).await;
    let first = client
        .complete(&request(), CancellationToken::new())
        .await
        .unwrap();
    task.await.unwrap();
    let Content::ToolCall { id: first_id, .. } = &first.content[0] else {
        panic!()
    };
    let mut next = request();
    next.input.extend(first.replay.clone());
    next.input
        .push(json!({"type":"function_call_output","call_id":first_id,"output":"retry work"}));
    let (client, task) = server(ndjson(&[event])).await;
    let second = client
        .complete(&next, CancellationToken::new())
        .await
        .unwrap();
    task.await.unwrap();
    let Content::ToolCall { id: second_id, .. } = &second.content[0] else {
        panic!()
    };
    assert_ne!(first_id, second_id);
}
#[tokio::test]
async fn cancellation_after_partial_frame_keeps_accounting_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api/chat", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        wire(&mut socket).await;
        let bytes = format!(
            "{}\n{{\"model\":",
            frame(json!({"role":"assistant","content":"partial"}), false)
        );
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n",bytes.len(),bytes).as_bytes()).await.unwrap();
        let mut rest = [0; 1];
        let _ = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut rest)).await;
    });
    let client = ProviderClient::with_wire(
        Endpoint::responses(&url, None).unwrap(),
        WireApi::OllamaChat,
        Duration::from_secs(5),
        8192,
    )
    .unwrap();
    let token = CancellationToken::new();
    let cancellation = token.clone();
    let result = client
        .complete_with_progress(&request(), token, move |p| {
            if matches!(p, ProviderProgress::TextDelta { .. }) {
                cancellation.cancel();
            }
        })
        .await
        .unwrap();
    assert_eq!(result.status, CompletionStatus::Incomplete);
    assert!(!result.usage_is_final && result.content.is_empty());
    task.await.unwrap();
}
#[tokio::test]
async fn configured_response_bound_rejects_oversized_ndjson_and_endpoint_is_explicit() {
    let (client, task) = server(vec![b'x'; 1024 * 1024 + 1]).await;
    let result = client
        .complete(&request(), CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(result.status, CompletionStatus::Completed);
    assert!(result.content.is_empty());
    task.await.unwrap();
    let client = ProviderClient::with_wire(
        Endpoint::responses("http://127.0.0.1:9/v1/chat/completions", None).unwrap(),
        WireApi::OllamaChat,
        Duration::from_secs(1),
        8192,
    )
    .unwrap();
    assert!(client.validate(&request()).is_err());
}
