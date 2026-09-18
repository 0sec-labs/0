use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use zero_cloud_client::{CloudClient, CloudError, GatewayCode};
const SECRET: &str = "fixture-secret-never-print";
fn client(host: &str) -> CloudClient {
    CloudClient::new(host, SECRET, Duration::from_secs(2), 8192).unwrap()
}
async fn fixture(
    status: u16,
    headers: &str,
    body: String,
) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let headers = headers.to_owned();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut buf = [0; 2048];
            let n = stream.read(&mut buf).await.unwrap();
            assert_ne!(n, 0);
            bytes.extend_from_slice(&buf[..n]);
            if bytes.windows(4).any(|p| p == b"\r\n\r\n") {
                break;
            }
        }
        stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",body.len()).as_bytes()).await.unwrap();
        drop(stream);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "unexpected retry"
        );
        String::from_utf8(bytes).unwrap()
    });
    (host, task)
}
#[test]
fn canonical_health_routes_and_configuration_rejection() {
    for host in ["https://cloud.0sec.ai", "https://CLOUD.0.SECURITY"] {
        assert_eq!(client(host).health_path(), "/api/health");
    }
    assert_eq!(client("https://self.example").health_path(), "/health");
    for host in [
        "http://remote.example",
        "https://user:fixture-secret-never-print@host",
        "https://host/?token=fixture-secret-never-print",
        "https://host/#fixture-secret-never-print",
        "file:///tmp/x",
    ] {
        let error = CloudClient::new(host, SECRET, Duration::from_secs(1), 1024)
            .err()
            .unwrap();
        assert_eq!(error, CloudError::InvalidConfiguration);
        assert!(!format!("{error:?} {error}").contains(SECRET));
    }
    assert!(
        CloudClient::new(
            "http://127.0.0.1",
            "bad\nheader",
            Duration::from_secs(1),
            1024
        )
        .is_err()
    );
}
#[tokio::test]
async fn actual_routes_headers_and_typed_models() {
    let catalog = json!({"object":"list","data":[{"id":"hosted","object":"model","owned_by":"cloud","provider":"fixture","upstream_model":"upstream","wire_api":"responses","context_length":1000,"max_output_tokens":100,"pricing":{"input_per_million_usd":1.25,"output_per_million_usd":2.5,"cached_input_per_million_usd":0.125}}]});
    for (route, body) in [
        ("/health", json!({"status":"ok"})),
        ("/api/inference/v1/models", catalog),
        (
            "/api/inference/account",
            json!({"remainingUsd":3.25,"currency":"USD"}),
        ),
        (
            "/api/inference/usage",
            json!({"requests":[{"id":"request-one","tokens":4}]}),
        ),
    ] {
        let (host, server) = fixture(200, "", body.to_string()).await;
        let c = client(&host);
        match route {
            "/health" => assert_eq!(
                c.ping_health(CancellationToken::new())
                    .await
                    .unwrap()
                    .status,
                "ok"
            ),
            "/api/inference/v1/models" => assert_eq!(
                c.inference_models(CancellationToken::new())
                    .await
                    .unwrap()
                    .data[0]
                    .pricing
                    .input_per_million_usd
                    .to_string(),
                "1.25"
            ),
            "/api/inference/account" => assert!(
                c.inference_account(CancellationToken::new())
                    .await
                    .unwrap()
                    .credits
                    .is_none()
            ),
            _ => assert_eq!(
                c.inference_usage(CancellationToken::new())
                    .await
                    .unwrap()
                    .requests
                    .len(),
                1
            ),
        }
        let request = server.await.unwrap();
        assert!(request.starts_with(&format!("GET {route} HTTP/1.1")));
        assert!(request.contains(&format!("authorization: Bearer {SECRET}")));
        assert!(request.contains("accept: application/json"));
        assert!(request.contains("user-agent: 0sec-cli/"));
    }
}
#[tokio::test]
async fn gateway_errors_are_typed_and_never_echo_raw_codes_or_body() {
    for (status, code, expected) in [
        (401, "inference_disabled", CloudError::Unauthorized),
        (403, "insufficient_funds", CloudError::Forbidden),
        (
            503,
            "inference_disabled",
            CloudError::Http {
                status: 503,
                code: Some(GatewayCode::InferenceDisabled),
            },
        ),
        (
            402,
            "insufficient_funds",
            CloudError::Http {
                status: 402,
                code: Some(GatewayCode::InsufficientFunds),
            },
        ),
        (
            500,
            SECRET,
            CloudError::Http {
                status: 500,
                code: None,
            },
        ),
    ] {
        let (host, server) = fixture(
            status,
            "",
            json!({"error":{"code":code,"message":SECRET}}).to_string(),
        )
        .await;
        let error = client(&host)
            .ping_health(CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error, expected);
        assert!(!format!("{error:?} {error}").contains(SECRET));
        server.await.unwrap();
    }
}
#[tokio::test]
async fn credit_normalization_preserves_service_values_without_deriving_percent() {
    for (credits, valid, percent, reset) in [
        (
            json!({"featureId":"credits","granted":100,"remaining":50}),
            true,
            None,
            None,
        ),
        (
            json!({"featureId":"credits","granted":100,"remaining":50,"remainingPercent":7,"nextResetAt":1234.0}),
            true,
            Some(7),
            Some(1234),
        ),
        (
            json!({"featureId":"credits","granted":100,"remaining":0,"remainingPercent":0}),
            true,
            Some(0),
            None,
        ),
        (
            json!({"featureId":"credits","granted":0,"remaining":0,"remainingPercent":80,"nextResetAt":8.65e15}),
            true,
            None,
            None,
        ),
        (
            json!({"featureId":"credits","granted":null,"remaining":5,"remainingPercent":50}),
            true,
            None,
            None,
        ),
        (
            json!({"featureId":"credits","remaining":5,"remainingPercent":50}),
            false,
            None,
            None,
        ),
        (
            json!({"featureId":"credits","granted":100,"remaining":-1}),
            false,
            None,
            None,
        ),
    ] {
        let (host, server) = fixture(
            200,
            "",
            json!({"remainingUsd":12,"currency":"USD","credits":credits}).to_string(),
        )
        .await;
        let account = client(&host)
            .inference_account(CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(account.credits.is_some(), valid);
        if let Some(credit) = account.credits {
            assert_eq!(credit.remaining_percent.and_then(|n| n.as_u64()), percent);
            assert_eq!(credit.next_reset_at, reset);
        }
        server.await.unwrap();
    }
}
#[tokio::test]
async fn redirect_destination_never_receives_credentials() {
    let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let location = format!(
        "Location: http://{}/secret\r\n",
        destination.local_addr().unwrap()
    );
    let (host, server) = fixture(307, &location, "{}".into()).await;
    assert_eq!(
        client(&host)
            .ping_health(CancellationToken::new())
            .await
            .unwrap_err(),
        CloudError::Http {
            status: 307,
            code: None
        }
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), destination.accept())
            .await
            .is_err()
    );
    server.await.unwrap();
}
#[tokio::test]
async fn finite_response_limit_and_invalid_catalog_fail_closed() {
    let (host, server) = fixture(200, "", "x".repeat(8193)).await;
    assert_eq!(
        client(&host)
            .ping_health(CancellationToken::new())
            .await
            .unwrap_err(),
        CloudError::ResponseLimit
    );
    server.await.unwrap();
    let (host, server) = fixture(
        200,
        "",
        json!({"object":"list","data":[{"id":SECRET}]}).to_string(),
    )
    .await;
    let error = client(&host)
        .inference_models(CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error, CloudError::InvalidResponse);
    assert!(!format!("{error:?}").contains(SECRET));
    server.await.unwrap();
}
#[tokio::test]
async fn cancellation_and_absolute_deadline_stop_waiting_on_live_connection() {
    for cancel in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let (ready_tx, ready) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut b = [0; 4096];
            socket.read(&mut b).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{").await.unwrap();
            ready_tx.send(()).unwrap();
            let _ = release_rx.await;
        });
        let token = CancellationToken::new();
        let copy = token.clone();
        let c = CloudClient::new(
            &host,
            SECRET,
            Duration::from_millis(if cancel { 2000 } else { 100 }),
            1024,
        )
        .unwrap();
        let task = tokio::spawn(async move { c.ping_health(copy).await });
        ready.await.unwrap();
        if cancel {
            token.cancel();
        }
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(
            error,
            if cancel {
                CloudError::Cancelled
            } else {
                CloudError::Timeout
            }
        );
        release.send(()).unwrap();
        server.await.unwrap();
    }
}
