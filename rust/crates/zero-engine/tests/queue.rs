//! Durable queue tests exercise the actual agent/provider boundary on loopback.
use serde_json::{Value, json};
use std::{
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
use zero_protocol::{
    Command, ExecutionEvent, Reply,
    agent::AgentRequest,
    model::Rates,
    queue::{QueuedAgent, QueuedAgentStatus},
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

fn request(dir: &std::path::Path, prompt: &str) -> AgentRequest {
    let source = dir.join("source");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("fixture.txt"), "fixture").unwrap();
    serde_json::from_value(json!({"provider":"local","model":"fixture","instructions":"test","prompt":prompt,"max_turns":1,"reservation_per_turn":10,"execution":{"execution_id":"queue-fixture","image":"local:no-execution","snapshot":zero_executor::pin_snapshot(&source).unwrap(),"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}})).unwrap()
}
async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(128);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let reply = tokio::time::timeout(Duration::from_secs(10), engine.handle(command, tx))
        .await
        .unwrap();
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
async fn enqueue(
    engine: &Engine,
    session: &str,
    command: &str,
    request: AgentRequest,
    after: Option<String>,
) -> QueuedAgent {
    match call(
        engine,
        Command::QueueAgent {
            session_id: session.into(),
            command_id: command.into(),
            request,
            after_input: after,
        },
    )
    .await
    {
        Reply::AgentQueued {
            input,
            duplicate: false,
        } => input,
        r => panic!("{r:?}"),
    }
}
fn run(session: &str, input: &QueuedAgent) -> Command {
    Command::RunQueuedAgent {
        session_id: session.into(),
        input_id: input.id.clone(),
    }
}
async fn list(engine: &Engine, session: &str) -> Vec<QueuedAgent> {
    match call(
        engine,
        Command::AgentQueue {
            session_id: session.into(),
            after_sequence: 0,
            limit: 100,
        },
    )
    .await
    {
        Reply::AgentQueue { inputs } => inputs,
        r => panic!("{r:?}"),
    }
}
fn answer() -> String {
    complete(json!([{"type":"message","content":[{"type":"output_text","text":"answer"}]}]))
}
#[tokio::test]
async fn pending_queue_survives_restart_fifo_and_continuation_replay_without_duplicate_effects() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let engine = Engine::open(&path, None).unwrap();
    let session = session(&engine).await;
    let first = enqueue(
        &engine,
        &session,
        "first",
        request(dir.path(), "first question"),
        None,
    )
    .await;
    let second = enqueue(
        &engine,
        &session,
        "second",
        request(dir.path(), "second question"),
        Some(first.id.clone()),
    )
    .await;
    assert!(matches!(
        call(&engine, run(&session, &second)).await,
        Reply::Error { .. }
    ));
    drop(engine);
    let http = Http::new(vec![answer()], false).await;
    let engine = Engine::open(&path, None).unwrap();
    http.configure(&engine);
    assert_eq!(
        list(&engine, &session).await[0].status,
        QueuedAgentStatus::Pending
    );
    let first_op = match call(&engine, run(&session, &first)).await {
        Reply::Agent {
            operation,
            duplicate: false,
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            operation.id
        }
        r => panic!("{r:?}"),
    };
    assert!(matches!(
        call(&engine, run(&session, &second)).await,
        Reply::Agent {
            duplicate: false,
            ..
        }
    ));
    let input = http.requests.lock().unwrap()[1]["input"].clone();
    let text = input.to_string();
    assert!(text.contains("first question"));
    assert!(text.contains("answer"));
    assert!(text.contains("second question"));
    let rows = list(&engine, &session).await;
    assert_eq!(
        rows[1]
            .resolved_request
            .as_ref()
            .unwrap()
            .continuation_of
            .as_deref(),
        Some(first_op.as_str())
    );
    assert!(
        rows.iter()
            .all(|r| r.status == QueuedAgentStatus::Succeeded)
    );
    drop(engine);
    // Receipts are inspectable/retryable without configuring any provider again.
    let engine = Engine::open(&path, None).unwrap();
    for input in [&first, &second] {
        assert!(matches!(
            call(&engine, run(&session, input)).await,
            Reply::Agent {
                duplicate: true,
                ..
            }
        ));
    }
    assert_eq!(http.count(), 2);
    match call(
        &engine,
        Command::SessionBudget {
            session_id: session,
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => {
            assert_eq!(budget.charged, 4);
            assert_eq!(budget.reserved, 0)
        }
        r => panic!("{r:?}"),
    }
}
#[tokio::test]
async fn active_input_accepts_followups_but_cancel_and_unknown_do_not_drain_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let engine = Arc::new(Engine::open(&path, None).unwrap());
    let session = session(&engine).await;
    let http = Http::new(
        vec!["data: {\"type\":\"response.created\"}\n\n".into()],
        true,
    )
    .await;
    http.configure(&engine);
    let first = enqueue(
        &engine,
        &session,
        "first",
        request(dir.path(), "first"),
        None,
    )
    .await;
    let owner = engine.clone();
    let cmd = run(&session, &first);
    let active = tokio::spawn(async move { call(&owner, cmd).await });
    tokio::time::timeout(Duration::from_secs(3), http.ready.notified())
        .await
        .unwrap();
    let next = enqueue(
        &engine,
        &session,
        "next",
        request(dir.path(), "next"),
        Some(first.id.clone()),
    )
    .await;
    let rows = list(&engine, &session).await;
    assert_eq!(rows[0].status, QueuedAgentStatus::Running);
    assert_eq!(rows[1].status, QueuedAgentStatus::Pending);
    assert!(matches!(
        call(&engine, run(&session, &next)).await,
        Reply::Error { .. }
    ));
    assert!(matches!(
        call(
            &engine,
            Command::CancelQueuedAgent {
                session_id: session.clone(),
                input_id: first.id.clone()
            }
        )
        .await,
        Reply::Error { .. }
    ));
    assert!(matches!(
        call(
            &engine,
            Command::Cancel {
                session_id: session.clone(),
                execution_id: first.run_command_id.clone()
            }
        )
        .await,
        Reply::Cancelled { accepted: true, .. }
    ));
    assert!(
        matches!(active.await.unwrap(),Reply::Agent{operation,..} if operation.status==OperationStatus::Unknown)
    );
    drop(engine);
    let engine = Engine::open(&path, None).unwrap();
    http.configure(&engine);
    let rows = list(&engine, &session).await;
    assert_eq!(rows[0].status, QueuedAgentStatus::Unknown);
    assert_eq!(rows[1].status, QueuedAgentStatus::Pending);
    assert!(matches!(
        call(&engine, run(&session, &first)).await,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert!(matches!(
        call(&engine, run(&session, &next)).await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 1);
    match call(
        &engine,
        Command::SessionBudget {
            session_id: session,
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => {
            assert_eq!(budget.charged, 0);
            assert_eq!(budget.reserved, 10)
        }
        r => panic!("{r:?}"),
    }
}
#[tokio::test]
async fn resolved_but_unadmitted_intent_can_retry_or_cancel_and_reserved_ids_cannot_bypass_queue() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let engine = Engine::open(&path, None).unwrap();
    let session = session(&engine).await;
    let request = request(dir.path(), "question");
    let first = enqueue(&engine, &session, "first", request.clone(), None).await;
    assert!(matches!(
        call(&engine, run(&session, &first)).await,
        Reply::Error { .. }
    ));
    let row = list(&engine, &session).await.remove(0);
    assert!(row.resolved_request.is_some());
    assert_eq!(row.status, QueuedAgentStatus::Pending);
    let http = Http::new(vec![answer()], false).await;
    http.configure(&engine);
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: session.clone(),
                command_id: first.run_command_id.clone(),
                request: request.clone()
            }
        )
        .await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 0);
    assert!(matches!(
        call(&engine, run(&session, &first)).await,
        Reply::Agent {
            duplicate: false,
            ..
        }
    ));
    let second = enqueue(&engine, &session, "second", request, None).await;
    for _ in 0..2 {
        assert!(
            matches!(call(&engine,Command::CancelQueuedAgent{session_id:session.clone(),input_id:second.id.clone()}).await,Reply::AgentInput{input} if input.status==QueuedAgentStatus::Cancelled)
        );
    }
    assert!(matches!(
        call(&engine, run(&session, &second)).await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 1);
}

#[tokio::test]
async fn recovered_dispatched_queue_receipt_never_replays_and_retains_usage_hold() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = zero_store::Store::open(&path).unwrap();
    store.claim_engine_epoch("lost-owner").unwrap();
    let session = store.create_session("fixture", 100).unwrap().id;
    let (input, _) = store
        .enqueue_agent(&session, "lost", &request(dir.path(), "lost turn"), &None)
        .unwrap();
    let resolved = store.resolve_queued_agent(&session, &input.id).unwrap();
    let admission = store.admit_command(&session, &input.run_command_id, &json!({"kind":"offline_snapshot_agent","request":resolved.resolved_request.unwrap(),"endpoint":"http://127.0.0.1:1/responses","rates":{"input":1000000,"cached_input":1000000,"output":1000000}})).unwrap();
    store
        .begin_operation(&admission.operation.id, "lost-owner")
        .unwrap();
    store
        .reserve_budget(&session, &admission.operation.id, 10)
        .unwrap();
    drop(store);
    let engine = Engine::open(&path, None).unwrap();
    let http = Http::new(vec![answer()], false).await;
    http.configure(&engine);
    assert_eq!(
        list(&engine, &session).await[0].status,
        QueuedAgentStatus::Unknown
    );
    assert!(
        matches!(call(&engine, run(&session, &input)).await, Reply::Agent { operation, duplicate:true, .. } if operation.status==OperationStatus::Unknown)
    );
    assert_eq!(http.count(), 0);
    match call(
        &engine,
        Command::SessionBudget {
            session_id: session,
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => {
            assert_eq!(budget.reserved, 10);
            assert_eq!(budget.charged, 0);
        }
        r => panic!("{r:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_cancellation_and_dispatch_have_one_serialized_winner() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(Engine::open(dir.path().join("state.db"), None).unwrap());
    let http = Http::new(vec![answer()], false).await;
    http.configure(&engine);
    let session = session(&engine).await;
    let mut dispatched = 0;
    for n in 0..12 {
        let input = enqueue(
            &engine,
            &session,
            &format!("race-{n}"),
            request(dir.path(), "race"),
            None,
        )
        .await;
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let a = engine.clone();
        let b = barrier.clone();
        let command = run(&session, &input);
        let running = tokio::spawn(async move {
            b.wait().await;
            call(&a, command).await
        });
        let a = engine.clone();
        let command = Command::CancelQueuedAgent {
            session_id: session.clone(),
            input_id: input.id,
        };
        let cancelled = tokio::spawn(async move {
            barrier.wait().await;
            call(&a, command).await
        });
        match (running.await.unwrap(), cancelled.await.unwrap()) {
            (
                Reply::Agent {
                    operation,
                    duplicate: false,
                    ..
                },
                Reply::Error { .. },
            ) => {
                assert_eq!(operation.status, OperationStatus::Succeeded);
                dispatched += 1;
            }
            (Reply::Error { .. }, Reply::AgentInput { input }) => {
                assert_eq!(input.status, QueuedAgentStatus::Cancelled)
            }
            other => panic!("non-serialized result: {other:?}"),
        }
    }
    assert_eq!(http.count(), dispatched);
}

#[tokio::test]
async fn recovered_ownerless_admission_returns_failed_receipt_without_replaying() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = zero_store::Store::open(&path).unwrap();
    store.claim_engine_epoch("lost-owner").unwrap();
    let session = store.create_session("fixture", 100).unwrap().id;
    let (input, _) = store
        .enqueue_agent(
            &session,
            "ownerless",
            &request(dir.path(), "question"),
            &None,
        )
        .unwrap();
    let resolved = store.resolve_queued_agent(&session, &input.id).unwrap();
    store
        .admit_command(
            &session,
            &input.run_command_id,
            &json!({"kind":"offline_snapshot_agent","request":resolved.resolved_request.unwrap()}),
        )
        .unwrap();
    drop(store);
    let engine = Engine::open(path, None).unwrap();
    assert!(
        matches!(call(&engine,run(&session,&input)).await,Reply::Agent{operation,result:None,duplicate:true} if operation.status==OperationStatus::Failed)
    );
    assert_eq!(
        list(&engine, &session).await[0].status,
        QueuedAgentStatus::Failed
    );
}
