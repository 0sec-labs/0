//! Public engine integration against local SSE only. No inference accounts or Docker.
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
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
use zero_protocol::{
    Command, ExecutionEvent, Reply,
    model::{CompletionStatus, Content, Rates, ResponsesRequest},
    session::{BudgetSnapshot, OperationStatus},
};
use zero_provider::{Endpoint, ProviderClient};

struct Fixture {
    url: String,
    count: Arc<AtomicUsize>,
    ready: Arc<Notify>,
    stop: CancellationToken,
    task: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.cancel();
        self.task.abort();
    }
}
impl Fixture {
    async fn new(body: String, hold: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/responses", listener.local_addr().unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let ready = Arc::new(Notify::new());
        let notify = ready.clone();
        let stop = CancellationToken::new();
        let cancel = stop.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = tokio::select! {_=cancel.cancelled()=>break,value=listener.accept()=>value.unwrap()};
                read_request(&mut socket).await;
                observed.fetch_add(1, Ordering::SeqCst);
                if hold {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    socket.write_all(body.as_bytes()).await.unwrap();
                    notify.notify_one();
                    cancel.cancelled().await;
                    break;
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                notify.notify_one();
            }
        });
        Self {
            url,
            count,
            ready,
            stop,
            task,
        }
    }
    fn configure(&self, engine: &Engine) {
        let client = ProviderClient::new(
            Endpoint::responses(&self.url, Some("fixture-credential")).unwrap(),
            Duration::from_secs(5),
            65536,
        )
        .unwrap();
        engine
            .configure_provider(
                "fixture",
                client,
                Rates {
                    input: 1_000_000,
                    cached_input: 100_000,
                    output: 2_000_000,
                },
            )
            .unwrap();
    }
    fn requests(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}
async fn read_request(socket: &mut TcpStream) {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut data = vec![];
        loop {
            let mut buf = [0; 2048];
            let n = socket.read(&mut buf).await.unwrap();
            assert_ne!(n, 0);
            data.extend_from_slice(&buf[..n]);
            assert!(data.len() < 1_000_000);
            if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&data[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (k, v) = line.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if data.len() >= end + 4 + length {
                    return;
                }
            }
        }
    })
    .await
    .unwrap();
}
fn request() -> ResponsesRequest {
    ResponsesRequest {
        model: "fixture".into(),
        instructions: "Only return fixture data".into(),
        input: vec![json!({"role":"user","content":"hello"})],
        tools: vec![],
        max_output_tokens: 32,
    }
}
fn infer(session: &str, id: &str, reservation: u64) -> Command {
    Command::Infer {
        session_id: session.into(),
        command_id: id.into(),
        provider: "fixture".into(),
        request: request(),
        reservation,
    }
}
async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, _rx) = mpsc::channel::<ExecutionEvent>(8);
    tokio::time::timeout(Duration::from_secs(8), engine.handle(command, tx))
        .await
        .unwrap()
}
async fn create(engine: &Engine, limit: u64) -> String {
    match call(
        engine,
        Command::SessionCreate {
            generation: "test-generation".into(),
            budget_limit: limit,
        },
    )
    .await
    {
        Reply::Session { session } => session.id,
        r => panic!("unexpected reply: {r:?}"),
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
        r => panic!("unexpected reply: {r:?}"),
    }
}
fn completed(output: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({"type":"response.completed","response":{"id":"response-fixture","status":"completed","output":output,"usage":{"input_tokens":10,"output_tokens":3,"input_tokens_details":{"cached_tokens":5}}}})
    )
}
fn partial() -> String {
    format!(
        "data: {}\n\ndata: {}\n\n",
        json!({"type":"response.created","response":{"id":"response-fixture","status":"in_progress","output":[],"usage":{"input_tokens":1,"output_tokens":0}}}),
        json!({"type":"response.output_text.delta","delta":"unfinished"})
    )
}

