#![cfg(target_os = "linux")]
//! Real loopback Responses traffic and fake Docker process lifecycle. No paid
//! calls, Docker daemon, security targets, or claim of sandbox qualification.
use crate::Engine;
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
use zero_executor::pin_snapshot;
use zero_protocol::{
    Command, ExecutionEvent, ExecutionRequest, Reply, agent::AgentRequest, model::Rates,
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
                    } else if action == "interactive" {
                        (
                            "interactive_create",
                            json!({"expected_generation":generation,"argv":["fixture"]}),
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

struct Pause {
    ready: Notify,
    released: std::sync::Mutex<bool>,
    wake: std::sync::Condvar,
}
impl Pause {
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
static STAGING_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STAGE_PAUSE: Mutex<Option<(String, Arc<Pause>)>> = Mutex::new(None);
pub(crate) fn pause_staging(session: &str) {
    let pause = STAGE_PAUSE
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(key, _)| key == session)
        .map(|(_, pause)| pause.clone());
    if let Some(pause) = pause {
        pause.ready.notify_one();
        let mut released = pause.released.lock().unwrap();
        while !*released {
            released = pause.wake.wait(released).unwrap();
        }
    }
}
struct Release(Arc<Pause>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release();
        *STAGE_PAUSE.lock().unwrap() = None;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn epoch_takeover_while_staging_prevents_guest_launch_and_retry() {
    let _serial = STAGING_TEST_LOCK.lock().await;
    let mut setup = Setup::new("echo");
    enable(&mut setup, 10000);
    let http = Http::new(vec![list(), "workspace:execute".into(), answer()], false).await;
    let engine = Arc::new(setup.engine());
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let command = setup.command(&session);
    let pause = Arc::new(Pause {
        ready: Notify::new(),
        released: Mutex::new(false),
        wake: std::sync::Condvar::new(),
    });
    *STAGE_PAUSE.lock().unwrap() = Some((session.clone(), pause.clone()));
    let _release = Release(pause.clone());
    let worker = engine.clone();
    let request = command.clone();
    let running = tokio::spawn(async move { call(&worker, request).await });
    tokio::time::timeout(Duration::from_secs(8), pause.ready.notified())
        .await
        .unwrap();
    // Explicit durable-revocation fault injection. A normal concurrent Engine
    // open is already blocked by the lifetime filesystem lock. Exercise the
    // last dispatch guard even if durable epoch authority changes underneath
    // an old actor suspended between claim and staging.
    zero_store::Store::open(setup.dir.path().join("native.sqlite"))
        .unwrap()
        .claim_engine_epoch("replacement-owner")
        .unwrap();
    pause.release();
    let _old_reply = running.await.unwrap();
    let store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    let actor = store
        .get_operation_by_command(&session, "parent-command")
        .unwrap();
    assert_eq!(actor.status, zero_protocol::OperationStatus::Unknown);
    let state = store.workspace_state(&actor.id).unwrap();
    assert_eq!(state.test_commands.len(), 1);
    assert!(setup.docker_calls().is_empty());
    assert_eq!(http.count(), 2);
    let db = rusqlite::Connection::open(setup.dir.path().join("native.sqlite")).unwrap();
    let starts: u64 = db
        .query_row(
            "SELECT count(*) FROM events WHERE kind='workspace_test_started'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(starts, 0);
    let running_children: u64 = db
        .query_row(
            "SELECT count(*) FROM operations WHERE status='running'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(running_children, 0);
    drop(engine);
    let replacement = setup.engine();
    http.configure(&replacement);
    let retry = call(&replacement, command).await;
    assert!(
        matches!(
            retry,
            Reply::Agent {
                duplicate: true,
                ..
            }
        ),
        "{retry:?}"
    );
    assert!(setup.docker_calls().is_empty());
    assert_eq!(http.count(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_interactive_staging_revocation_and_deadline_never_launch() {
    let _serial = STAGING_TEST_LOCK.lock().await;
    for cause in ["epoch", "deadline"] {
        let mut setup = Setup::new("echo");
        let deadline = if cause == "deadline" { 1000 } else { 10000 };
        enable(&mut setup, deadline);
        setup.request.interactive_policy = Some(zero_protocol::interactive::InteractivePolicy {
            max_sessions: 1,
            max_writes: 2,
            max_input_bytes: 1024,
            max_read_bytes: 1024,
            deadline_ms: deadline,
        });
        let http = Http::new(
            vec![list(), "workspace:interactive".into(), answer()],
            false,
        )
        .await;
        let engine = Arc::new(setup.engine());
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let command = setup.command(&session);
        let pause = Arc::new(Pause {
            ready: Notify::new(),
            released: Mutex::new(false),
            wake: std::sync::Condvar::new(),
        });
        *STAGE_PAUSE.lock().unwrap() = Some((session.clone(), pause.clone()));
        let _release = Release(pause.clone());
        let worker = engine.clone();
        let request = command.clone();
        let running = tokio::spawn(async move { call(&worker, request).await });
        tokio::time::timeout(Duration::from_secs(8), pause.ready.notified())
            .await
            .unwrap();
        if cause == "epoch" {
            zero_store::Store::open(setup.dir.path().join("native.sqlite"))
                .unwrap()
                .claim_engine_epoch("replacement-owner")
                .unwrap();
        } else {
            tokio::time::sleep(Duration::from_millis(deadline + 100)).await;
        }
        pause.release();
        let _ = running.await.unwrap();
        assert!(setup.docker_calls().is_empty(), "{cause}");
        let store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
        let actor = store
            .get_operation_by_command(&session, "parent-command")
            .unwrap();
        let sessions = store.workspace_interactive_sessions(&actor.id).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["status"], "unknown");
        drop(engine);
        let replacement = setup.engine();
        http.configure(&replacement);
        assert!(matches!(
            call(&replacement, command).await,
            Reply::Agent {
                duplicate: true,
                ..
            }
        ));
        assert_eq!(http.count(), 2);
        assert!(setup.docker_calls().is_empty());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_interactive_launch_is_one_use_and_inspection_rejects_tampering() {
    let mut setup = Setup::new("interactive");
    enable(&mut setup, 10000);
    setup.request.interactive_policy = Some(zero_protocol::interactive::InteractivePolicy {
        max_sessions: 1,
        max_writes: 2,
        max_input_bytes: 1024,
        max_read_bytes: 1024,
        deadline_ms: 10000,
    });
    let http = Http::new(
        vec![
            list(),
            "workspace:interactive".into(),
            "interactive:write".into(),
            ": hold\n\n".into(),
        ],
        false,
    )
    .await;
    let engine = Arc::new(setup.engine());
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let command = setup.command(&session);
    let worker = engine.clone();
    let running = tokio::spawn(async move { call(&worker, command).await });
    tokio::time::timeout(Duration::from_secs(8), async {
        while http.count() < 4 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let mut store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    let actor = store
        .get_operation_by_command(&session, "parent-command")
        .unwrap();
    let sessions = store.workspace_interactive_sessions(&actor.id).unwrap();
    assert_eq!(sessions.len(), 1);
    let handle = sessions[0]["handle"].as_str().unwrap();
    let execution = serde_json::from_value(sessions[0]["request"].clone()).unwrap();
    assert!(
        store
            .begin_workspace_interactive_dispatch(
                &actor.id,
                actor.owner.as_deref().unwrap(),
                handle,
                &execution
            )
            .unwrap_err()
            .to_string()
            .contains("already started")
    );
    assert!(
        store
            .begin_workspace_interactive_dispatch(&actor.id, "wrong-owner", handle, &execution)
            .is_err()
    );
    let db = rusqlite::Connection::open(setup.dir.path().join("native.sqlite")).unwrap();
    let (seq, raw): (u64, String) = db
        .query_row(
            "SELECT sequence,payload FROM events WHERE kind='workspace_interactive_started'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let mut forged: Value = serde_json::from_str(&raw).unwrap();
    forged["request"]["argv"] = json!(["forged"]);
    db.execute(
        "UPDATE events SET payload=?1 WHERE sequence=?2",
        rusqlite::params![forged.to_string(), seq],
    )
    .unwrap();
    assert!(store.workspace_interactive_sessions(&actor.id).is_err());
    db.execute(
        "UPDATE events SET payload=?1 WHERE sequence=?2",
        rusqlite::params![raw, seq],
    )
    .unwrap();
    engine.shutdown().await.unwrap();
    let _ = running.await.unwrap();
    assert!(!store.workspace_interactive_sessions(&actor.id).unwrap()[0]["result"].is_null());
    let write_seq:u64=db.query_row("SELECT sequence FROM events WHERE kind='interactive_effect' AND json_extract(payload,'$.call.action')='write'",[],|r|r.get(0)).unwrap();
    let late_seq: u64 = db
        .query_row("SELECT max(sequence)+100 FROM events", [], |r| r.get(0))
        .unwrap();
    db.execute(
        "UPDATE events SET sequence=?1 WHERE sequence=?2",
        rusqlite::params![late_seq, write_seq],
    )
    .unwrap();
    assert!(
        store.workspace_interactive_sessions(&actor.id).is_err(),
        "a settled write moved after actor termination must reject"
    );
    db.execute(
        "UPDATE events SET sequence=?1 WHERE sequence=?2",
        rusqlite::params![write_seq, late_seq],
    )
    .unwrap();
    db.execute(
        "UPDATE events SET kind='hidden_start' WHERE sequence=?1",
        [seq],
    )
    .unwrap();
    assert!(store.workspace_interactive_sessions(&actor.id).is_err());
    db.execute(
        "UPDATE events SET kind='workspace_interactive_started' WHERE sequence=?1",
        [seq],
    )
    .unwrap();
    assert_eq!(
        store.workspace_interactive_sessions(&actor.id).unwrap()[0]["assessment"],
        "unverified"
    );
}
