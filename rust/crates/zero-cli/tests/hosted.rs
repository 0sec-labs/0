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
    command.env("HOME", dir.path());
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

fn credential_file(dir: &TempDir, body: &str) -> std::path::PathBuf {
    let state = dir.path().join(".0sec");
    std::fs::create_dir_all(&state).unwrap();
    let path = state.join("cloud.env");
    std::fs::write(&path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    path
}
#[test]
fn hosted_legacy_file_pairs_token_and_host_and_preserves_env_precedence() {
    for source in ["file", "empty-env", "env", "override"] {
        let dir = TempDir::new().unwrap();
        let (host, server) = fixture(200, json!({"status":"ok"}).to_string());
        let file_host = if source == "file" || source == "empty-env" {
            host.as_str()
        } else {
            "https://unused-file.example"
        };
        credential_file(
            &dir,
            &format!(
                "# fixture\r\n0SEC_CLOUD_TOKEN=file-secret\r\n0SEC_CLOUD_HOST={file_host}/\r\n"
            ),
        );
        let mut command = cli(&dir);
        command
            .args(["hosted", "health"])
            .env_remove("0SEC_CLOUD_TOKEN")
            .env("0SEC_CLOUD_HOST", "https://must-not-pair-env-host.example");
        if source == "empty-env" {
            command.env("0SEC_CLOUD_TOKEN", "  ");
        }
        if source == "env" {
            command
                .env("0SEC_CLOUD_TOKEN", " env-secret ")
                .env("0SEC_CLOUD_HOST", &host);
            credential_file(&dir, "malformed file should never be loaded");
        }
        if source == "override" {
            command.args(["--host", &host]);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let request = server.join().unwrap();
        assert!(request.contains(if source == "env" {
            "authorization: Bearer env-secret"
        } else {
            "authorization: Bearer file-secret"
        }));
        assert!(!dir.path().join("never").exists());
    }
}
#[test]
fn custom_token_env_never_falls_back_to_legacy_file() {
    let dir = TempDir::new().unwrap();
    credential_file(
        &dir,
        "0SEC_CLOUD_TOKEN=file-secret\n0SEC_CLOUD_HOST=http://127.0.0.1:9\n",
    );
    let output = cli(&dir)
        .args([
            "hosted",
            "--token-env",
            "ABSENT_HOSTED_FIXTURE_TOKEN",
            "health",
        ])
        .env_remove("ABSENT_HOSTED_FIXTURE_TOKEN")
        .env("0SEC_CLOUD_TOKEN", "other-secret")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.contains("file fallback is disabled"));
    assert!(!error.contains("file-secret"));
    assert!(!error.contains("other-secret"));
}
#[test]
fn malformed_and_oversized_credential_files_never_echo_contents() {
    let dir = TempDir::new().unwrap();
    for content in [
        "fixture-secret malformed".to_owned(),
        "0SEC_CLOUD_TOKEN=fixture-secret\n0SEC_CLOUD_TOKEN=second-secret".into(),
        "0SEC_CLOUD_TOKEN=\"fixture-secret\"".into(),
        "x".repeat(64 * 1024 + 1),
    ] {
        credential_file(&dir, &content);
        let output = cli(&dir)
            .args(["hosted", "health"])
            .env_remove("0SEC_CLOUD_TOKEN")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("fixture-secret"));
    }
}
#[cfg(unix)]
#[test]
fn credential_file_requires_private_regular_file_and_never_executes_values() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = TempDir::new().unwrap();
    let path = credential_file(&dir, "0SEC_CLOUD_TOKEN=file-secret\n");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let rejected = cli(&dir)
        .args(["hosted", "health"])
        .env_remove("0SEC_CLOUD_TOKEN")
        .output()
        .unwrap();
    assert_eq!(rejected.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("0600"));
    let actual = dir.path().join("actual");
    std::fs::rename(&path, &actual).unwrap();
    symlink(&actual, &path).unwrap();
    let rejected = cli(&dir)
        .args(["hosted", "health"])
        .env_remove("0SEC_CLOUD_TOKEN")
        .output()
        .unwrap();
    assert_eq!(rejected.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("regular file"));
    std::fs::remove_file(&path).unwrap();
    let (host, server) = fixture(200, json!({"status":"ok"}).to_string());
    credential_file(
        &dir,
        &format!("0SEC_CLOUD_TOKEN=$(touch fixture-sentinel)\n0SEC_CLOUD_HOST={host}\n"),
    );
    let output = cli(&dir)
        .current_dir(dir.path())
        .args(["hosted", "health"])
        .env_remove("0SEC_CLOUD_TOKEN")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(!dir.path().join("fixture-sentinel").exists());
    assert!(
        server
            .join()
            .unwrap()
            .contains("authorization: Bearer $(touch fixture-sentinel)")
    );
}
