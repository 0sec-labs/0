#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Hosted binding fixtures use loopback HTTP only; no accounts or paid calls.
use serde_json::{Value, json};
use std::{
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
use zero_protocol::{
    Command, ExecutionEvent, Reply,
    model::{Rates, ResponsesRequest},
    session::{BudgetSnapshot, OperationStatus},
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
    async fn new() -> Self {
        Self::with_output(
            json!([{"type":"message","content":[{"type":"output_text","text":"fixture answer"}]}]),
        )
        .await
    }
    async fn with_output(output: Value) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/api/inference/v1/responses",
            listener.local_addr().unwrap()
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let stop = CancellationToken::new();
        let cancel = stop.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) =
                    tokio::select! {_=cancel.cancelled()=>break,r=listener.accept()=>r.unwrap()};
                let request = read_request(&mut socket).await;
                captured.lock().unwrap().push(request);
                let body = format!(
                    "data: {}\n\n",
                    json!({"type":"response.completed","response":{"id":"hosted-fixture","status":"completed","output":output,"usage":{"input_tokens":2,"output_tokens":1}}})
                );
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        Self {
            url,
            requests,
            stop,
            task,
        }
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
async fn read_request(socket: &mut TcpStream) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut data = Vec::new();
        loop {
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert_ne!(n, 0);
            data.extend_from_slice(&buf[..n]);
            assert!(data.len() < 1_000_000);
            if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                let length = String::from_utf8_lossy(&data[..end])
                    .lines()
                    .find_map(|line| {
                        let (k, v) = line.split_once(':')?;
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
async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, _rx) = mpsc::channel::<ExecutionEvent>(64);
    tokio::time::timeout(Duration::from_secs(12), engine.handle(command, tx))
        .await
        .unwrap()
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
async fn budget(engine: &Engine, id: &str) -> BudgetSnapshot {
    match call(
        engine,
        Command::SessionBudget {
            session_id: id.into(),
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => budget,
        r => panic!("{r:?}"),
    }
}
fn rates() -> Rates {
    Rates {
        input: 1_000_000,
        cached_input: 1_000_000,
        output: 1_000_000,
    }
}
fn request() -> ResponsesRequest {
    ResponsesRequest {
        model: "fixture".into(),
        instructions: "fixture".into(),
        input: vec![json!({"role":"user","content":"hello"})],
        tools: vec![],
        max_output_tokens: 32,
    }
}
fn pin(http: &Http, cap: u32, owner: &str) -> zero_protocol::model::HostedCatalogPin {
    let cloud = zero_cloud_client::CloudClient::new(
        http.url
            .strip_suffix("/api/inference/v1/responses")
            .unwrap(),
        "fixture-secret",
        Duration::from_secs(1),
        8192,
    )
    .unwrap();
    let catalog=serde_json::from_value(json!({"object":"list","data":[{"id":"fixture","object":"model","owned_by":owner,"provider":"fixture","upstream_model":"never-send-upstream","wire_api":"responses","context_length":20000,"max_output_tokens":cap,"pricing":{"input_per_million_usd":1,"output_per_million_usd":1,"cached_input_per_million_usd":1}}]})).unwrap();
    cloud
        .select_hosted_route(&catalog, "fixture")
        .unwrap()
        .provenance
}
fn client(pin: &zero_protocol::model::HostedCatalogPin) -> ProviderClient {
    ProviderClient::with_wire(
        Endpoint::responses(&pin.endpoint, Some("fixture-secret")).unwrap(),
        pin.wire_api,
        Duration::from_secs(3),
        65536,
    )
    .unwrap()
}
fn configure(engine: &Engine, pin: &zero_protocol::model::HostedCatalogPin) {
    engine
        .configure_hosted_provider(
            "hosted",
            client(pin).bind_hosted(pin.clone()).unwrap(),
            pin.rates,
            pin.clone(),
        )
        .unwrap();
}
fn infer(id: &str, command: &str, request: ResponsesRequest) -> Command {
    Command::Infer {
        session_id: id.into(),
        command_id: command.into(),
        provider: "hosted".into(),
        reservation: 10,
        request,
    }
}
fn agent(dir: &std::path::Path) -> zero_protocol::agent::AgentRequest {
    let source = dir.join("source");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("code.js"), "export const fixture = true;\n").unwrap();
    let execution = zero_protocol::ExecutionRequest {
        execution_id: "fixture".into(),
        image: "local:no-dispatch".into(),
        snapshot: zero_executor::pin_snapshot(&source).unwrap(),
        argv: vec!["true".into()],
        build_argv: None,
        stdin: None,
        timeout_ms: 1000,
        memory_mb: 128,
        cpus: 0.5,
        max_output_bytes: 2048,
    };
    zero_protocol::agent::AgentRequest {
        provider: "hosted".into(),
        context_policy: None,
        delegation_policy: None,
        operator_questions: false,
        tool_approval_policy: None,
        model: "fixture".into(),
        instructions: "fixture".into(),
        prompt: "hello".into(),
        execution: execution.into(),
        max_turns: 1,
        reservation_per_turn: 10,
        plugin_tools: vec![],
        continuation_of: None,
        source_review_operation_id: None,
        source_snapshot_tools: false,
        source_submission_max_hypotheses: None,
    }
}
#[tokio::test]
async fn bound_transport_rejects_model_limit_route_wire_and_invalid_pin_without_http() {
    let http = Http::new().await;
    let pin = pin(&http, 32, "cloud");
    let bound = client(&pin).bind_hosted(pin.clone()).unwrap();
    let mut wrong_model = request();
    wrong_model.model = "upstream".into();
    assert!(
        bound
            .complete(&wrong_model, CancellationToken::new())
            .await
            .is_err()
    );
    let mut req = request();
    req.max_output_tokens = 33;
    assert!(
        bound
            .complete(&req, CancellationToken::new())
            .await
            .is_err()
    );
    let wrong = ProviderClient::new(
        Endpoint::responses(&format!("{}wrong", pin.endpoint), None).unwrap(),
        Duration::from_secs(1),
        4096,
    )
    .unwrap();
    assert!(wrong.bind_hosted(pin.clone()).is_err());
    let wrong = ProviderClient::with_wire(
        Endpoint::responses(&pin.endpoint, None).unwrap(),
        zero_protocol::model::WireApi::ChatCompletions,
        Duration::from_secs(1),
        4096,
    )
    .unwrap();
    assert!(wrong.bind_hosted(pin.clone()).is_err());
    let mut invalid = pin.clone();
    invalid.catalog_model_sha256 = "0".repeat(64);
    assert!(client(&pin).bind_hosted(invalid).is_err());
    assert_eq!(http.count(), 0);
}
#[tokio::test]
async fn engine_requires_matching_explicit_bound_profile() {
    let http = Http::new().await;
    let pin = pin(&http, 8192, "cloud");
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path().join("state.db"), None).unwrap();
    assert!(
        engine
            .configure_hosted_provider("hosted", client(&pin), rates(), pin.clone())
            .is_err()
    );
    assert!(
        engine
            .configure_provider(
                "hosted",
                client(&pin).bind_hosted(pin.clone()).unwrap(),
                rates()
            )
            .is_err()
    );
    assert!(
        engine
            .configure_hosted_provider(
                "hosted",
                client(&pin).bind_hosted(pin.clone()).unwrap(),
                Rates {
                    input: 0,
                    ..rates()
                },
                pin.clone()
            )
            .is_err()
    );
    configure(&engine, &pin);
    engine.shutdown().await.unwrap();
    assert_eq!(http.count(), 0);
}
#[tokio::test]
async fn inference_pin_survives_restart_and_catalog_drift_cannot_retry() {
    let http = Http::new().await;
    let pin = pin(&http, 8192, "cloud");
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("state.db");
    let engine = Engine::open(&db, None).unwrap();
    configure(&engine, &pin);
    let id = session(&engine).await;
    match call(&engine, infer(&id, "once", request())).await {
        Reply::Inference {
            operation,
            duplicate: false,
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            assert_eq!(
                operation.payload["hosted_catalog"],
                serde_json::to_value(&pin).unwrap()
            );
        }
        r => panic!("{r:?}"),
    }
    assert_eq!(budget(&engine, &id).await.charged, 3);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = Engine::open(&db, None).unwrap();
    configure(&engine, &pin);
    assert!(matches!(
        call(&engine, infer(&id, "once", request())).await,
        Reply::Inference {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(budget(&engine, &id).await.charged, 3);
    engine.shutdown().await.unwrap();
    drop(engine);
    let changed = crate::pin(&http, 8192, "new-catalog-owner");
    let engine = Engine::open(&db, None).unwrap();
    configure(&engine, &changed);
    assert!(matches!(
        call(&engine, infer(&id, "once", request())).await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
    assert_eq!(http.requests.lock().unwrap()[0]["model"], "fixture");
}
#[tokio::test]
async fn agent_pin_binds_children_and_continuation_across_restart() {
    let http = Http::new().await;
    let pin = pin(&http, 8192, "cloud");
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("state.db");
    let request = agent(dir.path());
    let engine = Engine::open(&db, None).unwrap();
    configure(&engine, &pin);
    let id = session(&engine).await;
    let parent = match call(
        &engine,
        Command::RunAgent {
            session_id: id.clone(),
            command_id: "first".into(),
            request: request.clone(),
        },
    )
    .await
    {
        Reply::Agent { operation, .. } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            operation
        }
        r => panic!("{r:?}"),
    };
    let store = zero_store::Store::open_read_only(&db).unwrap();
    let child = store
        .get_operation_by_command(&id, &format!("{}:model:0", parent.id))
        .unwrap();
    assert_eq!(
        child.payload["hosted_catalog"],
        parent.payload["hosted_catalog"]
    );
    assert_eq!(
        parent.payload["hosted_catalog"],
        serde_json::to_value(&pin).unwrap()
    );
    drop(store);
    engine.shutdown().await.unwrap();
    drop(engine);
    let mut next = request.clone();
    next.continuation_of = Some(parent.id);
    next.prompt = "follow-up".into();
    let engine = Engine::open(&db, None).unwrap();
    configure(&engine, &crate::pin(&http, 8192, "changed"));
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: id.clone(),
                command_id: "next".into(),
                request: next.clone()
            }
        )
        .await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = Engine::open(&db, None).unwrap();
    configure(&engine, &pin);
    let command = Command::RunAgent {
        session_id: id.clone(),
        command_id: "next".into(),
        request: next,
    };
    assert!(
        matches!(call(&engine,command.clone()).await,Reply::Agent{operation,..} if operation.status==OperationStatus::Succeeded)
    );
    assert!(matches!(
        call(&engine, command).await,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(http.count(), 2);
    assert_eq!(budget(&engine, &id).await.charged, 6);
    let history = http.requests.lock().unwrap()[1]["input"].to_string();
    assert!(history.contains("fixture answer") && history.contains("follow-up"));
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn agent_and_source_policy_fail_before_admission_or_budget_or_source_copy() {
    let http = Http::new().await;
    let pin = pin(&http, 8191, "cloud");
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("state.db");
    let request = agent(dir.path());
    let snapshot = request.execution.sandbox_request().snapshot;
    std::fs::remove_dir_all(dir.path().join("source")).unwrap();
    let engine = Engine::open(&db, None).unwrap();
    configure(&engine, &pin);
    let id = session(&engine).await;
    let source = zero_protocol::source::SourceReviewRequest {
        provider: "hosted".into(),
        model: "fixture".into(),
        reservation: 10,
        source: zero_protocol::source::ReviewRequest {
            snapshot,
            selected_files: vec!["code.js".into()],
            question: "review".into(),
            max_hypotheses: 2,
        },
    };
    for command in [
        Command::RunAgent {
            session_id: id.clone(),
            command_id: "agent".into(),
            request,
        },
        Command::ReviewSource {
            session_id: id.clone(),
            command_id: "source".into(),
            request: source,
        },
    ] {
        assert!(matches!(call(&engine, command).await, Reply::Error { .. }));
    }
    let store = zero_store::Store::open_read_only(&db).unwrap();
    for command in ["agent", "source"] {
        assert!(matches!(
            store.get_operation_by_command(&id, command),
            Err(zero_store::Error::NotFound(_))
        ));
    }
    let budget = budget(&engine, &id).await;
    assert_eq!((budget.charged, budget.reserved), (0, 0));
    assert_eq!(http.count(), 0);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn source_records_catalog_and_readonly_export_rejects_child_pin_downgrade() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("state.db");
    let profile = agent(dir.path());
    let snapshot = profile.execution.sandbox_request().snapshot;
    let arguments=json!({"hypotheses":[{"title":"Unverified claim","claimed_severity":"low","explanation":"Review this value.","citations":[{"path":"code.js","sha256":snapshot.files[0].digest,"start_line":1,"end_line":1}]}]}).to_string();
    let http=Http::with_output(json!([{"type":"function_call","call_id":"submit","name":"submit_source_hypotheses","arguments":arguments}])).await;
    let pin = pin(&http, 8192, "cloud");
    let engine = Engine::open(&db, None).unwrap();
    configure(&engine, &pin);
    let id = session(&engine).await;
    let request = zero_protocol::source::SourceReviewRequest {
        provider: "hosted".into(),
        model: "fixture".into(),
        reservation: 10,
        source: zero_protocol::source::ReviewRequest {
            snapshot,
            selected_files: vec!["code.js".into()],
            question: "review".into(),
            max_hypotheses: 2,
        },
    };
    let command = Command::ReviewSource {
        session_id: id.clone(),
        command_id: "review".into(),
        request,
    };
    let (parent, child) = match call(&engine, command.clone()).await {
        Reply::SourceReview {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            (operation, result.inference_operation.unwrap())
        }
        r => panic!("{r:?}"),
    };
    let store = zero_store::Store::open_read_only(&db).unwrap();
    let mut child_payload = store.get_operation(&child).unwrap().payload;
    assert_eq!(
        child_payload["hosted_catalog"],
        serde_json::to_value(&pin).unwrap()
    );
    assert_eq!(
        parent.payload["hosted_catalog"],
        child_payload["hosted_catalog"]
    );
    drop(store);
    engine.shutdown().await.unwrap();
    drop(engine);
    std::fs::remove_dir_all(dir.path().join("source")).unwrap();
    let engine = Engine::open(&db, None).unwrap();
    configure(&engine, &pin);
    assert!(matches!(
        call(&engine, command).await,
        Reply::SourceReview {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
    drop(engine);
    assert_eq!(
        zero_engine::read_source_report(&db, &id, &parent.id)
            .unwrap()
            .review
            .hypotheses
            .len(),
        1
    );
    // A storage-corruption fixture removes only the captured child authority.
    // Export must reject it even though review/completion attachment hashes match.
    child_payload
        .as_object_mut()
        .unwrap()
        .remove("hosted_catalog");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute(
        "UPDATE operations SET payload=?1 WHERE id=?2",
        rusqlite::params![child_payload.to_string(), child],
    )
    .unwrap();
    drop(conn);
    assert!(zero_engine::read_source_report(&db, &id, &parent.id).is_err());
}
