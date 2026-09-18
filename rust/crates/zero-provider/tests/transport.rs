//! Real local TCP fixtures: no provider accounts, credentials or paid requests.
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use zero_provider::{CompletionStatus, Endpoint, ProviderClient, ResponsesRequest, TransportError};

const KEY: &str = "fixture-private-credential-never-display";

fn request() -> ResponsesRequest {
    ResponsesRequest {
        model: "fixture-model".into(),
        instructions: "fixture instruction".into(),
        input: vec![json!({"role":"user","content":"fixture input"})],
        tools: vec![],
        max_output_tokens: 32,
    }
}

fn client(url: &str, timeout: Duration, cap: usize) -> ProviderClient {
    ProviderClient::new(Endpoint::responses(url, Some(KEY)).unwrap(), timeout, cap).unwrap()
}

async fn listener() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/custom/responses", listener.local_addr().unwrap());
    (listener, url)
}

async fn read_request(socket: &mut TcpStream) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 2048];
            let size = socket.read(&mut chunk).await.unwrap();
            assert_ne!(size, 0, "connection closed before request body");
            bytes.extend_from_slice(&chunk[..size]);
            assert!(bytes.len() < 1024 * 1024);
            if let Some(boundary) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..boundary]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= boundary + 4 + length {
                    return bytes;
                }
            }
        }
    })
    .await
    .unwrap()
}

/// The fixture stays connected until the test explicitly releases it, avoiding
/// accidental EOF being mistaken for cancellation/deadline enforcement.
async fn held_stream(
    headers: bool,
    heartbeat: bool,
) -> (
    String,
    oneshot::Receiver<()>,
    oneshot::Sender<()>,
    JoinHandle<Vec<u8>>,
) {
    let (listener, url) = listener().await;
    let (ready_tx, ready) = oneshot::channel();
    let (release, mut release_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let wire = read_request(&mut socket).await;
        if headers {
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n: connected\n\n").await.unwrap();
        }
        let _ = ready_tx.send(());
        let mut tick = tokio::time::interval(Duration::from_millis(10));
        loop {
            tokio::select! {
                _ = &mut release_rx => break,
                _ = tick.tick(), if heartbeat => {
                    // Keep the listener alive even if a cancelled client closes.
                    let _ = socket.write_all(b": heartbeat\n\n").await;
                }
            }
        }
        wire
    });
    (url, ready, release, task)
}

async fn fixed_response(
    status: &str,
    headers: &str,
    body: String,
) -> (String, JoinHandle<(Vec<u8>, usize)>) {
    let (listener, url) = listener().await;
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
        body.len()
    );
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let wire = read_request(&mut socket).await;
        let _ = socket.write_all(reply.as_bytes()).await;
        drop(socket);
        let mut requests = 1;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(200);
        while let Ok(Ok((mut socket, _))) =
            tokio::time::timeout_at(deadline, listener.accept()).await
        {
            requests += 1;
            let _ = read_request(&mut socket).await;
            let _ = socket.write_all(reply.as_bytes()).await;
        }
        (wire, requests)
    });
    (url, task)
}

fn redacted(error: &str) {
    assert!(!error.contains(KEY), "credential appeared in error");
    assert!(!error.contains("fixture input"), "prompt appeared in error");
}

