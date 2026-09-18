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
    fn decision(
        &self,
        command_id: &str,
        status: &str,
        expected_revision: u64,
        note: &str,
    ) -> Command {
        serde_json::from_value(json!({"method":"triage_source_finding","params":{
            "session_id":self.session,"source_operation_id":self.operation,"hypothesis_id":self.hypothesis,
            "command_id":command_id,"status":status,"expected_revision":expected_revision,"note":note
        }})).unwrap()
    }
    fn list(&self) -> Command {
        serde_json::from_value(json!({"method":"source_findings","params":{
            "session_id":self.session,"source_operation_id":self.operation
        }}))
        .unwrap()
    }
    fn show(&self, after: u64, limit: u32) -> Command {
        serde_json::from_value(json!({"method":"source_finding","params":{
            "session_id":self.session,"source_operation_id":self.operation,"hypothesis_id":self.hypothesis,
            "after_revision":after,"limit":limit
        }})).unwrap()
    }
}
fn value(reply: Reply) -> Value {
    serde_json::to_value(reply).unwrap()
}

#[tokio::test]
async fn dedicated_and_adaptive_triage_are_offline_auditable_and_never_change_evidence() {
    for adaptive in [false, true] {
        let f = Fixture::new(adaptive).await;
        let path = f.dir.path().join("state.db");
        let original_report = serde_json::to_value(
            zero_engine::read_source_report(&path, &f.session, &f.operation).unwrap(),
        )
        .unwrap();
        let original_budget = budget(&f.engine, &f.session).await;
        let events_before = zero_store::Store::open_read_only(&path)
            .unwrap()
            .events(&f.session, 0, 1000)
            .unwrap()
            .len();
        let list = value(call(&f.engine, f.list()).await);
        assert_eq!(list["type"], "source_findings");
        assert_eq!(list["findings"].as_array().unwrap().len(), 1);
        let fresh = &list["findings"][0];
        assert_eq!(fresh["status"], "new");
        assert_eq!(fresh["revision"], 0);
        assert_eq!(fresh["hypothesis"]["state"], "unverified");
        assert_eq!(fresh["source_review_sha256"], f.review_digest);
        let shown = value(call(&f.engine, f.show(0, 50)).await);
        assert_eq!(shown["history"], json!([]));
        let readonly =
            zero_engine::read_source_findings(&path, &f.session, &f.operation, 0, 32).unwrap();
        assert_eq!(serde_json::to_value(readonly).unwrap(), list["findings"]);
        let (finding, history) =
            zero_engine::read_source_finding(&path, &f.session, &f.operation, &f.hypothesis, 0, 50)
                .unwrap();
        assert_eq!(serde_json::to_value(finding).unwrap(), *fresh);
        assert!(history.is_empty());
        assert_eq!(
            zero_store::Store::open_read_only(&path)
                .unwrap()
                .events(&f.session, 0, 1000)
                .unwrap()
                .len(),
            events_before
        );
        let accept = f.decision(
            "accept",
            "accepted",
            0,
            "Operator wants further investigation, not verification",
        );
        let suppress = f.decision("suppress", "suppressed", 1, "No longer in scope");
        let reopen = f.decision("reopen", "new", 2, "Reconsider original hypothesis");
        let stale = f.decision("stale", "accepted", 0, "stale CAS");
        let conflicting = f.decision("accept", "suppressed", 0, "changed exact retry");
        let show_first = f.show(0, 2);
        let show_after = f.show(2, 2);
        f.engine.shutdown().await.unwrap();
        drop(f.engine);
        // No provider registration, source files or backend are needed to triage.
        let engine = Engine::open(&path, None).unwrap();
        let first = value(call(&engine, accept.clone()).await);
        assert_eq!(first["type"], "source_finding_triaged");
        assert_eq!(first["duplicate"], false);
        assert_eq!(first["finding"]["status"], "accepted");
        assert_eq!(first["finding"]["revision"], 1);
        assert_eq!(first["decision"]["source_review_sha256"], f.review_digest);
        assert_eq!(
            value(call(&engine, suppress).await)["finding"]["revision"],
            2
        );
        assert_eq!(value(call(&engine, reopen).await)["finding"]["revision"], 3);
        let retry = value(call(&engine, accept).await);
        assert_eq!(retry["duplicate"], true);
        assert_eq!(retry["decision"], first["decision"]);
        assert_eq!(retry["finding"]["status"], "new");
        assert_eq!(retry["finding"]["revision"], 3);
        assert!(matches!(call(&engine, stale).await, Reply::Error { .. }));
        assert!(matches!(
            call(&engine, conflicting).await,
            Reply::Error { .. }
        ));
        let page = value(call(&engine, show_first).await);
        assert_eq!(page["history"].as_array().unwrap().len(), 2);
        assert_eq!(page["history"][0]["revision"], 1);
        assert_eq!(page["history"][1]["revision"], 2);
        let page = value(call(&engine, show_after).await);
        assert_eq!(page["history"].as_array().unwrap().len(), 1);
        assert_eq!(page["history"][0]["revision"], 3);
        assert_eq!(page["finding"]["hypothesis"]["state"], "unverified");
        assert_eq!(
            serde_json::to_value(
                zero_engine::read_source_report(&path, &f.session, &f.operation).unwrap()
            )
            .unwrap(),
            original_report
        );
        assert_eq!(budget(&engine, &f.session).await, original_budget);
        assert_eq!(f.http.count(), 1);
        let events = zero_store::Store::open_read_only(&path)
            .unwrap()
            .events(&f.session, 0, 1000)
            .unwrap();
        assert_eq!(events.len(), events_before + 3);
        engine.shutdown().await.unwrap();
        drop(engine);
        let (finding, history) =
            zero_engine::read_source_finding(&path, &f.session, &f.operation, &f.hypothesis, 0, 50)
                .unwrap();
        assert_eq!(serde_json::to_value(finding).unwrap()["revision"], 3);
        assert_eq!(history.len(), 3);
    }
}

