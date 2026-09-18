#![cfg(target_os = "linux")]
//! Retained source tools use loopback provider fixtures and never launch a backend.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use zero_engine::Engine;
use zero_executor::pin_snapshot;
use zero_protocol::{
    Command, ExecutionRequest, Reply,
    agent::{AgentRequest, AgentStatus},
    model::Rates,
    session::OperationStatus,
    source::{ReviewRequest, SourceReviewRequest},
};
use zero_provider::{Endpoint, ProviderClient};

struct Http {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    stop: CancellationToken,
    task: JoinHandle<()>,
}
impl Drop for Http {
    fn drop(&mut self) {
        self.stop.cancel();
        self.task.abort();
    }
}
impl Http {
    async fn new(responses: Vec<String>, hold: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/responses", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let stop = CancellationToken::new();
        let cancel = stop.clone();
        let task = tokio::spawn(async move {
            let mut n = 0;
            loop {
                let (mut stream, _) =
                    tokio::select! {_=cancel.cancelled()=>break,v=listener.accept()=>v.unwrap()};
                let request = read_request(&mut stream).await;
                captured.lock().unwrap().push(request);
                let body = responses
                    .get(n)
                    .unwrap_or_else(|| responses.last().unwrap());
                n += 1;
                if hold {
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    stream.write_all(body.as_bytes()).await.unwrap();
                    cancel.cancelled().await;
                    break;
                }
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        Self {
            url,
            requests,
            stop,
            task,
        }
    }
    fn configure(&self, engine: &Engine) {
        self.configure_wire(engine, zero_protocol::model::WireApi::Responses);
    }
    fn configure_wire(&self, engine: &Engine, wire: zero_protocol::model::WireApi) {
        engine
            .configure_provider(
                "local",
                ProviderClient::with_wire(
                    Endpoint::responses(&self.url, None).unwrap(),
                    wire,
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
}
async fn read_request(stream: &mut TcpStream) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut data = vec![];
        loop {
            let mut buf = [0; 4096];
            let n = stream.read(&mut buf).await.unwrap();
            assert_ne!(n, 0);
            data.extend_from_slice(&buf[..n]);
            assert!(data.len() < 1_000_000);
            if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                let length = String::from_utf8_lossy(&data[..end])
                    .lines()
                    .find_map(|s| {
                        let (k, v) = s.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if data.len() >= end + 4 + length {
                    return serde_json::from_slice(&data[end + 4..end + 4 + length]).unwrap();
                }
            }
        }
    })
    .await
    .unwrap()
}
fn complete(items: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({"type":"response.completed","response":{"id":"r-fixture","status":"completed","output":items,"usage":{"input_tokens":1,"output_tokens":1}}})
    )
}
fn tool(id: &str, name: &str, args: Value) -> Value {
    json!({"type":"function_call","call_id":id,"name":name,"arguments":args.to_string()})
}
fn answer() -> String {
    complete(
        json!([{"type":"message","content":[{"type":"output_text","text":"finished assessment"}]}]),
    )
}
struct Fixture {
    dir: tempfile::TempDir,
    engine: Engine,
    session: String,
    review: String,
    bundle: String,
    request: AgentRequest,
    http: Http,
}
async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, mut rx) = mpsc::channel(64);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let reply = engine.handle(command, tx).await;
    drain.await.unwrap();
    reply
}
async fn session(engine: &Engine) -> String {
    match call(
        engine,
        Command::SessionCreate {
            generation: "fixture".into(),
            budget_limit: 100,
        },
    )
    .await
    {
        Reply::Session { session } => session.id,
        r => panic!("{r:?}"),
    }
}
impl Fixture {
    async fn new(turns: Vec<String>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("app.js"),
            "const greeting = 'retained';\nconsole.log(greeting);\n",
        )
        .unwrap();
        fs::write(source.join("unselected.txt"), "NEVER_OFFERED_SECRET").unwrap();
        let snapshot = pin_snapshot(&source).unwrap();
        let hash = &snapshot
            .files
            .iter()
            .find(|f| f.path == "app.js")
            .unwrap()
            .digest;
        let mut responses = vec![complete(json!([tool(
            "submit",
            "submit_source_hypotheses",
            json!({"hypotheses":[{
                "title":"Fixture greeting","claimed_severity":"low","explanation":"The fixture prints its greeting.",
                "citations":[{"path":"app.js","sha256":hash,"start_line":1,"end_line":2}]
            }]})
        )]))];
        responses.extend(turns);
        let http = Http::new(responses, false).await;
        let docker = dir.path().join("forbidden-backend");
        fs::write(
            &docker,
            "#!/bin/sh\nprintf called > \"$(dirname \"$0\")/backend-called\"\nexit 99\n",
        )
        .unwrap();
        fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
        let engine = Engine::open(dir.path().join("state.db"), Some(docker)).unwrap();
        http.configure(&engine);
        let session = session(&engine).await;
        let (review, bundle) = match call(
            &engine,
            Command::ReviewSource {
                session_id: session.clone(),
                command_id: "review".into(),
                request: SourceReviewRequest {
                    provider: "local".into(),
                    model: "fixture".into(),
                    reservation: 5,
                    source: ReviewRequest {
                        snapshot: snapshot.clone(),
                        selected_files: vec!["app.js".into()],
                        question: "Review the fixture".into(),
                        max_hypotheses: 1,
                    },
                },
            },
        )
        .await
        {
            Reply::SourceReview {
                operation,
                result: Some(result),
                ..
            } => {
                assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
                (operation.id, result.artifacts["source.bundle"].clone())
            }
            r => panic!("{r:?}"),
        };
        let execution = ExecutionRequest {
            execution_id: "profile".into(),
            image: "local:unused".into(),
            snapshot,
            argv: vec!["unused".into()],
            build_argv: None,
            stdin: None,
            timeout_ms: 1000,
            memory_mb: 128,
            cpus: 0.5,
            max_output_bytes: 1024,
        };
        let request: AgentRequest = serde_json::from_value(json!({
            "provider":"local","model":"fixture","instructions":"Read only authorized retained source",
            "prompt":"Inspect the selected fixture", "source_review_operation_id":review,
            "execution":execution, "max_turns":3,"reservation_per_turn":5
        })).unwrap();
        Self {
            dir,
            engine,
            session,
            review,
            bundle,
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
    fn replay_outputs(&self) -> Vec<Value> {
        let requests = self.http.requests.lock().unwrap();
        requests.last().unwrap()["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["type"] == "function_call_output")
            .map(|v| {
                serde_json::from_str(v["output"].as_str().unwrap())
                    .unwrap_or_else(|_| json!({"error":v["output"]}))
            })
            .collect()
    }
    fn no_backend(&self) {
        assert!(!self.dir.path().join("backend-called").exists());
    }
}
fn completed(reply: Reply) -> String {
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
async fn retained_read_list_search_have_exact_identity_and_no_filesystem_or_backend_effects() {
    let f = Fixture::new(vec![
        complete(json!([
            tool(
                "read",
                "read_source_lines",
                json!({"path":"app.js","start_line":1,"end_line":1})
            ),
            tool(
                "list",
                "list_source_files",
                json!({"prefix":null,"max_results":10})
            ),
            tool(
                "search",
                "search_source_text",
                json!({"query":"greeting","prefix":null,"max_results":1})
            )
        ])),
        answer(),
    ])
    .await;
    fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let operation = completed(call(&f.engine, f.command("agent")).await);
    assert_eq!(f.http.count(), 3);
    let outputs = f.replay_outputs();
    assert_eq!(outputs.len(), 3, "{outputs:?}");
    assert_eq!(outputs[0]["bundle_sha256"], f.bundle);
    assert_eq!(outputs[0]["text"], "const greeting = 'retained';\n");
    assert_eq!(
        outputs[0]["citation"],
        json!({"path":"app.js","sha256":f.request.execution.sandbox_request().snapshot.files.iter().find(|v|v.path=="app.js").unwrap().digest,"start_line":1,"end_line":1})
    );
    assert_eq!(outputs[1]["files"].as_array().unwrap().len(), 1);
    assert_eq!(outputs[1]["files"][0]["path"], "app.js");
    assert_eq!(outputs[2]["matches"].as_array().unwrap().len(), 1);
    assert_eq!(outputs[2]["matches"][0]["text"], outputs[0]["text"]);
    assert_eq!(outputs[2]["truncated"], true);
    let db = rusqlite::Connection::open_with_flags(
        f.dir.path().join("state.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut stmt = db.prepare("SELECT id FROM operations WHERE json_extract(payload,'$.kind')='agent_source_tool' ORDER BY command_id").unwrap();
    let children: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(children.len(), 3);
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    for (child, expected) in children.iter().zip(&outputs) {
        let op = store.get_operation(child).unwrap();
        assert_eq!(op.status, OperationStatus::Succeeded);
        let artifacts = store.operation_artifacts(child).unwrap();
        let bytes = store.artifact(&artifacts["source.tool_result"]).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), *expected);
        assert_eq!(op.outcome.as_ref().unwrap()["bundle_sha256"], f.bundle);
        assert_eq!(
            op.outcome.as_ref().unwrap()["result_artifact"],
            artifacts["source.tool_result"]
        );
    }
    drop(store);
    drop(stmt);
    drop(db);
    let requests = f.http.requests.lock().unwrap().clone();
    for tool in [
        "read_source_lines",
        "list_source_files",
        "search_source_text",
    ] {
        assert!(
            requests[1]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["name"] == tool)
        );
    }
    match call(
        &f.engine,
        Command::SessionBudget {
            session_id: f.session.clone(),
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => assert_eq!((budget.charged, budget.reserved), (6, 0)),
        r => panic!("{r:?}"),
    }
    f.no_backend();
    let retry = f.command("agent");
    f.engine.shutdown().await.unwrap();
    drop(f.engine);
    let engine = Engine::open(
        f.dir.path().join("state.db"),
        Some(f.dir.path().join("forbidden-backend")),
    )
    .unwrap();
    f.http.configure(&engine);
    assert!(
        matches!(call(&engine,retry).await, Reply::Agent { operation:op,duplicate:true,.. } if op.id==operation)
    );
    assert_eq!(f.http.count(), 3);
    assert!(!f.dir.path().join("source").exists());
    assert!(!f.dir.path().join("backend-called").exists());
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn invalid_unselected_traversal_and_unknown_tools_return_errors_without_leaking_source() {
    for (name, args) in [
        (
            "read_source_lines",
            json!({"path":"../unselected.txt","start_line":1,"end_line":1}),
        ),
        (
            "read_source_lines",
            json!({"path":"unselected.txt","start_line":1,"end_line":1}),
        ),
        (
            "read_source_lines",
            json!({"path":"app.js","start_line":0,"end_line":1}),
        ),
        ("read_file", json!({"path":"app.js"})),
    ] {
        let f = Fixture::new(vec![
            complete(json!([tool("denied", name, args)])),
            answer(),
        ])
        .await;
        completed(call(&f.engine, f.command("denied")).await);
        let outputs = f.replay_outputs();
        assert_eq!(outputs.len(), 1);
        assert!(!outputs[0].to_string().contains("NEVER_OFFERED_SECRET"));
        assert!(!outputs[0].to_string().contains("const greeting"));
        assert!(!outputs[0]["error"].is_null(), "{outputs:?}");
        f.no_backend();
        f.engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn source_tools_are_not_offered_without_explicit_review_pin() {
    let mut f = Fixture::new(vec![
        complete(json!([tool(
            "denied",
            "read_source_lines",
            json!({"path":"app.js","start_line":1,"end_line":1})
        )])),
        answer(),
    ])
    .await;
    f.request.source_review_operation_id = None;
    completed(call(&f.engine, f.command("unoffered")).await);
    let requests = f.http.requests.lock().unwrap().clone();
    assert!(
        !requests[1]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["name"] == "read_source_lines")
    );
    assert!(!f.replay_outputs()[0]["error"].is_null());
    f.no_backend();
    f.engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn source_session_snapshot_and_root_mismatch_fail_before_provider_dispatch() {
    let f = Fixture::new(vec![answer()]).await;
    let other = session(&f.engine).await;
    for mutation in 0..3 {
        let mut request = f.request.clone();
        if let zero_protocol::agent::AgentExecution::Docker(execution) = &mut request.execution {
            match mutation {
                1 => execution.snapshot.digest = format!("sha256:{}", "0".repeat(64)),
                2 => execution.snapshot.root = f.dir.path().display().to_string(),
                _ => {}
            }
        }
        let reply = call(
            &f.engine,
            Command::RunAgent {
                session_id: if mutation == 0 {
                    other.clone()
                } else {
                    f.session.clone()
                },
                command_id: format!("mismatch-{mutation}"),
                request,
            },
        )
        .await;
        assert!(
            !matches!(reply,Reply::Agent {result:Some(ref result),..} if result.status==AgentStatus::Completed),
            "{reply:?}"
        );
        assert_eq!(f.http.count(), 1);
    }
    f.no_backend();
    f.engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn completed_continuation_cannot_remove_or_replace_retained_source_pin() {
    let f = Fixture::new(vec![answer()]).await;
    let parent = completed(call(&f.engine, f.command("first")).await);
    assert_eq!(f.http.count(), 2);
    for pin in [None, Some("different-source-operation".to_owned())] {
        let mut request = f.request.clone();
        request.continuation_of = Some(parent.clone());
        request.source_review_operation_id = pin;
        let reply = call(
            &f.engine,
            Command::RunAgent {
                session_id: f.session.clone(),
                command_id: format!("change-{}", request.source_review_operation_id.is_some()),
                request,
            },
        )
        .await;
        assert!(
            !matches!(reply,Reply::Agent {result:Some(ref result),..} if result.status==AgentStatus::Completed),
            "{reply:?}"
        );
        assert_eq!(f.http.count(), 2);
    }
    assert_eq!(
        f.request.source_review_operation_id.as_deref(),
        Some(f.review.as_str())
    );
    f.no_backend();
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn corrupted_retained_bundle_rejects_before_provider_and_admission() {
    let f = Fixture::new(vec![answer()]).await;
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    db.execute(
        "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
        rusqlite::params![b"forged retained source".as_slice(), f.bundle],
    )
    .unwrap();
    let reply = call(&f.engine, f.command("corrupted")).await;
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
    assert_eq!(f.http.count(), 1);
    let count: u64 = db
        .query_row(
            "SELECT count(*) FROM operations WHERE command_id='corrupted'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    f.no_backend();
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn tool_result_retention_failure_stops_before_next_provider_turn_and_never_leaves_running_work()
 {
    let f = Fixture::new(vec![
        complete(json!([tool(
            "read",
            "read_source_lines",
            json!({"path":"app.js","start_line":1,"end_line":1})
        )])),
        answer(),
    ])
    .await;
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_source_result BEFORE INSERT ON operation_artifacts WHEN NEW.name='source.tool_result' BEGIN SELECT RAISE(ABORT,'injected source retention failure'); END;").unwrap();
    let reply = tokio::time::timeout(
        Duration::from_secs(3),
        call(&f.engine, f.command("retention-failure")),
    )
    .await
    .unwrap();
    assert!(
        !matches!(reply, Reply::Agent { result:Some(ref result), .. } if result.status==AgentStatus::Completed),
        "{reply:?}"
    );
    assert_eq!(f.http.count(), 2);
    let count: u64 = db
        .query_row(
            "SELECT count(*) FROM operations WHERE status='running'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
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
    f.no_backend();
    f.engine.shutdown().await.unwrap();
}
