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
                let body = if selected.starts_with("interactive:") {
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

fn enable(setup: &mut Setup, deadline: u64) {
    setup.request.interactive_policy = Some(zero_protocol::interactive::InteractivePolicy {
        max_sessions: 2,
        max_writes: 4,
        max_input_bytes: 4096,
        max_read_bytes: 1024,
        deadline_ms: deadline,
    });
    let mut execution = setup.request.snapshot_request().unwrap();
    execution.backend = zero_protocol::sandbox::SandboxBackend::Docker {
        image: format!("sha256:{}", "a".repeat(64)),
    };
    execution.timeout_ms = 5000;
    setup.request.execution = Some(zero_protocol::agent::AgentExecution::Sandbox(execution));
    setup.request.max_turns = 8;
}
#[tokio::test]
async fn interactive_pipe_roundtrip_and_duplicate_actor_are_retained() {
    roundtrip(false).await;
}
#[tokio::test]
#[ignore = "requires explicitly selected installed immutable Docker image; no pulls"]
async fn actual_docker_interactive_roundtrip() {
    roundtrip(true).await;
}
async fn roundtrip(real: bool) {
    let mut setup = Setup::new("interactive");
    enable(&mut setup, 10000);
    if real {
        let mut execution = setup.request.snapshot_request().unwrap();
        execution.backend = zero_protocol::sandbox::SandboxBackend::Docker {
            image: std::env::var("ZERO_INTERACTIVE_DOCKER_IMAGE")
                .expect("set immutable installed image"),
        };
        setup.request.execution = Some(zero_protocol::agent::AgentExecution::Sandbox(execution));
    }
    let http = Http::new(
        vec![
            complete(json!([tool(
                "create",
                "interactive_create",
                json!({"argv":["cat"]})
            )])),
            "interactive:write".into(),
            "interactive:read".into(),
            "interactive:write".into(),
            "interactive:read".into(),
            "interactive:close".into(),
            answer(),
        ],
        false,
    )
    .await;
    let engine = if real {
        Engine::open(setup.dir.path().join("native.sqlite"), None).unwrap()
    } else {
        setup.engine()
    };
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
    assert_eq!(result.status, AgentStatus::Completed, "{result:?}");
    assert_eq!(result.tool_calls, 6);
    let requests = http.requests.lock().unwrap();
    let last = requests.last().unwrap();
    let outputs: Vec<Value> = last["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v["output"].as_str())
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect();
    assert!(
        outputs.iter().any(|v| v["bytes_base64"] == "aGVsbG8K"),
        "{outputs:?}"
    );
    assert!(outputs.iter().any(|v| v["forwarded_to_launcher"] == true));
    assert!(
        outputs
            .iter()
            .any(|v| v["after"] == 6 && v["bytes_base64"] == "aGVsbG8K"),
        "{outputs:?}"
    );
    drop(requests);
    let before = setup.docker_calls().len();
    let retry = call(&engine, command).await;
    assert!(matches!(
        retry,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(http.count(), 7);
    assert_eq!(setup.docker_calls().len(), before);
    let store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    let artifacts = store.operation_artifacts(&operation.id).unwrap();
    assert_eq!(
        artifacts
            .keys()
            .filter(|n| n.starts_with("interactive."))
            .count(),
        2
    );
    let transcript = artifacts
        .iter()
        .find(|(n, _)| n.ends_with(".transcript"))
        .unwrap()
        .1;
    assert_eq!(store.artifact(transcript).unwrap(), b"hello\nhello\n");
    let result = artifacts
        .iter()
        .find(|(n, _)| n.ends_with(".result"))
        .unwrap()
        .1;
    let retained: zero_protocol::sandbox::SandboxResult =
        serde_json::from_slice(&store.artifact(result).unwrap()).unwrap();
    assert!(
        matches!(
            retained.cleanup,
            zero_protocol::sandbox::SandboxCleanup::Confirmed
        ),
        "{retained:?}"
    );
    assert!(
        outputs
            .iter()
            .filter(|v| v.get("cleanup").is_some())
            .all(|v| v.get("stdout").is_none() && v.get("stderr").is_none())
    );
    assert_eq!(budget(&engine, &session).await.reserved, 0);
}
#[tokio::test]
async fn interactive_capability_rejects_mutable_image_before_provider() {
    let mut setup = Setup::new("interactive");
    enable(&mut setup, 1000);
    let mut execution = setup.request.snapshot_request().unwrap();
    execution.backend = zero_protocol::sandbox::SandboxBackend::Docker {
        image: "mutable:latest".into(),
    };
    setup.request.execution = Some(zero_protocol::agent::AgentExecution::Sandbox(execution));
    let http = Http::new(vec![answer()], false).await;
    let engine = setup.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let reply = call(&engine, setup.command(&session)).await;
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
    assert_eq!(http.count(), 0);
    assert!(setup.docker_calls().is_empty());
}

#[tokio::test]
async fn interactive_deadline_cancels_model_and_never_extends_on_retry() {
    let mut setup = Setup::new("interactive");
    enable(&mut setup, 200);
    let http = Http::new(
        vec!["data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n".into()],
        true,
    )
    .await;
    let engine = setup.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let command = setup.command(&session);
    let start = std::time::Instant::now();
    let reply = call(&engine, command.clone()).await;
    let Reply::Agent {
        result: Some(result),
        ..
    } = reply
    else {
        panic!("{reply:?}")
    };
    assert!(
        matches!(result.status, AgentStatus::Cancelled | AgentStatus::Unknown),
        "{result:?}"
    );
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(http.count(), 1);
    assert!(setup.docker_calls().is_empty());
    assert!(matches!(
        call(&engine, command).await,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(http.count(), 1);
}

#[tokio::test]
async fn interactive_unknown_cleanup_cannot_be_reported_completed() {
    let mut setup = Setup::new("cleanup-fail");
    enable(&mut setup, 10000);
    let http = Http::new(
        vec![
            complete(json!([tool(
                "create",
                "interactive_create",
                json!({"argv":["cat"]})
            )])),
            "interactive:read".into(),
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
        result: Some(result),
        ..
    } = reply
    else {
        panic!("{reply:?}")
    };
    assert_eq!(result.status, AgentStatus::Unknown, "{result:?}");
    assert!(setup.docker_calls().iter().any(|a| a[0] == "rm"));
}

#[tokio::test]
async fn durable_marker_rejects_duplicate_forged_and_wrong_owner_calls_then_shutdown_drains() {
    let mut setup = Setup::new("interactive");
    enable(&mut setup, 10000);
    let http = Http::new(
        vec![
            complete(json!([tool(
                "create",
                "interactive_create",
                json!({"argv":["cat"]})
            )])),
            ": hold\n\n".into(),
        ],
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
    let events = store.events(&session, 0, 1000).unwrap();
    let marker = events
        .iter()
        .find(|e| e.kind == "interactive_effect")
        .unwrap();
    let handle = marker.payload["handle"].as_str().unwrap();
    let create = zero_protocol::interactive::InteractiveCall::Create {
        expected_generation: None,
        argv: vec!["cat".into()],
    };
    let duplicate = store
        .claim_interactive(
            &actor.id,
            actor.owner.as_deref().unwrap(),
            0,
            0,
            "create",
            &create,
            handle,
        )
        .unwrap_err();
    assert!(
        duplicate.to_string().contains("already exists"),
        "{duplicate}"
    );
    assert!(
        store
            .claim_interactive(&actor.id, "another-engine", 0, 0, "create", &create, handle)
            .is_err()
    );
    let forged = zero_protocol::interactive::InteractiveCall::Create {
        expected_generation: None,
        argv: vec!["other".into()],
    };
    assert!(
        store
            .claim_interactive(
                &actor.id,
                actor.owner.as_deref().unwrap(),
                0,
                0,
                "create",
                &forged,
                handle
            )
            .is_err()
    );
    drop(store);
    engine.shutdown().await.unwrap();
    let reply = running.await.unwrap();
    assert!(matches!(reply,Reply::Agent{result:Some(ref r),..} if r.status==AgentStatus::Unknown));
    assert_eq!(http.count(), 2);
    assert_eq!(
        zero_store::Store::open(setup.dir.path().join("native.sqlite"))
            .unwrap()
            .budget(&session)
            .unwrap()
            .reserved,
        5
    );
}

#[tokio::test]
async fn blocked_write_is_unknown_once_and_drains_original_guest() {
    let mut setup = Setup::new("hang");
    enable(&mut setup, 3000);
    setup
        .request
        .interactive_policy
        .as_mut()
        .unwrap()
        .max_input_bytes = 32768;
    let http = Http::new(
        vec![
            complete(json!([tool(
                "create",
                "interactive_create",
                json!({"argv":["cat"]})
            )])),
            "interactive:read".into(),
            "interactive:write_block".into(),
            answer(),
        ],
        false,
    )
    .await;
    let engine = setup.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let command = setup.command(&session);
    let reply = call(&engine, command.clone()).await;
    let Reply::Agent {
        result: Some(result),
        ..
    } = reply
    else {
        panic!("{reply:?}")
    };
    assert_eq!(result.status, AgentStatus::Unknown, "{result:?}");
    assert_eq!(http.count(), 3);
    let before = setup.docker_calls().len();
    assert!(matches!(
        call(&engine, command).await,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(setup.docker_calls().len(), before);
    let store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    let events = store.events(&session, 0, 1000).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == "interactive_effect" && e.payload["call"]["action"] == "write")
            .count(),
        1
    );
}

#[tokio::test]
async fn final_usage_overage_stops_write_and_joins_prior_guest() {
    let mut setup = Setup::new("interactive");
    enable(&mut setup, 10000);
    let http = Http::new(
        vec![
            complete(json!([tool(
                "create",
                "interactive_create",
                json!({"argv":["cat"]})
            )])),
            "interactive:read".into(),
            "interactive:write_overbudget".into(),
            answer(),
        ],
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
    assert_eq!(result.status, AgentStatus::Failed, "{result:?}");
    assert!(result.error.unwrap().contains("budget"));
    assert_eq!(http.count(), 3);
    let store = zero_store::Store::open(setup.dir.path().join("native.sqlite")).unwrap();
    let account = store.budget(&session).unwrap();
    assert_eq!(account.charged, 205);
    assert_eq!(account.reserved, 0);
    let child = store
        .get_operation_by_command(&session, &format!("{}:model:2", operation.id))
        .unwrap();
    assert_eq!(
        child.status,
        zero_protocol::session::OperationStatus::Succeeded
    );
    let events = store.events(&session, 0, 1000).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == "interactive_effect" && e.payload["call"]["action"] == "write")
            .count(),
        0
    );
    let artifacts = store.operation_artifacts(&operation.id).unwrap();
    let digest = artifacts
        .iter()
        .find(|(n, _)| n.ends_with(".result"))
        .unwrap()
        .1;
    let retained: zero_protocol::sandbox::SandboxResult =
        serde_json::from_slice(&store.artifact(digest).unwrap()).unwrap();
    assert!(matches!(
        retained.cleanup,
        zero_protocol::sandbox::SandboxCleanup::Confirmed
    ));
    let before = setup.docker_calls().len();
    assert!(matches!(
        call(&engine, command).await,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(setup.docker_calls().len(), before);
    assert_eq!(http.count(), 3);
}
