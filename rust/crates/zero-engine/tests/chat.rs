//! Chat wire engine accounting/admission tests: loopback HTTP only.
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
    task::JoinHandle,
};
use zero_engine::Engine;
use zero_protocol::{
    Command, Reply,
    model::{CompletionStatus, Rates, ResponsesRequest, WireApi},
    session::{BudgetSnapshot, OperationStatus},
};
use zero_provider::{Endpoint, ProviderClient};

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/gateway/chat/completions",
            listener.local_addr().unwrap()
        );
        let requests = Arc::new(Mutex::new(vec![]));
        let seen = requests.clone();
        let body = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({"id":"chat-fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"answer"},"finish_reason":"stop"}]}),
            json!({"id":"chat-fixture","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":5}}})
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = vec![];
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let mut buf = [0; 4096];
                        let n = socket.read(&mut buf).await.unwrap();
                        assert_ne!(n, 0);
                        data.extend_from_slice(&buf[..n]);
                        assert!(data.len() < 1_000_000);
                        if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&data[..end]);
                            assert!(headers.starts_with("POST /gateway/chat/completions "));
                            let len = headers
                                .lines()
                                .find_map(|line| {
                                    let (k, v) = line.split_once(':')?;
                                    k.eq_ignore_ascii_case("content-length")
                                        .then(|| v.trim().parse::<usize>().unwrap())
                                })
                                .unwrap();
                            if data.len() >= end + 4 + len {
                                seen.lock().unwrap().push(
                                    serde_json::from_slice(&data[end + 4..end + 4 + len]).unwrap(),
                                );
                                break;
                            }
                        }
                    }
                })
                .await
                .unwrap();
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }
    fn configure(&self, engine: &Engine, wire: WireApi, rates: Rates) {
        engine
            .configure_provider(
                "fixture",
                ProviderClient::with_wire(
                    Endpoint::responses(&self.url, None).unwrap(),
                    wire,
                    Duration::from_secs(5),
                    65536,
                )
                .unwrap(),
                rates,
            )
            .unwrap();
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
fn rates() -> Rates {
    Rates {
        input: 1_000_000,
        cached_input: 100_000,
        output: 2_000_000,
    }
}
fn request() -> ResponsesRequest {
    ResponsesRequest {
        model: "fixture".into(),
        instructions: "instructions".into(),
        input: vec![json!({"role":"user","content":"hello"})],
        tools: vec![],
        max_output_tokens: 32,
    }
}
fn infer(session: &str, id: &str, request: ResponsesRequest) -> Command {
    Command::Infer {
        session_id: session.into(),
        command_id: id.into(),
        provider: "fixture".into(),
        request,
        reservation: 20,
    }
}
async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, _rx) = mpsc::channel(8);
    tokio::time::timeout(Duration::from_secs(8), engine.handle(command, tx))
        .await
        .unwrap()
}
async fn create(engine: &Engine) -> String {
    match call(
        engine,
        Command::SessionCreate {
            generation: "fixture-generation".into(),
            budget_limit: 100,
        },
    )
    .await
    {
        Reply::Session { session } => session.id,
        r => panic!("{r:?}"),
    }
}
async fn budget(engine: &Engine, session: &str) -> BudgetSnapshot {
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
async fn events(engine: &Engine, session: &str) -> Value {
    serde_json::to_value(
        call(
            engine,
            Command::SessionEvents {
                session_id: session.into(),
                after_sequence: 0,
                limit: 100,
            },
        )
        .await,
    )
    .unwrap()
}

#[tokio::test]
async fn chat_final_usage_settles_once_and_exact_retry_survives_restart() {
    let server = Server::new().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("native.sqlite");
    let engine = Engine::open(&path, None).unwrap();
    server.configure(&engine, WireApi::ChatCompletions, rates());
    let session = create(&engine).await;
    let id = match call(&engine, infer(&session, "one", request())).await {
        Reply::Inference {
            operation,
            completion: Some(c),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            assert_eq!(c.status, CompletionStatus::Completed);
            assert!(c.usage_is_final);
            assert_eq!(c.usage.unwrap().cached_input_tokens, 5);
            assert_eq!(operation.payload["wire_api"], "chat_completions");
            operation.id
        }
        r => panic!("{r:?}"),
    };
    let charged = BudgetSnapshot {
        limit: 100,
        reserved: 0,
        charged: 12,
    };
    assert_eq!(budget(&engine, &session).await, charged);
    for _ in 0..2 {
        match call(&engine, infer(&session, "one", request())).await {
            Reply::Inference {
                operation,
                duplicate: true,
                ..
            } => assert_eq!(operation.id, id),
            r => panic!("{r:?}"),
        }
    }
    assert_eq!(server.count(), 1);
    let wire = server.requests.lock().unwrap()[0].clone();
    assert_eq!(wire["messages"][1]["content"], "hello");
    assert_eq!(wire["stream_options"]["include_usage"], true);
    assert!(wire.get("input").is_none());
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = Engine::open(&path, None).unwrap();
    server.configure(&engine, WireApi::ChatCompletions, rates());
    assert!(matches!(
        call(&engine, infer(&session, "one", request())).await,
        Reply::Inference {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(budget(&engine, &session).await, charged);
    assert_eq!(server.count(), 1);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn responses_opaque_replay_is_rejected_before_admission_budget_or_http() {
    let server = Server::new().await;
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path().join("native.sqlite"), None).unwrap();
    server.configure(&engine, WireApi::ChatCompletions, rates());
    let session = create(&engine).await;
    let before = events(&engine, &session).await;
    let mut invalid = request();
    invalid.input.push(json!({"type":"reasoning","id":"rs-original","encrypted_content":"opaque-reasoning","summary":[]}));
    assert!(matches!(
        call(&engine, infer(&session, "not-admitted", invalid)).await,
        Reply::Error { .. }
    ));
    assert_eq!(
        budget(&engine, &session).await,
        BudgetSnapshot {
            limit: 100,
            reserved: 0,
            charged: 0
        }
    );
    assert_eq!(events(&engine, &session).await, before);
    assert_eq!(server.count(), 0);
    // A corrected request with the same command ID is a NEW admission, not conflict/retry.
    assert!(matches!(
        call(&engine, infer(&session, "not-admitted", request())).await,
        Reply::Inference {
            duplicate: false,
            ..
        }
    ));
    assert_eq!(server.count(), 1);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn same_command_with_changed_wire_or_rates_conflicts_without_effects() {
    let server = Server::new().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("native.sqlite");
    let engine = Engine::open(&path, None).unwrap();
    server.configure(&engine, WireApi::ChatCompletions, rates());
    let session = create(&engine).await;
    assert!(matches!(
        call(&engine, infer(&session, "one", request())).await,
        Reply::Inference {
            duplicate: false,
            ..
        }
    ));
    let before = events(&engine, &session).await;
    let charged = budget(&engine, &session).await;
    engine.shutdown().await.unwrap();
    drop(engine);
    for (wire, pricing) in [
        (WireApi::Responses, rates()),
        (
            WireApi::ChatCompletions,
            Rates {
                output: 3_000_000,
                ..rates()
            },
        ),
    ] {
        let engine = Engine::open(&path, None).unwrap();
        server.configure(&engine, wire, pricing);
        assert!(
            matches!(call(&engine,infer(&session,"one",request())).await,Reply::Error{code,..} if code=="conflict")
        );
        assert_eq!(events(&engine, &session).await, before);
        assert_eq!(budget(&engine, &session).await, charged);
        assert_eq!(server.count(), 1);
        engine.shutdown().await.unwrap();
    }
}