#[tokio::test]
async fn cancellation_before_headers_stops_without_waiting_for_server() {
    let (url, ready, release, server) = held_stream(false, false).await;
    let cancellation = CancellationToken::new();
    let token = cancellation.clone();
    let run = tokio::spawn(async move {
        client(&url, Duration::from_secs(5), 8192)
            .responses(&request(), token)
            .await
    });
    ready.await.unwrap();
    cancellation.cancel();
    let error = tokio::time::timeout(Duration::from_secs(1), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(matches!(error, TransportError::Cancelled));
    redacted(&format!("{error:?} {error}"));
    release.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn cancellation_of_live_sse_returns_incomplete_without_tools() {
    let (url, ready, release, server) = held_stream(true, true).await;
    let cancellation = CancellationToken::new();
    let token = cancellation.clone();
    let run = tokio::spawn(async move {
        client(&url, Duration::from_secs(5), 8192)
            .responses(&request(), token)
            .await
    });
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    cancellation.cancel();
    let completion = tokio::time::timeout(Duration::from_secs(1), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(completion.status, CompletionStatus::Incomplete);
    assert!(completion.content.is_empty());
    assert!(completion.usage.is_none());
    let error = completion.error.unwrap();
    assert!(error.contains("cancelled"));
    redacted(&error);
    release.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn absolute_deadline_expires_despite_sse_heartbeats() {
    let (url, ready, release, server) = held_stream(true, true).await;
    let run = tokio::spawn(async move {
        client(&url, Duration::from_millis(100), 8192)
            .responses(&request(), CancellationToken::new())
            .await
    });
    ready.await.unwrap();
    let completion = tokio::time::timeout(Duration::from_secs(1), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(completion.status, CompletionStatus::Incomplete);
    assert!(completion.content.is_empty());
    assert!(completion.error.unwrap().contains("deadline"));
    release.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn deadline_before_headers_is_explicit_transport_timeout() {
    let (url, ready, release, server) = held_stream(false, false).await;
    let run = tokio::spawn(async move {
        client(&url, Duration::from_millis(100), 8192)
            .responses(&request(), CancellationToken::new())
            .await
    });
    ready.await.unwrap();
    let error = tokio::time::timeout(Duration::from_secs(1), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(matches!(error, TransportError::Timeout));
    release.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn response_limit_stops_stream_and_never_promotes_partial_content() {
    let (url, server) = fixed_response(
        "200 OK",
        "Content-Type: text/event-stream\r\n",
        format!(": {}\n\n", "x".repeat(2048)),
    )
    .await;
    let completion = client(&url, Duration::from_secs(2), 1024)
        .responses(&request(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(completion.status, CompletionStatus::Incomplete);
    assert!(completion.content.is_empty());
    assert!(completion.error.unwrap().contains("limit"));
    assert_eq!(server.await.unwrap().1, 1);
}

#[tokio::test]
async fn unexpected_content_type_rejects_even_valid_looking_sse() {
    let (url, server) = fixed_response(
        "200 OK",
        "Content-Type: application/json\r\n",
        format!("{{\"error\":\"{KEY}\"}}"),
    )
    .await;
    let error = client(&url, Duration::from_secs(2), 8192)
        .responses(&request(), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(error, TransportError::InvalidResponse));
    redacted(&format!("{error:?} {error}"));
    assert_eq!(server.await.unwrap().1, 1);
}

#[tokio::test]
async fn redirect_does_not_contact_location_or_forward_credentials() {
    let (destination, destination_url) = listener().await;
    let (url, server) = fixed_response(
        "307 Temporary Redirect",
        &format!("Location: {destination_url}\r\n"),
        String::new(),
    )
    .await;
    let error = client(&url, Duration::from_secs(2), 8192)
        .responses(&request(), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(error, TransportError::Http(307)));
    assert!(
        tokio::time::timeout(Duration::from_millis(200), destination.accept())
            .await
            .is_err(),
        "redirect destination was contacted"
    );
    let (wire, count) = server.await.unwrap();
    assert!(
        String::from_utf8(wire)
            .unwrap()
            .contains(&format!("authorization: Bearer {KEY}"))
    );
    assert_eq!(count, 1);
    redacted(&format!("{error:?} {error}"));
}

#[tokio::test]
async fn throttling_and_server_failure_are_not_retried_or_body_echoed() {
    for status in ["429 Too Many Requests", "503 Service Unavailable"] {
        let (url, server) = fixed_response(
            status,
            "Retry-After: 0\r\nContent-Type: application/json\r\n",
            format!("{{\"error\":\"{KEY} fixture input\"}}"),
        )
        .await;
        let error = client(&url, Duration::from_secs(2), 8192)
            .responses(&request(), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(error, TransportError::Http(429 | 503)));
        redacted(&format!("{error:?} {error}"));
        assert_eq!(server.await.unwrap().1, 1);
    }
}

#[tokio::test]
async fn provider_stream_error_never_echoes_raw_message_or_credentials() {
    let event = json!({"type":"error","message":format!("{KEY} fixture input"),"code":"fixture"});
    let (url, server) = fixed_response(
        "200 OK",
        "Content-Type: text/event-stream\r\n",
        format!("data: {event}\n\n"),
    )
    .await;
    let completion = client(&url, Duration::from_secs(2), 8192)
        .responses(&request(), CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(completion.status, CompletionStatus::Completed);
    assert!(completion.content.is_empty());
    redacted(completion.error.as_ref().unwrap());
    assert_eq!(server.await.unwrap().1, 1);
}
