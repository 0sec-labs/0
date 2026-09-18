#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Discovery metadata never substitutes for selected-review provenance validation.
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
    source::{ReviewRequest, SourceReviewRequest},
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

struct Fixture {
    dir: tempfile::TempDir,
    engine: Engine,
    session: String,
    operation: String,
    hypothesis: String,
    review_digest: String,
    http: Http,
}
impl Fixture {
    async fn new(adaptive: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let request = request(dir.path());
        let submitted = if adaptive {
            complete(json!([tool(
                "submit-1",
                "submit_source_hypotheses",
                json!({
                    "selected_files":["app.js"],
                    "hypotheses":[{"title":"Unverified input claim","claimed_severity":"medium","explanation":"Input reaches return without conversion.","citations":[{"path":"app.js","sha256":request.source.snapshot.files[0].digest,"start_line":1,"end_line":1}]}]
                })
            )]))
        } else {
            response(&request)
        };
        let http = Http::new(vec![submitted], false).await;
        let engine = Engine::open(dir.path().join("state.db"), None).unwrap();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let operation = if adaptive {
            let agent: zero_protocol::agent::AgentRequest = serde_json::from_value(json!({
                "provider":"local", "model":"fixture", "instructions":"Inspect source only",
                "prompt":request.source.question,"source_snapshot_tools":true,
                "source_submission_max_hypotheses":2,"max_turns":2,"reservation_per_turn":5,
                "execution":{"execution_id":"unused","image":"local:unused","snapshot":request.source.snapshot,
                    "argv":["unused"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}
            })).unwrap();
            match call(
                &engine,
                Command::RunAgent {
                    session_id: session.clone(),
                    command_id: "adaptive".into(),
                    request: agent,
                },
            )
            .await
            {
                Reply::Agent {
                    operation,
                    result: Some(result),
                    ..
                } => {
                    assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
                    assert!(result.source_review.is_some());
                    operation.id
                }
                other => panic!("{other:?}"),
            }
        } else {
            match call(&engine, command(&session, request)).await {
                Reply::SourceReview {
                    operation,
                    result: Some(result),
                    ..
                } => {
                    assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
                    operation.id
                }
                other => panic!("{other:?}"),
            }
        };
        let report =
            zero_engine::read_source_report(&dir.path().join("state.db"), &session, &operation)
                .unwrap();
        let hypothesis = report.review.hypotheses[0].id.clone();
        let review_digest = report.artifacts["source.review"].clone();
        fs::remove_dir_all(dir.path().join("source")).unwrap();
        Self {
            dir,
            engine,
            session,
            operation,
            hypothesis,
            review_digest,
            http,
        }
    }
}

fn discovery(session: &str, limit: u32) -> Command {
    Command::SourceReviews {
        session_id: session.into(),
        before_sequence: None,
        limit,
    }
}

#[tokio::test]
async fn both_review_origins_are_discoverable_offline_after_restart_without_mutation() {
    for adaptive in [false, true] {
        let f = Fixture::new(adaptive).await;
        let path = f.dir.path().join("state.db");
        let before_budget = budget(&f.engine, &f.session).await;
        let store = zero_store::Store::open_read_only(&path).unwrap();
        let before_events =
            serde_json::to_value(store.events(&f.session, 0, 1000).unwrap()).unwrap();
        let before_artifacts = store.operation_artifacts(&f.operation).unwrap();
        f.engine.shutdown().await.unwrap();
        drop(f.engine);
        // No source files or configured provider survive into this engine.
        let engine = Engine::open(&path, None).unwrap();
        let page = match call(&engine, discovery(&f.session, 32)).await {
            Reply::SourceReviews { page } => page,
            other => panic!("{other:?}"),
        };
        assert_eq!(page.reviews.len(), 1);
        let candidate = &page.reviews[0];
        assert_eq!(candidate.operation_id, f.operation);
        assert_eq!(
            candidate.command_id,
            if adaptive { "adaptive" } else { "review" }
        );
        assert_eq!(candidate.operation_status, OperationStatus::Succeeded);
        assert_eq!(candidate.source_review_sha256, f.review_digest);
        assert!(candidate.sequence > 0);
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(json["reviews"][0].as_object().unwrap().len(), 5);
        assert_eq!(
            serde_json::to_value(
                zero_engine::read_source_reviews(&path, &f.session, None, 32).unwrap()
            )
            .unwrap(),
            json
        );
        let findings =
            zero_engine::read_source_findings(&path, &f.session, &candidate.operation_id, 0, 32)
                .unwrap();
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].hypothesis.id, f.hypothesis);
        assert_eq!(
            serde_json::to_value(&findings[0]).unwrap()["hypothesis"]["state"],
            "unverified"
        );
        assert_eq!(budget(&engine, &f.session).await, before_budget);
        assert_eq!(
            serde_json::to_value(store.events(&f.session, 0, 1000).unwrap()).unwrap(),
            before_events
        );
        assert_eq!(
            store.operation_artifacts(&f.operation).unwrap(),
            before_artifacts
        );
        assert_eq!(f.http.count(), 1);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn corrupt_artifact_remains_a_candidate_but_selection_rejects_it() {
    let f = Fixture::new(true).await;
    let path = f.dir.path().join("state.db");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
            rusqlite::params![b"{}".as_slice(), &f.review_digest],
        )
        .unwrap();
    let page = zero_engine::read_source_reviews(&path, &f.session, None, 32).unwrap();
    assert_eq!(page.reviews.len(), 1);
    assert_eq!(page.reviews[0].source_review_sha256, f.review_digest);
    assert!(zero_engine::read_source_findings(&path, &f.session, &f.operation, 0, 32).is_err());
    assert!(
        zero_engine::read_source_finding(&path, &f.session, &f.operation, &f.hypothesis, 0, 50)
            .is_err()
    );
    assert_eq!(f.http.count(), 1);
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn retained_partial_review_is_visible_without_claiming_success() {
    let f = Fixture::new(false).await;
    let path = f.dir.path().join("state.db");
    // Simulate retained artifacts whose owning operation never settled cleanly.
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE operations SET status='unknown' WHERE id=?1",
            [&f.operation],
        )
        .unwrap();
    let page = zero_engine::read_source_reviews(&path, &f.session, None, 32).unwrap();
    assert_eq!(page.reviews.len(), 1);
    assert_eq!(page.reviews[0].operation_status, OperationStatus::Unknown);
    assert!(zero_engine::read_source_findings(&path, &f.session, &f.operation, 0, 32).is_err());
    assert_eq!(f.http.count(), 1);
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn discovery_checks_session_and_bounds_without_creating_or_mutating_state() {
    let f = Fixture::new(false).await;
    let path = f.dir.path().join("state.db");
    let other = session(&f.engine, 0).await;
    assert!(
        zero_engine::read_source_reviews(&path, &other, None, 32)
            .unwrap()
            .reviews
            .is_empty()
    );
    assert!(zero_engine::read_source_findings(&path, &other, &f.operation, 0, 32).is_err());
    for limit in [0, 33, u32::MAX] {
        assert!(matches!(
            call(&f.engine, discovery(&f.session, limit)).await,
            Reply::Error { .. }
        ));
        assert!(zero_engine::read_source_reviews(&path, &f.session, None, limit).is_err());
    }
    assert!(zero_engine::read_source_reviews(&path, "missing-session", None, 32).is_err());
    let missing = f.dir.path().join("missing/state.db");
    assert!(zero_engine::read_source_reviews(&missing, &f.session, None, 32).is_err());
    assert!(!missing.parent().unwrap().exists());
    assert_eq!(f.http.count(), 1);
    f.engine.shutdown().await.unwrap();
}
