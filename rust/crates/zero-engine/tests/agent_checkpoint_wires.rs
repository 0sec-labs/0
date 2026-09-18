#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Real loopback Chat/Anthropic traffic and fake Docker process lifecycle. No paid
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
    async fn new(responses: Vec<String>) -> Self {
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
                max_turns: 1,
                reservation_per_turn: 10,
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

const REASONING: &str = "opaque reasoning\n☃\\\"\t";
const SIGNATURE: &str = "opaque-signed-thinking+/=\nsecond-line";
fn chat_response(tool: bool) -> String {
    let delta = if tool {
        json!({"role":"assistant","reasoning_content":REASONING,"tool_calls":[{"index":0,"id":"prior-call","type":"function","function":{"name":"execute_snapshot","arguments":"{\"argv\":[\"fixture\"]}"}}]})
    } else {
        json!({"role":"assistant","content":"finished after restart"})
    };
    let events = [
        json!({"id":"chat-fixture","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
        json!({"id":"chat-fixture","choices":[{"index":0,"delta":{},"finish_reason":if tool {"tool_calls"} else {"stop"}}]}),
        json!({"id":"chat-fixture","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}),
    ];
    events
        .iter()
        .map(|e| format!("data: {e}\n\n"))
        .collect::<String>()
        + "data: [DONE]\n\n"
}
fn anthropic_response(tool: bool) -> String {
    let mut events = vec![
        json!({"type":"message_start","message":{"id":"anthropic-fixture","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"usage":{"input_tokens":2,"output_tokens":0}}}),
    ];
    if tool {
        events.extend([
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":REASONING}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":SIGNATURE}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"prior-call","name":"execute_snapshot","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"argv\":[\"fixture\"]}"}}),
            json!({"type":"content_block_stop","index":1}),
        ]);
    } else {
        events.extend([
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"finished after restart"}}),
            json!({"type":"content_block_stop","index":0}),
        ]);
    }
    events.push(json!({"type":"message_delta","delta":{"stop_reason":if tool {"tool_use"} else {"end_turn"},"stop_sequence":null},"usage":{"output_tokens":1}}));
    events.push(json!({"type":"message_stop"}));
    events.iter().map(|e| format!("data: {e}\n\n")).collect()
}
async fn restart(wire: zero_protocol::model::WireApi, responses: Vec<String>) -> Vec<Value> {
    let f = Setup::new("echo");
    let http = Http::new(responses).await;
    let engine = f.engine();
    http.configure_wire(&engine, wire);
    let session = session(&engine, 100).await;
    let first = Command::RunAgent {
        session_id: session.clone(),
        command_id: "first".into(),
        request: f.request.clone(),
    };
    let parent = match call(&engine, first.clone()).await {
        Reply::Agent {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Failed);
            assert_eq!(result.status, AgentStatus::TurnLimit);
            assert_eq!(result.tool_calls, 1);
            assert!(result.continuation_artifact.is_some());
            operation.id
        }
        reply => panic!("{reply:?}"),
    };
    assert_eq!(http.count(), 1);
    assert_eq!(budget(&engine, &session).await.charged, 3);
    assert_eq!(budget(&engine, &session).await.reserved, 0);
    let prior_calls = f.docker_calls();
    assert_eq!(
        prior_calls.iter().filter(|call| call[0] == "start").count(),
        1
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    // Neither retry nor resuming the already completed tool round needs live source.
    fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let engine = f.engine();
    http.configure_wire(&engine, wire);
    assert!(matches!(
        call(&engine, first.clone()).await,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(http.count(), 1);
    assert_eq!(budget(&engine, &session).await.charged, 3);
    let mut request = f.request.clone();
    request.continuation_of = Some(parent);
    request.prompt = "Explain the retained result".into();
    let next = Command::RunAgent {
        session_id: session.clone(),
        command_id: "next".into(),
        request,
    };
    match call(&engine, next.clone()).await {
        Reply::Agent {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            assert_eq!(result.status, AgentStatus::Completed);
            assert_eq!(result.tool_calls, 0);
        }
        reply => panic!("{reply:?}"),
    }
    for command in [first, next] {
        assert!(matches!(
            call(&engine, command).await,
            Reply::Agent {
                duplicate: true,
                ..
            }
        ));
    }
    assert_eq!(http.count(), 2);
    assert_eq!(f.docker_calls(), prior_calls);
    assert_eq!(budget(&engine, &session).await.charged, 6);
    assert_eq!(budget(&engine, &session).await.reserved, 0);
    engine.shutdown().await.unwrap();
    http.requests.lock().unwrap().clone()
}
#[tokio::test]
async fn chat_turn_limit_restart_preserves_opaque_reasoning_and_order_without_reexecution() {
    let requests = restart(
        zero_protocol::model::WireApi::ChatCompletions,
        vec![chat_response(true), chat_response(false)],
    )
    .await;
    let request = &requests[1];
    assert!(request.get("input").is_none());
    assert_eq!(request["stream_options"]["include_usage"], true);
    let messages = request["messages"].as_array().unwrap();
    let index = messages
        .iter()
        .position(|m| m["role"] == "assistant")
        .unwrap();
    assert_eq!(messages[index]["reasoning_content"], REASONING);
    assert_eq!(
        messages[index]["tool_calls"],
        json!([{"id":"prior-call","type":"function","function":{"name":"execute_snapshot","arguments":"{\"argv\":[\"fixture\"]}"}}])
    );
    assert_eq!(messages[index + 1]["role"], "tool");
    assert_eq!(messages[index + 1]["tool_call_id"], "prior-call");
    assert_tool_result(messages[index + 1]["content"].as_str().unwrap());
    assert_eq!(
        messages[index + 2],
        json!({"role":"user","content":"Explain the retained result"})
    );
    assert_eq!(messages.len(), index + 3);
}
#[tokio::test]
async fn anthropic_turn_limit_restart_preserves_signed_thinking_and_order_without_reexecution() {
    let requests = restart(
        zero_protocol::model::WireApi::AnthropicMessages,
        vec![anthropic_response(true), anthropic_response(false)],
    )
    .await;
    let request = &requests[1];
    assert!(request.get("input").is_none());
    let messages = request["messages"].as_array().unwrap();
    let index = messages
        .iter()
        .position(|m| m["role"] == "assistant")
        .unwrap();
    assert_eq!(
        messages[index]["content"],
        json!([
            {"type":"thinking","thinking":REASONING,"signature":SIGNATURE},
            {"type":"tool_use","id":"prior-call","name":"execute_snapshot","input":{"argv":["fixture"]}}
        ])
    );
    assert_eq!(messages[index + 1]["role"], "user");
    assert_eq!(messages[index + 1]["content"][0]["type"], "tool_result");
    assert_eq!(
        messages[index + 1]["content"][0]["tool_use_id"],
        "prior-call"
    );
    assert_tool_result(
        messages[index + 1]["content"][0]["content"]
            .as_str()
            .unwrap(),
    );
    assert_eq!(
        messages[index + 2],
        json!({"role":"user","content":[{"type":"text","text":"Explain the retained result"}]})
    );
    assert_eq!(messages.len(), index + 3);
}

fn assert_tool_result(text: &str) {
    let result: Value = serde_json::from_str(text).unwrap();
    assert_eq!(result["stdout_text"], "tool fixture bytes");
    assert_eq!(result["stderr_text"], "fixture diagnostic\n");
    assert_eq!(result["exit_code"], 0);
    assert!(result["error"].is_null());
}