#[tokio::test]
async fn exact_retry_after_restart_never_reissues_http_or_settles_twice() {
    let fixture = Fixture::new(
        completed(json!([{"type":"message","content":[{"type":"output_text","text":"done"}]}])),
        false,
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("native.sqlite");
    let engine = Engine::open(&path, None).unwrap();
    fixture.configure(&engine);
    let session = create(&engine, 100).await;
    let first = call(&engine, infer(&session, "one", 20)).await;
    let operation_id = match first {
        Reply::Inference {
            operation,
            completion: Some(c),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            assert_eq!(c.status, CompletionStatus::Completed);
            operation.id
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(
        budget(&engine, &session).await,
        BudgetSnapshot {
            limit: 100,
            reserved: 0,
            charged: 12
        }
    );
    match call(&engine, infer(&session, "one", 20)).await {
        Reply::Inference {
            operation,
            duplicate: true,
            ..
        } => assert_eq!(operation.id, operation_id),
        r => panic!("{r:?}"),
    }
    let mut conflicting = infer(&session, "one", 20);
    if let Command::Infer { request, .. } = &mut conflicting {
        request.instructions = "different admitted payload".into();
    }
    assert!(
        matches!(call(&engine, conflicting).await, Reply::Error { code, .. } if code == "conflict")
    );
    assert_eq!(fixture.requests(), 1);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = Engine::open(&path, None).unwrap();
    fixture.configure(&engine);
    match call(&engine, infer(&session, "one", 20)).await {
        Reply::Inference {
            operation,
            completion: Some(c),
            duplicate: true,
        } => {
            assert_eq!(operation.id, operation_id);
            assert_eq!(
                c.content,
                vec![Content::Text {
                    text: "done".into()
                }]
            );
        }
        r => panic!("{r:?}"),
    }
    assert_eq!(fixture.requests(), 1);
    assert_eq!(budget(&engine, &session).await.charged, 12);
    let events = match call(
        &engine,
        Command::SessionEvents {
            session_id: session,
            after_sequence: 0,
            limit: 100,
        },
    )
    .await
    {
        Reply::SessionEvents { events } => events,
        r => panic!("{r:?}"),
    };
    assert_eq!(
        events.iter().filter(|e| e.kind == "budget_settled").count(),
        1
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn actual_overage_is_recorded_and_blocks_new_requests() {
    let fixture = Fixture::new(completed(json!([])), false).await;
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path().join("native.sqlite"), None).unwrap();
    fixture.configure(&engine);
    let session = create(&engine, 10).await;
    assert!(matches!(
        call(&engine, infer(&session, "one", 5)).await,
        Reply::Inference {
            duplicate: false,
            ..
        }
    ));
    assert_eq!(
        budget(&engine, &session).await,
        BudgetSnapshot {
            limit: 10,
            reserved: 0,
            charged: 12
        }
    );
    assert!(matches!(
        call(&engine, infer(&session, "one", 5)).await,
        Reply::Inference {
            duplicate: true,
            ..
        }
    ));
    match call(&engine, infer(&session, "two", 1)).await {
        Reply::Error { code, .. } => assert_eq!(code, "budget_exceeded"),
        r => panic!("{r:?}"),
    };
    assert_eq!(fixture.requests(), 1);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn truncated_response_is_unknown_and_retains_budget_after_restart() {
    let fixture = Fixture::new(partial(), false).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("native.sqlite");
    let engine = Engine::open(&path, None).unwrap();
    fixture.configure(&engine);
    let session = create(&engine, 100).await;
    match call(&engine, infer(&session, "truncated", 20)).await {
        Reply::Inference {
            operation,
            completion: Some(c),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Unknown);
            assert_eq!(c.status, CompletionStatus::Incomplete);
            assert!(c.content.is_empty());
        }
        r => panic!("{r:?}"),
    }
    assert_eq!(
        budget(&engine, &session).await,
        BudgetSnapshot {
            limit: 100,
            reserved: 20,
            charged: 0
        }
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = Engine::open(path, None).unwrap();
    fixture.configure(&engine);
    match call(&engine, infer(&session, "truncated", 20)).await {
        Reply::Inference {
            operation,
            duplicate: true,
            ..
        } => assert_eq!(operation.status, OperationStatus::Unknown),
        r => panic!("{r:?}"),
    };
    assert_eq!(fixture.requests(), 1);
    assert_eq!(budget(&engine, &session).await.reserved, 20);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancelled_remote_request_keeps_uncertain_spend_reserved() {
    let fixture = Fixture::new(partial(), true).await;
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(Engine::open(dir.path().join("native.sqlite"), None).unwrap());
    fixture.configure(&engine);
    let session = create(&engine, 100).await;
    let task = {
        let engine = engine.clone();
        let session = session.clone();
        tokio::spawn(async move { call(&engine, infer(&session, "cancel-me", 20)).await })
    };
    tokio::time::timeout(Duration::from_secs(3), fixture.ready.notified())
        .await
        .unwrap();
    assert!(matches!(
        call(
            &engine,
            Command::Cancel {
                session_id: session.clone(),
                execution_id: "cancel-me".into()
            }
        )
        .await,
        Reply::Cancelled { accepted: true, .. }
    ));
    match task.await.unwrap() {
        Reply::Inference { operation, .. } => {
            assert_eq!(operation.status, OperationStatus::Unknown)
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(
        budget(&engine, &session).await,
        BudgetSnapshot {
            limit: 100,
            reserved: 20,
            charged: 0
        }
    );
    assert!(matches!(
        call(&engine, infer(&session, "cancel-me", 20)).await,
        Reply::Inference {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(fixture.requests(), 1);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn provider_tool_names_are_data_and_cannot_trigger_execution() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("must-not-exist");
    let output = json!([{"type":"function_call","call_id":"malicious-tool-call","name":"write_file","arguments":json!({"path":marker,"content":"executed"}).to_string()}]);
    let fixture = Fixture::new(completed(output), false).await;
    let engine = Engine::open(
        dir.path().join("native.sqlite"),
        Some(dir.path().join("no-executor")),
    )
    .unwrap();
    fixture.configure(&engine);
    let session = create(&engine, 100).await;
    match call(&engine, infer(&session, "tool-call", 20)).await {
        Reply::Inference {
            completion: Some(c),
            ..
        } => assert!(
            matches!(c.content.as_slice(),[Content::ToolCall{name,..}] if name=="write_file")
        ),
        r => panic!("{r:?}"),
    };
    assert!(!marker.exists());
    assert_eq!(fixture.requests(), 1);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn completed_without_final_usage_must_not_settle_provisional_usage() {
    // A progress event's usage is not a receipt for the later completed response.
    let body = format!(
        "{}data: {}\n\n",
        partial(),
        json!({"type":"response.completed","response":{"id":"response-fixture","status":"completed","output":[]}})
    );
    let fixture = Fixture::new(body, false).await;
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path().join("native.sqlite"), None).unwrap();
    fixture.configure(&engine);
    let session = create(&engine, 100).await;
    match call(&engine, infer(&session, "no-final-usage", 20)).await {
        Reply::Inference {
            completion: Some(completion),
            ..
        } => {
            assert_eq!(completion.status, CompletionStatus::Incomplete);
            assert!(completion.content.is_empty());
            assert!(!completion.usage_is_final);
            assert_eq!(completion.usage.unwrap().input_tokens, 1);
        }
        reply => panic!("{reply:?}"),
    }

    assert_eq!(
        budget(&engine, &session).await,
        BudgetSnapshot {
            limit: 100,
            reserved: 20,
            charged: 0
        }
    );
    engine.shutdown().await.unwrap();
}
