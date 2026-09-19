#![cfg(unix)]
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, time::Duration};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use tokio_util::sync::CancellationToken;
use zero_provider::{CompletionStatus, Endpoint, ProviderClient, ResponsesRequest, TransportError};
const SESSION: &str = "00000000-0000-0000-0000-000000000001";
struct Fixture {
    dir: TempDir,
    endpoint: String,
    token_url: String,
}
impl Fixture {
    async fn new() -> (Self, TcpListener, TcpListener) {
        let model = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let token = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/responses", model.local_addr().unwrap());
        let token_url = format!(
            "http://{}/tenant/oauth2/v2.0/token",
            token.local_addr().unwrap()
        );
        let fixture = Self {
            dir: TempDir::new().unwrap(),
            endpoint,
            token_url,
        };
        std::fs::set_permissions(fixture.dir.path(), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        fixture.write(&json!({"schema_version":1,"session_id":SESSION,"tenant_id":"00000000-0000-0000-0000-000000000002","client_id":"00000000-0000-0000-0000-000000000003","account_id":"fixture-account","endpoint":fixture.endpoint,"scope":"https://cognitiveservices.azure.com/.default","revision":0,"refresh_token":"initial-refresh-secret","access_token":null,"expires_at_ms":null}));
        (fixture, token, model)
    }
    fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("credential.json")
    }
    fn read(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.path()).unwrap()).unwrap()
    }
    fn write(&self, value: &Value) {
        std::fs::write(self.path(), serde_json::to_vec(value).unwrap()).unwrap();
        std::fs::set_permissions(self.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    async fn client(&self) -> ProviderClient {
        self.client_timeout(Duration::from_secs(3)).await
    }
    async fn client_timeout(&self, timeout: Duration) -> ProviderClient {
        assert_eq!(
            std::fs::metadata(self.dir.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o022,
            0,
            "fixture parent must be private"
        );
        ProviderClient::new(
            Endpoint::azure_entra(&self.endpoint, &self.path(), Some(&self.token_url))
                .await
                .unwrap(),
            timeout,
            8192,
        )
        .unwrap()
    }
}
fn request() -> ResponsesRequest {
    ResponsesRequest {
        model: "fixture".into(),
        instructions: "inspect".into(),
        input: vec![],
        tools: vec![],
        max_output_tokens: 32,
    }
}
async fn read(socket: &mut TcpStream) -> String {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut bytes = vec![];
        loop {
            let mut chunk = [0; 4096];
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            assert!(bytes.len() < 1024 * 1024);
            if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..end]);
                let size: usize = header
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                            .map(|(_, v)| v.trim().parse().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + size {
                    return String::from_utf8(bytes).unwrap();
                }
            }
        }
    })
    .await
    .unwrap()
}
async fn respond(socket: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let _=socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
}
fn token(expires: u64, refresh: &str) -> String {
    json!({"token_type":"Bearer","access_token":"new-access-secret","refresh_token":refresh,"expires_in":expires}).to_string()
}
fn completion() -> String {
    format!(
        "data: {}\n\n",
        json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":1}}})
    )
}
async fn no_connection(listener: &TcpListener) {
    assert!(
        tokio::time::timeout(Duration::from_millis(75), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn concurrent_clients_refresh_once_and_persist_before_any_model_request() {
    let (f, tokens, models) = Fixture::new().await;
    let one = f.client().await;
    let two = f.client().await;
    let token_server = tokio::spawn(async move {
        let (mut socket, _) = tokens.accept().await.unwrap();
        let wire = read(&mut socket).await;
        respond(
            &mut socket,
            "200 OK",
            "application/json",
            &token(3600, "rotated-secret"),
        )
        .await;
        (tokens, wire)
    });
    let path = f.path();
    let model_server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = models.accept().await.unwrap();
            let wire = read(&mut socket).await;
            assert!(wire.contains("authorization: Bearer new-access-secret"));
            assert!(!wire.contains("api-key:"));
            let stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(stored["revision"], 1);
            assert_eq!(stored["refresh_token"], "rotated-secret");
            respond(&mut socket, "200 OK", "text/event-stream", &completion()).await;
        }
        models
    });
    let req = request();
    let (a, b) = tokio::join!(
        one.complete(&req, CancellationToken::new()),
        two.complete(&req, CancellationToken::new())
    );
    for result in [a, b] {
        let result = result.unwrap();
        assert_eq!(result.status, CompletionStatus::Completed);
        assert!(result.usage_is_final);
    }
    let (tokens, wire) = token_server.await.unwrap();
    assert!(wire.starts_with("POST /tenant/oauth2/v2.0/token "));
    assert!(wire.contains("grant_type=refresh_token"));
    assert!(wire.contains("refresh_token=initial-refresh-secret"));
    assert!(wire.contains("scope=https%3A%2F%2Fcognitiveservices.azure.com%2F.default"));
    assert!(!wire.contains("authorization:"));
    no_connection(&tokens).await;
    no_connection(&model_server.await.unwrap()).await;
    assert_eq!(
        std::fs::metadata(f.path()).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn next_expiry_uses_rotated_token_and_new_revision() {
    let (f, tokens, models) = Fixture::new().await;
    let client = f.client().await;
    let token_server = tokio::spawn(async move {
        let mut wires = vec![];
        for i in 0..2 {
            let (mut socket, _) = tokens.accept().await.unwrap();
            wires.push(read(&mut socket).await);
            respond(
                &mut socket,
                "200 OK",
                "application/json",
                &token(
                    if i == 0 { 61 } else { 3600 },
                    if i == 0 {
                        "rotation-one"
                    } else {
                        "rotation-two"
                    },
                ),
            )
            .await;
        }
        wires
    });
    let model_server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = models.accept().await.unwrap();
            read(&mut socket).await;
            respond(&mut socket, "200 OK", "text/event-stream", &completion()).await;
        }
    });
    client
        .complete(&request(), CancellationToken::new())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    client
        .complete(&request(), CancellationToken::new())
        .await
        .unwrap();
    let wires = token_server.await.unwrap();
    assert!(wires[1].contains("refresh_token=rotation-one"));
    assert!(!wires[1].contains("initial-refresh-secret"));
    model_server.await.unwrap();
    assert_eq!(f.read()["revision"], 2);
    assert_eq!(f.read()["refresh_token"], "rotation-two");
}

