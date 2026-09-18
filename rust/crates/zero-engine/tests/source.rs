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
            let exported = zero_engine::read_source_workflow_report(
                &f.dir.path().join("state.db"),
                &f.session,
                &f.source,
                &[operation.id.clone()],
                &[],
            )
            .unwrap();
            assert_eq!(exported.reproductions[0].operation_status, operation.status);
            assert_eq!(
                serde_json::to_value(&exported.reproductions[0].assessment).unwrap(),
                serde_json::to_value(result.assessment.as_ref().unwrap()).unwrap()
            );
            assert!(
                !serde_json::to_string(&exported)
                    .unwrap()
                    .contains(f.dir.path().to_str().unwrap())
            );
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
            let exported = zero_engine::read_source_workflow_report(
                &f.dir.path().join("state.db"),
                &f.session,
                &f.source,
                &[operation.id.clone()],
                &[],
            )
            .unwrap();
            assert_eq!(exported.reproductions[0].operation_status, operation.status);
            assert_eq!(
                serde_json::to_value(&exported.reproductions[0].assessment).unwrap(),
                serde_json::to_value(result.assessment.as_ref().unwrap()).unwrap()
            );
            assert!(
                !serde_json::to_string(&exported)
                    .unwrap()
                    .contains(f.dir.path().to_str().unwrap())
            );
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
            let exported = zero_engine::read_source_workflow_report(
                &f.dir.path().join("state.db"),
                &f.session,
                &f.source,
                &[operation.id.clone()],
                &[],
            )
            .unwrap();
            assert_eq!(exported.reproductions[0].operation_status, operation.status);
            assert_eq!(
                serde_json::to_value(&exported.reproductions[0].assessment).unwrap(),
                serde_json::to_value(result.assessment.as_ref().unwrap()).unwrap()
            );
            assert!(
                !serde_json::to_string(&exported)
                    .unwrap()
                    .contains(f.dir.path().to_str().unwrap())
            );
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