#[tokio::test]
async fn triage_rejects_wrong_identity_stale_intent_and_invalid_limits_without_events() {
    let f = Fixture::new(false).await;
    let other = session(&f.engine, 100).await;
    let path = f.dir.path().join("state.db");
    let before = zero_store::Store::open_read_only(&path)
        .unwrap()
        .events(&f.session, 0, 1000)
        .unwrap()
        .len();
    let base = serde_json::to_value(f.decision("bad", "accepted", 0, "note")).unwrap();
    for (field, value) in [
        ("session_id", json!(other)),
        ("source_operation_id", json!("missing")),
        ("hypothesis_id", json!("sha256:wrong")),
        ("note", json!("x".repeat(4097))),
        ("expected_revision", json!(1)),
    ] {
        let mut request = base.clone();
        request["params"][field] = value;
        assert!(
            matches!(
                call(&f.engine, serde_json::from_value(request).unwrap()).await,
                Reply::Error { .. }
            ),
            "accepted {field}"
        );
    }
    for limit in [0, 101] {
        assert!(matches!(
            call(&f.engine, f.show(0, limit)).await,
            Reply::Error { .. }
        ));
        assert!(
            zero_engine::read_source_finding(
                &path,
                &f.session,
                &f.operation,
                &f.hypothesis,
                0,
                limit
            )
            .is_err()
        );
    }
    assert_eq!(
        zero_store::Store::open_read_only(&path)
            .unwrap()
            .events(&f.session, 0, 1000)
            .unwrap()
            .len(),
        before
    );
    assert_eq!(f.http.count(), 1);
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn retained_source_corruption_or_unsuccessful_status_blocks_reads_and_decisions() {
    for adaptive in [false, true] {
        for mutation in ["review_bytes", "status", "hidden_error"] {
            let f = Fixture::new(adaptive).await;
            let path = f.dir.path().join("state.db");
            let before = zero_store::Store::open_read_only(&path)
                .unwrap()
                .events(&f.session, 0, 1000)
                .unwrap()
                .len();
            let db = rusqlite::Connection::open(&path).unwrap();
            match mutation {
                "review_bytes" => {
                    db.execute(
                        "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
                        rusqlite::params![b"{}".as_slice(), f.review_digest],
                    )
                    .unwrap();
                }
                "status" => {
                    db.execute(
                        "UPDATE operations SET status='failed' WHERE id=?1",
                        [&f.operation],
                    )
                    .unwrap();
                }
                _ => {
                    let raw: String = db
                        .query_row(
                            "SELECT outcome FROM operations WHERE id=?1",
                            [&f.operation],
                            |row| row.get(0),
                        )
                        .unwrap();
                    let mut outcome: Value = serde_json::from_str(&raw).unwrap();
                    if adaptive {
                        outcome["source_review"]["error"] = json!("retained failure");
                    } else {
                        outcome["error"] = json!("retained failure");
                    }
                    db.execute(
                        "UPDATE operations SET outcome=?1 WHERE id=?2",
                        rusqlite::params![outcome.to_string(), f.operation],
                    )
                    .unwrap();
                }
            }
            drop(db);
            assert!(
                zero_engine::read_source_findings(&path, &f.session, &f.operation, 0, 32).is_err(),
                "accepted {mutation}"
            );
            assert!(
                zero_engine::read_source_finding(
                    &path,
                    &f.session,
                    &f.operation,
                    &f.hypothesis,
                    0,
                    50
                )
                .is_err()
            );
            assert!(matches!(
                call(&f.engine, f.decision("bad", "accepted", 0, "note")).await,
                Reply::Error { .. }
            ));
            assert_eq!(
                zero_store::Store::open_read_only(&path)
                    .unwrap()
                    .events(&f.session, 0, 1000)
                    .unwrap()
                    .len(),
                before
            );
            assert_eq!(f.http.count(), 1);
            f.engine.shutdown().await.unwrap();
        }
    }
}

#[test]
fn readonly_triage_never_creates_missing_state_or_migrates_foreign_state() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.db");
    assert!(zero_engine::read_source_findings(&missing, "session", "source", 0, 32).is_err());
    assert!(!missing.exists());
    let foreign = dir.path().join("foreign.db");
    let conn = rusqlite::Connection::open(&foreign).unwrap();
    conn.execute("CREATE TABLE marker(value TEXT)", []).unwrap();
    drop(conn);
    let before = fs::read(&foreign).unwrap();
    assert!(
        zero_engine::read_source_finding(&foreign, "session", "source", "hypothesis", 0, 50)
            .is_err()
    );
    assert_eq!(fs::read(&foreign).unwrap(), before);
}

