use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    time::{Duration, Instant},
};
use tempfile::TempDir;
fn cli(dir: &TempDir) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    command
        .arg("--state")
        .arg(dir.path().join("never/state.db"))
        .arg("--providers")
        .arg(dir.path().join("missing-provider.json"));
    command
}
fn fixture(status: u16, body: String) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut socket = loop {
            match listener.accept() {
                Ok((s, _)) => break s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("{e}"),
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut b = [0; 2048];
            let n = socket.read(&mut b).unwrap();
            assert_ne!(n, 0);
            bytes.extend_from_slice(&b[..n]);
            if bytes.windows(4).any(|p| p == b"\r\n\r\n") {
                break;
            }
        }
        write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        String::from_utf8(bytes).unwrap()
    });
    (url, task)
}
#[test]
fn hosted_routes_use_explicit_token_and_never_open_state_or_profiles() {
    let dir = TempDir::new().unwrap();
    for (action, route, body) in [
        ("health", "/health", json!({"status":"ok"})),
        (
            "models",
            "/api/inference/v1/models",
            json!({"object":"list","data":[]}),
        ),
        (
            "account",
            "/api/inference/account",
            json!({"remainingUsd":4,"currency":"USD"}),
        ),
        ("usage", "/api/inference/usage", json!({"requests":[]})),
    ] {
        let (host, server) = fixture(200, body.to_string());
        let output = cli(&dir)
            .args([
                "hosted",
                "--host",
                &host,
                "--token-env",
                "HOSTED_FIXTURE_TOKEN",
                action,
            ])
            .env("HOSTED_FIXTURE_TOKEN", "fixture-secret")
            .env("0SEC_CLOUD_HOST", "https://invalid.example")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let _: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-secret"));
        let request = server.join().unwrap();
        assert!(request.starts_with(&format!("GET {route} ")));
        assert!(request.contains("authorization: Bearer fixture-secret"));
        assert!(!dir.path().join("never").exists());
    }
}
#[test]
fn hosted_gateway_errors_are_nonzero_and_redacted_with_env_host() {
    let dir = TempDir::new().unwrap();
    let (host, server) = fixture(
        401,
        json!({"error":{"message":"fixture-secret"}}).to_string(),
    );
    let output = cli(&dir)
        .args(["hosted", "health"])
        .env("0SEC_CLOUD_HOST", host)
        .env("0SEC_CLOUD_TOKEN", "fixture-secret")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("401"));
    assert!(!stderr.contains("fixture-secret"));
    server.join().unwrap();
    assert!(!dir.path().join("never").exists());
}
#[test]
fn hosted_metadata_bypasses_missing_credentials_and_invalid_host() {
    let dir = TempDir::new().unwrap();
    for args in [
        vec!["hosted", "--host", "invalid", "--help"],
        vec!["hosted", "health", "--help"],
        vec!["schema"],
        vec!["--help"],
    ] {
        let output = cli(&dir)
            .args(args)
            .env_remove("0SEC_CLOUD_TOKEN")
            .env("0SEC_CLOUD_HOST", "invalid")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!dir.path().join("never").exists());
    }
    let output = cli(&dir)
        .args(["hosted", "health"])
        .env_remove("0SEC_CLOUD_TOKEN")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(!dir.path().join("never").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn hosted_sigterm_cancels_live_request_without_state_or_credentials_output() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let dir = TempDir::new().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let (ready_tx, ready) = tokio::sync::oneshot::channel();
    let (release, release_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        socket.read(&mut buf).await.unwrap();
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{",
            )
            .await
            .unwrap();
        ready_tx.send(()).unwrap();
        let _ = release_rx.await;
    });
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(dir.path().join("never/state.db"))
        .args(["hosted", "--host", &host, "health"])
        .env("0SEC_CLOUD_TOKEN", "fixture-secret")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), ready)
        .await
        .unwrap()
        .unwrap();
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().unwrap().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let output = tokio::time::timeout(Duration::from_secs(3), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("cancelled"));
    assert!(!stderr.contains("fixture-secret"));
    assert!(!dir.path().join("never").exists());
    release.send(()).unwrap();
    server.await.unwrap();
}
