//! Deterministic loopback Gemini wire fixtures, never live or paid inference.
#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use tokio_util::sync::CancellationToken;
use zero_provider::{
    CompletionStatus, Content, Endpoint, ProviderClient, ProviderProgress, ResponsesRequest,
    WireApi,
};
fn request() -> ResponsesRequest {
    ResponsesRequest {
        model: "gemini-fixture".into(),
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
fn usage() -> Value {
    json!({"promptTokenCount":10,"candidatesTokenCount":4,"thoughtsTokenCount":3,"cachedContentTokenCount":2,"totalTokenCount":17})
}
fn event(parts: Value, reason: Option<&str>) -> Value {
    let mut v = json!({"responseId":"response-A","modelVersion":"gemini-fixture-001","candidates":[{"index":0,"content":{"role":"model","parts":parts}}]});
    if let Some(r) = reason {
        v["candidates"][0]["finishReason"] = json!(r);
        v["usageMetadata"] = usage();
    }
    v
}
fn sse(values: &[Value]) -> Vec<u8> {
    values
        .iter()
        .map(|v| format!("data: {v}\r\n\r\n"))
        .collect::<String>()
        .into_bytes()
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
    let url = format!(
        "http://{}/gateway/models/gemini-fixture:streamGenerateContent",
        listener.local_addr().unwrap()
    );
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let req = wire(&mut socket).await;
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).as_bytes()).await.unwrap();
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
            WireApi::GoogleGenerateContent,
            Duration::from_secs(5),
            1024 * 1024,
        )
        .unwrap(),
        task,
    )
}