#[tokio::test]
async fn same_hypothesis_in_another_source_operation_has_independent_disposition() {
    let f = Fixture::new(false).await;
    let second_request = request(f.dir.path());
    let second = match call(
        &f.engine,
        Command::ReviewSource {
            session_id: f.session.clone(),
            command_id: "second-review".into(),
            request: second_request,
        },
    )
    .await
    {
        Reply::SourceReview { operation, .. } => operation.id,
        other => panic!("{other:?}"),
    };
    let path = f.dir.path().join("state.db");
    let untouched = zero_engine::read_source_findings(&path, &f.session, &second, 0, 32).unwrap();
    assert_eq!(untouched.len(), 1);
    assert_eq!(untouched[0].hypothesis.id, f.hypothesis);
    let accepted = value(
        call(
            &f.engine,
            f.decision("accept", "accepted", 0, "exact operation only"),
        )
        .await,
    );
    assert_eq!(accepted["finding"]["status"], "accepted");
    let untouched = zero_engine::read_source_findings(&path, &f.session, &second, 0, 32).unwrap();
    assert_eq!(
        serde_json::to_value(&untouched[0]).unwrap()["status"],
        "new"
    );
    assert_eq!(untouched[0].revision, 0);
    assert!(
        zero_engine::read_source_findings(&path, &f.session, &second, 1, 1)
            .unwrap()
            .is_empty()
    );
    assert!(zero_engine::read_source_findings(&path, &f.session, &second, 0, 0).is_err());
    assert_eq!(f.http.count(), 2);
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn empty_valid_review_is_an_empty_hypothesis_page_without_a_safety_verdict() {
    let dir = tempfile::tempdir().unwrap();
    let request = request(dir.path());
    let http = Http::new(
        vec![complete(json!([tool(
            "empty",
            "submit_source_hypotheses",
            json!({"hypotheses":[]})
        )]))],
        false,
    )
    .await;
    let engine = Engine::open(dir.path().join("state.db"), None).unwrap();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let operation = match call(&engine, command(&session, request)).await {
        Reply::SourceReview {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
            operation.id
        }
        other => panic!("{other:?}"),
    };
    let path = dir.path().join("state.db");
    assert!(
        zero_engine::read_source_findings(&path, &session, &operation, 0, 32)
            .unwrap()
            .is_empty()
    );
    let report = zero_engine::read_source_report(&path, &session, &operation).unwrap();
    assert_eq!(
        report.security_conclusion,
        zero_protocol::source::SecurityConclusion::NotEstablished
    );
    assert_eq!(
        report.verification_state,
        zero_protocol::source::VerificationState::Unverified
    );
    engine.shutdown().await.unwrap();
}
