use super::*;
use zero_protocol::source_acquisition::{NpmReceipt, SourceReceipt};
async fn request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let mut b = [0; 4096];
        let n = socket.read(&mut b).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&b[..n]);
        assert!(bytes.len() < 1024 * 1024);
        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&bytes[..end]);
            let len = header
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + len {
                return bytes;
            }
        }
    }
}
async fn respond(socket: &mut tokio::net::TcpStream, body: &[u8], mime: &str) {
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
    socket.write_all(body).await.unwrap();
}
#[tokio::test]
async fn published_npm_receipt_survives_source_registry_and_config_deletion() {
    let d = tempfile::tempdir().unwrap();
    let capture = d.path().join("capture");
    let state = d.path().join("state.db");
    let marker = d.path().join("script-ran");
    let tgz = d.path().join("fixture.tgz");
    // Offline stdlib fixture generation only; the production path invokes no Python/npm/shell.
    let fixture=std::process::Command::new("python3").args(["-c",r#"import io,tarfile,json,hashlib,base64,sys
files={'package.json':json.dumps({'name':'@local/fixture','version':'1.2.3','scripts':{'postinstall':'touch '+sys.argv[2]}}).encode(),'app.rs':b'fn main() {}\n','bin/data':b'\x00\xffbinary'}
with tarfile.open(sys.argv[1],'w:gz',format=tarfile.PAX_FORMAT) as t:
 for name,data in files.items():
  h=tarfile.TarInfo('package/'+name);h.size=len(data);h.mode=0o755 if name.startswith('bin/') else 0o644;h.pax_headers={'mtime':'123.5'};t.addfile(h,io.BytesIO(data))
print('sha512-'+base64.b64encode(hashlib.sha512(open(sys.argv[1],'rb').read()).digest()).decode())
"#]).arg(&tgz).arg(&marker).output().unwrap();
    assert!(
        fixture.status.success(),
        "{}",
        String::from_utf8_lossy(&fixture.stderr)
    );
    let integrity = String::from_utf8(fixture.stdout).unwrap().trim().to_owned();
    let tarball = std::fs::read(&tgz).unwrap();
    let registry = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let registry_url = format!("http://{}/", registry.local_addr().unwrap());
    let base = registry_url.clone();
    let registry_task = tokio::spawn(async move {
        for index in 0..2 {
            let (mut socket, _) = registry.accept().await.unwrap();
            let bytes = request(&mut socket).await;
            let text = String::from_utf8(bytes).unwrap();
            assert!(text.starts_with(if index == 0 {
                "GET /@local%2Ffixture/1.2.3 "
            } else {
                "GET /fixture.tgz "
            }));
            assert!(!text.to_lowercase().contains("authorization:"));
            let body = if index == 0 {
                json!({"name":"@local/fixture","version":"1.2.3","dist":{"tarball":format!("{base}fixture.tgz"),"integrity":integrity}}).to_string().into_bytes()
            } else {
                tarball.clone()
            };
            respond(&mut socket, &body, "application/octet-stream").await;
        }
    });
    let acquired = tokio::time::timeout(
        Duration::from_secs(20),
        cli()
            .arg("--state")
            .arg(&state)
            .args([
                "source",
                "acquire",
                "--npm-package",
                "@local/fixture",
                "--version",
                "1.2.3",
                "--registry",
                &registry_url,
                "--output",
            ])
            .arg(&capture)
            .env("NPM_TOKEN", "ambient-must-not-send")
            .env("HTTP_PROXY", "http://127.0.0.1:1")
            .env("npm_config_ignore_scripts", "false")
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        acquired.status.success(),
        "{}",
        String::from_utf8_lossy(&acquired.stderr)
    );
    registry_task.await.unwrap();
    let receipt: NpmReceipt = serde_json::from_slice(&acquired.stdout).unwrap();
    receipt.validate().unwrap();
    assert!(!state.exists());
    assert!(!marker.exists());
    assert_eq!(receipt.snapshot.files.len(), 3);
    assert_eq!(receipt.executable_paths, vec!["bin/data"]);
    assert_eq!(
        std::fs::read(capture.join("receipt.json")).unwrap(),
        receipt.canonical_bytes().unwrap()
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let providers = d.path().join("providers.json");
    let profiles = d.path().join("reviews.json");
    std::fs::write(&providers,json!({"fixture":{"url":format!("http://{}/responses",listener.local_addr().unwrap()),"api_key_env":"NPM_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":10000,"max_response_bytes":65536}}).to_string()).unwrap();
    std::fs::write(&profiles,json!({"local":{"schema_version":1,"provider":"fixture","model":"fixture","instructions":"Inspect published source","question":"Review the published function","execution":{"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"budget_limit":20,"currency":"units","reservation_per_turn":10,"max_turns":2,"max_hypotheses":2,"deadline_ms":30000}}).to_string()).unwrap();
    let make_review = |db: &Path| {
        let mut c = cli();
        c.arg("--state")
            .arg(db)
            .arg("--providers")
            .arg(&providers)
            .arg("--review-profiles")
            .arg(&profiles)
            .arg("review")
            .arg(capture.join("source"))
            .arg("--acquisition-receipt")
            .arg(capture.join("receipt.json"))
            .args([
                "--profile",
                "local",
                "--command-id",
                "npm-review",
                "--format",
                "json",
            ])
            .env("NPM_FIXTURE_KEY", "fixture-only");
        c
    };
    use std::os::unix::fs::PermissionsExt;
    for mutation in 0..3 {
        let rejected = d.path().join(format!("rejected{mutation}.db"));
        let mut changed = receipt.clone();
        match mutation {
            0 => std::fs::set_permissions(
                capture.join("source/bin/data"),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap(),
            1 => std::fs::write(capture.join("source/app.rs"), "changed").unwrap(),
            _ => changed.snapshot.root = "/different/source".into(),
        };
        std::fs::write(
            capture.join("receipt.json"),
            changed.canonical_bytes().unwrap(),
        )
        .unwrap();
        let output = make_review(&rejected).output().await.unwrap();
        assert!(!output.status.success());
        assert!(!rejected.exists());
        std::fs::set_permissions(
            capture.join("source/bin/data"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        std::fs::write(capture.join("source/app.rs"), "fn main() {}\n").unwrap();
        std::fs::write(
            capture.join("receipt.json"),
            receipt.canonical_bytes().unwrap(),
        )
        .unwrap();
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    let child = make_review(&state).spawn().unwrap();
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(20), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let _request = request(&mut socket).await;
    let file = receipt
        .snapshot
        .files
        .iter()
        .find(|f| f.path == "app.rs")
        .unwrap();
    let args = json!({"selected_files":["app.rs"],"hypotheses":[{"title":"Published function","claimed_severity":"low","explanation":"Unverified observation","citations":[{"path":"app.rs","sha256":file.digest,"start_line":1,"end_line":1}]}]});
    let event = json!({"type":"response.completed","response":{"id":"fixture","status":"completed","output":[{"type":"function_call","id":"fc-submit","call_id":"submit","name":"submit_source_hypotheses","arguments":args.to_string()}],"usage":{"input_tokens":2,"output_tokens":1}}});
    respond(
        &mut socket,
        format!("data: {event}\n\n").as_bytes(),
        "text/event-stream",
    )
    .await;
    drop(socket);
    let done = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        done.status.success(),
        "{}",
        String::from_utf8_lossy(&done.stderr)
    );
    let done: Value = serde_json::from_slice(&done.stdout).unwrap();
    let id = done["review"]["review"]["id"].as_str().unwrap();
    assert_eq!(
        done["review"]["review"]["acquisition_receipt"]["source"]["version"],
        "1.2.3"
    );
    let store = zero_store::Store::open_read_only(&state).unwrap();
    let original = store.review_acquisition_receipt(id).unwrap().unwrap();
    let SourceReceipt::Npm(retained) = original.receipt else {
        panic!()
    };
    assert_eq!(
        retained.canonical_bytes().unwrap(),
        receipt.canonical_bytes().unwrap()
    );
    let archive = store.review_source_archive(id).unwrap().unwrap();
    assert_eq!(archive.manifest.snapshot_sha256, receipt.snapshot.digest);
    assert!(
        archive
            .manifest
            .files
            .iter()
            .find(|f| f.path == "bin/data")
            .unwrap()
            .executable
    );
    drop(store);
    std::fs::remove_dir_all(&capture).unwrap();
    std::fs::remove_file(&tgz).unwrap();
    std::fs::remove_file(&providers).unwrap();
    std::fs::remove_file(&profiles).unwrap();
    assert!(!marker.exists());
    let retry = make_review(&state).output().await.unwrap();
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    let retry: Value = serde_json::from_slice(&retry.stdout).unwrap();
    assert_eq!(retry["duplicate"], true);
    let mut historical = done["review"].clone();
    let mut cached = retry["review"].clone();
    historical.as_object_mut().unwrap().remove("observed_at_ms");
    cached.as_object_mut().unwrap().remove("observed_at_ms");
    assert_eq!(cached, historical);
    let report = cli()
        .arg("--state")
        .arg(&state)
        .args(["review", "report", "--review", id, "--format", "json"])
        .output()
        .await
        .unwrap();
    assert!(
        report.status.success(),
        "{}",
        String::from_utf8_lossy(&report.stderr)
    );
    let report: Value = serde_json::from_slice(&report.stdout).unwrap();
    assert_eq!(
        report["report"]["review"]["review"]["acquisition_receipt"],
        done["review"]["review"]["acquisition_receipt"]
    );
    assert_eq!(
        report["report"]["source"]["snapshot_sha256"],
        receipt.snapshot.digest
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn npm_requires_exact_version_and_rejects_mixed_transports_before_state() {
    let d = tempfile::tempdir().unwrap();
    let output = d.path().join("out");
    let state = d.path().join("state");
    for extra in [
        vec!["--version", "latest"],
        vec!["--version", "^1.0.0"],
        vec!["--version", "1.0.0", "--ref", "refs/heads/main"],
        vec!["--version", "1.0.0", "--url", "https://example.test/repo"],
        vec![],
    ] {
        let out = cli()
            .arg("--state")
            .arg(&state)
            .args(["source", "acquire", "--npm-package", "fixture", "--output"])
            .arg(&output)
            .args(extra)
            .output()
            .await
            .unwrap();
        assert!(!out.status.success());
        assert!(!state.exists());
        assert!(!output.exists());
    }
}

#[tokio::test]
async fn sigterm_drains_partial_npm_download_without_publication_or_model_state() {
    let d = tempfile::tempdir().unwrap();
    let state = d.path().join("db");
    let output = d.path().join("capture");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let child = cli()
        .arg("--state")
        .arg(&state)
        .args([
            "source",
            "acquire",
            "--npm-package",
            "fixture",
            "--version",
            "1.2.3",
            "--registry",
            &base,
            "--output",
        ])
        .arg(&output)
        .spawn()
        .unwrap();
    let (mut metadata, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .unwrap()
        .unwrap();
    request(&mut metadata).await;
    let body=json!({"name":"fixture","version":"1.2.3","dist":{"tarball":format!("{base}held.tgz"),"integrity":format!("sha512-{}==","A".repeat(86))}}).to_string();
    respond(&mut metadata, body.as_bytes(), "application/json").await;
    drop(metadata);
    let (mut held, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .unwrap()
        .unwrap();
    request(&mut held).await;
    held.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\npartial")
        .await
        .unwrap();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let done = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(done.status.code(), Some(143));
    assert!(String::from_utf8_lossy(&done.stderr).contains("npm acquisition cancelled"));
    assert!(done.stdout.is_empty());
    assert!(!state.exists());
    assert!(!output.exists());
    assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
    let mut last = [0; 1];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), held.read(&mut last))
            .await
            .unwrap()
            .unwrap(),
        0
    );
}