#[tokio::test]
async fn signed_parallel_calls_exact_replay_and_thinking_accounted_once() {
    let parts = json!([{"text":"thinking €","thought":true,"thoughtSignature":"opaque-secret-signature"},{"functionCall":{"name":"read_source","args":{"path":"a"}},"thoughtSignature":"signed-first"},{"functionCall":{"id":"upstream-2","name":"read_source","args":{"path":"b"}}}]);
    let (client, task) = server(sse(&[event(parts.clone(), Some("STOP"))])).await;
    let mut progress = Vec::new();
    let result = client
        .complete_with_progress(&request(), CancellationToken::new(), |p| progress.push(p))
        .await
        .unwrap();
    assert_eq!(result.status, CompletionStatus::Completed);
    assert!(result.error.is_none() && result.usage_is_final);
    let u = result.usage.as_ref().unwrap();
    assert_eq!(
        (u.input_tokens, u.output_tokens, u.cached_input_tokens),
        (10, 7, 2)
    );
    assert_eq!(
        zero_provider::Rates {
            input: 1_000_000,
            cached_input: 0,
            output: 1_000_000
        }
        .charge(u),
        Some(15)
    );
    assert_eq!(result.content.len(), 2);
    assert!(
        progress
            .iter()
            .any(|p| matches!(p,ProviderProgress::ReasoningDelta{text,..} if text=="thinking €"))
    );
    assert!(
        !serde_json::to_string(&progress)
            .unwrap()
            .contains("opaque-secret-signature")
    );
    let (headers, body) = task.await.unwrap();
    let headers = headers.to_ascii_lowercase();
    assert!(
        headers.starts_with("post /gateway/models/gemini-fixture:streamgeneratecontent?alt=sse ")
    );
    assert!(headers.contains("x-goog-api-key: private-key"));
    assert!(!headers.contains("authorization:") && !headers.contains("\r\napi-key:"));
    assert_eq!(
        body["generationConfig"],
        json!({"candidateCount":1,"maxOutputTokens":64})
    );
    assert_eq!(
        body["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"],
        request().tools[0].parameters
    );
    let mut next = request();
    next.input.extend(result.replay.clone());
    let ids: Vec<_> = result
        .content
        .iter()
        .map(|c| {
            if let Content::ToolCall { id, .. } = c {
                id.clone()
            } else {
                panic!()
            }
        })
        .collect();
    assert_eq!(ids, vec!["google:response-A:0", "upstream-2"]);
    for id in &ids {
        next.input
            .push(json!({"type":"function_call_output","call_id":id,"output":"exact result"}));
    }
    let (client, task) = server(sse(&[event(json!([{"text":"done"}]), Some("STOP"))])).await;
    let second = client
        .complete(&next, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(second.status, CompletionStatus::Completed);
    let (_, body) = task.await.unwrap();
    assert_eq!(body["contents"][1], json!({"role":"model","parts":parts}));
    assert!(
        body["contents"][2]["parts"][0]["functionResponse"]
            .get("id")
            .is_none()
    );
    assert_eq!(
        body["contents"][2]["parts"][1]["functionResponse"]["id"],
        "upstream-2"
    );
    for mutation in 0..5 {
        let mut bad = next.clone();
        match mutation {
            0 => bad.model = "other".into(),
            1 => bad.input[1]["call_ids"][0] = json!("forged"),
            2 => bad.input[1]["content"]["parts"][0]["inlineData"] = json!({}),
            3 => bad.input[2]["call_id"] = json!("unknown"),
            _ => {
                bad.input.pop();
            }
        }
        assert!(client.validate(&bad).is_err(), "mutation {mutation}");
    }
}

#[tokio::test]
async fn incomplete_duplicate_malformed_and_unrepresentable_usage_never_settle_or_dispatch() {
    let tool = json!([{"functionCall":{"name":"read_source","args":{"path":"a"}}}]);
    let valid = event(tool.clone(), Some("STOP"));
    let mut cases = vec![
        vec![event(tool.clone(), None)],
        vec![valid.clone(), valid.clone()],
    ];
    for key in [
        "thoughtsTokenCount",
        "candidatesTokenCount",
        "totalTokenCount",
        "cachedContentTokenCount",
    ] {
        let mut v = valid.clone();
        v["usageMetadata"][key] = json!(-1);
        cases.push(vec![v]);
    }
    let mut v = valid.clone();
    v["usageMetadata"]["totalTokenCount"] = json!(14);
    cases.push(vec![v]);
    let mut v = valid.clone();
    v["usageMetadata"]["toolUsePromptTokenCount"] = json!(1);
    cases.push(vec![v]);
    let mut v = valid.clone();
    let duplicate = v["candidates"][0].clone();
    v["candidates"].as_array_mut().unwrap().push(duplicate);
    cases.push(vec![v]);
    let mut v = valid.clone();
    v["candidates"][0]["content"]["parts"][0]["functionCall"]["partialArgs"] = json!([]);
    cases.push(vec![v]);
    for values in cases {
        let (client, task) = server(sse(&values)).await;
        let result = client
            .complete(&request(), CancellationToken::new())
            .await
            .unwrap();
        assert_ne!(result.status, CompletionStatus::Completed);
        assert!(result.content.is_empty() && !result.usage_is_final);
        task.await.unwrap();
    }
    for reason in ["MAX_TOKENS", "SAFETY", "MALFORMED_FUNCTION_CALL"] {
        let (client, task) = server(sse(&[event(tool.clone(), Some(reason))])).await;
        let result = client
            .complete(&request(), CancellationToken::new())
            .await
            .unwrap();
        assert_ne!(result.status, CompletionStatus::Completed);
        assert!(result.content.is_empty() && result.usage_is_final);
        task.await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_and_absolute_deadline_drop_connection_without_retry() {
    for deadline in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/models/gemini-fixture:streamGenerateContent",
            listener.local_addr().unwrap()
        );
        let (ready_tx, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            wire(&mut socket).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            socket
                .write_all(&sse(&[event(
                    json!([{"functionCall":{"name":"read_source","args":{}}}]),
                    None,
                )]))
                .await
                .unwrap();
            ready_tx.send(()).unwrap();
            let mut b = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(5), socket.read(&mut b))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        let client = ProviderClient::with_wire(
            Endpoint::responses(&url, None).unwrap(),
            WireApi::GoogleGenerateContent,
            Duration::from_millis(if deadline { 300 } else { 5000 }),
            65536,
        )
        .unwrap();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let inference = tokio::spawn(async move { client.complete(&request(), token).await });
        ready.await.unwrap();
        if !deadline {
            cancel.cancel();
        }
        let result = inference.await.unwrap();
        match result {
            Ok(result) => assert!(
                !result.usage_is_final && result.content.is_empty() && result.error.is_some()
            ),
            Err(e) => assert!(matches!(
                e,
                zero_provider::TransportError::Cancelled | zero_provider::TransportError::Timeout
            )),
        }
        task.await.unwrap();
    }
}

#[test]
fn endpoint_model_and_authentication_are_explicit() {
    let url = "https://gateway.example/prefix/models/gemini-fixture:streamGenerateContent";
    let client = ProviderClient::with_wire(
        Endpoint::responses(url, Some("key")).unwrap(),
        WireApi::GoogleGenerateContent,
        Duration::from_secs(1),
        65536,
    )
    .unwrap();
    assert!(client.validate(&request()).is_ok());
    for model in [
        "other-model",
        "../gemini-fixture",
        "gemini-fixture?key=secret",
        "models/gemini-fixture",
    ] {
        let mut r = request();
        r.model = model.into();
        assert!(client.validate(&r).is_err());
    }
    for endpoint in [
        format!("{url}?alt=sse"),
        format!("{url}?key=secret"),
        "http://public.example/models/gemini-fixture:streamGenerateContent".into(),
    ] {
        assert!(Endpoint::responses(&endpoint, Some("key")).is_err());
    }
    for endpoint in [
        Endpoint::azure_api_key(url, "key").unwrap(),
        Endpoint::github_copilot(url, "key").unwrap(),
    ] {
        assert!(
            ProviderClient::with_wire(
                endpoint,
                WireApi::GoogleGenerateContent,
                Duration::from_secs(1),
                65536
            )
            .is_err()
        );
    }
    let mut r = request();
    r.input.push(json!({"type":"anthropic_message","model":"gemini-fixture","message":{"role":"assistant","content":[]}}));
    assert!(client.validate(&r).is_err());
    let mut r = request();
    r.input[0]["content"] = json!([{"type":"input_image","image_url":"https://target.example"}]);
    assert!(client.validate(&r).is_err());
}

#[tokio::test]
async fn missing_usage_oversize_and_partial_tail_keep_original_reservation_unknown() {
    let mut final_event = event(json!([{"text":"hello"}]), Some("STOP"));
    final_event.as_object_mut().unwrap().remove("usageMetadata");
    let (client, task) = server(sse(&[final_event])).await;
    let result = client
        .complete(&request(), CancellationToken::new())
        .await
        .unwrap();
    assert!(!result.usage_is_final && result.usage.is_none() && result.error.is_some());
    task.await.unwrap();
    let mut bytes = sse(&[event(json!([{"text":"done"}]), Some("STOP"))]);
    bytes.extend_from_slice(b"data: {\"unfinished\":");
    let (client, task) = server(bytes).await;
    let result = client
        .complete(&request(), CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(result.status, CompletionStatus::Completed);
    assert!(!result.usage_is_final);
    task.await.unwrap();
    let (client, task) = server(sse(&[event(
        json!([{"text":"x".repeat(4096)}]),
        Some("STOP"),
    )]))
    .await;
    let client = ProviderClient::with_wire(
        Endpoint::responses(client.endpoint_identity(), None).unwrap(),
        WireApi::GoogleGenerateContent,
        Duration::from_secs(5),
        1024,
    )
    .unwrap();
    let result = client
        .complete(&request(), CancellationToken::new())
        .await
        .unwrap();
    assert!(!result.usage_is_final && result.error.as_deref().unwrap().contains("limit"));
    task.await.unwrap();
}

#[tokio::test]
async fn tool_ids_remain_unique_across_separate_stream_frames() {
    for duplicate in [false, true] {
        let mut call = json!({"name":"read_source","args":{"path":"a"}});
        if duplicate {
            call["id"] = json!("same-upstream-id");
        }
        let frames = [
            event(json!([{"functionCall":call}]), None),
            event(json!([{"functionCall":call}]), Some("STOP")),
        ];
        let (client, task) = server(sse(&frames)).await;
        let result = client
            .complete(&request(), CancellationToken::new())
            .await
            .unwrap();
        if duplicate {
            assert!(!result.usage_is_final && result.content.is_empty());
        } else {
            assert_eq!(result.status, CompletionStatus::Completed);
            let ids: Vec<_> = result
                .content
                .iter()
                .filter_map(|item| {
                    if let Content::ToolCall { id, .. } = item {
                        Some(id.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(ids, vec!["google:response-A:0", "google:response-A:1"]);
        }
        task.await.unwrap();
    }
}
