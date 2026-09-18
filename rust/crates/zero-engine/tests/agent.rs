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
    session::OperationStatus,
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
                let body = responses
                    .get(n)
                    .unwrap_or_else(|| responses.last().unwrap());
                n += 1;
                if hold {
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    stream.write_all(body.as_bytes()).await.unwrap();
                    notified.notify_one();
                    cancel.cancelled().await;
                    break;
                }
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                notified.notify_one();
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
                web_submission_max_hypotheses: None,
                provider: "local".into(),
                context_policy: None,
                delegation_policy: None,
                operator_questions: false,
                http_profile: None,
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

#[tokio::test]
async fn two_turn_tool_loop_replays_output_and_parent_retry_is_effect_free_after_restart() {
    let f = Setup::new("echo");
    let http = Http::new(
        vec![
            complete(json!([tool(
                "call-1",
                "execute_snapshot",
                json!({"argv":["printf","literal ; $(false)"]})
            )])),
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
            duplicate: false,
        } => {
            assert_eq!(result.status, AgentStatus::Completed);
            assert_eq!((result.turns, result.tool_calls), (2, 1));
            assert_eq!(result.text, "finished assessment");
            operation.id
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(http.count(), 2);
    let requests = http.requests.lock().unwrap().clone();
    assert_eq!(requests[0]["tools"][0]["name"], "execute_snapshot");
    let replay = requests[1]["input"].as_array().unwrap();
    assert!(
        replay
            .iter()
            .any(|i| i["type"] == "function_call" && i["call_id"] == "call-1")
    );
    let output = replay
        .iter()
        .find(|i| i["type"] == "function_call_output")
        .unwrap();
    assert_eq!(output["call_id"], "call-1");
    let rendered: Value = serde_json::from_str(output["output"].as_str().unwrap()).unwrap();
    assert_eq!(rendered["stdout_text"], "tool fixture bytes");
    let calls = f.docker_calls();
    assert_eq!(calls.iter().filter(|c| c[0] == "create").count(), 1);
    let create = calls.iter().find(|c| c[0] == "create").unwrap().to_string();
    assert!(create.contains("literal ; $(false)"));
    assert!(create.contains("--network"));
    assert!(create.contains("none"));
    assert!(create.contains("--read-only"));
    assert_eq!(budget(&engine, &s).await.charged, 4);
    assert_eq!(budget(&engine, &s).await.reserved, 0);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    http.configure(&engine);
    match call(&engine, f.command(&s)).await {
        Reply::Agent {
            operation,
            duplicate: true,
            result: Some(result),
        } => {
            assert_eq!(operation.id, parent);
            assert_eq!(result.status, AgentStatus::Completed)
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(http.count(), 2);
    assert_eq!(f.docker_calls(), calls);
    assert_eq!(budget(&engine, &s).await.charged, 4);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn unoffered_tool_and_privileged_fields_are_rejected_without_launch() {
    let f = Setup::new("echo");
    let http = Http::new(
        vec![
            complete(json!([
                tool(
                    "unknown",
                    "bash",
                    json!({"argv":["touch","/tmp/forbidden"]})
                ),
                tool(
                    "privileged",
                    "execute_snapshot",
                    json!({"argv":["true"],"image":"attacker:image","network":"host"})
                )
            ])),
            answer(),
        ],
        false,
    )
    .await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    match call(&engine, f.command(&s)).await {
        Reply::Agent {
            result: Some(r), ..
        } => {
            assert_eq!(r.status, AgentStatus::Completed);
            assert_eq!(r.tool_calls, 0)
        }
        r => panic!("{r:?}"),
    };
    assert!(f.docker_calls().is_empty());
    let requests = http.requests.lock().unwrap();
    let rejections: Vec<_> = requests[1]["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["type"] == "function_call_output")
        .collect();
    assert_eq!(rejections.len(), 2);
    assert!(
        rejections
            .iter()
            .all(|v| v["output"].as_str().unwrap().contains("Tool rejected"))
    );
    drop(requests);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn turn_cap_and_per_turn_budget_bound_model_calls() {
    let mut f = Setup::new("echo");
    f.request.max_turns = 2;
    let http = Http::new(
        vec![complete(json!([tool("nope", "unknown", json!({}))]))],
        false,
    )
    .await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    match call(&engine, f.command(&s)).await {
        Reply::Agent {
            result: Some(r),
            operation,
            ..
        } => {
            assert_eq!(r.status, AgentStatus::TurnLimit);
            assert_eq!(r.turns, 2);
            assert_eq!(operation.status, OperationStatus::Failed)
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(http.count(), 2);
    assert_eq!(budget(&engine, &s).await.charged, 4);
    engine.shutdown().await.unwrap();
    let f = Setup::new("echo");
    let http = Http::new(
        vec![complete(json!([tool("nope", "unknown", json!({}))]))],
        false,
    )
    .await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 5).await;
    match call(&engine, f.command(&s)).await {
        Reply::Agent {
            result: Some(r), ..
        } => {
            assert_eq!(r.status, AgentStatus::Failed);
            assert_eq!(r.turns, 1)
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(http.count(), 1);
    assert_eq!(budget(&engine, &s).await.charged, 2);
    assert_eq!(budget(&engine, &s).await.reserved, 0);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn provider_eof_is_unknown_without_tools_or_budget_release() {
    let f = Setup::new("echo");
    let body = format!(
        "data: {}\n\n",
        json!({"type":"response.created","response":{"id":"partial","status":"in_progress","output":[]}})
    );
    let http = Http::new(vec![body], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    match call(&engine, f.command(&s)).await {
        Reply::Agent {
            operation,
            result: Some(r),
            ..
        } => {
            assert_eq!(r.status, AgentStatus::Unknown);
            assert_eq!(operation.status, OperationStatus::Unknown);
            assert_eq!(r.turns, 1)
        }
        r => panic!("{r:?}"),
    };
    assert!(f.docker_calls().is_empty());
    assert_eq!(budget(&engine, &s).await.reserved, 5);
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn shutdown_cancels_active_actor_and_preserves_uncertain_provider_reservation() {
    let f = Setup::new("echo");
    let http = Http::new(vec![": held\n\n".into()], true).await;
    let engine = Arc::new(f.engine());
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let command = f.command(&s);
    let running = {
        let engine = engine.clone();
        tokio::spawn(async move { call(&engine, command).await })
    };
    tokio::time::timeout(Duration::from_secs(3), http.ready.notified())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), engine.shutdown())
        .await
        .unwrap()
        .unwrap();
    match running.await.unwrap() {
        Reply::Agent {
            operation,
            result: Some(r),
            ..
        } => {
            assert_eq!(r.status, AgentStatus::Unknown);
            assert_eq!(operation.status, OperationStatus::Unknown)
        }
        r => panic!("{r:?}"),
    };
    drop(engine);
    let engine = f.engine();
    http.configure(&engine);
    assert_eq!(budget(&engine, &s).await.reserved, 5);
    assert!(matches!(
        call(&engine, f.command(&s)).await,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn empty_completed_response_is_not_a_successful_agent_answer() {
    let fixture = Setup::new("echo");
    let http = Http::new(vec![complete(json!([]))], false).await;
    let engine = fixture.engine();
    http.configure(&engine);
    let id = session(&engine, 100).await;
    match call(&engine, fixture.command(&id)).await {
        Reply::Agent {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Failed);
            assert_eq!(result.status, AgentStatus::Failed);
            assert!(result.error.unwrap().contains("without a final answer"));
        }
        reply => panic!("{reply:?}"),
    }
    assert_eq!(http.count(), 1);
    assert!(fixture.docker_calls().is_empty());
    assert_eq!(budget(&engine, &id).await.charged, 2);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn continuation_after_restart_replays_history_without_reissuing_prior_effects() {
    let f = Setup::new("echo");
    let http = Http::new(
        vec![
            complete(json!([tool(
                "prior-tool",
                "execute_snapshot",
                json!({"argv":["true"]})
            )])),
            answer(),
            answer(),
        ],
        false,
    )
    .await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let parent = match call(&engine, f.command(&s)).await {
        Reply::Agent { operation, .. } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            operation.id
        }
        r => panic!("{r:?}"),
    };
    let prior_calls = f.docker_calls();
    assert_eq!(http.count(), 2);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    http.configure(&engine);
    let mut request = f.request.clone();
    request.continuation_of = Some(parent.clone());
    request.prompt = "Explain the previous result".into();
    let command = Command::RunAgent {
        session_id: s.clone(),
        command_id: "follow-up".into(),
        request,
    };
    let completed = match call(&engine, command.clone()).await {
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
    let requests = http.requests.lock().unwrap().clone();
    let input = requests[2]["input"].as_array().unwrap();
    assert_eq!(input[0]["content"], f.request.prompt);
    assert!(
        input
            .iter()
            .any(|v| v["type"] == "function_call" && v["call_id"] == "prior-tool")
    );
    assert!(
        input
            .iter()
            .any(|v| v["type"] == "function_call_output" && v["call_id"] == "prior-tool")
    );
    assert!(
        input
            .iter()
            .any(|v| v["type"] == "message" && v["content"][0]["text"] == "finished assessment")
    );
    assert_eq!(
        input.last().unwrap()["content"],
        "Explain the previous result"
    );
    assert_eq!(f.docker_calls(), prior_calls);
    assert_eq!(budget(&engine, &s).await.charged, 6);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    http.configure(&engine);
    match call(&engine, command).await {
        Reply::Agent {
            operation,
            duplicate: true,
            ..
        } => assert_eq!(operation.id, completed),
        r => panic!("{r:?}"),
    }
    assert_eq!(http.count(), 3);
    assert_eq!(f.docker_calls(), prior_calls);
    assert_eq!(budget(&engine, &s).await.charged, 6);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn continuation_rejects_other_session_changed_authority_and_unknown_parent_before_admission()
{
    let f = Setup::new("echo");
    let http = Http::new(vec![answer()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let other = session(&engine, 100).await;
    let parent = match call(&engine, f.command(&s)).await {
        Reply::Agent { operation, .. } => operation.id,
        r => panic!("{r:?}"),
    };
    let mut base = f.request.clone();
    base.continuation_of = Some(parent);
    let mut changed = base.clone();
    changed.execution = {
        let mut sandbox = changed.snapshot_request().unwrap();
        sandbox.memory_mb += 128;
        Some(sandbox.into())
    };
    let mut instructions = base.clone();
    instructions.instructions = "new authority".into();
    for (index, (id, request)) in [
        (other, base),
        (s.clone(), changed),
        (s.clone(), instructions),
    ]
    .into_iter()
    .enumerate()
    {
        assert!(matches!(
            call(
                &engine,
                Command::RunAgent {
                    session_id: id,
                    command_id: format!("rejected-{index}"),
                    request
                }
            )
            .await,
            Reply::Error { .. }
        ));
    }
    assert_eq!(http.count(), 1);
    let store = zero_store::Store::open(f.dir.path().join("native.sqlite")).unwrap();
    assert!(store.get_operation_by_command(&s, "rejected-1").is_err());
    assert!(store.get_operation_by_command(&s, "rejected-2").is_err());
    drop(store);
    engine.shutdown().await.unwrap();

    let f = Setup::new("echo");
    let http = Http::new(vec![": incomplete\n\n".into()], false).await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let parent = match call(&engine, f.command(&s)).await {
        Reply::Agent { operation, .. } => {
            assert_eq!(operation.status, OperationStatus::Unknown);
            operation.id
        }
        r => panic!("{r:?}"),
    };
    let mut request = f.request.clone();
    request.continuation_of = Some(parent);
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: s.clone(),
                command_id: "not-a-recovery".into(),
                request
            }
        )
        .await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 1);
    assert_eq!(budget(&engine, &s).await.reserved, 5);
    engine.shutdown().await.unwrap();
}

fn anthropic_response(tool: bool, cache_write: u64) -> String {
    let mut events = vec![
        json!({"type":"message_start","message":{"id":"anthropic-fixture","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"usage":{"input_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":cache_write,"output_tokens":0}}}),
    ];
    if tool {
        events.extend([
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"fixture reasoning"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-signature"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"anthropic-tool","name":"execute_snapshot","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"argv\":[\"true\"]}"}}),
            json!({"type":"content_block_stop","index":1}),
        ]);
    } else {
        events.extend([
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Anthropic fixture answer"}}),
            json!({"type":"content_block_stop","index":0}),
        ]);
    }
    events.push(json!({"type":"message_delta","delta":{"stop_reason":if tool {"tool_use"} else {"end_turn"},"stop_sequence":null},"usage":{"output_tokens":1}}));
    events.push(json!({"type":"message_stop"}));
    events.iter().map(|e| format!("data: {e}\n\n")).collect()
}
#[tokio::test]
async fn anthropic_tool_replay_and_completed_continuation_keep_signed_history_and_usage() {
    use zero_protocol::model::WireApi;
    let f = Setup::new("echo");
    f.request.validate_capabilities().unwrap();
    let http = Http::new(
        vec![
            anthropic_response(true, 0),
            anthropic_response(false, 0),
            anthropic_response(false, 0),
        ],
        false,
    )
    .await;
    let engine = f.engine();
    http.configure_wire(&engine, WireApi::AnthropicMessages);
    let s = session(&engine, 100).await;
    let mut request = f.request.clone();
    request.reservation_per_turn = 10;
    let command = Command::RunAgent {
        session_id: s.clone(),
        command_id: "anthropic-parent".into(),
        request: request.clone(),
    };
    let parent = match call(&engine, command.clone()).await {
        Reply::Agent {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(result.status, AgentStatus::Completed);
            assert_eq!(result.tool_calls, 1);
            operation.id
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(budget(&engine, &s).await.charged, 12);
    let prior_calls = f.docker_calls();
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    http.configure_wire(&engine, WireApi::AnthropicMessages);
    request.continuation_of = Some(parent);
    request.prompt = "follow up".into();
    assert!(
        matches!(call(&engine,Command::RunAgent{session_id:s.clone(),command_id:"anthropic-next".into(),request}).await,Reply::Agent{operation,..} if operation.status==OperationStatus::Succeeded)
    );
    let requests = http.requests.lock().unwrap().clone();
    let input = requests[2]["messages"].as_array().unwrap();
    let assistant = input
        .iter()
        .find(|m| m["role"] == "assistant" && m["content"][0]["type"] == "thinking")
        .unwrap();
    assert_eq!(assistant["content"][0]["signature"], "opaque-signature");
    assert!(input.iter().any(|m| m["role"] == "user"
        && m["content"].as_array().is_some_and(|b| {
            b.iter()
                .any(|b| b["type"] == "tool_result" && b["tool_use_id"] == "anthropic-tool")
        })));
    assert!(
        input
            .to_vec()
            .iter()
            .any(|m| m.to_string().contains("Anthropic fixture answer"))
    );
    assert_eq!(f.docker_calls(), prior_calls);
    assert_eq!(budget(&engine, &s).await.charged, 18);
    assert_eq!(budget(&engine, &s).await.reserved, 0);
    assert!(matches!(
        call(&engine, command).await,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(http.count(), 3);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn anthropic_unpriced_cache_write_retains_reservation_for_explicit_reconciliation() {
    use zero_protocol::model::{ResponsesRequest, WireApi};
    let f = Setup::new("echo");
    let http = Http::new(vec![anthropic_response(false, 4)], false).await;
    let engine = f.engine();
    http.configure_wire(&engine, WireApi::AnthropicMessages);
    let s = session(&engine, 100).await;
    let operation = match call(
        &engine,
        Command::Infer {
            session_id: s.clone(),
            command_id: "unpriced".into(),
            provider: "local".into(),
            request: ResponsesRequest {
                model: "fixture".into(),
                instructions: "".into(),
                input: vec![json!({"role":"user","content":"hello"})],
                tools: vec![],
                max_output_tokens: 32,
            },
            reservation: 20,
        },
    )
    .await
    {
        Reply::Inference {
            operation,
            completion: Some(completion),
            ..
        } => {
            assert_eq!(operation.payload["kind"], "anthropic_inference");
            assert!(!completion.usage_is_final);
            assert_eq!(
                completion.replay[0]["usage"]["cache_creation_input_tokens"],
                4
            );
            operation.id
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(budget(&engine, &s).await.reserved, 20);
    assert_eq!(budget(&engine, &s).await.charged, 0);
    assert!(matches!(
        call(
            &engine,
            Command::ReconcileUsage {
                session_id: s.clone(),
                operation_id: operation,
                charged: 15,
                evidence: "fixture invoice confirms cache-write charge".into()
            }
        )
        .await,
        Reply::SessionBudget { .. }
    ));
    assert_eq!(budget(&engine, &s).await.reserved, 0);
    assert_eq!(budget(&engine, &s).await.charged, 15);
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
}