#[tokio::test]
async fn changed_login_during_refresh_is_not_overwritten_or_used() {
    let (f, tokens, models) = Fixture::new().await;
    let client = f.client().await;
    let (ready_tx, ready) = oneshot::channel();
    let (release, hold) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = tokens.accept().await.unwrap();
        read(&mut socket).await;
        ready_tx.send(()).unwrap();
        hold.await.unwrap();
        respond(
            &mut socket,
            "200 OK",
            "application/json",
            &token(3600, "must-not-persist"),
        )
        .await;
    });
    let run =
        tokio::spawn(async move { client.complete(&request(), CancellationToken::new()).await });
    ready.await.unwrap();
    let mut changed = f.read();
    changed["session_id"] = json!("00000000-0000-0000-0000-000000000009");
    changed["refresh_token"] = json!("new-login-secret");
    f.write(&changed);
    release.send(()).unwrap();
    assert!(matches!(
        run.await.unwrap(),
        Err(TransportError::CredentialUnavailable)
    ));
    server.await.unwrap();
    assert_eq!(f.read(), changed);
    no_connection(&models).await;
    assert!(!std::fs::read_dir(f.dir.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
}

#[tokio::test]
async fn cancellation_and_deadline_never_dispatch_model_or_retry_refresh() {
    for cancelled in [true, false] {
        let (f, tokens, models) = Fixture::new().await;
        let client = std::sync::Arc::new(
            f.client_timeout(if cancelled {
                Duration::from_secs(3)
            } else {
                Duration::from_millis(100)
            })
            .await,
        );
        let old = f.read();
        let (ready_tx, ready) = oneshot::channel();
        let (release, hold) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = tokens.accept().await.unwrap();
            read(&mut socket).await;
            ready_tx.send(()).unwrap();
            hold.await.unwrap();
            tokens
        });
        let cancel = CancellationToken::new();
        let child = cancel.clone();
        let run_client = client.clone();
        let run = tokio::spawn(async move { run_client.complete(&request(), child).await });
        ready.await.unwrap();
        if cancelled {
            cancel.cancel();
        }
        let error = tokio::time::timeout(Duration::from_secs(1), run)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(matches!(
            error,
            TransportError::Cancelled | TransportError::Timeout
        ));
        assert_eq!(f.read(), old);
        assert!(matches!(
            client.complete(&request(), CancellationToken::new()).await,
            Err(TransportError::CredentialUnavailable)
        ));
        release.send(()).unwrap();
        no_connection(&server.await.unwrap()).await;
        no_connection(&models).await;
    }
}

