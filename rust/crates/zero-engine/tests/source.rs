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

use std::os::unix::fs::PermissionsExt;
use zero_protocol::verification::{
    Case, Disposition, ExactOutput, Limits, Mode, Plan, SourceReproductionRequest,
};
struct ReproFixture {
    dir: tempfile::TempDir,
    engine: Engine,
    session: String,
    source: String,
    plan: Plan,
}
impl ReproFixture {
    async fn new(scenario: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let request = request(dir.path());
        let http = Http::new(vec![response(&request)], false).await;
        let fake=include_str!("../../zero-executor/tests/fixtures/fake-docker.py").replace("elif args[0] == \"start\":", "elif args[0] == \"start\":\n    import sqlite3\n    db=sqlite3.connect(root / \"state.db\")\n    assert db.execute(\"SELECT count(*) FROM operation_artifacts WHERE name=\'reproduction.plan\'\").fetchone()[0]>0\n    assert db.execute(\"SELECT count(*) FROM operation_artifacts WHERE name=\'reproduction.request\'\").fetchone()[0]>0");
        fs::write(dir.path().join("docker"), fake).unwrap();
        fs::set_permissions(dir.path().join("docker"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("scenario.txt"), scenario).unwrap();
        let engine =
            Engine::open(dir.path().join("state.db"), Some(dir.path().join("docker"))).unwrap();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let (source, hypothesis, bundle) =
            match call(&engine, command(&session, request.clone())).await {
                Reply::SourceReview {
                    operation,
                    result: Some(result),
                    ..
                } => (
                    operation.id,
                    result.review.unwrap().hypotheses[0].id.clone(),
                    result.artifacts["source.bundle"].clone(),
                ),
                r => panic!("{r:?}"),
            };
        let plan = Plan {
            schema_version: 1,
            oracle_version: zero_verification::ORACLE_VERSION.into(),
            hypothesis_id: hypothesis,
            source_bundle_digest: bundle,
            snapshot: request.source.snapshot,
            backend: zero_protocol::sandbox::SandboxBackend::Docker {
                image: format!("sha256:{}", "a".repeat(64)),
            },
            limits: Limits {
                timeout_ms: 700,
                memory_mb: 128,
                cpus: 0.5,
                max_output_bytes: 1024,
            },
            repeats: 2,
            cases: vec![
                Case {
                    id: "attack".into(),
                    mode: Mode::Attack,
                    argv: vec!["node".into(), "app.js".into(), "attack".into()],
                    stdin: Some("attack-output\n".into()),
                    expected: ExactOutput {
                        exit_code: 0,
                        stdout: b"attack-output\n".to_vec(),
                        stderr: b"fixture diagnostic\n".to_vec(),
                    },
                    safe_expected: None,
                },
                Case {
                    id: "control".into(),
                    mode: Mode::LegitimateControl,
                    argv: vec!["node".into(), "app.js".into(), "control".into()],
                    stdin: Some("legitimate-output\n".into()),
                    expected: ExactOutput {
                        exit_code: 0,
                        stdout: b"legitimate-output\n".to_vec(),
                        stderr: b"fixture diagnostic\n".to_vec(),
                    },
                    safe_expected: None,
                },
            ],
        };
        Self {
            dir,
            engine,
            session,
            source,
            plan,
        }
    }
    fn command(&self, id: &str) -> Command {
        Command::ReproduceSource {
            session_id: self.session.clone(),
            command_id: id.into(),
            request: SourceReproductionRequest {
                source_operation_id: self.source.clone(),
                plan: self.plan.clone(),
            },
        }
    }
    fn calls(&self) -> usize {
        fs::read_to_string(self.dir.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .count()
    }
}
#[tokio::test]
async fn reproduction_retains_exact_matrix_and_retries_after_source_deletion() {
    let f = ReproFixture::new("echo").await;
    let result = match call(&f.engine, f.command("repro")).await {
        Reply::SourceReproduction {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            result
        }
        r => panic!("{r:?}"),
    };
    let assessment = result.assessment.unwrap();
    assert_eq!(assessment.disposition, Disposition::ObservedForPlan);
    assert!(!assessment.vulnerability_reportable);
    assert_eq!(assessment.observed_attempts, 4);
    assert_eq!(result.children.len(), 4);
    let store = zero_store::Store::open(f.dir.path().join("state.db")).unwrap();
    let mut evidence = vec![];
    let mut ids = std::collections::BTreeSet::new();
    for child in result.children {
        let artifacts = store.operation_artifacts(&child).unwrap();
        let item: zero_verification::Evidence =
            serde_json::from_slice(&store.artifact(&artifacts["reproduction.evidence"]).unwrap())
                .unwrap();
        assert!(ids.insert(item.request.execution_id.clone()));
        assert_eq!(
            store.artifact(&artifacts["reproduction.request"]).unwrap(),
            serde_json::to_vec(&item.request).unwrap()
        );
        evidence.push(item);
    }
    let recomputed = zero_verification::assess(
        &zero_verification::FrozenPlan::new(f.plan.clone()).unwrap(),
        &evidence,
    )
    .unwrap();
    assert_eq!(assessment.assessment_digest, recomputed.assessment_digest);
    assert_eq!(budget(&f.engine, &f.session).await, (2, 0));
    let calls = f.calls();
    let command = f.command("repro");
    f.engine.shutdown().await.unwrap();
    drop(f.engine);
    fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let engine = Engine::open(
        f.dir.path().join("state.db"),
        Some(f.dir.path().join("docker")),
    )
    .unwrap();
    assert!(matches!(
        call(&engine, command).await,
        Reply::SourceReproduction {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(
        fs::read_to_string(f.dir.path().join("calls.jsonl"))
            .unwrap()
            .lines()
            .count(),
        calls
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn reproduction_attack_mismatch_is_completed_observation_and_control_failure_is_inconclusive()
{
    for control in [false, true] {
        let mut f = ReproFixture::new("echo").await;
        f.plan.cases[usize::from(control)].expected.stdout = b"different output".to_vec();
        match call(&f.engine, f.command("repro")).await {
            Reply::SourceReproduction {
                operation,
                result: Some(result),
                ..
            } => {
                let assessment = result.assessment.unwrap();
                assert_eq!(assessment.observed_attempts, 4);
                assert_eq!(
                    assessment.disposition,
                    if control {
                        Disposition::Inconclusive
                    } else {
                        Disposition::NotObserved
                    }
                );
                assert_eq!(
                    operation.status,
                    if control {
                        OperationStatus::Failed
                    } else {
                        OperationStatus::Succeeded
                    }
                );
            }
            r => panic!("{r:?}"),
        };
        f.engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn reproduction_rejects_cross_session_hypothesis_bundle_and_root_changes() {
    let f = ReproFixture::new("echo").await;
    for mutation in 0..4 {
        let mut cmd = f.command(&format!("bad-{mutation}"));
        if let Command::ReproduceSource {
            session_id,
            request,
            ..
        } = &mut cmd
        {
            match mutation {
                0 => *session_id = session(&f.engine, 100).await,
                1 => request.plan.hypothesis_id = "invented".into(),
                2 => request.plan.source_bundle_digest = format!("sha256:{}", "b".repeat(64)),
                _ => request.plan.snapshot.root = f.dir.path().display().to_string(),
            }
        }
        match call(&f.engine, cmd).await {
            Reply::SourceReproduction {
                operation,
                result: Some(result),
                ..
            } => {
                assert_eq!(operation.status, OperationStatus::Failed);
                assert!(!result.external_effects_started);
            }
            r => panic!("{r:?}"),
        };
    }
    assert_eq!(f.calls(), 0);
    f.engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn reproduction_plan_or_child_retention_failure_never_launches() {
    for name in ["reproduction.plan", "reproduction.request"] {
        let f = ReproFixture::new("echo").await;
        let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
        db.execute_batch(&format!("CREATE TRIGGER reject_repro BEFORE INSERT ON operation_artifacts WHEN NEW.name='{name}' BEGIN SELECT RAISE(ABORT,'injected retention failure'); END;")).unwrap();
        match tokio::time::timeout(Duration::from_secs(3), call(&f.engine, f.command("repro")))
            .await
            .unwrap()
        {
            Reply::SourceReproduction {
                operation,
                result: Some(result),
                ..
            } => {
                assert_eq!(operation.status, OperationStatus::Failed);
                assert!(!result.external_effects_started);
            }
            r => panic!("{r:?}"),
        };
        assert_eq!(f.calls(), 0);
        f.engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn reproduction_unknown_cleanup_stops_matrix_and_preserves_recovery() {
    let f = ReproFixture::new("cleanup-fail").await;
    let outcome = match call(&f.engine, f.command("repro")).await {
        Reply::SourceReproduction {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Unknown);
            assert_eq!(
                result.assessment.as_ref().unwrap().disposition,
                Disposition::Unknown
            );
            assert_eq!(result.children.len(), 1);
            result
        }
        r => panic!("{r:?}"),
    };
    let calls = f.calls();
    assert!(matches!(
        call(&f.engine, f.command("repro")).await,
        Reply::SourceReproduction {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(f.calls(), calls);
    let store = zero_store::Store::open(f.dir.path().join("state.db")).unwrap();
    let artifacts = store.operation_artifacts(&outcome.children[0]).unwrap();
    let item: zero_verification::Evidence =
        serde_json::from_slice(&store.artifact(&artifacts["reproduction.evidence"]).unwrap())
            .unwrap();
    if let zero_protocol::sandbox::SandboxCleanup::Unconfirmed {
        recovery:
            zero_protocol::sandbox::SandboxRecovery::Docker {
                snapshot_dir: Some(path),
                ..
            },
    } = item.result.cleanup
    {
        assert!(std::path::Path::new(&path).exists());
        fs::remove_dir_all(path).unwrap();
    } else {
        panic!("expected durable recovery")
    };
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn reproduction_cancel_before_first_attempt_keeps_empty_matrix_inconclusive() {
    let f = ReproFixture::new("echo").await;
    let (tx, rx) = mpsc::channel(1);
    drop(rx);
    match f.engine.handle(f.command("repro"), tx).await {
        Reply::SourceReproduction {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Cancelled);
            assert_eq!(
                result.assessment.unwrap().disposition,
                Disposition::Inconclusive
            );
            assert!(!result.external_effects_started);
            assert!(result.children.is_empty());
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(f.calls(), 0);
    f.engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn reproduction_cancel_active_child_waits_for_cleanup_and_stops_remaining_cases() {
    let f = ReproFixture::new("hang").await;
    let command = f.command("repro");
    let session = f.session.clone();
    let engine = Arc::new(f.engine);
    let owner = engine.clone();
    let (tx, mut rx) = mpsc::channel(64);
    let task = tokio::spawn(async move { owner.handle(command, tx).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if matches!(
                rx.recv().await,
                Some(zero_protocol::ExecutionEvent::Sandbox {
                    event: zero_protocol::sandbox::SandboxEvent::Output { .. }
                })
            ) {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        call(
            &engine,
            Command::Cancel {
                session_id: session,
                execution_id: "repro".into()
            }
        )
        .await,
        Reply::Cancelled { accepted: true, .. }
    ));
    match task.await.unwrap() {
        Reply::SourceReproduction {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Cancelled);
            assert_eq!(
                result.assessment.unwrap().disposition,
                Disposition::Cancelled
            );
            assert_eq!(result.children.len(), 1);
        }
        r => panic!("{r:?}"),
    };
    assert!(!f.dir.path().join("container.json").exists());
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn reproduction_rejects_source_outcome_artifact_substitution() {
    let f = ReproFixture::new("echo").await;
    let store = zero_store::Store::open(f.dir.path().join("state.db")).unwrap();
    let source = store.get_operation(&f.source).unwrap();
    let mut outcome = source.outcome.unwrap();
    outcome["artifacts"]["source.bundle"] = json!(format!("sha256:{}", "f".repeat(64)));
    rusqlite::Connection::open(f.dir.path().join("state.db"))
        .unwrap()
        .execute(
            "UPDATE operations SET outcome=?1 WHERE id=?2",
            rusqlite::params![outcome.to_string(), f.source],
        )
        .unwrap();
    match call(&f.engine, f.command("repro")).await {
        Reply::SourceReproduction {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Failed);
            assert!(!result.external_effects_started);
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(f.calls(), 0);
    f.engine.shutdown().await.unwrap();
}
