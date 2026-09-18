#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Real loopback Responses traffic and fake Docker process lifecycle. No paid
//! calls, Docker daemon, security targets, or claim of sandbox qualification.
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
    Command, ExecutionEvent, ExecutionRequest, Reply,
    agent::{AgentRequest, AgentStatus},
    model::Rates,
    session::OperationStatus,
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
struct Setup {
    dir: tempfile::TempDir,
    request: AgentRequest,
}
impl Setup {
    fn new(scenario: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let docker = dir.path().join("docker");
        fs::write(
            &docker,
            include_str!("../../zero-executor/tests/fixtures/fake-docker.py"),
        )
        .unwrap();
        fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("scenario.txt"), scenario).unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("file.txt"), "pinned").unwrap();
        let execution = ExecutionRequest {
            execution_id: "profile".into(),
            image: "local:test".into(),
            snapshot: pin_snapshot(&source).unwrap(),
            argv: vec!["default-argv".into()],
            build_argv: None,
            stdin: Some("tool fixture bytes".into()),
            timeout_ms: 3000,
            memory_mb: 128,
            cpus: 0.5,
            max_output_bytes: 2048,
        };
        Self {
            dir,
            request: AgentRequest {
                plugin_tools: vec![],
                continuation_of: None,
                source_review_operation_id: None,
                source_snapshot_tools: false,
                source_submission_max_hypotheses: None,
                provider: "local".into(),
                context_policy: None,
                delegation_policy: None,
                model: "fixture".into(),
                instructions: "Use only offered tools".into(),
                prompt: "Inspect the authorized snapshot".into(),
                execution: execution.into(),
                max_turns: 3,
                reservation_per_turn: 5,
            },
        }
    }
    fn engine(&self) -> Engine {
        Engine::open(
            self.dir.path().join("native.sqlite"),
            Some(self.dir.path().join("docker")),
        )
        .unwrap()
    }
    fn docker_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.dir.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    fn command(&self, session: &str) -> Command {
        Command::RunAgent {
            session_id: session.into(),
            command_id: "parent-command".into(),
            request: self.request.clone(),
        }
    }
}
async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, _rx) = mpsc::channel::<ExecutionEvent>(64);
    tokio::time::timeout(Duration::from_secs(15), engine.handle(command, tx))
        .await
        .unwrap()
}
async fn session(engine: &Engine, limit: u64) -> String {
    match call(
        engine,
        Command::SessionCreate {
            generation: "pinned-generation".into(),
            budget_limit: limit,
        },
    )
    .await
    {
        Reply::Session { session } => session.id,
        r => panic!("{r:?}"),
    }
}
async fn budget(engine: &Engine, session: &str) -> zero_protocol::session::BudgetSnapshot {
    match call(
        engine,
        Command::SessionBudget {
            session_id: session.into(),
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => budget,
        r => panic!("{r:?}"),
    }
}

fn setup(turns: u32) -> Setup {
    let mut f = Setup::new("echo");
    f.request.max_turns = turns;
    f.request.context_policy = Some(zero_protocol::context::ContextPolicy {
        schema_version: 1,
        max_input_bytes: 2048,
        keep_recent_rounds: 1,
    });
    f
}
fn round(index: usize) -> String {
    complete(
        json!([{"type":"reasoning","id":format!("reason-{index}"),"encrypted_content":format!("opaque-round-{index}-{}","x".repeat(1000)),"summary":[]},tool(&format!("call-{index}"),"execute_snapshot",json!({"argv":["fixture"]}))]),
    )
}
fn parent(reply: Reply, status: OperationStatus) -> zero_protocol::Operation {
    match reply {
        Reply::Agent {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, status, "{result:?}");
            operation
        }
        r => panic!("{r:?}"),
    }
}
fn next(f: &Setup, session: &str, previous: &str) -> Command {
    let mut request = f.request.clone();
    request.continuation_of = Some(previous.into());
    request.prompt = "Follow-up exact user constraint".into();
    Command::RunAgent {
        session_id: session.into(),
        command_id: "followup".into(),
        request,
    }
}
fn db(f: &Setup) -> std::path::PathBuf {
    f.dir.path().join("native.sqlite")
}
fn attached(f: &Setup, parent: &str, name: &str) -> Value {
    let store = zero_store::Store::open_read_only(db(f)).unwrap();
    let attached = store.operation_artifacts(parent).unwrap();
    serde_json::from_slice(&store.artifact(&attached[name]).unwrap()).unwrap()
}
#[tokio::test]
async fn completed_projection_retains_full_history_across_restart_and_exact_retry() {
    let f = setup(3);
    let http = Http::new(vec![round(0), round(1), answer(), answer()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let first = parent(
        call(&engine, f.command(&session)).await,
        OperationStatus::Succeeded,
    );
    let projected = http.requests.lock().unwrap()[2]["input"].to_string();
    assert!(!projected.contains("opaque-round-0"));
    assert!(projected.contains("opaque-round-1"));
    let full = attached(&f, &first.id, "context.state.2");
    assert!(full.to_string().contains("opaque-round-0"));
    let receipt = attached(&f, &first.id, "context.receipt.2");
    assert_eq!(
        receipt["projection"]["omitted"].as_array().unwrap().len(),
        1
    );
    assert!(
        receipt["projection"]["input_bytes"].as_u64().unwrap()
            > receipt["projection"]["projected_bytes"].as_u64().unwrap()
    );
    let tools = f.docker_calls().len();
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    http.configure(&engine);
    let command = next(&f, &session, &first.id);
    let second = parent(
        call(&engine, command.clone()).await,
        OperationStatus::Succeeded,
    );
    assert!(
        attached(&f, &second.id, "context.state.0")
            .to_string()
            .contains("opaque-round-0")
    );
    assert!(matches!(
        call(&engine, command).await,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(http.count(), 4);
    assert_eq!(f.docker_calls().len(), tools);
    assert_eq!(budget(&engine, &session).await.charged, 8);
    let latest = http.requests.lock().unwrap()[3].clone();
    assert_eq!(latest["instructions"], f.request.instructions);
    assert!(latest["input"].to_string().contains(&f.request.prompt));
    assert!(
        latest["input"]
            .to_string()
            .contains("Follow-up exact user constraint")
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn turn_limit_checkpoint_restores_complete_rounds_even_when_last_request_was_projected() {
    let f = setup(3);
    let http = Http::new(vec![round(0), round(1), round(2), answer()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let first = parent(
        call(&engine, f.command(&session)).await,
        OperationStatus::Failed,
    );
    let outcome: zero_protocol::agent::AgentResult =
        serde_json::from_value(first.outcome.clone().unwrap()).unwrap();
    assert_eq!(outcome.status, AgentStatus::TurnLimit);
    assert!(outcome.continuation_artifact.is_some());
    let checkpoint = attached(&f, &first.id, "agent.continuation");
    assert!(checkpoint["input"].to_string().contains("opaque-round-0"));
    assert!(checkpoint["input"].to_string().contains("opaque-round-2"));
    let calls = f.docker_calls().len();
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    http.configure(&engine);
    parent(
        call(&engine, next(&f, &session, &first.id)).await,
        OperationStatus::Succeeded,
    );
    assert_eq!(http.count(), 4);
    assert_eq!(f.docker_calls().len(), calls);
    let input = http.requests.lock().unwrap()[3]["input"].to_string();
    assert!(!input.contains("opaque-round-0"));
    assert!(input.contains("opaque-round-2"));
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn context_artifact_or_request_corruption_rejects_continuation_before_new_effects() {
    for corruption in [
        "state",
        "receipt",
        "binding",
        "tools",
        "instructions",
        "template",
    ] {
        let f = setup(1);
        let http = Http::new(vec![answer()], false).await;
        let engine = f.engine();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let first = parent(
            call(&engine, f.command(&session)).await,
            OperationStatus::Succeeded,
        );
        engine.shutdown().await.unwrap();
        drop(engine);
        let store = zero_store::Store::open_read_only(db(&f)).unwrap();
        let child = store
            .get_operation_by_command(&session, &format!("{}:model:0", first.id))
            .unwrap();
        let artifacts = store.operation_artifacts(&first.id).unwrap();
        drop(store);
        let conn = rusqlite::Connection::open(db(&f)).unwrap();
        match corruption {
            "state" | "receipt" => {
                let name = format!("context.{corruption}.0");
                conn.execute(
                    "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
                    rusqlite::params![b"{}".to_vec(), artifacts[&name]],
                )
                .unwrap();
            }
            "template" => {
                let mut payload = first.payload.clone();
                payload["context_template"]["tools"] = json!([]);
                conn.execute(
                    "UPDATE operations SET payload=?1 WHERE id=?2",
                    rusqlite::params![payload.to_string(), first.id],
                )
                .unwrap();
            }
            _ => {
                let mut payload = child.payload.clone();
                match corruption {
                    "binding" => {
                        payload["context"]["state_sha256"] = json!("sha256:wrong");
                    }
                    "tools" => payload["request"]["tools"] = json!([]),
                    _ => payload["request"]["instructions"] = json!("changed"),
                };
                conn.execute(
                    "UPDATE operations SET payload=?1 WHERE id=?2",
                    rusqlite::params![payload.to_string(), child.id],
                )
                .unwrap();
            }
        }
        drop(conn);
        let engine = f.engine();
        http.configure(&engine);
        assert!(
            matches!(
                call(&engine, next(&f, &session, &first.id)).await,
                Reply::Error { .. }
            ),
            "accepted {corruption}"
        );
        assert_eq!(http.count(), 1);
        assert_eq!(budget(&engine, &session).await.charged, 2);
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn artifact_retention_failure_precedes_child_admission_reservation_and_http() {
    let f = setup(1);
    let http = Http::new(vec![answer()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let conn = rusqlite::Connection::open(db(&f)).unwrap();
    conn.execute_batch("CREATE TRIGGER deny_context BEFORE INSERT ON operation_artifacts WHEN NEW.name LIKE 'context.receipt.%' BEGIN SELECT RAISE(FAIL,'fixture retained context failure'); END;").unwrap();
    drop(conn);
    let failed = parent(
        call(&engine, f.command(&session)).await,
        OperationStatus::Failed,
    );
    assert_eq!(http.count(), 0);
    rusqlite::Connection::open(db(&f))
        .unwrap()
        .execute_batch("DROP TRIGGER deny_context;")
        .unwrap();
    let store = zero_store::Store::open_read_only(db(&f)).unwrap();
    assert!(matches!(
        store.get_operation_by_command(&session, &format!("{}:model:0", failed.id)),
        Err(zero_store::Error::NotFound(_))
    ));
    let b = budget(&engine, &session).await;
    assert_eq!((b.reserved, b.charged), (0, 0));
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn protected_prompt_and_mandatory_recent_round_overflow_never_silently_drop_text() {
    let mut f = setup(3);
    f.request.prompt = "p".repeat(3000);
    let http = Http::new(vec![round(0)], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    assert!(matches!(
        call(&engine, f.command(&session)).await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 0);
    f.request.prompt = "Preserve me".into();
    f.request.context_policy.as_mut().unwrap().max_input_bytes = 1024;
    let failed = parent(
        call(&engine, f.command(&session)).await,
        OperationStatus::Failed,
    );
    assert_eq!(http.count(), 1);
    let store = zero_store::Store::open_read_only(db(&f)).unwrap();
    assert!(matches!(
        store.get_operation_by_command(&session, &format!("{}:model:1", failed.id)),
        Err(zero_store::Error::NotFound(_))
    ));
    assert_eq!(budget(&engine, &session).await.charged, 2);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn fully_rehashed_omitted_round_corruption_cannot_rewrite_original_history() {
    for mutation in ["output", "delete", "reorder"] {
        let f = setup(4);
        let http = Http::new(vec![round(0), round(1), round(2), answer()], false).await;
        let engine = f.engine();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let first = parent(
            call(&engine, f.command(&session)).await,
            OperationStatus::Succeeded,
        );
        engine.shutdown().await.unwrap();
        drop(engine);
        let mut state = attached(&f, &first.id, "context.state.3");
        let mut receipt = attached(&f, &first.id, "context.receipt.3");
        let store = zero_store::Store::open_read_only(db(&f)).unwrap();
        let child = store
            .get_operation_by_command(&session, &format!("{}:model:3", first.id))
            .unwrap();
        drop(store);
        let spans = state["spans"].as_array_mut().unwrap();
        let positions: Vec<_> = spans
            .iter()
            .enumerate()
            .filter_map(|(i, s)| (s["kind"] == "round").then_some(i))
            .collect();
        assert_eq!(positions.len(), 3);
        match mutation {
            "output" => {
                spans[positions[0]]["tool_outputs"][0]["output"] = json!("forged omitted output")
            }
            "delete" => {
                spans.remove(positions[0]);
            }
            _ => spans.swap(positions[0], positions[1]),
        }
        let state =
            zero_context::ContextState::from_bytes(&serde_json::to_vec(&state).unwrap()).unwrap();
        let projected =
            zero_context::project(&state, f.request.context_policy.as_ref().unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(&projected.input).unwrap(),
            child.payload["request"]["input"],
            "mutation must leave actual dispatched request unchanged"
        );
        receipt["projection"] = serde_json::to_value(projected.receipt).unwrap();
        let state_bytes = state.to_bytes().unwrap();
        let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
        let state_hash = format!("sha256:{}", zero_plugin::sha256(&state_bytes));
        let receipt_hash = format!("sha256:{}", zero_plugin::sha256(&receipt_bytes));
        let mut payload = child.payload.clone();
        payload["context"] = json!({"state_sha256":state_hash,"receipt_sha256":receipt_hash});
        // Forge all derived artifact hashes and bindings, preserving actual requests
        // and source operation outcomes: journal witnesses must still detect this.
        let conn = rusqlite::Connection::open(db(&f)).unwrap();
        for (name, hash, bytes) in [
            ("context.state.3", &state_hash, state_bytes),
            ("context.receipt.3", &receipt_hash, receipt_bytes),
        ] {
            conn.execute(
                "INSERT INTO artifacts(digest,bytes) VALUES(?1,?2)",
                rusqlite::params![hash, bytes],
            )
            .unwrap();
            conn.execute(
                "UPDATE operation_artifacts SET digest=?1 WHERE operation_id=?2 AND name=?3",
                rusqlite::params![hash, first.id, name],
            )
            .unwrap();
        }
        conn.execute(
            "UPDATE operations SET payload=?1 WHERE id=?2",
            rusqlite::params![payload.to_string(), child.id],
        )
        .unwrap();
        drop(conn);
        let engine = f.engine();
        http.configure(&engine);
        assert!(
            matches!(
                call(&engine, next(&f, &session, &first.id)).await,
                Reply::Error { .. }
            ),
            "accepted forged {mutation}"
        );
        assert_eq!(http.count(), 4);
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn full_state_byte_cap_is_enforced_before_any_provider_effect() {
    let mut f = setup(1);
    f.request.prompt = "x".repeat(zero_context::MAX_STATE_BYTES);
    let http = Http::new(vec![answer()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    match call(&engine, f.command(&session)).await {
        Reply::Error { message, .. } => {
            assert!(message.contains("retained state bounds"), "{message}")
        }
        other => panic!("{other:?}"),
    };
    assert_eq!(http.count(), 0);
    assert_eq!(budget(&engine, &session).await.charged, 0);
    engine.shutdown().await.unwrap();
}