#[tokio::test]
async fn invalid_or_oversized_refresh_is_redacted_and_never_infers() {
    for (status, body) in [
        (
            "400 Bad Request",
            json!({"error":"initial-refresh-secret"}).to_string(),
        ),
        ("200 OK", token(0, "bad")),
        ("200 OK", token(3600, "bad\r\nheader")),
        ("200 OK", "x".repeat(65537)),
    ] {
        let (f, tokens, models) = Fixture::new().await;
        let old = f.read();
        let client = f.client().await;
        let server = tokio::spawn(async move {
            let (mut socket, _) = tokens.accept().await.unwrap();
            read(&mut socket).await;
            respond(&mut socket, status, "application/json", &body).await;
            tokens
        });
        let error = client
            .complete(&request(), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(error, TransportError::CredentialUnavailable));
        assert!(!format!("{error:?} {error}").contains("initial-refresh-secret"));
        assert_eq!(f.read(), old);
        no_connection(&server.await.unwrap()).await;
        no_connection(&models).await;
    }
}

#[tokio::test]
async fn untrusted_file_types_permissions_and_refresh_route_are_rejected() {
    let (f, _, _) = Fixture::new().await;
    std::fs::set_permissions(f.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        Endpoint::azure_entra(&f.endpoint, &f.path(), Some(&f.token_url))
            .await
            .is_err()
    );
    std::fs::set_permissions(f.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = f.dir.path().join("link");
    std::os::unix::fs::symlink(f.path(), &link).unwrap();
    assert!(
        Endpoint::azure_entra(&f.endpoint, &link, Some(&f.token_url))
            .await
            .is_err()
    );
    std::fs::remove_file(link).unwrap();
    let hard = f.dir.path().join("hard");
    std::fs::hard_link(f.path(), &hard).unwrap();
    assert!(
        Endpoint::azure_entra(&f.endpoint, &f.path(), Some(&f.token_url))
            .await
            .is_err()
    );
    std::fs::remove_file(hard).unwrap();
    assert!(
        Endpoint::azure_entra(
            &f.endpoint,
            &f.path(),
            Some("https://attacker.example/token")
        )
        .await
        .is_err()
    );
    assert!(
        Endpoint::azure_entra(
            "https://attacker.example/openai/v1/responses",
            &f.path(),
            None
        )
        .await
        .is_err()
    );
    let mut altered = f.read();
    altered["scope"] = json!("https://graph.microsoft.com/.default");
    f.write(&altered);
    assert!(
        Endpoint::azure_entra(&f.endpoint, &f.path(), Some(&f.token_url))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn cached_access_never_refreshes_on_model_unauthorized() {
    let (f, tokens, models) = Fixture::new().await;
    let mut record = f.read();
    record["access_token"] = json!("cached-secret");
    record["expires_at_ms"] = json!(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 3600000
    );
    f.write(&record);
    let client = f.client().await;
    let server = tokio::spawn(async move {
        let (mut socket, _) = models.accept().await.unwrap();
        let request = read(&mut socket).await;
        assert!(request.contains("authorization: Bearer cached-secret"));
        respond(
            &mut socket,
            "401 Unauthorized",
            "application/json",
            "{\"error\":\"cached-secret\"}",
        )
        .await;
        models
    });
    assert!(matches!(
        client.complete(&request(), CancellationToken::new()).await,
        Err(TransportError::Http(401))
    ));
    no_connection(&tokens).await;
    no_connection(&server.await.unwrap()).await;
    assert_eq!(f.read(), record);
}

#[tokio::test]
async fn replaced_lock_rejects_persistence_and_any_inference() {
    let (f, tokens, models) = Fixture::new().await;
    let client = f.client().await;
    let old = f.read();
    let (ready_tx, ready) = oneshot::channel();
    let (release, hold) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = tokens.accept().await.unwrap();
        read(&mut socket).await;
        ready_tx.send(()).unwrap();
        hold.await.unwrap();
        respond(
            &mut socket,
            "200 OK",
            "application/json",
            &token(3600, "discarded-rotation"),
        )
        .await;
    });
    let run =
        tokio::spawn(async move { client.complete(&request(), CancellationToken::new()).await });
    ready.await.unwrap();
    let lock = f.dir.path().join("credential.json.oauth-lock");
    std::fs::remove_file(&lock).unwrap();
    std::fs::write(&lock, b"").unwrap();
    std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o600)).unwrap();
    release.send(()).unwrap();
    assert!(matches!(
        run.await.unwrap(),
        Err(TransportError::CredentialUnavailable)
    ));
    server.await.unwrap();
    assert_eq!(f.read(), old);
    no_connection(&models).await;
}

