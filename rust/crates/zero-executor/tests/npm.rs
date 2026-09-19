#![cfg(target_os = "linux")]
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha512};
use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use zero_executor::{NpmRequest, SnapshotLimits, acquire_npm};
use zero_protocol::source_acquisition::NpmSource;
fn package() -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    for (path, bytes, mode) in [
        (
            "package/package.json",
            br#"{"name":"@scope/fixture","version":"1.2.3","scripts":{"postinstall":"exit 99"}}"#
                .as_slice(),
            0o644,
        ),
        ("package/bin/run", b"#!/bin/sh\nexit 17\n".as_slice(), 0o755),
        ("package/data.bin", b"\0\xff\x01binary".as_slice(), 0o644),
    ] {
        let mut h = tar::Header::new_gnu();
        h.set_size(bytes.len() as u64);
        h.set_mode(mode);
        h.set_cksum();
        tar.append_data(&mut h, path, bytes).unwrap();
    }
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&tar.into_inner().unwrap()).unwrap();
    gz.finish().unwrap()
}
struct Server {
    url: String,
    seen: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn new(mode: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        let base = url.clone();
        let bytes = package();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut b = [0; 1024];
                    let n = socket.read(&mut b).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&b[..n]);
                    assert!(request.len() < 16384);
                    if request.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                record.lock().unwrap().push(request.clone());
                let tarball = request.starts_with("GET /package.tgz ");
                if mode == "hold" && tarball {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\none")
                        .await
                        .unwrap();
                    std::future::pending::<()>().await;
                }
                if mode == "redirect" {
                    socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {base}other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                    continue;
                }
                if mode == "oversize" {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3000000\r\nConnection: close\r\n\r\n").await.unwrap();
                    continue;
                }
                let body = if tarball {
                    bytes.clone()
                } else {
                    let integrity = if mode == "integrity" {
                        STANDARD.encode([0; 64])
                    } else {
                        STANDARD.encode(Sha512::digest(&bytes))
                    };
                    serde_json::to_vec(&serde_json::json!({"name":if mode=="identity"{"other"}else{"@scope/fixture"},"version":"1.2.3","dist":{"tarball":if mode=="origin"{"http://127.0.0.1:1/package.tgz".into()}else{format!("{base}package.tgz")},"integrity":format!("sha512-{integrity}")}})).unwrap()
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(&body).await.unwrap();
            }
        });
        Self { url, seen, task }
    }
    fn request(&self, out: &std::path::Path) -> NpmRequest {
        NpmRequest {
            source: NpmSource {
                registry: self.url.clone(),
                package: "@scope/fixture".into(),
                version: "1.2.3".into(),
            },
            output: out.into(),
            timeout_ms: 10_000,
            limits: SnapshotLimits {
                max_files: 4096,
                max_bytes: 64 * 1024 * 1024,
            },
        }
    }
}
#[tokio::test]
async fn published_content_modes_receipt_and_no_install_scripts() {
    let server = Server::new("ok").await;
    let d = tempfile::tempdir().unwrap();
    let output = d.path().join("published");
    let receipt = acquire_npm(server.request(&output), CancellationToken::new())
        .await
        .unwrap();
    receipt.validate().unwrap();
    assert_eq!(receipt.snapshot.files.len(), 3);
    assert_eq!(receipt.executable_paths, vec!["bin/run"]);
    assert_eq!(
        std::fs::read(output.join("source/data.bin")).unwrap(),
        b"\0\xff\x01binary"
    );
    assert_eq!(
        std::fs::metadata(output.join("source/bin/run"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::read(output.join("receipt.json")).unwrap(),
        receipt.canonical_bytes().unwrap()
    );
    zero_executor::verify_snapshot(&receipt.snapshot, &|| Ok(())).unwrap();
    let requests = server.seen.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("GET /@scope%2Ffixture/1.2.3 "));
    for request in requests.iter() {
        assert!(!request.to_lowercase().contains("authorization:"));
    }
    drop(requests);
    assert!(
        acquire_npm(server.request(&output), CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(server.seen.lock().unwrap().len(), 2);
    assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
}
#[tokio::test]
async fn rejects_changed_identity_integrity_cross_origin_redirect_and_oversize_without_publication()
{
    for (mode, expected_requests) in [
        ("identity", 1),
        ("origin", 1),
        ("redirect", 1),
        ("oversize", 1),
        ("integrity", 2),
    ] {
        let server = Server::new(mode).await;
        let d = tempfile::tempdir().unwrap();
        let output = d.path().join("published");
        assert!(
            acquire_npm(server.request(&output), CancellationToken::new())
                .await
                .is_err(),
            "{mode}"
        );
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0, "{mode}");
        assert_eq!(
            server.seen.lock().unwrap().len(),
            expected_requests,
            "{mode}"
        );
    }
}
#[tokio::test]
async fn cancellation_and_deadline_drain_download_without_staging_or_retry() {
    for cancelled in [false, true] {
        let server = Server::new("hold").await;
        let d = tempfile::tempdir().unwrap();
        let output = d.path().join("published");
        let mut request = server.request(&output);
        request.timeout_ms = if cancelled { 10_000 } else { 150 };
        let token = CancellationToken::new();
        let run_token = token.clone();
        let task = tokio::spawn(acquire_npm(request, run_token));
        tokio::time::timeout(Duration::from_secs(3), async {
            while server.seen.lock().unwrap().len() < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        if cancelled {
            token.cancel();
        }
        let error = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(
            error.contains(if cancelled { "cancelled" } else { "deadline" }),
            "{error}"
        );
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
        assert_eq!(server.seen.lock().unwrap().len(), 2);
    }
}
#[tokio::test]
async fn extraction_limits_cleanup_and_symlink_parent_never_publish() {
    let server = Server::new("ok").await;
    let d = tempfile::tempdir().unwrap();
    let output = d.path().join("published");
    let mut request = server.request(&output);
    request.limits.max_files = 1;
    assert!(
        acquire_npm(request, CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
    let real = d.path().join("real");
    std::fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, d.path().join("alias")).unwrap();
    assert!(
        acquire_npm(
            server.request(&d.path().join("alias/published")),
            CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert_eq!(server.seen.lock().unwrap().len(), 2);
    assert!(!real.join("published").exists());
}
