#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{
    fs,
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
    Command, Reply,
    model::Rates,
    session::OperationStatus,
    source::{ReviewRequest, SourceReviewRequest, VerificationState},
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
#[allow(dead_code)]
fn answer() -> String {
    complete(
        json!([{"type":"message","content":[{"type":"output_text","text":"finished assessment"}]}]),
    )
}

fn request(dir: &std::path::Path) -> SourceReviewRequest {
    fs::create_dir_all(dir.join("source")).unwrap();
    fs::write(
        dir.join("source/app.js"),
        "function sensitive(input) { return input; }\n",
    )
    .unwrap();
    SourceReviewRequest {
        provider: "local".into(),
        model: "fixture".into(),
        reservation: 5,
        source: ReviewRequest {
            snapshot: zero_executor::pin_snapshot(&dir.join("source")).unwrap(),
            selected_files: vec!["app.js".into()],
            question: "Assess input trust".into(),
            max_hypotheses: 2,
        },
    }
}
fn response(request: &SourceReviewRequest) -> String {
    complete(json!([tool(
        "submit-1",
        "submit_source_hypotheses",
        json!({"hypotheses":[{"title":"Unverified input claim","claimed_severity":"medium","explanation":"Input reaches return without conversion.","citations":[{"path":"app.js","sha256":request.source.snapshot.files[0].digest,"start_line":1,"end_line":1}]}]})
    )]))
}
async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, _rx) = mpsc::channel(64);
    engine.handle(command, tx).await
}
async fn session(engine: &Engine, limit: u64) -> String {
    match call(
        engine,
        Command::SessionCreate {
            generation: "g".into(),
            budget_limit: limit,
        },
    )
    .await
    {
        Reply::Session { session } => session.id,
        r => panic!("{r:?}"),
    }
}
fn command(session: &str, request: SourceReviewRequest) -> Command {
    Command::ReviewSource {
        session_id: session.into(),
        command_id: "review".into(),
        request,
    }
}
async fn budget(engine: &Engine, session: &str) -> (u64, u64) {
    match call(
        engine,
        Command::SessionBudget {
            session_id: session.into(),
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => (budget.charged, budget.reserved),
        r => panic!("{r:?}"),
    }
}
#[tokio::test]
async fn retained_source_and_usage_survive_restart_retry_after_original_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let request = request(dir.path());
    let http = Http::new(vec![response(&request)], false).await;
    let path = dir.path().join("state.db");
    let engine = Engine::open(&path, None).unwrap();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let outcome = match call(&engine, command(&session, request.clone())).await {
        Reply::SourceReview {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            assert_eq!(
                result.review.as_ref().unwrap().hypotheses[0].state,
                VerificationState::Unverified
            );
            result
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(http.count(), 1);
    assert_eq!(budget(&engine, &session).await, (2, 0));
    assert_eq!(outcome.artifacts.len(), 4);
    let store = zero_store::Store::open(&path).unwrap();
    let bundle = zero_source::SourceBundle::from_bytes(
        &store.artifact(&outcome.artifacts["source.bundle"]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        bundle.files()[0].text(),
        "function sensitive(input) { return input; }\n"
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    fs::remove_dir_all(dir.path().join("source")).unwrap();
    let engine = Engine::open(&path, None).unwrap();
    http.configure(&engine);
    assert!(matches!(
        call(&engine, command(&session, request.clone())).await,
        Reply::SourceReview {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(http.count(), 1);
    assert_eq!(budget(&engine, &session).await, (2, 0));
    let mut changed = request;
    changed.source.question = "Different".into();
    assert!(matches!(
        call(&engine, command(&session, changed)).await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn malformed_citation_or_prose_never_becomes_a_report() {
    for citation in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let request = request(dir.path());
        let body = if citation {
            response(&request).replace("app.js", "invented.js")
        } else {
            answer()
        };
        let http = Http::new(vec![body], false).await;
        let engine = Engine::open(dir.path().join("state.db"), None).unwrap();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        match call(&engine, command(&session, request)).await {
            Reply::SourceReview {
                operation,
                result: Some(result),
                ..
            } => {
                assert_eq!(operation.status, OperationStatus::Failed);
                assert!(result.review.is_none());
                assert!(result.artifacts.contains_key("source.completion"));
            }
            r => panic!("{r:?}"),
        };
        assert_eq!(budget(&engine, &session).await, (2, 0));
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn budget_and_predispatch_artifact_journal_failure_prevent_http() {
    for fail_journal in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let request = request(dir.path());
        let http = Http::new(vec![response(&request)], false).await;
        let path = dir.path().join("state.db");
        let engine = Engine::open(&path, None).unwrap();
        http.configure(&engine);
        let session = session(&engine, if fail_journal { 100 } else { 1 }).await;
        if fail_journal {
            rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TRIGGER reject_artifact BEFORE INSERT ON events WHEN NEW.kind='operation_artifact' BEGIN SELECT RAISE(ABORT,'injected retention failure'); END;").unwrap();
        }
        match call(&engine, command(&session, request)).await {
            Reply::SourceReview {
                operation,
                result: Some(result),
                ..
            } => {
                assert_eq!(operation.status, OperationStatus::Failed);
                assert!(!result.external_effects_started);
            }
            r => panic!("{r:?}"),
        };
        assert_eq!(http.count(), 0);
        assert_eq!(budget(&engine, &session).await, (0, 0));
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn cancelled_provider_is_unknown_and_keeps_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let request = request(dir.path());
    let http = Http::new(
        vec!["data: {\"type\":\"response.created\",\"response\":{\"id\":\"pending\"}}\n\n".into()],
        true,
    )
    .await;
    let engine = Arc::new(Engine::open(dir.path().join("state.db"), None).unwrap());
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let owner = engine.clone();
    let cmd = command(&session, request);
    let task = tokio::spawn(async move { call(&owner, cmd).await });
    http.ready.notified().await;
    assert!(matches!(
        call(
            &engine,
            Command::Cancel {
                session_id: session.clone(),
                execution_id: "review".into()
            }
        )
        .await,
        Reply::Cancelled { accepted: true, .. }
    ));
    match task.await.unwrap() {
        Reply::SourceReview { operation, .. } => {
            assert_eq!(operation.status, OperationStatus::Unknown)
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(budget(&engine, &session).await, (0, 5));
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_final_usage_stays_reserved_and_changed_provider_conflicts_without_source_read() {
    let dir = tempfile::tempdir().unwrap();
    let request = request(dir.path());
    let body =
        response(&request).replace(",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}", "");
    assert!(!body.contains("usage"));
    let http = Http::new(vec![body], false).await;
    let path = dir.path().join("state.db");
    let engine = Engine::open(&path, None).unwrap();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    assert!(matches!(
        call(&engine, command(&session, request.clone())).await,
        Reply::SourceReview {
            operation: zero_protocol::Operation {
                status: OperationStatus::Succeeded,
                ..
            },
            ..
        }
    ));
    assert_eq!(budget(&engine, &session).await, (0, 5));
    engine.shutdown().await.unwrap();
    drop(engine);
    fs::remove_dir_all(dir.path().join("source")).unwrap();
    let changed = Http::new(vec![response(&request)], false).await;
    let engine = Engine::open(&path, None).unwrap();
    changed.configure(&engine);
    assert!(
        matches!(call(&engine,command(&session,request)).await,Reply::Error{code,..} if code=="conflict")
    );
    assert_eq!(changed.count(), 0);
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn lost_admission_delivery_cancels_before_source_read_or_http() {
    let dir = tempfile::tempdir().unwrap();
    let request = request(dir.path());
    let http = Http::new(vec![response(&request)], false).await;
    let engine = Engine::open(dir.path().join("state.db"), None).unwrap();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    fs::remove_dir_all(dir.path().join("source")).unwrap();
    let (tx, rx) = mpsc::channel(1);
    drop(rx);
    match engine.handle(command(&session, request), tx).await {
        Reply::SourceReview {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Cancelled);
            assert!(!result.external_effects_started);
            assert!(result.artifacts.is_empty());
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(http.count(), 0);
    assert_eq!(budget(&engine, &session).await, (0, 0));
    engine.shutdown().await.unwrap();
}