#[tokio::test]
async fn refresh_redirect_never_receives_credentials_at_destination() {
    let (f, tokens, models) = Fixture::new().await;
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/token", target.local_addr().unwrap());
    let client = f.client().await;
    let server = tokio::spawn(async move {
        let (mut socket, _) = tokens.accept().await.unwrap();
        read(&mut socket).await;
        socket.write_all(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    });
    assert!(matches!(
        client.complete(&request(), CancellationToken::new()).await,
        Err(TransportError::CredentialUnavailable)
    ));
    server.await.unwrap();
    no_connection(&target).await;
    no_connection(&models).await;
}

#[tokio::test]
async fn cancelled_lock_wait_keeps_same_client_reusable() {
    use nix::fcntl::{Flock, FlockArg};
    use std::os::unix::fs::OpenOptionsExt;
    let (f, tokens, models) = Fixture::new().await;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(f.dir.path().join("credential.json.oauth-lock"))
        .unwrap();
    let lock = Flock::lock(lock, FlockArg::LockExclusive).unwrap();
    let client = std::sync::Arc::new(f.client().await);
    let cancel = CancellationToken::new();
    let child_token = cancel.clone();
    let task_client = client.clone();
    let run = tokio::spawn(async move { task_client.complete(&request(), child_token).await });
    tokio::time::sleep(Duration::from_millis(60)).await;
    cancel.cancel();
    assert!(matches!(run.await.unwrap(), Err(TransportError::Cancelled)));
    no_connection(&tokens).await;
    no_connection(&models).await;
    drop(lock);
    let auth = tokio::spawn(async move {
        let (mut socket, _) = tokens.accept().await.unwrap();
        read(&mut socket).await;
        respond(
            &mut socket,
            "200 OK",
            "application/json",
            &token(3600, "after-wait"),
        )
        .await;
    });
    let model = tokio::spawn(async move {
        let (mut socket, _) = models.accept().await.unwrap();
        read(&mut socket).await;
        respond(&mut socket, "200 OK", "text/event-stream", &completion()).await;
    });
    assert_eq!(
        client
            .complete(&request(), CancellationToken::new())
            .await
            .unwrap()
            .status,
        CompletionStatus::Completed
    );
    auth.await.unwrap();
    model.await.unwrap();
    assert_eq!(f.read()["revision"], 1);
}

#[tokio::test]
async fn exhausted_rotation_revision_rejects_before_refresh() {
    let (f, tokens, models) = Fixture::new().await;
    let mut record = f.read();
    record["revision"] = json!(9_007_199_254_740_990u64);
    f.write(&record);
    let client = f.client().await;
    assert!(matches!(
        client.complete(&request(), CancellationToken::new()).await,
        Err(TransportError::CredentialUnavailable)
    ));
    no_connection(&tokens).await;
    no_connection(&models).await;
    assert_eq!(f.read(), record);
}
