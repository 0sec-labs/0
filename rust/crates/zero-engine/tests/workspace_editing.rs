#![cfg(target_os = "linux")]
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
    sync::{Notify, mpsc},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use zero_engine::Engine;
use zero_executor::pin_snapshot;
use zero_protocol::{
    Command, ExecutionEvent, ExecutionRequest, Reply,
    agent::{AgentRequest, AgentStatus},
    model::Rates,
};
use zero_provider::{Endpoint, ProviderClient};

struct Http {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    ready: Arc<Notify>,
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
        let ready = Arc::new(Notify::new());
        let notified = ready.clone();
        let stop = CancellationToken::new();
        let cancel = stop.clone();
        let task = tokio::spawn(async move {
            let mut n = 0;
            loop {
                let (mut stream, _) =
                    tokio::select! {_=cancel.cancelled()=>break,v=listener.accept()=>v.unwrap()};
                let request = read_request(&mut stream).await;
                captured.lock().unwrap().push(request);
                let selected = responses
                    .get(n)
                    .unwrap_or_else(|| responses.last().unwrap());
                let dynamic;
                let body = if selected.starts_with("workspace:") {
                    let guard = captured.lock().unwrap();
                    let request = guard.last().unwrap();
                    let generation = request["input"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|v| v["output"].as_str())
                        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
                        .filter_map(|v| v["generation"].as_str().map(str::to_owned))
                        .last()
                        .unwrap();
                    let action = selected.strip_prefix("workspace:").unwrap();
                    let (name, args) = if action == "edit" {
                        (
                            "write_file",
                            json!({"path":"file.txt","expected_generation":generation,"content":"edited"}),
                        )
                    } else {
                        (
                            "execute_workspace",
                            json!({"expected_generation":generation,"argv":["fixture"]}),
                        )
                    };
                    let body = complete(json!([tool(&format!("call-{n}"), name, args)]));
                    dynamic = if action == "overbudget" {
                        body.replace("\"input_tokens\":1", "\"input_tokens\":200")
                    } else {
                        body
                    };
                    &dynamic
                } else if selected.starts_with("interactive:") {
                    let guard = captured.lock().unwrap();
                    let request = guard.last().unwrap();
                    let handle = request["input"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|v| v["output"].as_str())
                        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
                        .find_map(|v| v["session_id"].as_str().map(str::to_owned))
                        .unwrap();
                    let selected_action = selected.strip_prefix("interactive:").unwrap();
                    let action = if matches!(selected_action, "write_block" | "write_overbudget") {
                        "write"
                    } else {
                        selected_action
                    };
                    let args = match action {
                        "write" => {
                            json!({"session_id":handle,"data_base64":if selected_action=="write_block"{zero_protocol::interactive::encode_bytes(&vec![b'a';16384])}else{"aGVsbG8K".into()}})
                        }
                        "read" => {
                            json!({"session_id":handle,"after":request["input"].as_array().unwrap().iter().filter_map(|v|v["output"].as_str()).filter_map(|s|serde_json::from_str::<Value>(s).ok()).filter_map(|v|v["next_after"].as_u64()).last().unwrap_or(0),"max_bytes":1024,"wait_ms":250})
                        }
                        "close" => json!({"session_id":handle}),
                        _ => panic!("bad fixture"),
                    };
                    let body = complete(json!([tool(
                        &format!("call-{n}"),
                        &format!("interactive_{action}"),
                        args
                    )]));
                    dynamic = if selected_action == "write_overbudget" {
                        body.replace("\"input_tokens\":1", "\"input_tokens\":200")
                    } else {
                        body
                    };
                    &dynamic
                } else {
                    selected
                };
                n += 1;
                if hold || body.starts_with(": hold") {
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    stream.write_all(body.as_bytes()).await.unwrap();
                    notified.notify_one();
                    cancel.cancelled().await;
                    break;
                }
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        Self {
            url,
            requests,
            ready,
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
            include_str!("../../zero-executor/tests/fixtures/fake-docker.py").replace("elif args[0] == \"start\":", "elif args[0] == \"start\":\n    import os\n    if scenario == \"hang\":\n        import fcntl\n        fcntl.fcntl(0, 1031, 4096)\n    if scenario == \"interactive\":\n        while True:\n            data = os.read(0, 4096)\n            if not data: break\n            os.write(1, data)\n        sys.exit(0)"),
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
            stdin: None,
            timeout_ms: 3000,
            memory_mb: 128,
            cpus: 0.5,
            max_output_bytes: 2048,
        };
        Self {
            dir,
            request: AgentRequest {
                interactive_policy: None,
                workspace_policy: None,
                plugin_tools: vec![],
                continuation_of: None,
                source_review_operation_id: None,
                source_snapshot_tools: false,
                source_submission_max_hypotheses: None,
                web_submission_max_hypotheses: None,
                provider: "local".into(),
                context_policy: None,
                delegation_policy: None,
                operator_questions: false,
                http_profile: None,
                web_experiment_policy: None,
                tool_approval_policy: None,
                model: "fixture".into(),
                instructions: "Use only offered tools".into(),
                prompt: "Inspect the authorized snapshot".into(),
                execution: Some(execution.into()),
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

fn enable(setup: &mut Setup, deadline_ms: u64) {
    let mut execution = setup.request.snapshot_request().unwrap();
    execution.backend = zero_protocol::sandbox::SandboxBackend::Docker {
        image: format!("sha256:{}", "a".repeat(64)),
    };
    execution.timeout_ms = 5000;
    setup.request.execution = Some(zero_protocol::agent::AgentExecution::Sandbox(
        execution.clone(),
    ));
    setup.request.max_turns = 8;
    setup.request.workspace_policy = Some(zero_protocol::workspace_edit::WorkspacePolicy {
        paths: vec![zero_protocol::workspace_edit::EditablePath {
            path: "file.txt".into(),
            baseline_sha256: Some(execution.snapshot.files[0].digest.clone()),
            executable: false,
        }],
        max_edits: 4,
        max_changed_bytes: 4096,
        max_test_runs: 2,
        deadline_ms,
    });
}
fn list() -> String {
    complete(json!([tool(
        "list",
        "workspace_list",
        json!({"prefix":"","after":"","max_results":10})
    )]))
}
#[tokio::test]
async fn cancelled_provider_preserves_committed_edit_and_never_replays_effect() {
    let mut setup = Setup::new("echo");
    enable(&mut setup, 1500);
    let http = Http::new(
        vec![list(), "workspace:edit".into(), ": hold\n\n".into()],
        false,
    )
    .await;
    let engine = setup.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let command = setup.command(&session);
    let reply = call(&engine, command.clone()).await;
    let Reply::Agent {
        operation,
        result: Some(result),
        ..
    } = reply
    else {
        panic!("{reply:?}")
    };
    assert_eq!(result.status, AgentStatus::Unknown);
    let store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    let state = store.workspace_state(&operation.id).unwrap();
    assert_eq!(
        zero_workspace::bytes(&state.current, "file.txt").unwrap(),
        b"edited"
    );
    assert_eq!(state.receipts.len(), 1);
    assert!(state.test_commands.is_empty());
    assert_eq!(store.budget(&session).unwrap().reserved, 5);
    assert!(matches!(
        call(&engine, command).await,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(http.count(), 3);
    assert!(setup.docker_calls().is_empty());
}
#[tokio::test]
async fn completed_overage_blocks_execution_but_preserves_prior_edit_provenance() {
    let mut setup = Setup::new("echo");
    enable(&mut setup, 10000);
    let http = Http::new(
        vec![
            list(),
            "workspace:edit".into(),
            "workspace:overbudget".into(),
            answer(),
        ],
        false,
    )
    .await;
    let engine = setup.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let reply = call(&engine, setup.command(&session)).await;
    let Reply::Agent {
        operation,
        result: Some(result),
        ..
    } = reply
    else {
        panic!("{reply:?}")
    };
    assert_eq!(result.status, AgentStatus::Failed);
    let store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    let state = store.workspace_state(&operation.id).unwrap();
    assert_eq!(
        zero_workspace::bytes(&state.current, "file.txt").unwrap(),
        b"edited"
    );
    assert!(state.test_commands.is_empty());
    assert_eq!(store.budget(&session).unwrap().charged, 205);
    assert!(setup.docker_calls().is_empty());
}
#[tokio::test]
async fn duplicate_forged_and_wrong_owner_edits_reject_while_actor_running() {
    let mut setup = Setup::new("echo");
    enable(&mut setup, 10000);
    let http = Http::new(
        vec![list(), "workspace:edit".into(), ": hold\n\n".into()],
        false,
    )
    .await;
    let engine = Arc::new(setup.engine());
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let command = setup.command(&session);
    let running = {
        let engine = engine.clone();
        tokio::spawn(async move { call(&engine, command).await })
    };
    tokio::time::timeout(Duration::from_secs(3), http.ready.notified())
        .await
        .unwrap();
    let mut store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    let actor = store
        .get_operation_by_command(&session, "parent-command")
        .unwrap();
    let state = store.workspace_state(&actor.id).unwrap();
    let call = zero_protocol::workspace_edit::WorkspaceCall::Write {
        path: "file.txt".into(),
        expected_generation: zero_workspace::generation(&state.baseline).unwrap(),
        content: "edited".into(),
    };
    let position = zero_store::WorkspaceInvocation {
        turn: 1,
        index: 0,
        call_id: "call-1".into(),
    };
    let error = store
        .claim_workspace_effect(&actor.id, actor.owner.as_deref().unwrap(), &position, &call)
        .unwrap_err();
    assert!(error.to_string().contains("already claimed"), "{error}");
    assert!(
        store
            .claim_workspace_effect(&actor.id, "other-owner", &position, &call)
            .is_err()
    );
    let forged = zero_protocol::workspace_edit::WorkspaceCall::Write {
        path: "file.txt".into(),
        expected_generation: zero_workspace::generation(&state.baseline).unwrap(),
        content: "forged".into(),
    };
    assert!(
        store
            .claim_workspace_effect(
                &actor.id,
                actor.owner.as_deref().unwrap(),
                &position,
                &forged
            )
            .is_err()
    );
    drop(store);
    engine.shutdown().await.unwrap();
    running.await.unwrap();
}
#[tokio::test]
async fn execution_cleanup_uncertainty_stops_actor_and_keeps_test_generation() {
    let mut setup = Setup::new("cleanup-fail");
    enable(&mut setup, 1500);
    let http = Http::new(vec![list(), "workspace:execute".into(), answer()], false).await;
    let engine = setup.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let reply = call(&engine, setup.command(&session)).await;
    let Reply::Agent {
        operation,
        result: Some(result),
        ..
    } = reply
    else {
        panic!("{reply:?}")
    };
    assert_eq!(result.status, AgentStatus::Unknown, "{result:?}");
    let store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    let tests = store.workspace_tests(&operation.id).unwrap();
    assert_eq!(tests.len(), 1);
    assert_eq!(tests[0]["status"], "unknown");
    assert_eq!(tests[0]["assessment"], "unverified");
    assert_eq!(http.count(), 2);
}

#[tokio::test]
async fn independent_workspace_inspection_rejects_missing_committed_edit_bytes() {
    let mut setup = Setup::new("echo");
    enable(&mut setup, 10000);
    let http = Http::new(vec![list(), "workspace:edit".into(), answer()], false).await;
    let engine = setup.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let reply = call(&engine, setup.command(&session)).await;
    let Reply::Agent {
        operation,
        result: Some(result),
        ..
    } = reply
    else {
        panic!("{reply:?}")
    };
    assert_eq!(result.status, AgentStatus::Completed);
    let store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    let state = store.workspace_state(&operation.id).unwrap();
    let sha = state
        .current
        .manifest
        .files
        .iter()
        .find(|f| f.path == "file.txt")
        .unwrap()
        .sha256
        .clone();
    drop(store);
    let connection = rusqlite::Connection::open(setup.dir.path().join("native.sqlite")).unwrap();
    assert_eq!(
        connection
            .execute("DELETE FROM artifacts WHERE digest=?1", [sha])
            .unwrap(),
        1
    );
    drop(connection);
    let store = zero_store::Store::open_read_only(setup.dir.path().join("native.sqlite")).unwrap();
    assert!(store.workspace_state(&operation.id).is_err());
}

#[tokio::test]
async fn independent_workspace_inspection_rejects_settlement_after_effect() {
    let mut setup = Setup::new("echo");
    enable(&mut setup, 10000);
    let http = Http::new(vec![list(), "workspace:edit".into(), answer()], false).await;
    let engine = setup.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let reply = call(&engine, setup.command(&session)).await;
    let Reply::Agent {
        operation,
        result: Some(result),
        ..
    } = reply
    else {
        panic!("{reply:?}")
    };
    assert_eq!(result.status, AgentStatus::Completed);
    let store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    assert_eq!(
        store.workspace_state(&operation.id).unwrap().receipts.len(),
        1
    );
    let origin = store
        .get_operation_by_command(&session, &format!("{}:model:1", operation.id))
        .unwrap();
    drop(store);
    let connection = rusqlite::Connection::open(setup.dir.path().join("native.sqlite")).unwrap();
    let last: u64 = connection
        .query_row(
            "SELECT max(sequence) FROM events WHERE session_id=?1",
            [&session],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(connection.execute("UPDATE events SET sequence=?3 WHERE session_id=?1 AND kind='budget_settled' AND json_extract(payload,'$.reservation_id')=?2",rusqlite::params![session,origin.id,last+1]).unwrap(),1);
    drop(connection);
    let store = zero_store::Store::open_read_only(setup.dir.path().join("native.sqlite")).unwrap();
    let error = store
        .workspace_state(&operation.id)
        .err()
        .expect("settlement after effect must fail historical inspection");
    assert!(error.to_string().contains("settlement"), "{error}");
}

#[tokio::test]
async fn independent_workspace_test_inspection_authenticates_dispatch_witness() {
    let mut setup = Setup::new("echo");
    enable(&mut setup, 10000);
    let http = Http::new(vec![list(), "workspace:execute".into(), answer()], false).await;
    let engine = setup.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let reply = call(&engine, setup.command(&session)).await;
    let Reply::Agent {
        operation,
        result: Some(result),
        ..
    } = reply
    else {
        panic!("{reply:?}")
    };
    assert_eq!(result.status, AgentStatus::Completed, "{result:?}");
    let path = setup.dir.path().join("native.sqlite");
    let store = zero_store::Store::open_read_only(&path).unwrap();
    assert_eq!(store.workspace_tests(&operation.id).unwrap().len(), 1);
    drop(store);
    let c = rusqlite::Connection::open(&path).unwrap();
    let (sequence,payload):(u64,String)=c.query_row("SELECT sequence,payload FROM events WHERE session_id=?1 AND kind='workspace_test_started'",[&session],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    let last: u64 = c
        .query_row(
            "SELECT max(sequence) FROM events WHERE session_id=?1",
            [&session],
            |r| r.get(0),
        )
        .unwrap();
    for variant in 0..4 {
        match variant {
            0 => {
                c.execute(
                    "DELETE FROM events WHERE session_id=?1 AND sequence=?2",
                    rusqlite::params![session, sequence],
                )
                .unwrap();
            }
            1 => {
                let mut bad: Value = serde_json::from_str(&payload).unwrap();
                bad["request"]["memory_mb"] = json!(4096);
                c.execute(
                    "UPDATE events SET payload=?3 WHERE session_id=?1 AND sequence=?2",
                    rusqlite::params![session, sequence, bad.to_string()],
                )
                .unwrap();
            }
            2 => {
                c.execute(
                    "UPDATE events SET sequence=?3 WHERE session_id=?1 AND sequence=?2",
                    rusqlite::params![session, sequence, last + 1],
                )
                .unwrap();
            }
            _ => {
                c.execute("INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,?2,'workspace_test_started',?3)",rusqlite::params![session,last+1,payload]).unwrap();
            }
        }
        let store = zero_store::Store::open_read_only(&path).unwrap();
        let error = store
            .workspace_tests(&operation.id)
            .err()
            .expect("tampered dispatch must fail inspection");
        assert!(
            error.to_string().contains("dispatch"),
            "variant {variant}: {error}"
        );
        drop(store);
        c.execute(
            "DELETE FROM events WHERE session_id=?1 AND kind='workspace_test_started'",
            [&session],
        )
        .unwrap();
        c.execute("INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,?2,'workspace_test_started',?3)",rusqlite::params![session,sequence,payload]).unwrap();
    }
    let store = zero_store::Store::open_read_only(&path).unwrap();
    assert_eq!(store.workspace_tests(&operation.id).unwrap().len(), 1);
    drop(store);
    // Make an unused integer slot immediately before dispatch without changing
    // any valid ordering, then corrupt each live-gate precondition separately.
    c.execute(
        "UPDATE events SET sequence=-sequence WHERE session_id=?1",
        [&session],
    )
    .unwrap();
    c.execute(
        "UPDATE events SET sequence=-sequence*2 WHERE session_id=?1",
        [&session],
    )
    .unwrap();
    let before_start = sequence * 2 - 1;
    c.execute(
        "INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,?2,'budget_reserved',?3)",
        rusqlite::params![
            session,
            before_start,
            json!({"reservation_id":"late-unsettled-hold","amount":101}).to_string()
        ],
    )
    .unwrap();
    let store = zero_store::Store::open_read_only(&path).unwrap();
    assert!(
        store
            .workspace_tests(&operation.id)
            .unwrap_err()
            .to_string()
            .contains("account")
    );
    drop(store);
    c.execute(
        "DELETE FROM events WHERE session_id=?1 AND sequence=?2",
        rusqlite::params![session, before_start],
    )
    .unwrap();
    c.execute("UPDATE events SET sequence=?3 WHERE session_id=?1 AND kind='operation_settled' AND json_extract(payload,'$.id')=?2",rusqlite::params![session,operation.id,before_start]).unwrap();
    let store = zero_store::Store::open_read_only(&path).unwrap();
    assert!(
        store
            .workspace_tests(&operation.id)
            .unwrap_err()
            .to_string()
            .contains("parent termination")
    );
}
