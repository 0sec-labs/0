#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::Command,
};
#[path = "support/review_repair.rs"]
mod review_repair;
#[path = "support/review_repair_docker.rs"]
mod review_repair_docker;
#[path = "support/review_reproduce.rs"]
mod review_reproduce;

const SOURCE: &str = "fn main() {\n    println!(\"retained review marker\");\n}\n";
struct Fixture {
    _dir: tempfile::TempDir,
    source: PathBuf,
    state: PathBuf,
    profiles: PathBuf,
    providers: PathBuf,
    listener: TcpListener,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("app.rs"), SOURCE).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let providers = dir.path().join("providers.json");
        std::fs::write(&providers, json!({"fixture":{
            "url":format!("http://{}/responses",listener.local_addr().unwrap()),
            "api_key_env":"REVIEW_CLI_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},
            "timeout_ms":20000,"max_response_bytes":65536
        }}).to_string()).unwrap();
        let profiles = dir.path().join("reviews.json");
        std::fs::write(&profiles, json!({"local":{
            "schema_version":1,"provider":"fixture","model":"fixture","instructions":"Review pinned local source",
            "question":"Locate the greeting; submit only cited unverified observations.",
            "execution":{"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},
                "timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},
            "budget_limit":100,"currency":"units","reservation_per_turn":10,"max_turns":4,
            "max_hypotheses":4,"deadline_ms":60000
        }}).to_string()).unwrap();
        let state = dir.path().join("state.db");
        Self {
            _dir: dir,
            source,
            state,
            profiles,
            providers,
            listener,
        }
    }
    fn cli(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state")
            .arg(&self.state)
            .arg("--providers")
            .arg(&self.providers)
            .arg("--review-profiles")
            .arg(&self.profiles)
            .env("REVIEW_CLI_KEY", "local-provider-secret")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        c
    }
    fn run(&self, command: &str) -> Command {
        let mut c = self.cli();
        c.arg("review").arg(&self.source).args([
            "--profile",
            "local",
            "--command-id",
            command,
            "--format",
            "json",
        ]);
        c
    }
    async fn next(&self) -> (TcpStream, Value) {
        self.next_with_timeout(Duration::from_secs(15)).await
    }
    async fn next_with_timeout(&self, deadline: Duration) -> (TcpStream, Value) {
        tokio::time::timeout(deadline, async {
            let (mut stream, _) = self.listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).await.unwrap();
                assert_ne!(n, 0, "provider closed before request");
                bytes.extend_from_slice(&chunk[..n]);
                assert!(bytes.len() <= 1024 * 1024);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    assert!(headers.starts_with("POST /responses HTTP/1.1"));
                    let len: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + len {
                        return (
                            stream,
                            serde_json::from_slice(&bytes[end + 4..end + 4 + len]).unwrap(),
                        );
                    }
                }
            }
        })
        .await
        .expect("bounded local provider request")
    }
    async fn no_request(&self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(100), self.listener.accept())
                .await
                .is_err(),
            "unexpected second physical request"
        );
    }
}
async fn finish(child: tokio::process::Child) -> Output {
    tokio::time::timeout(Duration::from_secs(25), child.wait_with_output())
        .await
        .expect("bounded CLI execution")
        .unwrap()
}
fn decoded(out: &Output) -> Value {
    assert!(!String::from_utf8_lossy(&out.stdout).contains("local-provider-secret"));
    assert!(!String::from_utf8_lossy(&out.stderr).contains("local-provider-secret"));
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "{e}; status {:?}; stdout {}; stderr {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    })
}
async fn respond(mut stream: TcpStream, id: &str, name: &str, args: Value) {
    let event = json!({"type":"response.completed","response":{"id":id,"status":"completed",
        "output":[{"type":"function_call","id":format!("fc-{id}"),"call_id":id,"name":name,"arguments":args.to_string()}],
        "usage":{"input_tokens":2,"output_tokens":1}}});
    let body = format!("data: {event}\n\n");
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
fn tool_output(request: &Value, id: &str) -> Value {
    let item = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["type"] == "function_call_output" && v["call_id"] == id)
        .unwrap();
    serde_json::from_str(item["output"].as_str().unwrap()).unwrap()
}