use zero_protocol::repair::{MaterializeRequest, RepairValidationRequest, RepairValidationStatus};
async fn repair_fixture() -> (ReproFixture, RepairValidationRequest) {
    let mut f = ReproFixture::new("echo").await;
    f.plan.cases[0].safe_expected = Some(ExactOutput {
        exit_code: 0,
        stdout: b"safe-output\n".to_vec(),
        stderr: b"fixture diagnostic\n".to_vec(),
    });
    let path = f.dir.path().join("docker");
    let fake=fs::read_to_string(&path).unwrap()
        .replace("state.write_text(json.dumps({\"name\": name, \"id\": container_id}))","state.write_text(json.dumps({\"name\": name, \"id\": container_id}))\n    mount = args[args.index('--mount')+1]\n    source = pathlib.Path(mount.split('src=')[1].split(',')[0])\n    (root / 'candidate-source.txt').write_text((source / 'app.js').read_text())")
        .replace("sys.stdout.buffer.write(sys.stdin.buffer.read())","data = sys.stdin.buffer.read()\n        code = (root / 'candidate-source.txt').read_text()\n        if b'attack-output' in data and 'SAFE_REPLACEMENT' in code: data = b'safe-output\\n'\n        if b'legitimate-output' in data and 'BAD_CONTROL' in code: data = b'wrong-control\\n'\n        sys.stdout.buffer.write(data)");
    fs::write(&path, fake).unwrap();
    let repro = match call(&f.engine, f.command("baseline")).await {
        Reply::SourceReproduction {
            operation,
            result: Some(r),
            ..
        } => {
            assert_eq!(
                r.assessment.unwrap().disposition,
                Disposition::ObservedForPlan
            );
            operation.id
        }
        r => panic!("{r:?}"),
    };
    let request = RepairValidationRequest {
        reproduction_operation_id: repro,
        materialize: MaterializeRequest {
            baseline: f.plan.snapshot.clone(),
            target: "app.js".into(),
            allowed_paths: vec!["app.js".into()],
            protected_paths: vec!["tests".into()],
            expected_preimage_sha256: f.plan.snapshot.files[0].digest.clone(),
            replacement: "// SAFE_REPLACEMENT\n".into(),
        },
    };
    (f, request)
}
fn repair_command(f: &ReproFixture, id: &str, request: RepairValidationRequest) -> Command {
    Command::ValidateSourceRepair {
        session_id: f.session.clone(),
        command_id: id.into(),
        request,
    }
}
#[tokio::test]
async fn repair_validates_two_fresh_copies_and_retry_never_reapplies_or_runs() {
    let (f, request) = repair_fixture().await;
    let original = fs::read(f.dir.path().join("source/app.js")).unwrap();
    let command = repair_command(&f, "repair", request.clone());
    let result = match call(&f.engine, command).await {
        Reply::SourceRepair {
            operation,
            result: Some(r),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded, "{r:?}");
            r
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(
        result.status,
        RepairValidationStatus::ValidatedCandidateForPlan
    );
    assert!(!result.vulnerability_reportable);
    assert_eq!(result.phases.len(), 2);
    assert!(result.cleanup_recovery.is_empty());
    assert_ne!(
        result.phases[0].derived_plan_digest,
        result.phases[1].derived_plan_digest
    );
    let store = zero_store::Store::open(f.dir.path().join("state.db")).unwrap();
    for phase in &result.phases {
        assert_eq!(phase.observations.children.len(), 4);
        assert_eq!(
            phase.observations.assessment.as_ref().unwrap().disposition,
            Disposition::ObservedForPlan
        );
        let plan: Plan = serde_json::from_slice(
            &store
                .artifact(&phase.observations.artifacts[&format!("{}.plan", phase.name)])
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            plan.snapshot.digest,
            result
                .candidate_receipt
                .as_ref()
                .unwrap()
                .candidate_snapshot_sha256
        );
        assert!(!std::path::Path::new(&plan.snapshot.root).exists());
        assert_eq!(
            plan.cases[0].expected,
            f.plan.cases[0].safe_expected.clone().unwrap()
        );
        assert_eq!(plan.cases[1].expected, f.plan.cases[1].expected);
    }
    assert_eq!(
        fs::read(f.dir.path().join("source/app.js")).unwrap(),
        original
    );
    assert_eq!(budget(&f.engine, &f.session).await, (2, 0));
    let calls = f.calls();
    let session = f.session.clone();
    let dir = f.dir;
    f.engine.shutdown().await.unwrap();
    drop(f.engine);
    fs::remove_dir_all(dir.path().join("source")).unwrap();
    let engine =
        Engine::open(dir.path().join("state.db"), Some(dir.path().join("docker"))).unwrap();
    match call(
        &engine,
        Command::ValidateSourceRepair {
            session_id: session,
            command_id: "repair".into(),
            request,
        },
    )
    .await
    {
        Reply::SourceRepair {
            duplicate: true,
            result: Some(r),
            ..
        } => assert_eq!(r.status, RepairValidationStatus::ValidatedCandidateForPlan),
        r => panic!("{r:?}"),
    }
    assert_eq!(
        fs::read_to_string(dir.path().join("calls.jsonl"))
            .unwrap()
            .lines()
            .count(),
        calls
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn repair_rejects_wrong_expectations_protected_paths_and_preimages() {
    let (f, request) = repair_fixture().await;
    for kind in ["protected", "preimage", "baseline"] {
        let mut bad = request.clone();
        match kind {
            "protected" => bad.materialize.protected_paths.push("app.js".into()),
            "preimage" => {
                bad.materialize.expected_preimage_sha256 = format!("sha256:{}", "b".repeat(64))
            }
            _ => bad.materialize.baseline.root = "/another/root".into(),
        };
        let before = f.calls();
        let reply = call(
            &f.engine,
            repair_command(&f, &format!("repair-{kind}"), bad),
        )
        .await;
        assert!(
            matches!(
                reply,
                Reply::SourceRepair {
                    operation: zero_protocol::Operation {
                        status: OperationStatus::Failed,
                        ..
                    },
                    ..
                }
            ),
            "{kind}: {reply:?}"
        );
        assert_eq!(f.calls(), before);
    }
    for (id, replacement) in [
        ("no-change", "// unchanged\n"),
        ("control", "// SAFE_REPLACEMENT BAD_CONTROL\n"),
    ] {
        let mut bad = request.clone();
        bad.materialize.replacement = replacement.into();
        match call(&f.engine, repair_command(&f, id, bad)).await {
            Reply::SourceRepair {
                operation,
                result: Some(r),
                ..
            } => {
                assert_eq!(operation.status, OperationStatus::Failed);
                assert_eq!(r.status, RepairValidationStatus::NotValidated);
                assert_eq!(r.phases.len(), 1);
            }
            r => panic!("{r:?}"),
        }
    }
    f.engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn repair_unknown_cleanup_retains_private_copy_and_stops_reconstruction() {
    let (f, request) = repair_fixture().await;
    let baseline_id = request.reproduction_operation_id.clone();
    fs::write(f.dir.path().join("scenario.txt"), "cleanup-fail").unwrap();
    match call(&f.engine, repair_command(&f, "unknown", request)).await {
        Reply::SourceRepair {
            operation,
            result: Some(r),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Unknown);
            assert_eq!(r.status, RepairValidationStatus::Unknown);
            assert_eq!(r.phases.len(), 1);
            assert_eq!(r.phases[0].observations.children.len(), 1);
            assert_eq!(r.cleanup_recovery.len(), 1);
            let exported = zero_engine::read_source_workflow_report(
                &f.dir.path().join("state.db"),
                &f.session,
                &f.source,
                &[baseline_id],
                &[operation.id],
            )
            .unwrap();
            assert_eq!(exported.repairs[0].status, RepairValidationStatus::Unknown);
            assert_eq!(exported.repairs[0].cleanup_recovery_count, 1);
            assert!(
                !serde_json::to_string(&exported)
                    .unwrap()
                    .contains(f.dir.path().to_str().unwrap())
            );
            assert!(std::path::Path::new(&r.cleanup_recovery[0]).exists());
            // Only the process fixture is used; test may remove its retained private copy.
            fs::remove_dir_all(&r.cleanup_recovery[0]).unwrap();
        }
        r => panic!("{r:?}"),
    }
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn repair_cancel_before_work_does_not_materialize_or_execute() {
    let (f, request) = repair_fixture().await;
    let baseline_id = request.reproduction_operation_id.clone();
    let before = f.calls();
    let (tx, rx) = mpsc::channel(1);
    drop(rx);
    match f
        .engine
        .handle(repair_command(&f, "cancel-repair", request), tx)
        .await
    {
        Reply::SourceRepair {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Cancelled);
            assert_eq!(result.status, RepairValidationStatus::Cancelled);
            assert!(result.phases.is_empty());
            assert!(result.candidate_receipt.is_none());
            assert!(
                zero_engine::read_source_workflow_report(
                    &f.dir.path().join("state.db"),
                    &f.session,
                    &f.source,
                    &[baseline_id],
                    &[operation.id]
                )
                .is_err()
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(before, f.calls());
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn repair_receipt_retention_failure_prevents_execution() {
    let (f, request) = repair_fixture().await;
    let before = f.calls();
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_repair BEFORE INSERT ON operation_artifacts WHEN NEW.name='repair.candidate.receipt' BEGIN SELECT RAISE(ABORT,'injected retention failure'); END;").unwrap();
    match call(&f.engine, repair_command(&f, "receipt-failure", request)).await {
        Reply::SourceRepair {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Failed);
            assert!(result.phases.is_empty());
            assert!(result.cleanup_recovery.is_empty());
            assert!(result.error.is_some());
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(before, f.calls());
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn repair_rejects_corrupt_retained_baseline_evidence_before_execution() {
    let (f, request) = repair_fixture().await;
    let before = f.calls();
    let store = zero_store::Store::open(f.dir.path().join("state.db")).unwrap();
    let artifacts = store
        .operation_artifacts(&request.reproduction_operation_id)
        .unwrap();
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    db.execute(
        "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
        rusqlite::params![b"{}".as_slice(), artifacts["reproduction.evidence_index"]],
    )
    .unwrap();
    match call(&f.engine, repair_command(&f, "corrupt-baseline", request)).await {
        Reply::SourceRepair {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Failed);
            assert!(result.phases.is_empty());
            assert!(result.candidate_receipt.is_none());
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(before, f.calls());
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn linked_reproduction_report_rechecks_child_journal_and_exact_selection() {
    let f = ReproFixture::new("echo").await;
    let (id, outcome) = match call(&f.engine, f.command("report-repro")).await {
        Reply::SourceReproduction {
            operation,
            result: Some(outcome),
            ..
        } => (operation.id, outcome),
        other => panic!("{other:?}"),
    };
    let state = f.dir.path().join("state.db");
    let ids = vec![id.clone()];
    let report =
        || zero_engine::read_source_workflow_report(&state, &f.session, &f.source, &ids, &[]);
    let before = f.calls();
    fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    assert_eq!(
        report().unwrap().reproductions[0].assessment.disposition,
        Disposition::ObservedForPlan
    );
    let db = rusqlite::Connection::open(&state).unwrap();
    let child = &outcome.children[0];
    for (operation, column, key, replacement) in [
        (
            child.as_str(),
            "payload",
            "parent_operation",
            serde_json::json!("wrong"),
        ),
        (
            child.as_str(),
            "payload",
            "kind",
            serde_json::json!("other"),
        ),
        (
            child.as_str(),
            "payload",
            "plan_digest",
            serde_json::json!("wrong"),
        ),
        (
            child.as_str(),
            "payload",
            "case_id",
            serde_json::json!("control"),
        ),
        (child.as_str(), "payload", "repeat", serde_json::json!(99)),
        (
            child.as_str(),
            "payload",
            "execution_id",
            serde_json::json!("other"),
        ),
        (
            child.as_str(),
            "outcome",
            "exit_code",
            serde_json::json!(99),
        ),
        (
            child.as_str(),
            "outcome",
            "request_artifact",
            serde_json::json!("wrong"),
        ),
        (
            child.as_str(),
            "outcome",
            "evidence_artifact",
            serde_json::json!("wrong"),
        ),
        (id.as_str(), "outcome", "children", serde_json::json!([])),
        (
            id.as_str(),
            "outcome",
            "error",
            serde_json::json!("retained failure"),
        ),
    ] {
        let raw: String = db
            .query_row(
                &format!("SELECT {column} FROM operations WHERE id=?1"),
                [operation],
                |r| r.get(0),
            )
            .unwrap();
        let mut modified: serde_json::Value = serde_json::from_str(&raw).unwrap();
        modified[key] = replacement;
        db.execute(
            &format!("UPDATE operations SET {column}=?1 WHERE id=?2"),
            rusqlite::params![modified.to_string(), operation],
        )
        .unwrap();
        assert!(report().is_err(), "accepted corrupted {column}.{key}");
        db.execute(
            &format!("UPDATE operations SET {column}=?1 WHERE id=?2"),
            rusqlite::params![raw, operation],
        )
        .unwrap();
    }
    db.execute(
        "UPDATE operations SET status='running' WHERE id=?1",
        [child],
    )
    .unwrap();
    assert!(report().is_err());
    db.execute(
        "UPDATE operations SET status='succeeded' WHERE id=?1",
        [child],
    )
    .unwrap();
    assert!(report().is_ok());
    for selection in [
        vec![id.clone(), id.clone()],
        vec![f.source.clone()],
        vec![id.clone(); 33],
    ] {
        assert!(
            zero_engine::read_source_workflow_report(
                &state,
                &f.session,
                &f.source,
                &selection,
                &[]
            )
            .is_err()
        );
    }
    assert!(
        zero_engine::read_source_workflow_report(&state, "other-session", &f.source, &ids, &[])
            .is_err()
    );
    assert_eq!(before, f.calls());
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn linked_repair_report_rechecks_candidate_evidence_and_requires_explicit_baseline() {
    let (f, request) = repair_fixture().await;
    let baseline = request.reproduction_operation_id.clone();
    let (id, outcome) = match call(&f.engine, repair_command(&f, "report-repair", request)).await {
        Reply::SourceRepair {
            operation,
            result: Some(outcome),
            ..
        } => (operation.id, outcome),
        other => panic!("{other:?}"),
    };
    let state = f.dir.path().join("state.db");
    let report = || {
        zero_engine::read_source_workflow_report(
            &state,
            &f.session,
            &f.source,
            &[baseline.clone()],
            &[id.clone()],
        )
    };
    let before = f.calls();
    fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let exported = report().unwrap();
    assert_eq!(
        exported.repairs[0].status,
        RepairValidationStatus::ValidatedCandidateForPlan
    );
    assert_eq!(exported.repairs[0].phases.len(), 2);
    assert!(
        zero_engine::read_source_workflow_report(&state, &f.session, &f.source, &[], &[id.clone()])
            .is_err()
    );
    let db = rusqlite::Connection::open(&state).unwrap();
    for (operation, column, key, replacement) in [
        (
            id.as_str(),
            "payload",
            "request_digest",
            serde_json::json!("wrong"),
        ),
        (
            id.as_str(),
            "payload",
            "reproduction_operation_id",
            serde_json::json!("other"),
        ),
        (
            id.as_str(),
            "outcome",
            "original_plan_digest",
            serde_json::json!("wrong"),
        ),
        (
            id.as_str(),
            "outcome",
            "vulnerability_reportable",
            serde_json::json!(true),
        ),
        (
            id.as_str(),
            "outcome",
            "cleanup_recovery",
            serde_json::json!(["/not-cleaned"]),
        ),
        (
            outcome.phases[1].observations.children[0].as_str(),
            "outcome",
            "exit_code",
            serde_json::json!(99),
        ),
    ] {
        let raw: String = db
            .query_row(
                &format!("SELECT {column} FROM operations WHERE id=?1"),
                [operation],
                |r| r.get(0),
            )
            .unwrap();
        let mut modified: serde_json::Value = serde_json::from_str(&raw).unwrap();
        modified[key] = replacement;
        db.execute(
            &format!("UPDATE operations SET {column}=?1 WHERE id=?2"),
            rusqlite::params![modified.to_string(), operation],
        )
        .unwrap();
        assert!(report().is_err(), "accepted corrupted {column}.{key}");
        db.execute(
            &format!("UPDATE operations SET {column}=?1 WHERE id=?2"),
            rusqlite::params![raw, operation],
        )
        .unwrap();
    }
    assert!(report().is_ok());
    assert_eq!(before, f.calls());
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn linked_repair_report_preserves_unsuccessful_candidate_and_control_outcomes() {
    for (replacement, disposition) in [
        ("// unchanged candidate\n", Disposition::NotObserved),
        (
            "// SAFE_REPLACEMENT BAD_CONTROL\n",
            Disposition::Inconclusive,
        ),
    ] {
        let (f, mut request) = repair_fixture().await;
        request.materialize.replacement = replacement.into();
        let baseline = request.reproduction_operation_id.clone();
        let operation = match call(
            &f.engine,
            repair_command(&f, "failed-candidate-report", request),
        )
        .await
        {
            Reply::SourceRepair {
                operation,
                result: Some(result),
                ..
            } => {
                assert_eq!(result.status, RepairValidationStatus::NotValidated);
                operation
            }
            other => panic!("{other:?}"),
        };
        let before = f.calls();
        fs::remove_dir_all(f.dir.path().join("source")).unwrap();
        let report = zero_engine::read_source_workflow_report(
            &f.dir.path().join("state.db"),
            &f.session,
            &f.source,
            &[baseline],
            &[operation.id],
        )
        .unwrap();
        assert_eq!(
            report.repairs[0].status,
            RepairValidationStatus::NotValidated
        );
        assert_eq!(report.repairs[0].phases.len(), 1);
        assert_eq!(
            report.repairs[0].phases[0].assessment.disposition,
            disposition
        );
        assert_eq!(before, f.calls());
        f.engine.shutdown().await.unwrap();
    }
}
