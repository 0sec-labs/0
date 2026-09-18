#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use zero_cloud_client::{LoginError, LoginOptions, LoginSession};
fn options() -> LoginOptions {
    LoginOptions {
        interval: Duration::from_millis(1),
        attempts: 10,
        deadline: Duration::from_secs(2),
        request_timeout: Duration::from_millis(500),
        max_response_bytes: 1024,
    }
}
async fn fixture(
    replies: Vec<(u16, String)>,
) -> (LoginSession, tokio::task::JoinHandle<TcpListener>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let session = LoginSession::new(
        &format!("http://{}/prefix", listener.local_addr().unwrap()),
        options(),
    )
    .unwrap();
    let nonce = session
        .browser_url()
        .split("?session=")
        .nth(1)
        .unwrap()
        .to_owned();
    assert_eq!(nonce.len(), 12);
    assert!(
        nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    );
    let task = tokio::spawn(async move {
        for (status, body) in replies {
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut b = [0; 1024];
                let n = socket.read(&mut b).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&b[..n]);
            }
            let header = String::from_utf8(bytes).unwrap();
            assert!(header.starts_with(&format!(
                "GET /prefix/cli-auth/sessions/{nonce} HTTP/1.1\r\n"
            )));
            assert!(!header.to_ascii_lowercase().contains("authorization:"));
            assert!(!header.contains("fixture-secret"));
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
        listener
    });
    (session, task)
}
async fn no_further_requests(task: tokio::task::JoinHandle<TcpListener>) {
    let listener = task.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn exact_legacy_pending_routes_reach_ready_and_return_in_memory_credential() {
    let (session, server) = fixture(vec![
        (200, r#"{"status":"pending"}"#.into()),
        (202, "".into()),
        (204, "".into()),
        (404, "".into()),
        (200, r#"{"status":"ready","token":"fixture-secret"}"#.into()),
    ])
    .await;
    assert!(session.browser_url().contains("/prefix/cli-auth?session="));
    let credential = session.wait(CancellationToken::new()).await.unwrap();
    assert_eq!(credential.expose_token(), "fixture-secret");
    assert!(credential.host().ends_with("/prefix"));
    no_further_requests(server).await;
}
#[tokio::test]
async fn supports_access_token_and_absent_status_legacy_response() {
    for body in [
        r#"{"access_token":"fixture-secret"}"#,
        r#"{"status":"ready","token":"bad token","access_token":"fixture-secret"}"#,
    ] {
        let (s, t) = fixture(vec![(200, body.into())]).await;
        assert_eq!(
            s.wait(CancellationToken::new())
                .await
                .unwrap()
                .expose_token(),
            "fixture-secret"
        );
        no_further_requests(t).await;
    }
}
#[tokio::test]
async fn rejects_credentials_before_ready_malformed_responses_and_expiry_without_leaks() {
    for (status, body, expected) in [
        (
            200,
            r#"{"status":"pending","token":"fixture-secret"}"#,
            LoginError::InvalidResponse,
        ),
        (
            200,
            r#"{"status":"expired","token":"fixture-secret"}"#,
            LoginError::InvalidResponse,
        ),
        (
            200,
            r#"{"status":"unknown","token":"fixture-secret"}"#,
            LoginError::InvalidResponse,
        ),
        (
            200,
            r#"{"status":"ready","token":"bad secret"}"#,
            LoginError::InvalidResponse,
        ),
        (
            200,
            "fixture-secret invalid JSON",
            LoginError::InvalidResponse,
        ),
        (200, r#"{"status":"expired"}"#, LoginError::Expired),
        (410, "fixture-secret", LoginError::Expired),
    ] {
        let (s, t) = fixture(vec![(status, body.into())]).await;
        let error = s.wait(CancellationToken::new()).await.err().unwrap();
        assert_eq!(error, expected);
        assert!(!format!("{error:?} {error}").contains("secret"));
        no_further_requests(t).await;
    }
}
#[tokio::test]
async fn errors_are_terminal_including_rate_limit_and_service_outage() {
    for status in [301, 401, 403, 429, 500, 503] {
        let (s, t) = fixture(vec![(status, "fixture-secret body".into())]).await;
        let error = s.wait(CancellationToken::new()).await.err().unwrap();
        assert_eq!(error, LoginError::Http { status });
        assert_eq!(error.recoverable(), status == 429 || status >= 500);
        assert!(!error.to_string().contains("secret"));
        no_further_requests(t).await;
    }
}
#[tokio::test]
async fn redirect_location_is_never_contacted() {
    let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let s = LoginSession::new(
        &format!("http://{}", origin.local_addr().unwrap()),
        options(),
    )
    .unwrap();
    let location = format!("http://{}/secret", destination.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = origin.accept().await.unwrap();
        let mut b = [0; 4096];
        socket.read(&mut b).await.unwrap();
        socket
            .write_all(
                format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
    });
    assert_eq!(
        s.wait(CancellationToken::new()).await.err().unwrap(),
        LoginError::Http { status: 302 }
    );
    task.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), destination.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn bounded_body_poll_budget_and_cancelled_sleep() {
    let (s, t) = fixture(vec![(200, "x".repeat(1025))]).await;
    assert_eq!(
        s.wait(CancellationToken::new()).await.err().unwrap(),
        LoginError::ResponseLimit
    );
    no_further_requests(t).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = options();
    config.interval = Duration::from_secs(1);
    let s = LoginSession::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        config,
    )
    .unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(s.wait(cancel).await.err().unwrap(), LoginError::Cancelled);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
    let mut config = options();
    config.deadline = Duration::from_millis(10);
    config.interval = Duration::from_secs(1);
    let s = LoginSession::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        config,
    )
    .unwrap();
    assert_eq!(
        s.wait(CancellationToken::new()).await.err().unwrap(),
        LoginError::Timeout
    );
}
#[tokio::test]
async fn cancellation_and_deadline_interrupt_stalled_body() {
    for cancel_it in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = options();
        config.request_timeout = Duration::from_millis(40);
        let s = LoginSession::new(
            &format!("http://{}", listener.local_addr().unwrap()),
            config,
        )
        .unwrap();
        let cancel = CancellationToken::new();
        let control = cancel.clone();
        let task = tokio::spawn(async move { s.wait(cancel).await });
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut b = [0; 4096];
        socket.read(&mut b).await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
            .await
            .unwrap();
        if cancel_it {
            control.cancel();
        }
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap();
        assert_eq!(
            error,
            if cancel_it {
                LoginError::Cancelled
            } else {
                LoginError::Timeout
            }
        );
    }
}
#[test]
fn bad_hosts_and_unbounded_options_fail_without_exposing_inputs() {
    for host in [
        "http://example.com",
        "https://user:secret@example.com",
        "https://example.com?secret",
        "https://example.com#secret",
        "file:///secret",
    ] {
        assert!(matches!(
            LoginSession::new(host, options()),
            Err(LoginError::InvalidConfiguration)
        ));
    }
    let mut config = options();
    config.attempts = 151;
    assert!(matches!(
        LoginSession::new("https://example.com", config),
        Err(LoginError::InvalidConfiguration)
    ));
}

#[tokio::test]
async fn pending_attempt_budget_and_network_failures_do_not_restart_session() {
    for network_failure in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = options();
        config.attempts = if network_failure { 10 } else { 1 };
        let session = LoginSession::new(
            &format!("http://{}", listener.local_addr().unwrap()),
            config,
        )
        .unwrap();
        let task = tokio::spawn(async move { session.wait(CancellationToken::new()).await });
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 4096];
        socket.read(&mut bytes).await.unwrap();
        if !network_failure {
            socket
                .write_all(
                    b"HTTP/1.1 202 Pending\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        }
        drop(socket);
        let error = task.await.unwrap().err().unwrap();
        assert_eq!(
            error,
            if network_failure {
                LoginError::Network
            } else {
                LoginError::Timeout
            }
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), listener.accept())
                .await
                .is_err()
        );
    }
}