async fn submit_cited(f: &Fixture, mut command: Command, digest: &str) -> Value {
    let mut child = command.spawn().unwrap();
    let (socket, _) = tokio::select! {
        pair = f.next() => pair,
        status = child.wait() => {
            let out = finish(child).await;
            panic!("review exited before submission: {status:?}; {} {}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        }
    };
    respond(socket, "submit", "submit_source_hypotheses", json!({"selected_files":["app.rs"],"hypotheses":[{
        "title":"Captured source","claimed_severity":"low","explanation":"A retained source observation, not a security conclusion.",
        "citations":[{"path":"app.rs","sha256":digest,"start_line":1,"end_line":3}]
    }]})).await;
    let out = finish(child).await;
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    decoded(&out)
}

#[tokio::test]
async fn cited_local_review_retains_report_and_retries_without_source_or_configuration() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new().await;
    std::fs::write(
        f.source.join("unselected.txt"),
        b"Retain this unselected source too.\n",
    )
    .unwrap();
    std::fs::write(f.source.join("binary.dat"), [0, 255, 0xc3, 0x28, 10]).unwrap();
    std::fs::write(
        f.source.join("run.sh"),
        b"#!/bin/sh\nprintf 'retained executable\\n'\n",
    )
    .unwrap();
    std::fs::set_permissions(
        f.source.join("run.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    // Distinct sparse chunks approach the archive cap without a giant fixture
    // allocation. Copying these blobs into a normal report view would exhaust
    // its 64 MiB aggregate budget once journal/request metadata is included.
    {
        use std::io::{Seek, SeekFrom, Write};
        let mut large = std::fs::File::create(f.source.join("large-unselected.bin")).unwrap();
        large.set_len(64 * 1024 * 1024 - 16 * 1024).unwrap();
        for index in 0..8u64 {
            large
                .seek(SeekFrom::Start(index * 8 * 1024 * 1024))
                .unwrap();
            large.write_all(&[index as u8 + 1]).unwrap();
        }
    }
    let original = zero_executor::pin_snapshot(&f.source).unwrap();
    let digest = original
        .files
        .iter()
        .find(|file| file.path == "app.rs")
        .unwrap()
        .digest
        .clone();
    let started = std::time::Instant::now();
    let mut child = f.run("cited-review").spawn().unwrap();
    let (socket, first) = tokio::select! {
        request = f.next_with_timeout(Duration::from_secs(90)) => request,
        status = child.wait() => {
            let mut stdout = String::new();
            let mut stderr = String::new();
            child.stdout.take().unwrap().read_to_string(&mut stdout).await.unwrap();
            child.stderr.take().unwrap().read_to_string(&mut stderr).await.unwrap();
            panic!("large archive review exited before provider: {status:?}; stdout={stdout}; stderr={stderr}");
        }
    };
    eprintln!(
        "near-64MiB review preparation before first provider: {:?}",
        started.elapsed()
    );
    // Physical provider admission can only occur after the full root archive
    // was atomically retained, not merely after a selected-text bundle exists.
    {
        let store = zero_store::Store::open_read_only(&f.state).unwrap();
        let record = store.review_by_command("cited-review").unwrap().unwrap();
        let events = store.events(&record.session_id, 0, 100).unwrap();
        let archived = events
            .iter()
            .find(|event| {
                event.kind == "review_source_archived"
                    && event.payload["root_operation_id"] == record.root_operation_id
            })
            .unwrap();
        let inference = events
            .iter()
            .find(|event| {
                event.kind == "command_admitted"
                    && event.payload["payload"]["kind"] == "agent_inference"
            })
            .unwrap();
        assert!(archived.sequence < inference.sequence);
    }
    let names: Vec<_> = first["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for name in [
        "search_source_text",
        "read_source_lines",
        "submit_source_hypotheses",
    ] {
        assert!(names.contains(&name));
    }
    assert!(!names.contains(&"http_request"));
    respond(
        socket,
        "search",
        "search_source_text",
        json!({"query":"retained review marker","max_results":10}),
    )
    .await;
    let (socket, second) = f.next().await;
    let search = tool_output(&second, "search");
    assert_eq!(search["matches"][0]["citation"]["sha256"], digest);
    assert_eq!(search["matches"][0]["citation"]["path"], "app.rs");
    respond(
        socket,
        "read",
        "read_source_lines",
        json!({"path":"app.rs","start_line":1,"end_line":3}),
    )
    .await;
    let (socket, third) = f.next().await;
    assert!(
        tool_output(&third, "read")
            .to_string()
            .contains("retained review marker")
    );
    respond(socket,"submit","submit_source_hypotheses",json!({"selected_files":["app.rs"],"hypotheses":[{
        "title":"Greeting is present","claimed_severity":"low","explanation":"The retained source contains a literal greeting, not a demonstrated vulnerability.",
        "citations":[{"path":"app.rs","sha256":digest,"start_line":1,"end_line":3}]
    }]})).await;
    let out = finish(child).await;
    let run = decoded(&out);
    assert!(
        out.status.success(),
        "{run}; {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(run["duplicate"], false);
    let snapshot = &run["review"];
    assert_eq!(snapshot["root_status"], "succeeded");
    assert_eq!(snapshot["controller_status"], "succeeded");
    assert_eq!(snapshot["budget"]["charged"], 9);
    assert_eq!(snapshot["budget"]["reserved"], 0);
    assert_eq!(
        std::fs::read_to_string(f.source.join("app.rs")).unwrap(),
        SOURCE
    );
    assert_eq!(
        zero_executor::pin_snapshot(&f.source).unwrap().digest,
        original.digest
    );
    let id = snapshot["review"]["id"].as_str().unwrap();
    let report_out = finish(
        f.cli()
            .args(["review", "report", "--review", id, "--format", "json"])
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(report_out.status.success());
    let report = decoded(&report_out)["report"].clone();
    assert!(serde_json::to_vec(&report).unwrap().len() < 64 * 1024);
    assert_eq!(report["security_conclusion"], "not_established");
    assert_eq!(report["source"]["verification_state"], "unverified");
    let claims = report["source"]["review"]["hypotheses"].as_array().unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0]["state"], "unverified");
    assert_eq!(claims[0]["claim"]["citations"][0]["sha256"], digest);
    std::fs::remove_dir_all(&f.source).unwrap();
    std::fs::remove_file(&f.profiles).unwrap();
    std::fs::remove_file(&f.providers).unwrap();
    {
        let store = zero_store::Store::open_read_only(&f.state).unwrap();
        let archive = store.review_source_archive(id).unwrap().unwrap();
        archive.validate_pin(&original).unwrap();
        assert_eq!(archive.manifest.files.len(), 5);
        assert!(archive.blobs.values().map(Vec::len).sum::<usize>() > 63 * 1024 * 1024);
        assert!(
            archive
                .manifest
                .files
                .iter()
                .any(|file| file.path == "run.sh" && file.executable)
        );
        let (stage, restored) = zero_executor::stage_source_archive(&archive, &|| Ok(())).unwrap();
        assert_eq!(restored.digest, original.digest);
        assert_eq!(
            serde_json::to_value(&restored.files).unwrap(),
            serde_json::to_value(&original.files).unwrap()
        );
        zero_executor::verify_snapshot(&restored, &|| Ok(())).unwrap();
        let root = std::path::Path::new(&restored.root);
        assert_eq!(
            std::fs::read(root.join("app.rs")).unwrap(),
            SOURCE.as_bytes()
        );
        assert_eq!(
            std::fs::read(root.join("unselected.txt")).unwrap(),
            b"Retain this unselected source too.\n"
        );
        assert_eq!(
            std::fs::read(root.join("binary.dat")).unwrap(),
            [0, 255, 0xc3, 0x28, 10]
        );
        assert_ne!(
            std::fs::metadata(root.join("run.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
        assert_eq!(
            std::fs::metadata(root.join("app.rs"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
        assert_eq!(
            std::fs::metadata(root.join("large-unselected.bin"))
                .unwrap()
                .len(),
            64 * 1024 * 1024 - 16 * 1024
        );
        stage.remove().unwrap();
    }
    let retry_out = finish(
        f.run("cited-review")
            .env_remove("REVIEW_CLI_KEY")
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        retry_out.status.success(),
        "{}",
        String::from_utf8_lossy(&retry_out.stderr)
    );
    let retry = decoded(&retry_out);
    assert_eq!(retry["duplicate"], true);
    assert_eq!(retry["review"]["review"], snapshot["review"]);
    assert_eq!(retry["review"]["budget"], snapshot["budget"]);
    for (mode, selector, key) in [
        ("show", "--review", id),
        ("report", "--review", id),
        ("show", "--command-id", "cited-review"),
        ("report", "--command-id", "cited-review"),
    ] {
        let mut c = f.cli();
        c.env_remove("REVIEW_CLI_KEY")
            .args(["review", mode, selector, key]);
        if mode == "report" {
            c.args(["--format", "json"]);
        }
        let out = finish(c.spawn().unwrap()).await;
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let value = decoded(&out);
        if mode == "report" {
            assert_eq!(value["report"]["source"], report["source"]);
            assert_eq!(value["report"]["security_conclusion"], "not_established");
        } else {
            assert_eq!(value["review"]["review"], snapshot["review"]);
        }
    }
    let sarif_out = finish(
        f.cli()
            .env_remove("REVIEW_CLI_KEY")
            .args([
                "review",
                "report",
                "--command-id",
                "cited-review",
                "--format",
                "sarif",
            ])
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        sarif_out.status.success(),
        "{}",
        String::from_utf8_lossy(&sarif_out.stderr)
    );
    let sarif = decoded(&sarif_out);
    let run = &sarif["runs"][0];
    assert_eq!(run["properties"]["sourceReport"], report["source"]);
    assert_eq!(run["properties"]["reportState"], "source_submission");
    assert_eq!(run["properties"]["review"]["budget"], snapshot["budget"]);
    assert_eq!(run["results"][0]["kind"], "review");
    assert_eq!(run["results"][0]["level"], "note");
    let sarif_retry = finish(
        f.cli()
            .env_remove("REVIEW_CLI_KEY")
            .arg("review")
            .arg(&f.source)
            .args([
                "--profile",
                "local",
                "--command-id",
                "cited-review",
                "--format",
                "sarif",
            ])
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        sarif_retry.status.success(),
        "{}",
        String::from_utf8_lossy(&sarif_retry.stderr)
    );
    let sarif_retry = decoded(&sarif_retry);
    assert_eq!(
        sarif_retry["runs"][0]["properties"]["sourceReport"],
        report["source"]
    );
    assert_eq!(
        sarif_retry["runs"][0]["properties"]["review"]["budget"],
        snapshot["budget"]
    );
    for (path, profile) in [
        (f.source.with_extension("changed"), "local"),
        (f.source.clone(), "changed"),
    ] {
        let out = finish(
            f.cli()
                .arg("review")
                .arg(path)
                .args([
                    "--profile",
                    profile,
                    "--command-id",
                    "cited-review",
                    "--format",
                    "json",
                ])
                .spawn()
                .unwrap(),
        )
        .await;
        assert_eq!(out.status.code(), Some(2));
    }
    f.no_request().await;
}

#[tokio::test]
async fn sigterm_drains_local_review_and_preserves_uncertain_model_hold() {
    let f = Fixture::new().await;
    let child = f.run("held-review").spawn().unwrap();
    let pid = child.id().unwrap();
    let (mut socket, _) = f.next().await;
    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"working\"}\n\n").await.unwrap();
    let store = zero_store::Store::open_read_only(&f.state).unwrap();
    let record = store.review_by_command("held-review").unwrap().unwrap();
    let before = store.review_snapshot(&record.id).unwrap();
    assert_eq!(before.budget.reserved, 10);
    drop(store);
    let live = finish(
        f.cli()
            .args(["review", "show", "--command-id", "held-review"])
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        live.status.success(),
        "{}",
        String::from_utf8_lossy(&live.stderr)
    );
    let live = decoded(&live);
    assert_eq!(live["review"]["review"]["id"], record.id);
    assert_eq!(live["review"]["root_status"], "running");
    assert_eq!(live["review"]["budget"]["reserved"], 10);
    let kill = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .unwrap();
    assert!(kill.success());
    let out = finish(child).await;
    assert_eq!(
        out.status.code(),
        Some(143),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let reply = decoded(&out);
    assert_eq!(reply["review"]["review"]["id"], record.id);
    assert_eq!(reply["review"]["close_reason"], "cancelled");
    assert_eq!(reply["review"]["budget"]["reserved"], 10);
    assert_ne!(reply["review"]["root_status"], "running");
    assert_ne!(reply["review"]["controller_status"], "running");
    drop(socket);
    let report_out = finish(
        f.cli()
            .args([
                "review",
                "report",
                "--command-id",
                "held-review",
                "--format",
                "json",
            ])
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        report_out.status.success(),
        "{}",
        String::from_utf8_lossy(&report_out.stderr)
    );
    let report = decoded(&report_out);
    assert_eq!(report["report"]["security_conclusion"], "not_established");
    assert!(report["report"]["source"].is_null());
    assert_eq!(report["report"]["review"]["budget"]["reserved"], 10);
    let sarif_out = finish(
        f.cli()
            .env_remove("REVIEW_CLI_KEY")
            .args([
                "review",
                "report",
                "--command-id",
                "held-review",
                "--format",
                "sarif",
            ])
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        sarif_out.status.success(),
        "{}",
        String::from_utf8_lossy(&sarif_out.stderr)
    );
    let sarif = decoded(&sarif_out);
    let run = &sarif["runs"][0];
    assert_eq!(run["results"], json!([]));
    assert!(run["properties"]["sourceReport"].is_null());
    assert_eq!(run["properties"]["reportState"], "no_source_submission");
    assert_eq!(run["properties"]["review"]["budget"]["reserved"], 10);
    assert_eq!(run["properties"]["review"]["close_reason"], "cancelled");
    assert_eq!(run["properties"]["securityConclusion"], "not_established");
    assert!(run.get("invocations").is_none());

    assert_eq!(
        std::fs::read_to_string(f.source.join("app.rs")).unwrap(),
        SOURCE
    );
    f.no_request().await;
}

#[tokio::test]
async fn deadline_stops_open_provider_stream_without_releasing_the_usage_hold() {
    let f = Fixture::new().await;
    let mut profiles: Value = serde_json::from_slice(&std::fs::read(&f.profiles).unwrap()).unwrap();
    profiles["local"]["deadline_ms"] = json!(1000);
    std::fs::write(&f.profiles, profiles.to_string()).unwrap();
    let child = f.run("deadline-review").spawn().unwrap();
    let (mut socket, _) = f.next().await;
    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"working\"}\n\n").await.unwrap();
    let out = finish(child).await;
    assert_eq!(
        out.status.code(),
        Some(2),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let run = decoded(&out);
    assert_eq!(run["review"]["close_reason"], "deadline");
    assert_eq!(run["review"]["budget"]["reserved"], 10);
    assert_eq!(run["review"]["budget"]["charged"], 0);
    assert_ne!(run["review"]["root_status"], "running");
    assert_ne!(run["review"]["controller_status"], "running");
    drop(socket);
    let out = finish(
        f.cli()
            .args([
                "review",
                "report",
                "--command-id",
                "deadline-review",
                "--format",
                "json",
            ])
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = decoded(&out);
    assert!(report["report"]["source"].is_null());
    assert_eq!(report["report"]["security_conclusion"], "not_established");
    assert_eq!(report["report"]["review"]["budget"]["reserved"], 10);
    f.no_request().await;
}

#[tokio::test]
async fn owner_loss_recovery_retains_unknown_and_never_replays_a_paid_inference() {
    let f = Fixture::new().await;
    let mut child = f.run("lost-review").spawn().unwrap();
    let (mut socket, _) = f.next().await;
    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"working\"}\n\n").await.unwrap();
    let store = zero_store::Store::open_read_only(&f.state).unwrap();
    let original = store.review_by_command("lost-review").unwrap().unwrap();
    assert_eq!(
        store.review_snapshot(&original.id).unwrap().budget.reserved,
        10
    );
    drop(store);
    child.start_kill().unwrap(); // SIGKILL deliberately prevents graceful shutdown.
    let out = finish(child).await;
    assert!(!out.status.success());
    drop(socket);
    std::fs::remove_dir_all(&f.source).unwrap();
    std::fs::remove_file(&f.profiles).unwrap();
    std::fs::remove_file(&f.providers).unwrap();
    // A new real engine owner performs existing epoch recovery. Read-only retry
    // itself must neither seize ownership nor resume the lost model operation.
    let mut recovery = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    recovery
        .arg("--state")
        .arg(&f.state)
        .args(["session", "create", "--budget-limit", "1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let out = finish(recovery.spawn().unwrap()).await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let out = finish(
        f.run("lost-review")
            .env_remove("REVIEW_CLI_KEY")
            .spawn()
            .unwrap(),
    )
    .await;
    assert_eq!(
        out.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let retry = decoded(&out);
    assert_eq!(retry["duplicate"], true);
    assert_eq!(retry["review"]["review"]["id"], original.id);
    assert_eq!(retry["review"]["root_status"], "unknown");
    assert_eq!(retry["review"]["controller_status"], "unknown");
    assert_eq!(retry["review"]["budget"]["reserved"], 10);
    assert_eq!(retry["review"]["budget"]["charged"], 0);
    let out = finish(
        f.cli()
            .env_remove("REVIEW_CLI_KEY")
            .args([
                "review",
                "report",
                "--command-id",
                "lost-review",
                "--format",
                "json",
            ])
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = decoded(&out);
    assert!(report["report"]["source"].is_null());
    assert_eq!(report["report"]["security_conclusion"], "not_established");
    assert_eq!(report["report"]["review"]["budget"]["reserved"], 10);
    f.no_request().await;
}

#[tokio::test]
async fn review_current_directory_stages_before_creating_default_state_and_retries_in_place() {
    let f = Fixture::new().await;
    std::fs::create_dir_all(f.source.join(".0sec/native")).unwrap();
    std::fs::write(
        f.source.join(".0sec/native/notes.rs"),
        b"// adjacent source, never excluded\n",
    )
    .unwrap();
    std::fs::write(
        f.source.join(".0sec/native/state.db.backup"),
        b"ordinary source despite similar name",
    )
    .unwrap();
    std::fs::write(
        f.source.join("untracked.rs"),
        b"// current untracked source\n",
    )
    .unwrap();
    let original = zero_executor::pin_snapshot(&f.source).unwrap();
    let digest = original
        .files
        .iter()
        .find(|file| file.path == "app.rs")
        .unwrap()
        .digest
        .clone();
    let default_state = f.source.join(".0sec/native/state.db");
    assert!(!default_state.exists());
    let cli = || {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.current_dir(&f.source)
            .arg("--providers")
            .arg(&f.providers)
            .arg("--review-profiles")
            .arg(&f.profiles)
            .env("REVIEW_CLI_KEY", "local-provider-secret")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        c
    };
    let args = [
        "review",
        ".",
        "--profile",
        "local",
        "--command-id",
        "default-state-review",
        "--format",
        "json",
    ];
    let mut child = cli().args(args).spawn().unwrap();
    let (socket, _) = tokio::select! {
        pair = f.next() => pair,
        status = child.wait() => {
            let out = finish(child).await;
            panic!("default-state CLI exited before provider request: {status:?}; {} {}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        }
    };
    assert!(
        default_state.exists(),
        "admitted provider work has a durable default database"
    );
    respond(
        socket,
        "read",
        "read_source_lines",
        json!({"path":"app.rs","start_line":1,"end_line":3}),
    )
    .await;
    let (socket, request) = tokio::select! {
        pair = f.next() => pair,
        status = child.wait() => {
            let out = finish(child).await;
            panic!("default-state CLI exited before submission: {status:?}; {} {}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        }
    };
    assert!(
        tool_output(&request, "read")
            .to_string()
            .contains("retained review marker")
    );
    respond(socket, "submit", "submit_source_hypotheses", json!({"selected_files":["app.rs"],"hypotheses":[{
        "title":"Captured greeting","claimed_severity":"low","explanation":"The pinned source contains a greeting; no security conclusion.",
        "citations":[{"path":"app.rs","sha256":digest,"start_line":1,"end_line":3}]
    }]})).await;
    let out = finish(child).await;
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let run = decoded(&out);
    assert_eq!(run["review"]["review"]["input_path"], ".");
    let captured = run["review"]["review"]["canonical_path"].as_str().unwrap();
    assert_ne!(std::path::Path::new(captured), f.source.as_path());
    assert!(
        !std::path::Path::new(captured).exists(),
        "drained review must remove its private staged source"
    );
    assert_eq!(run["review"]["review"]["snapshot_sha256"], original.digest);
    assert_eq!(run["review"]["root_status"], "succeeded");
    assert_eq!(run["review"]["budget"]["charged"], 6);
    assert_eq!(run["review"]["budget"]["reserved"], 0);
    assert_eq!(
        std::fs::read_to_string(f.source.join("app.rs")).unwrap(),
        SOURCE
    );
    let scope = &run["review"]["review"]["workspace_selection"];
    assert_eq!(scope["original_root"], f.source.to_str().unwrap());
    assert_eq!(scope["policy"]["kind"], "exclude_native_state");
    assert_eq!(
        scope["policy"]["state_relative_path"],
        ".0sec/native/state.db"
    );
    assert_eq!(scope["exclusions"].as_array().unwrap().len(), 5);
    let second_args = [
        "review",
        ".",
        "--profile",
        "local",
        "--command-id",
        "default-state-review-2",
        "--format",
        "json",
    ];
    let second = submit_cited(
        &f,
        {
            let mut c = cli();
            c.args(second_args);
            c
        },
        &digest,
    )
    .await;
    assert_eq!(second["duplicate"], false);
    assert_ne!(
        second["review"]["review"]["id"],
        run["review"]["review"]["id"]
    );
    assert_eq!(
        second["review"]["review"]["snapshot_sha256"],
        original.digest
    );
    assert_eq!(second["review"]["review"]["workspace_selection"], *scope);
    {
        let store = zero_store::Store::open_read_only(&default_state).unwrap();
        let first_archive = store
            .review_source_archive(run["review"]["review"]["id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        let second_archive = store
            .review_source_archive(second["review"]["review"]["id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(first_archive, second_archive);
        let paths: Vec<_> = first_archive
            .manifest
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        for path in [
            "app.rs",
            "untracked.rs",
            ".0sec/native/notes.rs",
            ".0sec/native/state.db.backup",
        ] {
            assert!(paths.contains(&path));
        }
        for rule in scope["exclusions"].as_array().unwrap() {
            assert!(!paths.contains(&rule.as_str().unwrap()));
        }
    }
    for format in ["terminal", "markdown", "html"] {
        let out = finish(
            cli()
                .args([
                    "review",
                    "report",
                    "--command-id",
                    "default-state-review-2",
                    "--format",
                    format,
                ])
                .spawn()
                .unwrap(),
        )
        .await;
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let rendered = String::from_utf8(out.stdout).unwrap();
        assert!(rendered.contains("Workspace root:"));
        assert!(rendered.contains("Configured exclusion rules (including absent paths):"));
        assert!(rendered.contains(".0sec/native/state.db"));
    }
    std::fs::remove_file(f.source.join("app.rs")).unwrap();
    std::fs::remove_file(&f.providers).unwrap();
    std::fs::remove_file(&f.profiles).unwrap();
    let out = finish(
        cli()
            .args(args)
            .env_remove("REVIEW_CLI_KEY")
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let retry = decoded(&out);
    assert_eq!(retry["duplicate"], true);
    assert_eq!(retry["review"]["review"], run["review"]["review"]);
    assert_eq!(retry["review"]["budget"], run["review"]["budget"]);
    let out = finish(
        cli()
            .args([
                "review",
                "report",
                "--command-id",
                "default-state-review",
                "--format",
                "json",
            ])
            .env_remove("REVIEW_CLI_KEY")
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = decoded(&out);
    assert_eq!(
        report["report"]["source"]["snapshot_sha256"],
        original.digest
    );
    assert_eq!(
        report["report"]["source"]["review"]["hypotheses"][0]["claim"]["citations"][0]["sha256"],
        digest
    );
    assert_eq!(report["report"]["security_conclusion"], "not_established");
    f.no_request().await;
}

#[tokio::test]
async fn workspace_selection_supports_custom_external_state_and_explicit_full_tree() {
    for in_source in [false, true] {
        let mut f = Fixture::new().await;
        if in_source {
            f.state = f.source.join("control/native.sqlite");
        }
        let original = zero_executor::pin_snapshot(&f.source).unwrap();
        let digest = original
            .files
            .iter()
            .find(|file| file.path == "app.rs")
            .unwrap()
            .digest
            .clone();
        let first = submit_cited(&f, f.run("selected-first"), &digest).await;
        let second = submit_cited(&f, f.run("selected-second"), &digest).await;
        assert_eq!(
            first["review"]["review"]["snapshot_sha256"],
            original.digest
        );
        assert_eq!(
            second["review"]["review"]["snapshot_sha256"],
            original.digest
        );
        let selection = &second["review"]["review"]["workspace_selection"];
        assert_eq!(selection["original_root"], f.source.to_str().unwrap());
        assert_eq!(
            selection["policy"]["kind"],
            if in_source {
                "exclude_native_state"
            } else {
                "full_tree"
            }
        );
        if in_source {
            assert_eq!(
                selection["policy"]["state_relative_path"],
                "control/native.sqlite"
            );
            assert_eq!(selection["exclusions"].as_array().unwrap().len(), 5);
            let mut profile: Value =
                serde_json::from_slice(&std::fs::read(&f.profiles).unwrap()).unwrap();
            profile["local"]["workspace_selection"] = json!("full_tree");
            std::fs::write(&f.profiles, serde_json::to_vec(&profile).unwrap()).unwrap();
            let full = submit_cited(&f, f.run("explicit-full-tree"), &digest).await;
            assert_eq!(
                full["review"]["review"]["workspace_selection"]["policy"]["kind"],
                "full_tree"
            );
            assert!(
                full["review"]["review"]["workspace_selection"]["exclusions"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            let archive = zero_store::Store::open_read_only(&f.state)
                .unwrap()
                .review_source_archive(full["review"]["review"]["id"].as_str().unwrap())
                .unwrap()
                .unwrap();
            assert!(
                archive
                    .manifest
                    .files
                    .iter()
                    .any(|file| file.path == "control/native.sqlite")
            );
        } else {
            assert!(selection["exclusions"].as_array().unwrap().is_empty());
        }
        assert_eq!(
            std::fs::read_to_string(f.source.join("app.rs")).unwrap(),
            SOURCE
        );
        f.no_request().await;
    }
}
