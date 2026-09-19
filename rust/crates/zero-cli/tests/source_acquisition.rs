#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    process::Command,
};

fn commit(root: &Path) -> String {
    for args in [
        vec!["init", "--initial-branch=main"],
        vec!["add", "."],
        vec!["commit", "-m", "fixture"],
    ] {
        let status = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }
    String::from_utf8(
        std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .into()
}
fn cli() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    c.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    c
}

#[tokio::test]
async fn actual_acquisition_is_reviewable_and_retained_source_survives_repository_deletion() {
    let d = tempfile::tempdir().unwrap();
    let repo = d.path().join("repository");
    std::fs::create_dir(&repo).unwrap();
    std::fs::write(repo.join("app.rs"), "fn main() {}\n").unwrap();
    let commit = commit(&repo);
    std::fs::write(
        repo.join("dirty-secret"),
        "uncommitted source is not the Git tree",
    )
    .unwrap();
    let capture = d.path().join("capture");
    let state = d.path().join("state.db");
    let hostile = d.path().join("hostile.gitconfig");
    let marker = d.path().join("ambient-executed");
    std::fs::write(
        &hostile,
        format!(
            "[credential]\n helper = !touch {}\n[url \"ext::sh -c touch {}\"]\n insteadOf = /\n",
            marker.display(),
            marker.display()
        ),
    )
    .unwrap();
    let acquired = tokio::time::timeout(
        Duration::from_secs(15),
        cli()
            .arg("--state")
            .arg(&state)
            .args(["source", "acquire", "--local-repository"])
            .arg(&repo)
            .args(["--ref", "refs/heads/main", "--output"])
            .arg(&capture)
            .env("GIT_CONFIG_GLOBAL", &hostile)
            .env("GIT_CONFIG_SYSTEM", &hostile)
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "protocol.ext.allow")
            .env("GIT_CONFIG_VALUE_0", "always")
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
    let receipt: zero_protocol::source_acquisition::RepositoryReceipt =
        serde_json::from_slice(&acquired.stdout).unwrap();
    receipt.validate().unwrap();
    assert_eq!(receipt.commit_oid, commit);
    assert_eq!(receipt.snapshot.files.len(), 1);
    assert!(!state.exists());
    assert!(!marker.exists());
    let retained: Value =
        serde_json::from_slice(&std::fs::read(capture.join("receipt.json")).unwrap()).unwrap();
    assert_eq!(retained, serde_json::to_value(&receipt).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let providers = d.path().join("providers.json");
    let profiles = d.path().join("reviews.json");
    std::fs::write(&providers,json!({"fixture":{"url":format!("http://{}/responses",listener.local_addr().unwrap()),"api_key_env":"SOURCE_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":10000,"max_response_bytes":65536}}).to_string()).unwrap();
    std::fs::write(&profiles,json!({"local":{"schema_version":1,"provider":"fixture","model":"fixture","instructions":"Inspect source","question":"Review the committed function","execution":{"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"budget_limit":20,"currency":"units","reservation_per_turn":10,"max_turns":2,"max_hypotheses":2,"deadline_ms":30000}}).to_string()).unwrap();
    // Every mismatched capture fails before Engine creates state or sends an inference.
    use std::os::unix::fs::PermissionsExt;
    let source_file = capture.join("source/app.rs");
    for mismatch in 0..4 {
        let rejected_state = d.path().join(format!("rejected-{mismatch}.db"));
        let mut altered = receipt.clone();
        match mismatch {
            0 => std::fs::write(&source_file, b"changed source").unwrap(),
            1 => std::fs::set_permissions(&source_file, std::fs::Permissions::from_mode(0o755))
                .unwrap(),
            2 => altered.snapshot.root = "/another/source".into(),
            _ => {}
        }
        let mut bytes = altered.canonical_bytes().unwrap();
        if mismatch == 3 {
            bytes.push(b'\n');
        }
        std::fs::write(capture.join("receipt.json"), bytes).unwrap();
        let rejected = tokio::time::timeout(
            Duration::from_secs(10),
            cli()
                .arg("--state")
                .arg(&rejected_state)
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
                    "rejected",
                    "--format",
                    "json",
                ])
                .env("SOURCE_FIXTURE_KEY", "fixture-only")
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!rejected.status.success(), "mismatch {mismatch} accepted");
        assert!(
            !rejected_state.exists(),
            "mismatch {mismatch} opened Engine"
        );
        std::fs::write(&source_file, b"fn main() {}\n").unwrap();
        std::fs::set_permissions(&source_file, std::fs::Permissions::from_mode(0o644)).unwrap();
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
    let child = cli()
        .arg("--state")
        .arg(&state)
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
            "acquired-review",
            "--format",
            "json",
        ])
        .env("SOURCE_FIXTURE_KEY", "fixture-only")
        .spawn()
        .unwrap();
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(15), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut request = Vec::new();
    loop {
        let mut b = [0u8; 4096];
        let n = socket.read(&mut b).await.unwrap();
        assert!(n > 0);
        request.extend_from_slice(&b[..n]);
        assert!(request.len() < 1024 * 1024);
        if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&request[..end]);
            let count: usize = headers
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse().unwrap())
                })
                .unwrap();
            if request.len() >= end + 4 + count {
                break;
            }
        }
    }
    let arguments = json!({"selected_files":["app.rs"],"hypotheses":[{"title":"Committed function","claimed_severity":"low","explanation":"Unverified source observation","citations":[{"path":"app.rs","sha256":receipt.snapshot.files[0].digest,"start_line":1,"end_line":1}]}]});
    let event = json!({"type":"response.completed","response":{"id":"fixture","status":"completed","output":[{"type":"function_call","id":"fc-submit","call_id":"submit","name":"submit_source_hypotheses","arguments":arguments.to_string()}],"usage":{"input_tokens":2,"output_tokens":1}}});
    let body = format!("data: {event}\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    drop(socket);
    let completed = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        completed.status.success(),
        "{}",
        String::from_utf8_lossy(&completed.stderr)
    );
    let result: Value = serde_json::from_slice(&completed.stdout).unwrap();
    let id = result["review"]["review"]["id"].as_str().unwrap();
    let store = zero_store::Store::open_read_only(&state).unwrap();
    assert_eq!(
        store
            .review_source_archive_manifest(id)
            .unwrap()
            .unwrap()
            .snapshot_sha256,
        receipt.snapshot.digest
    );
    let provenance = store.review_acquisition_receipt(id).unwrap().unwrap();
    assert_eq!(provenance.receipt.commit_oid, commit);
    assert_eq!(
        result["review"]["review"]["acquisition_receipt"]["commit_oid"],
        commit
    );
    drop(store);
    std::fs::remove_file(capture.join("receipt.json")).unwrap();
    std::fs::remove_dir_all(&repo).unwrap();
    std::fs::remove_dir_all(capture.join("source")).unwrap();
    std::fs::remove_file(profiles).unwrap();
    std::fs::remove_file(providers).unwrap();
    let retry = cli()
        .arg("--state")
        .arg(&state)
        .arg("review")
        .arg(capture.join("source"))
        .arg("--acquisition-receipt")
        .arg(capture.join("receipt.json"))
        .args([
            "--profile",
            "local",
            "--command-id",
            "acquired-review",
            "--format",
            "json",
        ])
        .output()
        .await
        .unwrap();
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    let retry: Value = serde_json::from_slice(&retry.stdout).unwrap();
    assert_eq!(retry["duplicate"], true);
    for selector in [None, Some(capture.join("different.json"))] {
        let mut command = cli();
        command
            .arg("--state")
            .arg(&state)
            .arg("review")
            .arg(capture.join("source"))
            .args([
                "--profile",
                "local",
                "--command-id",
                "acquired-review",
                "--format",
                "json",
            ]);
        if let Some(path) = selector {
            command.arg("--acquisition-receipt").arg(path);
        }
        let conflict = command.output().await.unwrap();
        assert!(!conflict.status.success());
        assert!(String::from_utf8_lossy(&conflict.stderr).contains("identity conflicts"));
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
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
        report["report"]["review"]["review"]["acquisition_receipt"]["commit_oid"],
        commit
    );
    assert_eq!(
        report["report"]["source"]["snapshot_sha256"],
        receipt.snapshot.digest
    );
    assert_eq!(
        report["report"]["source"]["review"]["hypotheses"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn rejects_credentials_and_unknown_protocol_without_creating_state_or_output() {
    let d = tempfile::tempdir().unwrap();
    let state = d.path().join("state.db");
    let output = d.path().join("capture");
    for url in [
        "https://user:credential-secret@example.invalid/repo",
        "ssh://example.invalid/repo",
        "file:///tmp/repo",
    ] {
        let result = cli()
            .arg("--state")
            .arg(&state)
            .args([
                "source",
                "acquire",
                "--url",
                url,
                "--ref",
                "refs/heads/main",
                "--output",
            ])
            .arg(&output)
            .output()
            .await
            .unwrap();
        assert!(!result.status.success());
        assert!(!state.exists());
        assert!(!output.exists());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("credential-secret"));
    }
}

#[tokio::test]
async fn signal_drains_acquisition_and_reports_its_disposition() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let repo = d.path().join("repository");
    std::fs::create_dir(&repo).unwrap();
    std::fs::write(repo.join("app.rs"), "fn main() {}\n").unwrap();
    commit(&repo);
    let marker = d.path().join("started");
    let wrapper = d.path().join("git-wrapper");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nprintf ready > '{}'\nexec /bin/sleep 30\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let output = d.path().join("capture");
    let mut child = cli()
        .args(["source", "acquire", "--local-repository"])
        .arg(&repo)
        .args(["--ref", "refs/heads/main", "--output"])
        .arg(&output)
        .arg("--git-bin")
        .arg(&wrapper)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !marker.exists() {
            assert!(child.try_wait().unwrap().is_none());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.status.code(), Some(143));
    assert!(!output.exists());
    assert!(
        String::from_utf8_lossy(&result.stderr)
            .contains("Acquisition stopped: Git acquisition cancelled")
    );
}
