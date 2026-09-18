//! Explicit full-snapshot source tools, localhost provider only; no Docker or paid calls.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
use zero_engine::Engine;
use zero_protocol::{
    Command, Reply,
    agent::{AgentRequest, AgentStatus},
    model::{Rates, WireApi},
    session::OperationStatus,
};
use zero_provider::{Endpoint, ProviderClient};

fn completed(items: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({"type":"response.completed","response":{"id":"fixture","status":"completed","output":items,"usage":{"input_tokens":1,"output_tokens":1}}})
    )
}
fn answer() -> String {
    completed(
        json!([{"type":"message","content":[{"type":"output_text","text":"fixture complete"}]}]),
    )
}
fn tool(id: &str, name: &str, args: Value) -> Value {
    json!({"type":"function_call","call_id":id,"name":name,"arguments":args.to_string()})
}
struct Http {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    ready: CancellationToken,
    release: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Http {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Http {
    async fn new(responses: Vec<String>, hold_first: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/responses", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(vec![]));
        let captured = requests.clone();
        let ready = CancellationToken::new();
        let signal = ready.clone();
        let release = CancellationToken::new();
        let gate = release.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = tokio::time::timeout(Duration::from_secs(3), async {
                    let mut bytes = vec![];
                    loop {
                        let mut buf = [0; 4096];
                        let n = stream.read(&mut buf).await.unwrap();
                        assert_ne!(n, 0);
                        bytes.extend_from_slice(&buf[..n]);
                        assert!(bytes.len() < 1_000_000);
                        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                            let length = String::from_utf8_lossy(&bytes[..end])
                                .lines()
                                .find_map(|line| {
                                    let (k, v) = line.split_once(':')?;
                                    k.eq_ignore_ascii_case("content-length")
                                        .then(|| v.trim().parse::<usize>().unwrap())
                                })
                                .unwrap();
                            if bytes.len() >= end + 4 + length {
                                break serde_json::from_slice::<Value>(
                                    &bytes[end + 4..end + 4 + length],
                                )
                                .unwrap();
                            }
                        }
                    }
                })
                .await
                .unwrap();
                let index = {
                    let mut requests = captured.lock().unwrap();
                    let index = requests.len();
                    requests.push(request);
                    index
                };
                signal.cancel();
                if index == 0 && hold_first {
                    gate.cancelled().await;
                }
                let body = responses
                    .get(index)
                    .unwrap_or_else(|| responses.last().unwrap());
                if stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.is_err() {continue;}
            }
        });
        Self {
            url,
            requests,
            ready,
            release,
            task,
        }
    }
    fn configure(&self, engine: &Engine) {
        engine
            .configure_provider(
                "fixture",
                ProviderClient::with_wire(
                    Endpoint::responses(&self.url, None).unwrap(),
                    WireApi::Responses,
                    Duration::from_secs(10),
                    65536,
                )
                .unwrap(),
                Rates {
                    input: 1_000_000,
                    cached_input: 1_000_000,
                    output: 1_000_000,
                },
            )
            .unwrap();
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
    async fn wait(&self) {
        tokio::time::timeout(Duration::from_secs(5), self.ready.cancelled())
            .await
            .unwrap();
    }
}
async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, mut rx) = mpsc::channel(64);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let reply = tokio::time::timeout(Duration::from_secs(10), engine.handle(command, tx))
        .await
        .unwrap();
    drain.await.unwrap();
    reply
}
struct Fixture {
    dir: tempfile::TempDir,
    engine: Arc<Engine>,
    session: String,
    request: AgentRequest,
    http: Http,
}
impl Fixture {
    async fn new(responses: Vec<String>, hold: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("source");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("app.js"),
            "const original = 'pinned';\nconsole.log(original);\n",
        )
        .unwrap();
        fs::write(root.join("other.txt"), "entire snapshot\n").unwrap();
        let snapshot = zero_executor::pin_snapshot(&root).unwrap();
        let forbidden = dir.path().join("docker");
        fs::write(
            &forbidden,
            "#!/bin/sh\nprintf called > \"$(dirname \"$0\")/backend-called\"\nexit 99\n",
        )
        .unwrap();
        fs::set_permissions(&forbidden, fs::Permissions::from_mode(0o700)).unwrap();
        let engine = Arc::new(Engine::open(dir.path().join("state.db"), Some(forbidden)).unwrap());
        let http = Http::new(responses, hold).await;
        http.configure(&engine);
        let session = match call(
            &engine,
            Command::SessionCreate {
                generation: "fixture".into(),
                budget_limit: 100,
            },
        )
        .await
        {
            Reply::Session { session } => session.id,
            r => panic!("{r:?}"),
        };
        let request=serde_json::from_value(json!({"provider":"fixture","model":"fixture","instructions":"Read explicitly authorized pinned source","prompt":"Inspect the source","source_snapshot_tools":true,"execution":{"execution_id":"profile","image":"unused:local","snapshot":snapshot,"argv":["unused"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024},"max_turns":3,"reservation_per_turn":5})).unwrap();
        Self {
            dir,
            engine,
            session,
            request,
            http,
        }
    }
    fn command(&self, id: &str) -> Command {
        Command::RunAgent {
            session_id: self.session.clone(),
            command_id: id.into(),
            request: self.request.clone(),
        }
    }
    fn prepared(&self) -> Value {
        let store = zero_store::Store::open_read_only(self.dir.path().join("state.db")).unwrap();
        let events = store.events(&self.session, 0, 1000).unwrap();
        let event = events
            .iter()
            .find(|e| e.payload["kind"] == "source.snapshot_prepared")
            .expect("prepared event before provider");
        event.payload["details"].clone()
    }
    fn no_backend(&self) {
        assert!(!self.dir.path().join("backend-called").exists());
    }
}
fn successful(reply: Reply) -> String {
    match reply {
        Reply::Agent {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
            assert_eq!(result.status, AgentStatus::Completed);
            operation.id
        }
        r => panic!("{r:?}"),
    }
}
#[tokio::test]
async fn source_tools_read_private_copy_after_original_changes_and_retry_after_deletion() {
    let f = Fixture::new(
        vec![
            completed(json!([
                tool(
                    "read",
                    "read_source_lines",
                    json!({"path":"app.js","start_line":1,"end_line":1})
                ),
                tool("list", "list_source_files", json!({"max_results":10})),
                tool(
                    "search",
                    "search_source_text",
                    json!({"query":"original","max_results":1})
                )
            ])),
            answer(),
        ],
        true,
    )
    .await;
    let engine = f.engine.clone();
    let command = f.command("read");
    let run = tokio::spawn(async move { call(&engine, command).await });
    f.http.wait().await;
    let prepared = f.prepared();
    let staged = PathBuf::from(prepared["path"].as_str().unwrap());
    assert!(staged.exists());
    let pin = f.request.execution.sandbox_request().snapshot;
    assert_eq!(prepared["snapshot_digest"], pin.digest);
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    assert!(
        !store
            .artifact(prepared["catalog_artifact"].as_str().unwrap())
            .unwrap()
            .is_empty()
    );
    drop(store);
    fs::write(f.dir.path().join("source/app.js"), "MUTATED HOST SOURCE\n").unwrap();
    f.http.release.cancel();
    let parent = successful(run.await.unwrap());
    assert!(!staged.exists());
    assert_eq!(f.http.count(), 2);
    f.no_backend();
    let requests = f.http.requests.lock().unwrap().clone();
    let outputs: Vec<Value> = requests[1]["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["type"] == "function_call_output")
        .map(|v| serde_json::from_str(v["output"].as_str().unwrap()).unwrap())
        .collect();
    assert_eq!(outputs[0]["text"], "const original = 'pinned';\n");
    assert_eq!(outputs[0]["snapshot_digest"], pin.digest);
    assert_eq!(
        outputs[0]["citation"]["sha256"],
        pin.files
            .iter()
            .find(|v| v.path == "app.js")
            .unwrap()
            .digest
    );
    assert_eq!(outputs[1]["files"].as_array().unwrap().len(), 2);
    assert_eq!(outputs[2]["matches"][0]["text"], outputs[0]["text"]);
    assert_eq!(outputs[2]["truncated"], true);
    match call(
        &f.engine,
        Command::SessionBudget {
            session_id: f.session.clone(),
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => assert_eq!((budget.charged, budget.reserved), (4, 0)),
        r => panic!("{r:?}"),
    }
    let mut continuation = f.request.clone();
    continuation.continuation_of = Some(parent.clone());
    let result = call(
        &f.engine,
        Command::RunAgent {
            session_id: f.session.clone(),
            command_id: "changed-source".into(),
            request: continuation,
        },
    )
    .await;
    assert!(
        !matches!(result,Reply::Agent{result:Some(ref r),..} if r.status==AgentStatus::Completed),
        "{result:?}"
    );
    assert_eq!(f.http.count(), 2);
    let retry = f.command("read");
    f.engine.shutdown().await.unwrap();
    drop(f.engine);
    fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let engine = Engine::open(
        f.dir.path().join("state.db"),
        Some(f.dir.path().join("docker")),
    )
    .unwrap();
    f.http.configure(&engine);
    assert!(
        matches!(call(&engine,retry).await,Reply::Agent{operation,duplicate:true,..} if operation.id==parent)
    );
    assert_eq!(f.http.count(), 2);
    assert!(!f.dir.path().join("source").exists());
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn conflicting_source_modes_and_shadowing_aliases_fail_before_provider() {
    let f = Fixture::new(vec![answer()], false).await;
    let mut legacy = serde_json::to_value(&f.request).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("source_snapshot_tools");
    let implicit: AgentRequest = serde_json::from_value(legacy.clone()).unwrap();
    legacy["source_snapshot_tools"] = json!(false);
    let explicit: AgentRequest = serde_json::from_value(legacy).unwrap();
    assert_eq!(
        serde_json::to_value(&implicit).unwrap(),
        serde_json::to_value(explicit).unwrap()
    );
    assert!(
        serde_json::to_value(implicit)
            .unwrap()
            .get("source_snapshot_tools")
            .is_none()
    );

    for alias in [false, true] {
        let mut raw = serde_json::to_value(&f.request).unwrap();
        if alias {
            raw["plugin_tools"] =
                json!([{"alias":"read_source_lines","plugin":"not-authorized","tool":"read"}]);
        } else {
            raw["source_review_operation_id"] = json!("not-an-authorized-review");
        }
        let request = serde_json::from_value(raw).unwrap();
        let reply = call(
            &f.engine,
            Command::RunAgent {
                session_id: f.session.clone(),
                command_id: format!("reject-{alias}"),
                request,
            },
        )
        .await;
        assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
        assert_eq!(f.http.count(), 0);
    }
    f.no_backend();
    f.engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn catalog_retention_failure_stops_before_any_provider_spend() {
    let f = Fixture::new(vec![answer()], false).await;
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_catalog BEFORE INSERT ON operation_artifacts WHEN NEW.name='source.snapshot_catalog' BEGIN SELECT RAISE(ABORT,'injected catalog failure'); END;").unwrap();
    let reply = call(&f.engine, f.command("catalog-failure")).await;
    assert!(
        !matches!(reply,Reply::Agent{result:Some(ref r),..} if r.status==AgentStatus::Completed),
        "{reply:?}"
    );
    assert_eq!(f.http.count(), 0);
    let running: u64 = db
        .query_row(
            "SELECT count(*) FROM operations WHERE status='running'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(running, 0);
    match call(
        &f.engine,
        Command::SessionBudget {
            session_id: f.session.clone(),
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => assert_eq!((budget.charged, budget.reserved), (0, 0)),
        r => panic!("{r:?}"),
    }
    f.no_backend();
    f.engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn unavailable_event_consumer_cancels_before_preparation_and_provider() {
    let f = Fixture::new(vec![answer()], false).await;
    let (tx, rx) = mpsc::channel(1);
    drop(rx);
    let reply = f.engine.handle(f.command("cancel-before-prep"), tx).await;
    match reply {
        Reply::Agent {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Cancelled);
            assert_eq!(result.status, AgentStatus::Cancelled);
        }
        r => panic!("{r:?}"),
    }
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    assert!(
        !store
            .events(&f.session, 0, 1000)
            .unwrap()
            .iter()
            .any(|e| e.payload["kind"] == "source.snapshot_prepared")
    );
    assert_eq!(f.http.count(), 0);
    f.no_backend();
    f.engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn cleanup_failure_overrides_success_or_checkpoint_with_recoverable_unknown() {
    assert!(
        std::process::Command::new("id")
            .arg("-u")
            .output()
            .unwrap()
            .stdout
            != b"0\n",
        "permission-failure fixture requires nonroot"
    );
    for turn_limit in [false, true] {
        let response = if turn_limit {
            completed(json!([tool("denied", "unoffered", json!({}))]))
        } else {
            answer()
        };
        let mut f = Fixture::new(vec![response], true).await;
        if turn_limit {
            f.request.max_turns = 1;
        }
        let engine = f.engine.clone();
        let command = f.command("cleanup-failure");
        let run = tokio::spawn(async move { call(&engine, command).await });
        f.http.wait().await;
        let prepared = f.prepared();
        let staged = PathBuf::from(prepared["path"].as_str().unwrap());
        fs::set_permissions(staged.join("source"), fs::Permissions::from_mode(0o000)).unwrap();
        f.http.release.cancel();
        let reply = run.await.unwrap();
        // Always restore the fixture path before assertions so failures do not
        // leave intentionally inaccessible temporary directories behind.
        if staged.join("source").exists() {
            fs::set_permissions(staged.join("source"), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let outcome = serde_json::to_value(&reply).unwrap();
        match reply {
            Reply::Agent {
                operation,
                result: Some(result),
                ..
            } => {
                assert_eq!(operation.status, OperationStatus::Unknown, "{result:?}");
                assert_eq!(result.status, AgentStatus::Unknown);
                let result = serde_json::to_value(result).unwrap();
                assert_eq!(result["source_recovery_path"], staged.display().to_string());
                assert!(result["continuation_artifact"].is_null());
            }
            r => panic!("{r:?}"),
        }
        assert!(staged.exists(), "{outcome}");
        fs::remove_dir_all(&staged).unwrap();
        assert_eq!(f.http.count(), 1);
        f.no_backend();
        f.engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn listing_pages_make_every_pinned_file_discoverable_without_backend_work() {
    let mut f = Fixture::new(
        vec![
            completed(json!([tool(
                "page1",
                "list_source_files",
                json!({"max_results":32})
            )])),
            completed(json!([tool(
                "page2",
                "list_source_files",
                json!({"max_results":32,"after_path":"file-30.txt"})
            )])),
            completed(json!([tool(
                "page3",
                "list_source_files",
                json!({"max_results":32,"after_path":"file-62.txt"})
            )])),
            answer(),
        ],
        false,
    )
    .await;
    for index in 0..65 {
        fs::write(
            f.dir.path().join(format!("source/file-{index:02}.txt")),
            "pinned\n",
        )
        .unwrap();
    }
    f.request.max_turns = 4;
    let snapshot = zero_executor::pin_snapshot(&f.dir.path().join("source")).unwrap();
    let mut request = serde_json::to_value(&f.request).unwrap();
    request["execution"]["snapshot"] = serde_json::to_value(&snapshot).unwrap();
    f.request = serde_json::from_value(request).unwrap();
    successful(call(&f.engine, f.command("paged")).await);
    let requests = f.http.requests.lock().unwrap().clone();
    let results: Vec<Value> = requests[3]["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| serde_json::from_str(item["output"].as_str().unwrap()).unwrap())
        .collect();
    assert_eq!(results.len(), 3);
    assert_eq!(results[0]["files"].as_array().unwrap().len(), 32);
    assert_eq!(results[0]["next_after_path"], "file-30.txt");
    assert_eq!(results[1]["files"][0]["path"], "file-31.txt");
    assert_eq!(results[1]["files"].as_array().unwrap().len(), 32);
    assert_eq!(results[1]["next_after_path"], "file-62.txt");
    let first: std::collections::BTreeSet<_> = results[0]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert!(
        results[1]["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| !first.contains(f["path"].as_str().unwrap()))
    );
    assert_eq!(results[0]["snapshot_digest"], snapshot.digest);
    assert_eq!(results[1]["snapshot_digest"], snapshot.digest);
    assert_eq!(results[2]["files"].as_array().unwrap().len(), 3);
    assert_eq!(results[2]["truncated"], false);
    assert!(results[2].get("next_after_path").is_none());
    let all: Vec<_> = results
        .iter()
        .flat_map(|r| r["files"].as_array().unwrap())
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    let expected: Vec<_> = snapshot.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(all, expected);
    f.no_backend();
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn listing_rejects_fabricated_or_noncanonical_cursors_without_expanding_authority() {
    let f = Fixture::new(
        vec![
            completed(json!([
                tool(
                    "missing",
                    "list_source_files",
                    json!({"max_results":2,"after_path":"absent.txt"})
                ),
                tool(
                    "traversal",
                    "list_source_files",
                    json!({"max_results":2,"after_path":"../app.js"})
                ),
                tool(
                    "scope",
                    "list_source_files",
                    json!({"prefix":"app.js","max_results":2,"after_path":"other.txt"})
                ),
                tool(
                    "valid",
                    "list_source_files",
                    json!({"max_results":2,"after_path":"app.js"})
                )
            ])),
            answer(),
        ],
        false,
    )
    .await;
    successful(call(&f.engine, f.command("cursor-denials")).await);
    let requests = f.http.requests.lock().unwrap().clone();
    let results: Vec<_> = requests[1]["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["type"] == "function_call_output")
        .collect();
    assert_eq!(results.len(), 4);
    for result in &results[..3] {
        assert!(
            result["output"]
                .as_str()
                .unwrap()
                .starts_with("Tool rejected:")
        );
    }
    let valid: Value = serde_json::from_str(results[3]["output"].as_str().unwrap()).unwrap();
    assert_eq!(valid["files"][0]["path"], "other.txt");
    assert_eq!(valid["files"].as_array().unwrap().len(), 1);
    assert_eq!(valid["truncated"], false);
    assert!(valid.get("next_after_path").is_none());
    f.no_backend();
    f.engine.shutdown().await.unwrap();
}
