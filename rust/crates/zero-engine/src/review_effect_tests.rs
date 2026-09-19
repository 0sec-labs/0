#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Actual actor/provider/source integration under an atomically admitted review.
use super::*;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
use zero_protocol::{
    agent::AgentStatus,
    model::Rates,
    review::{ReviewCloseReason, ReviewProfile},
};
use zero_provider::{Endpoint, ProviderClient};

struct Provider {
    endpoint: String,
    requests: mpsc::Receiver<(TcpStream, Value)>,
    task: JoinHandle<()>,
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Provider {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/responses", listener.local_addr().unwrap());
        let (tx, requests) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                if tx.send((socket, request)).await.is_err() {
                    break;
                }
            }
        });
        Self {
            endpoint,
            requests,
            task,
        }
    }
    async fn next(&mut self) -> (TcpStream, Value) {
        tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
            .await
            .unwrap()
            .unwrap()
    }
    fn assert_no_more_requests(&mut self) {
        assert!(matches!(
            self.requests.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
}
async fn read_request(socket: &mut TcpStream) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            assert!(bytes.len() <= 1024 * 1024);
            if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                let length = String::from_utf8_lossy(&bytes[..end])
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    return serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                }
            }
        }
    })
    .await
    .unwrap()
}
async fn respond(mut socket: TcpStream, call: &str, name: &str, arguments: Value) {
    let body = format!(
        "data: {}\n\n",
        json!({"type":"response.completed","response":{"id":format!("response-{call}"),"status":"completed","output":[{"type":"function_call","call_id":call,"name":name,"arguments":arguments.to_string()}],"usage":{"input_tokens":1,"output_tokens":1}}})
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
fn output(request: &Value, call: &str) -> Value {
    let item = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == call)
        .unwrap();
    serde_json::from_str(item["output"].as_str().unwrap()).unwrap()
}

struct Fixture {
    dir: tempfile::TempDir,
    engine: Engine,
    provider: Provider,
    admission: zero_store::ReviewAdmission,
    actor: Option<agent::PreparedActor>,
}
impl Fixture {
    async fn new(deadline_ms: u64) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("app.rs"),
            "pub fn greeting() -> &'static str {\n    \"retained review source\"\n}\n",
        )
        .unwrap();
        let snapshot = zero_executor::pin_snapshot(&source).unwrap();
        let provider = Provider::new().await;
        // No tool in these tests launches a sandbox. A nonexistent configured
        // binary turns an accidental backend invocation into an explicit failure.
        let engine = Engine::open(
            dir.path().join("state.db"),
            Some(dir.path().join("no-backend")),
        )
        .unwrap();
        let rates = Rates {
            input: 1_000_000,
            cached_input: 1_000_000,
            output: 1_000_000,
        };
        engine
            .configure_provider(
                "local",
                ProviderClient::new(
                    Endpoint::responses(&provider.endpoint, None).unwrap(),
                    Duration::from_secs(10),
                    65536,
                )
                .unwrap(),
                rates,
            )
            .unwrap();
        let profile: ReviewProfile = serde_json::from_value(json!({"schema_version":1,"provider":"local","model":"fixture","instructions":"Review only the pinned source; use exact citations.","question":"Inspect greeting output","execution":{"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"budget_limit":100,"currency":"units","reservation_per_turn":10,"max_turns":4,"max_hypotheses":2,"deadline_ms":deadline_ms})).unwrap();
        let review_id = uuid::Uuid::new_v4().to_string();
        let session_id = uuid::Uuid::new_v4().to_string();
        let root_operation_id = uuid::Uuid::new_v4().to_string();
        let request = profile
            .request(snapshot.clone(), &root_operation_id)
            .unwrap();
        let configured = lock(&engine.shared.providers).unwrap()["local"].clone();
        let context = serde_json::from_value(json!({"endpoint":configured.client.endpoint_identity(),"wire_api":"responses","rates":configured.rates})).unwrap();
        let (mut root_payload, actor) = agent::prepare_actor(
            &engine.shared,
            &lock(&engine.shared.store).unwrap(),
            &session_id,
            &format!("review:{review_id}:root"),
            request,
            configured,
            None,
            false,
        )
        .unwrap();
        root_payload["review_template"] = serde_json::to_value(&actor.template).unwrap();
        let admission = zero_store::ReviewAdmission {
            workspace_selection: None,
            review_id,
            session_id,
            root_operation_id,
            controller_operation_id: uuid::Uuid::new_v4().to_string(),
            input_path: source.to_string_lossy().into_owned(),
            canonical_path: snapshot.root.clone(),
            profile_name: "fixture".into(),
            profile,
            snapshot,
            root_payload,
            provider_context: BTreeMap::from([("local".into(), context)]),
        };
        lock(&engine.shared.store)
            .unwrap()
            .admit_review("review-command", &engine.shared.owner, &admission)
            .unwrap();
        Self {
            dir,
            engine,
            provider,
            admission,
            actor: Some(actor),
        }
    }
    fn start(&mut self) -> JoinHandle<Result<Reply, EngineError>> {
        let shared = Arc::clone(&self.engine.shared);
        let session = self.admission.session_id.clone();
        let root = self.admission.root_operation_id.clone();
        let actor = self.actor.take().unwrap();
        let cancel = CancellationToken::new();
        let command = lock(&shared.store)
            .unwrap()
            .get_operation(&root)
            .unwrap()
            .command_id;
        lock(&shared.control).unwrap().active.insert(
            session.clone(),
            Active {
                command_id: command.clone(),
                execution_id: command,
                cancel: cancel.clone(),
            },
        );
        let mut guard = WorkerGuard::new(shared, &session, &root, cancel.clone());
        tokio::spawn(async move {
            let (tx, mut rx) = mpsc::channel(128);
            let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
            let result =
                agent::run_actor(&guard.shared, &session, &root, actor, cancel, tx, None).await;
            drain.await.unwrap();
            guard.settled = result.is_ok();
            drop(guard);
            result
        })
    }
    fn close(&self, reason: ReviewCloseReason) {
        assert!(
            lock(&self.engine.shared.store)
                .unwrap()
                .request_review_stop(&self.admission.review_id, &self.engine.shared.owner, reason)
                .unwrap()
        );
    }
    fn events(&self) -> Vec<zero_protocol::SessionEvent> {
        lock(&self.engine.shared.store)
            .unwrap()
            .events(&self.admission.session_id, 0, 1000)
            .unwrap()
    }
    fn unchanged_source(&self) {
        let after = zero_executor::pin_snapshot(Path::new(&self.admission.snapshot.root)).unwrap();
        assert_eq!(after.digest, self.admission.snapshot.digest);
        assert_eq!(
            serde_json::to_value(after.files).unwrap(),
            serde_json::to_value(&self.admission.snapshot.files).unwrap()
        );
    }
}
async fn finish(
    task: JoinHandle<Result<Reply, EngineError>>,
) -> (zero_protocol::Operation, zero_protocol::agent::AgentResult) {
    match tokio::time::timeout(Duration::from_secs(8), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        Reply::Agent {
            operation,
            result,
            duplicate: false,
        } => (operation, result.unwrap()),
        reply => panic!("unexpected actor reply {reply:?}"),
    }
}

#[tokio::test]
async fn review_actor_search_read_and_submission_have_pre_result_effect_witnesses() {
    let mut f = Fixture::new(60_000).await;
    let task = f.start();
    let (socket, first) = f.provider.next().await;
    assert!(
        first["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "search_source_text")
    );
    respond(
        socket,
        "search",
        "search_source_text",
        json!({"query":"retained review","max_results":10}),
    )
    .await;
    let (socket, second) = f.provider.next().await;
    assert!(output(&second, "search").to_string().contains("app.rs"));
    respond(
        socket,
        "read",
        "read_source_lines",
        json!({"path":"app.rs","start_line":1,"end_line":3}),
    )
    .await;
    let (socket, third) = f.provider.next().await;
    assert!(
        output(&third, "read")
            .to_string()
            .contains("retained review source")
    );
    let events = f.events();
    let preparation = events
        .iter()
        .find(|event| {
            event.kind == "operation_detail"
                && event.payload["kind"] == "review_source_preparation_started"
        })
        .unwrap();
    let catalog = events
        .iter()
        .find(|event| {
            event.kind == "operation_detail" && event.payload["kind"] == "source.snapshot_prepared"
        })
        .unwrap();
    assert!(preparation.sequence < catalog.sequence);
    assert_eq!(
        preparation.payload["operation_id"],
        f.admission.root_operation_id
    );
    assert_eq!(
        preparation.payload["details"]["snapshot_sha256"],
        f.admission.snapshot.digest
    );
    let reads: Vec<_> = events
        .iter()
        .filter(|event| {
            event.kind == "command_admitted"
                && event.payload["payload"]["kind"] == "agent_source_tool"
        })
        .collect();
    assert_eq!(reads.len(), 2);
    for admitted in reads {
        let id = admitted.payload["id"].as_str().unwrap();
        let effect = events
            .iter()
            .find(|event| {
                event.kind == "operation_detail"
                    && event.payload["operation_id"] == id
                    && event.payload["kind"] == "review_effect_started"
            })
            .unwrap();
        let settled = events
            .iter()
            .find(|event| event.kind == "operation_settled" && event.payload["id"] == id)
            .unwrap();
        assert!(admitted.sequence < effect.sequence && effect.sequence < settled.sequence);
        assert_eq!(
            effect.payload["details"]["review_id"],
            f.admission.review_id
        );
        assert_eq!(effect.payload["details"]["owner"], f.engine.shared.owner);
        assert_eq!(
            effect.payload["details"]["payload_sha256"],
            effect.payload["details"]["request_sha256"]
        );
        let store = lock(&f.engine.shared.store).unwrap();
        let operation = store.get_operation(id).unwrap();
        assert_eq!(operation.status, OperationStatus::Succeeded);
        assert!(
            store
                .operation_artifacts(id)
                .unwrap()
                .contains_key("source.tool_result")
        );
    }
    let digest = &f.admission.snapshot.files[0].digest;
    respond(socket,"submit","submit_source_hypotheses",json!({"selected_files":["app.rs"],"hypotheses":[{"title":"Greeting is printed","claimed_severity":"low","explanation":"The pinned source contains a greeting string.","citations":[{"path":"app.rs","sha256":digest,"start_line":1,"end_line":3}]}]})).await;
    let (operation, result) = finish(task).await;
    assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
    assert_eq!(result.status, AgentStatus::Completed);
    assert_eq!(
        result
            .source_review
            .unwrap()
            .review
            .unwrap()
            .hypotheses
            .len(),
        1
    );
    assert_eq!(
        lock(&f.engine.shared.store)
            .unwrap()
            .budget(&f.admission.session_id)
            .unwrap()
            .reserved,
        0
    );
    f.provider.assert_no_more_requests();
    f.unchanged_source();
    assert!(!f.dir.path().join("no-backend").exists());
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn closed_or_expired_review_denies_source_effects_returned_by_inflight_model() {
    for reason in [ReviewCloseReason::Cancelled, ReviewCloseReason::Deadline] {
        let mut f = Fixture::new(if reason == ReviewCloseReason::Deadline {
            1000
        } else {
            60_000
        })
        .await;
        let task = f.start();
        let (socket, _) = f.provider.next().await;
        if reason == ReviewCloseReason::Deadline {
            let deadline = lock(&f.engine.shared.store)
                .unwrap()
                .review_snapshot(&f.admission.review_id)
                .unwrap()
                .review
                .deadline_at_ms;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            tokio::time::sleep(Duration::from_millis(deadline.saturating_sub(now) + 5)).await;
        }
        f.close(reason);
        respond(
            socket,
            "late-read",
            "read_source_lines",
            json!({"path":"app.rs","start_line":1,"end_line":3}),
        )
        .await;
        let (_, result) = finish(task).await;
        assert_ne!(result.status, AgentStatus::Completed);
        assert!(result.source_review.is_none());
        let events = f.events();
        assert!(!events.iter().any(|event| event.kind == "command_admitted"
            && event.payload["payload"]["kind"] == "agent_source_tool"));
        assert!(!events.iter().any(|event| event.kind == "operation_detail"
            && event.payload["kind"] == "review_effect_started"));
        assert_eq!(
            lock(&f.engine.shared.store)
                .unwrap()
                .budget(&f.admission.session_id)
                .unwrap()
                .charged,
            2
        );
        f.provider.assert_no_more_requests();
        f.unchanged_source();
        f.engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn closed_review_never_starts_provider_or_source_tool() {
    let mut f = Fixture::new(60_000).await;
    f.close(ReviewCloseReason::Cancelled);
    let task = f.start();
    let (_, result) = finish(task).await;
    assert_ne!(result.status, AgentStatus::Completed);
    f.provider.assert_no_more_requests();
    assert!(
        !f.events()
            .iter()
            .any(|event| event.kind == "operation_detail"
                && matches!(
                    event.payload["kind"].as_str(),
                    Some(
                        "review_source_preparation_started"
                            | "source.snapshot_prepared"
                            | "review_effect_started"
                    )
                ))
    );
    assert!(
        !f.events()
            .iter()
            .any(|event| event.kind == "command_admitted"
                && event.payload["payload"]["kind"] == "agent_inference")
    );
    assert_eq!(
        lock(&f.engine.shared.store)
            .unwrap()
            .budget(&f.admission.session_id)
            .unwrap()
            .reserved,
        0
    );
    f.unchanged_source();
    f.engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn generic_cancel_and_shutdown_close_review_and_preserve_inflight_hold() {
    for shutdown in [false, true] {
        let mut f = Fixture::new(60_000).await;
        let task = f.start();
        // Retain the accepted socket without sending a response: cancellation
        // cannot establish provider usage or refund the outstanding reservation.
        let (socket, _) = f.provider.next().await;
        assert_eq!(f.engine.shared.workers.count.load(Ordering::Acquire), 1);
        if shutdown {
            tokio::time::timeout(Duration::from_secs(5), f.engine.shutdown())
                .await
                .unwrap()
                .unwrap();
        } else {
            let command = lock(&f.engine.shared.store)
                .unwrap()
                .get_operation(&f.admission.root_operation_id)
                .unwrap()
                .command_id;
            let (tx, _rx) = mpsc::channel(8);
            let reply = f
                .engine
                .handle(
                    Command::Cancel {
                        session_id: f.admission.session_id.clone(),
                        execution_id: command.clone(),
                    },
                    tx,
                )
                .await;
            assert!(
                matches!(reply, Reply::Cancelled { execution_id, accepted: true } if execution_id == command)
            );
        }
        let (operation, result) = finish(task).await;
        assert_eq!(operation.status, OperationStatus::Unknown);
        assert_eq!(result.status, AgentStatus::Unknown);
        assert!(result.source_review.is_none());
        assert_eq!(f.engine.shared.workers.count.load(Ordering::Acquire), 0);
        assert!(lock(&f.engine.shared.control).unwrap().active.is_empty());
        let snapshot = lock(&f.engine.shared.store)
            .unwrap()
            .review_snapshot(&f.admission.review_id)
            .unwrap();
        assert_eq!(snapshot.close_reason, Some(ReviewCloseReason::Cancelled));
        let budget = lock(&f.engine.shared.store)
            .unwrap()
            .budget(&f.admission.session_id)
            .unwrap();
        assert_eq!(budget.charged, 0);
        assert_eq!(budget.reserved, 10);
        let events = f.events();
        let close = events
            .iter()
            .find(|event| event.kind == "review_admission_closed")
            .unwrap();
        let settled = events
            .iter()
            .find(|event| {
                event.kind == "operation_unknown"
                    && event.payload["id"] == f.admission.root_operation_id
            })
            .unwrap();
        assert!(close.sequence < settled.sequence);
        assert!(!events.iter().any(|event| event.kind == "command_admitted"
            && event.payload["payload"]["kind"] == "agent_source_tool"));
        assert!(!events.iter().any(|event| event.kind == "operation_detail"
            && event.payload["kind"] == "review_effect_started"));
        f.provider.assert_no_more_requests();
        f.unchanged_source();
        drop(socket);
        f.engine.shutdown().await.unwrap();
    }
}
