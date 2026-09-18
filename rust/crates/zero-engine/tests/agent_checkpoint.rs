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
                operator_questions: false,
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

fn tool_turn() -> String {
    complete(json!([tool(
        "prior-tool",
        "execute_snapshot",
        json!({"argv":["fixture"]})
    )]))
}
fn followup(f: &Setup, session: &str, parent: &str, id: &str) -> Command {
    let mut request = f.request.clone();
    request.continuation_of = Some(parent.into());
    request.prompt = "Explain the retained result".into();
    Command::RunAgent {
        session_id: session.into(),
        command_id: id.into(),
        request,
    }
}
fn limited(reply: Reply) -> (String, String) {
    match reply {
        Reply::Agent {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Failed, "{result:?}");
            assert_eq!(result.status, AgentStatus::TurnLimit, "{result:?}");
            let digest = serde_json::to_value(result).unwrap()["continuation_artifact"]
                .as_str()
                .expect("settled turn limit needs checkpoint")
                .to_owned();
            (operation.id, digest)
        }
        r => panic!("{r:?}"),
    }
}
fn replay_output(http: &Http) -> Value {
    let requests = http.requests.lock().unwrap();
    let output = requests.last().unwrap()["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["type"] == "function_call_output")
        .unwrap();
    assert_eq!(output["call_id"], "prior-tool");
    serde_json::from_str(output["output"].as_str().unwrap()).unwrap()
}
#[tokio::test]
async fn turn_limit_checkpoint_survives_restart_and_duplicate_without_reissuing_effects() {
    let mut f = Setup::new("echo");
    f.request.max_turns = 1;
    let http = Http::new(vec![tool_turn(), answer()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let (parent, digest) = limited(call(&engine, f.command(&s)).await);
    let store = zero_store::Store::open_read_only(f.dir.path().join("native.sqlite")).unwrap();
    assert_eq!(
        store.operation_artifacts(&parent).unwrap()["agent.continuation"],
        digest
    );
    assert!(!store.artifact(&digest).unwrap().is_empty());
    drop(store);
    let calls = f.docker_calls();
    assert_eq!(http.count(), 1);
    assert_eq!(
        (
            budget(&engine, &s).await.charged,
            budget(&engine, &s).await.reserved
        ),
        (2, 0)
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let engine = f.engine();
    http.configure(&engine);
    let command = followup(&f, &s, &parent, "continue");
    let continued = match call(&engine, command.clone()).await {
        Reply::Agent {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(result.status, AgentStatus::Completed);
            operation.id
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(http.count(), 2);
    assert_eq!(f.docker_calls(), calls);
    let output = replay_output(&http);
    assert_eq!(output["stdout_text"], "tool fixture bytes");
    assert_eq!(output["exit_code"], 0);
    let requests = http.requests.lock().unwrap().clone();
    let input = requests[1]["input"].as_array().unwrap();
    assert_eq!(
        input
            .iter()
            .filter(|v| v["type"] == "function_call" && v["call_id"] == "prior-tool")
            .count(),
        1
    );
    assert_eq!(
        input
            .iter()
            .filter(|v| v["type"] == "function_call_output")
            .count(),
        1
    );
    assert_eq!(
        input.last().unwrap()["content"],
        "Explain the retained result"
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    http.configure(&engine);
    assert!(
        matches!(call(&engine,command).await,Reply::Agent {operation,duplicate:true,..} if operation.id==continued)
    );
    assert_eq!(http.count(), 2);
    assert_eq!(f.docker_calls(), calls);
    assert_eq!(
        (
            budget(&engine, &s).await.charged,
            budget(&engine, &s).await.reserved
        ),
        (4, 0)
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn known_nonzero_tool_result_is_preserved_without_becoming_success() {
    let mut f = Setup::new("nonzero");
    f.request.max_turns = 1;
    let http = Http::new(vec![tool_turn(), answer()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let (parent, _) = limited(call(&engine, f.command(&s)).await);
    let calls = f.docker_calls();
    assert!(
        matches!(call(&engine,followup(&f,&s,&parent,"explain-failure")).await,Reply::Agent {result:Some(result),..} if result.status==AgentStatus::Completed)
    );
    let output = replay_output(&http);
    assert_eq!(output["exit_code"], 7);
    assert_eq!(output["status"], "exited");
    assert_eq!(f.docker_calls(), calls);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn missing_or_corrupted_checkpoint_rejects_before_provider() {
    for missing in [true, false] {
        let mut f = Setup::new("echo");
        f.request.max_turns = 1;
        let http = Http::new(vec![tool_turn(), answer()], false).await;
        let engine = f.engine();
        http.configure(&engine);
        let s = session(&engine, 100).await;
        let (parent, digest) = limited(call(&engine, f.command(&s)).await);
        let calls = f.docker_calls();
        let db = rusqlite::Connection::open(f.dir.path().join("native.sqlite")).unwrap();
        if missing {
            db.execute("DELETE FROM operation_artifacts WHERE operation_id=?1 AND name='agent.continuation'",[&parent]).unwrap();
        } else {
            db.execute(
                "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
                rusqlite::params![b"forged".as_slice(), digest],
            )
            .unwrap();
        }
        assert!(matches!(
            call(&engine, followup(&f, &s, &parent, "reject")).await,
            Reply::Error { .. }
        ));
        assert_eq!(http.count(), 1);
        assert_eq!(f.docker_calls(), calls);
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn checkpoint_persistence_failure_never_advertises_continuation_or_repeats_tool() {
    let mut f = Setup::new("echo");
    f.request.max_turns = 1;
    let http = Http::new(vec![tool_turn(), answer()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let db = rusqlite::Connection::open(f.dir.path().join("native.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON operation_artifacts WHEN NEW.name='agent.continuation' BEGIN SELECT RAISE(ABORT,'injected checkpoint retention failure'); END;").unwrap();
    let reply = call(&engine, f.command(&s)).await;
    if let Reply::Agent {
        result: Some(result),
        ..
    } = &reply
    {
        assert!(serde_json::to_value(result).unwrap()["continuation_artifact"].is_null());
    }
    assert_eq!(http.count(), 1);
    let calls = f.docker_calls();
    assert_eq!(calls.iter().filter(|v| v[0] == "start").count(), 1);
    let count: u64 = db
        .query_row(
            "SELECT count(*) FROM operations WHERE status='running'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0, "{reply:?}");
    let _ = call(&engine, f.command(&s)).await;
    assert_eq!(http.count(), 1);
    assert_eq!(f.docker_calls(), calls);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn changed_authority_or_cross_session_cannot_use_turn_limit_checkpoint() {
    let mut f = Setup::new("echo");
    f.request.max_turns = 1;
    let http = Http::new(vec![tool_turn(), answer()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let (parent, _) = limited(call(&engine, f.command(&s)).await);
    let other = session(&engine, 100).await;
    for mutation in 0..3 {
        let mut cmd = followup(&f, &s, &parent, &format!("changed-{mutation}"));
        if let Command::RunAgent {
            session_id,
            request,
            ..
        } = &mut cmd
        {
            match mutation {
                0 => *session_id = other.clone(),
                1 => request.instructions.push_str(" changed"),
                _ => {
                    let mut execution = request.execution.sandbox_request();
                    execution.snapshot.root = f.dir.path().display().to_string();
                    request.execution = execution.into();
                }
            }
        }
        assert!(matches!(call(&engine, cmd).await, Reply::Error { .. }));
        assert_eq!(http.count(), 1);
    }
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn unknown_cleanup_has_no_checkpoint_and_cannot_be_continued() {
    let mut f = Setup::new("cleanup-fail");
    f.request.max_turns = 1;
    if let zero_protocol::agent::AgentExecution::Docker(r) = &mut f.request.execution {
        r.timeout_ms = 1000;
    }
    let http = Http::new(vec![tool_turn(), answer()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let parent = match call(&engine, f.command(&s)).await {
        Reply::Agent {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(result.status, AgentStatus::Unknown);
            assert!(serde_json::to_value(result).unwrap()["continuation_artifact"].is_null());
            operation.id
        }
        r => panic!("{r:?}"),
    };
    assert!(matches!(
        call(&engine, followup(&f, &s, &parent, "reject")).await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn missing_usage_hold_survives_continuation_and_limits_new_spending() {
    for limit in [5, 10] {
        let mut f = Setup::new("echo");
        f.request.max_turns = 1;
        let without_usage =
            tool_turn().replace(",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}", "");
        assert!(!without_usage.contains("usage"));
        let http = Http::new(vec![without_usage, answer()], false).await;
        let engine = f.engine();
        http.configure(&engine);
        let s = session(&engine, limit).await;
        let (parent, _) = limited(call(&engine, f.command(&s)).await);
        assert_eq!(
            (
                budget(&engine, &s).await.charged,
                budget(&engine, &s).await.reserved
            ),
            (0, 5)
        );
        let calls = f.docker_calls();
        let reply = call(&engine, followup(&f, &s, &parent, "continue-with-hold")).await;
        if limit == 10 {
            assert!(
                matches!(reply,Reply::Agent {result:Some(result),..} if result.status==AgentStatus::Completed)
            );
            assert_eq!(http.count(), 2);
            assert_eq!(
                (
                    budget(&engine, &s).await.charged,
                    budget(&engine, &s).await.reserved
                ),
                (2, 5)
            );
        } else {
            assert!(
                !matches!(reply,Reply::Agent {result:Some(result),..} if result.status==AgentStatus::Completed)
            );
            assert_eq!(http.count(), 1);
            assert_eq!(
                (
                    budget(&engine, &s).await.charged,
                    budget(&engine, &s).await.reserved
                ),
                (0, 5)
            );
        }
        assert_eq!(f.docker_calls(), calls);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn duplicate_tool_call_ids_never_produce_a_resumable_checkpoint() {
    let mut f = Setup::new("echo");
    f.request.max_turns = 1;
    let http = Http::new(
        vec![
            complete(json!([
                tool("duplicate", "unknown_tool", json!({})),
                tool("duplicate", "unknown_tool", json!({}))
            ])),
            answer(),
        ],
        false,
    )
    .await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let parent = match call(&engine, f.command(&s)).await {
        Reply::Agent {
            operation,
            result: Some(result),
            ..
        } => {
            assert_ne!(result.status, AgentStatus::Completed);
            assert!(serde_json::to_value(result).unwrap()["continuation_artifact"].is_null());
            operation.id
        }
        r => panic!("{r:?}"),
    };
    assert!(matches!(
        call(&engine, followup(&f, &s, &parent, "reject-duplicate")).await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 1);
    assert!(f.docker_calls().is_empty());
    engine.shutdown().await.unwrap();
}
