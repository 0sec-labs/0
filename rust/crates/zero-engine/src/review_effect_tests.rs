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
        fs::write(source.join("z-unread.bin"), [0, 255, 1, 128]).unwrap();
        fs::write(source.join("z-tool.sh"), "#!/bin/sh\nexit 0\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(source.join("z-tool.sh"), fs::Permissions::from_mode(0o755)).unwrap();
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

#[tokio::test]
async fn archived_review_preparation_preserves_logical_plan_and_revalidates_offline() {
    use zero_protocol::review_reproduction::ReviewReproductionPlan;
    let mut f = Fixture::new(60_000).await;
    let task = f.start();
    let (socket, _) = f.provider.next().await;
    let digest = &f.admission.snapshot.files[0].digest;
    respond(socket,"submit","submit_source_hypotheses",json!({"selected_files":["app.rs"],"hypotheses":[{"title":"Greeting is printed","claimed_severity":"low","explanation":"The pinned source contains a greeting string.","citations":[{"path":"app.rs","sha256":digest,"start_line":1,"end_line":3}]}]})).await;
    let (operation, _) = finish(task).await;
    assert_eq!(operation.status, OperationStatus::Succeeded);
    let mut store = lock(&f.engine.shared.store).unwrap();
    let source = source_provenance::load(&store, &f.admission.session_id, &operation.id).unwrap();
    let manifest = store
        .review_source_archive_manifest(&f.admission.review_id)
        .unwrap()
        .unwrap();
    let authorization: ReviewReproductionPlan = serde_json::from_value(json!({
        "schema_version":1,
        "review_id":f.admission.review_id,
        "source_operation_id":operation.id,
        "archive_manifest_sha256":format!("sha256:{}",zero_plugin::sha256(&manifest.canonical_bytes().unwrap())),
        "deadline_ms":30000,"max_executions":4,
        "plan":{
            "schema_version":1,"oracle_version":zero_verification::ORACLE_VERSION,
            "hypothesis_id":source.review.hypotheses[0].id,
            "source_bundle_digest":source.bundle.digest(),"snapshot":source.snapshot,
            "backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},
            "limits":{"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},
            "repeats":2,"cases":[
                {"id":"attack","mode":"attack","argv":["/bin/sh","z-tool.sh"],"stdin":null,"expected":{"exit_code":0,"stdout":"","stderr":""},"safe_expected":{"exit_code":0,"stdout":"c2FmZQo=","stderr":""}},
                {"id":"control","mode":"legitimate_control","argv":["/bin/true"],"stdin":null,"expected":{"exit_code":0,"stdout":"","stderr":""}}
            ]
        }
    })).unwrap();
    // A succeeded source actor alone does not establish a drained controller.
    assert!(review_reproduction::prepare(&store, &authorization, &|| Ok(())).is_err());
    store.settle_operation(&f.admission.controller_operation_id, &f.engine.shared.owner,
        OperationStatus::Succeeded,
        &json!({"schema_version":1,"review_id":f.admission.review_id,"root_operation_id":operation.id,"root_status":operation.status})).unwrap();
    let native = zero_store::NativeReproductionAdmission {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: uuid::Uuid::new_v4().to_string(),
        operation_id: uuid::Uuid::new_v4().to_string(),
        authorization: authorization.clone(),
        source_operation_sha256: format!(
            "sha256:{}",
            zero_plugin::sha256(
                &serde_json::to_vec(&serde_json::to_value(&operation).unwrap()).unwrap()
            )
        ),
    };
    for change in 0..4 {
        let mut forged = native.clone();
        match change {
            0 => forged.source_operation_sha256 = format!("sha256:{}", "0".repeat(64)),
            1 => {
                forged.authorization.archive_manifest_sha256 = format!("sha256:{}", "0".repeat(64))
            }
            2 => forged.authorization.plan.snapshot.root = "/different-original".into(),
            _ => forged.authorization.plan.hypothesis_id = "uncaptured-claim".into(),
        }
        assert!(
            store
                .admit_native_reproduction("verify", &f.engine.shared.owner, &forged)
                .is_err()
        );
        assert!(
            store
                .native_reproduction_by_command("verify")
                .unwrap()
                .is_none()
        );
    }
    // A failure at the last durable creation event rolls back the entire new
    // authorization, including its zero-budget session and retained intent.
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    let counts = || {
        [
            "sessions",
            "operations",
            "artifacts",
            "operation_artifacts",
            "native_reproductions",
            "events",
        ]
        .map(|table| {
            db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get::<_, u64>(0)
            })
            .unwrap()
        })
    };
    let before = counts();
    db.execute_batch("CREATE TRIGGER fail_native_created BEFORE INSERT ON events WHEN NEW.kind='native_reproduction_created' BEGIN SELECT RAISE(ABORT,'late native admission failure'); END;").unwrap();
    assert!(
        store
            .admit_native_reproduction("verify", &f.engine.shared.owner, &native)
            .is_err()
    );
    assert_eq!(counts(), before);
    db.execute_batch("DROP TRIGGER fail_native_created")
        .unwrap();
    assert!(
        store
            .native_reproduction_by_command("verify")
            .unwrap()
            .is_none()
    );
    drop(db);
    let admitted = store
        .admit_native_reproduction("verify", &f.engine.shared.owner, &native)
        .unwrap();
    assert!(!admitted.duplicate);
    assert_eq!(admitted.operation.status, OperationStatus::Running);
    assert_eq!(
        store.get_session(&native.session_id).unwrap().budget_limit,
        0
    );
    assert_eq!(
        store.native_reproduction(&native.id).unwrap().record,
        admitted.record
    );
    assert!(
        store
            .admit_command(
                &native.session_id,
                "generic",
                &json!({"kind":"responses_inference"})
            )
            .is_err()
    );
    assert!(
        store
            .admit_owned_batch(
                &native.session_id,
                &f.engine.shared.owner,
                &[("generic".into(), json!({"kind":"offline_snapshot_agent"}))]
            )
            .is_err()
    );
    assert!(
        store
            .stop_native_reproduction(
                &native.id,
                &f.engine.shared.owner,
                ReviewCloseReason::Deadline
            )
            .is_err()
    );
    assert!(
        store
            .stop_native_reproduction(&native.id, "other-owner", ReviewCloseReason::Cancelled)
            .is_err()
    );
    assert!(
        store
            .stop_native_reproduction(
                &native.id,
                &f.engine.shared.owner,
                ReviewCloseReason::Cancelled
            )
            .unwrap()
    );
    assert!(
        !store
            .stop_native_reproduction(
                &native.id,
                &f.engine.shared.owner,
                ReviewCloseReason::Cancelled
            )
            .unwrap()
    );
    let mut retry = native.clone();
    retry.id = "do-not-use-current-identities".into();
    retry.source_operation_sha256 = "do-not-recapture".into();
    assert!(
        store
            .admit_native_reproduction("verify", "no-current-owner", &retry)
            .unwrap()
            .duplicate
    );
    retry.authorization.deadline_ms += 1;
    assert!(
        store
            .admit_native_reproduction("verify", &f.engine.shared.owner, &retry)
            .is_err()
    );
    // A stale worker decision cannot overwrite the already accepted close,
    // even when its cancellation token has not yet observed that close.
    let finalized = store
        .settle_native_reproduction(
            &native.id,
            &f.engine.shared.owner,
            OperationStatus::Succeeded,
            &reproduction::empty_outcome(),
            false,
        )
        .unwrap();
    assert_eq!(finalized.status, OperationStatus::Cancelled);
    assert!(store.native_reproduction_closed(&native.id).unwrap());
    assert_eq!(
        store
            .native_reproduction(&native.id)
            .unwrap()
            .operation
            .status,
        OperationStatus::Cancelled
    );
    let events_before =
        serde_json::to_value(store.events(&f.admission.session_id, 0, 1000).unwrap()).unwrap();
    let budget_before =
        serde_json::to_value(store.budget(&f.admission.session_id).unwrap()).unwrap();
    fs::remove_dir_all(&f.admission.snapshot.root).unwrap();
    let prepared = review_reproduction::prepare(&store, &authorization, &|| Ok(())).unwrap();
    let execution = prepared.execution_plan().clone();
    let binding = prepared.binding().clone();
    assert_ne!(prepared.logical_plan().digest(), execution.digest());
    assert_eq!(
        serde_json::to_value(prepared.logical_plan().plan()).unwrap(),
        serde_json::to_value(&authorization.plan).unwrap()
    );
    let dispatch = zero_store::NativeReproductionAdmission {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: uuid::Uuid::new_v4().to_string(),
        operation_id: uuid::Uuid::new_v4().to_string(),
        ..native.clone()
    };
    store
        .admit_native_reproduction("dispatch", &f.engine.shared.owner, &dispatch)
        .unwrap();
    assert!(
        store
            .bind_native_reproduction_source(
                &dispatch.id,
                &f.engine.shared.owner,
                execution.plan(),
                &binding
            )
            .is_err()
    );
    store
        .begin_native_reproduction_preparation(&dispatch.id, &f.engine.shared.owner)
        .unwrap();
    assert!(
        store
            .begin_native_reproduction_preparation(&dispatch.id, &f.engine.shared.owner)
            .is_err()
    );
    store
        .bind_native_reproduction_source(
            &dispatch.id,
            &f.engine.shared.owner,
            execution.plan(),
            &binding,
        )
        .unwrap();
    store
        .bind_native_reproduction_source(
            &dispatch.id,
            &f.engine.shared.owner,
            execution.plan(),
            &binding,
        )
        .unwrap();
    assert_eq!(
        store
            .native_reproduction_bound_source(&dispatch.id)
            .unwrap()
            .unwrap()
            .1,
        binding
    );
    assert!(
        store
            .admit_native_reproduction_case(&dispatch.id, &f.engine.shared.owner, 1, 0)
            .is_err()
    );
    let (child, physical) = store
        .admit_native_reproduction_case(&dispatch.id, &f.engine.shared.owner, 0, 0)
        .unwrap();
    assert!(
        store
            .begin_native_reproduction_effect(&dispatch.id, &child.id, &f.engine.shared.owner)
            .is_err()
    );
    store
        .retain_operation_artifact(
            &child.id,
            &f.engine.shared.owner,
            "reproduction.request",
            &serde_json::to_vec(&physical).unwrap(),
        )
        .unwrap();
    store
        .begin_native_reproduction_effect(&dispatch.id, &child.id, &f.engine.shared.owner)
        .unwrap();
    native_case_corruption_rejected(
        &f.dir.path().join("state.db"),
        &dispatch.id,
        &dispatch.session_id,
        &child.id,
        &f.engine.shared.owner,
    );
    assert!(
        store
            .begin_native_reproduction_effect(&dispatch.id, &child.id, &f.engine.shared.owner)
            .is_err()
    );
    assert!(
        store
            .admit_native_reproduction_case(&dispatch.id, &f.engine.shared.owner, 0, 0)
            .is_err()
    );
    assert!(
        store
            .admit_native_reproduction_case(&dispatch.id, &f.engine.shared.owner, 0, 1)
            .is_err()
    );
    store
        .mark_operation_unknown(
            &child.id,
            &f.engine.shared.owner,
            "permission fixture does not dispatch a guest",
        )
        .unwrap();
    assert!(
        store
            .admit_native_reproduction_case(&dispatch.id, &f.engine.shared.owner, 0, 1)
            .is_err()
    );
    store
        .stop_native_reproduction(
            &dispatch.id,
            &f.engine.shared.owner,
            ReviewCloseReason::Cancelled,
        )
        .unwrap();
    store
        .mark_operation_unknown(
            &dispatch.operation_id,
            &f.engine.shared.owner,
            "fixture ended with uncertain child",
        )
        .unwrap();
    assert!(
        store
            .begin_native_reproduction_effect(&dispatch.id, &child.id, &f.engine.shared.owner)
            .is_err()
    );
    store
        .bind_native_reproduction_source(
            &dispatch.id,
            &f.engine.shared.owner,
            execution.plan(),
            &binding,
        )
        .unwrap();
    let restored = Path::new(&execution.plan().snapshot.root);
    assert_eq!(
        fs::read(restored.join("z-unread.bin")).unwrap(),
        [0, 255, 1, 128]
    );
    use std::os::unix::fs::PermissionsExt;
    assert_ne!(
        fs::metadata(restored.join("z-tool.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    zero_executor::verify_snapshot(&execution.plan().snapshot, &|| Ok(())).unwrap();
    review_reproduction::validate_binding(&store, &authorization, &execution, &binding).unwrap();
    prepared.remove().unwrap();
    assert!(!restored.exists());
    // Offline validation needs neither temporary tree nor original directory.
    review_reproduction::validate_binding(&store, &authorization, &execution, &binding).unwrap();
    for changed in 0..8 {
        let mut forged = binding.clone();
        match changed {
            0 => forged.schema_version = 2,
            1 => forged.review_id = uuid::Uuid::new_v4().to_string(),
            2 => forged.source_session_id = uuid::Uuid::new_v4().to_string(),
            3 => forged.source_operation_id = uuid::Uuid::new_v4().to_string(),
            4 => forged.archive_manifest_sha256 = format!("sha256:{}", "0".repeat(64)),
            7 => forged.authorization_sha256 = format!("sha256:{}", "0".repeat(64)),
            5 => forged.logical_plan_sha256 = format!("sha256:{}", "0".repeat(64)),
            _ => forged.execution_plan_sha256 = format!("sha256:{}", "0".repeat(64)),
        }
        assert!(
            review_reproduction::validate_binding(&store, &authorization, &execution, &forged)
                .is_err()
        );
    }
    let mut wrong = authorization.clone();
    wrong.archive_manifest_sha256 = format!("sha256:{}", "0".repeat(64));
    assert!(review_reproduction::prepare(&store, &wrong, &|| Ok(())).is_err());
    assert!(review_reproduction::validate_binding(&store, &wrong, &execution, &binding).is_err());
    wrong = authorization.clone();
    wrong.plan.cases[0].argv.push("changed-host-command".into());
    assert!(review_reproduction::validate_binding(&store, &wrong, &execution, &binding).is_err());
    assert!(
        review_reproduction::prepare(&store, &authorization, &|| Err("cancelled".into())).is_err()
    );
    for field in ["deadline_ms", "max_executions"] {
        let mut value = serde_json::to_value(&authorization).unwrap();
        value[field] = json!(if field == "deadline_ms" { 20000 } else { 5 });
        let changed = serde_json::from_value(value).unwrap();
        assert!(
            review_reproduction::validate_binding(&store, &changed, &execution, &binding).is_err()
        );
    }
    assert_eq!(
        serde_json::to_value(store.events(&f.admission.session_id, 0, 1000).unwrap()).unwrap(),
        events_before
    );
    assert_eq!(
        serde_json::to_value(store.budget(&f.admission.session_id).unwrap()).unwrap(),
        budget_before
    );
    drop(store);
    f.provider.assert_no_more_requests();
    assert!(!f.dir.path().join("no-backend").exists());
    // Exercise the real owned Engine path against a process-lifecycle fixture.
    // This checks dispatch ordering, not Docker isolation.
    let fake = include_str!("../../zero-executor/tests/fixtures/fake-docker.py")
        .replace("sys.stderr.write(\"fixture diagnostic\\n\")", "pass")
        .replace("elif args[0] == \"start\":", "elif args[0] == \"start\":\n    import sqlite3\n    db=sqlite3.connect(root / \"state.db\")\n    started=sum(json.loads(line)[0]==\"start\" for line in (root/\"calls.jsonl\").read_text().splitlines())\n    assert db.execute(\"SELECT count(*) FROM events WHERE kind='native_reproduction_effect_started'\").fetchone()[0] >= started\n    assert db.execute(\"SELECT count(*) FROM operation_artifacts WHERE name='native_reproduction.effect_start'\").fetchone()[0] >= started");
    let binary = f.dir.path().join("no-backend");
    fs::write(&binary, fake).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(f.dir.path().join("scenario.txt"), "success").unwrap();
    lock(&f.engine.shared.providers).unwrap().clear();
    let (tx, mut rx) = mpsc::channel(64);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let reply = f
        .engine
        .reproduce_review("native-engine".into(), authorization.clone(), tx)
        .await
        .unwrap();
    drain.await.unwrap();
    let Reply::SourceReproduction {
        operation: reproduced,
        result: Some(result),
        duplicate: false,
    } = reply
    else {
        panic!("wrong native reply");
    };
    assert_eq!(
        reproduced.status,
        OperationStatus::Succeeded,
        "{:?}",
        result
    );
    assert_eq!(
        result.assessment.unwrap().disposition,
        zero_protocol::verification::Disposition::ObservedForPlan
    );
    assert_eq!(result.children.len(), 4);
    assert_eq!(
        lock(&f.engine.shared.store)
            .unwrap()
            .get_session(&reproduced.session_id)
            .unwrap()
            .budget_limit,
        0
    );
    let calls = fs::read(f.dir.path().join("calls.jsonl")).unwrap();
    assert_eq!(
        String::from_utf8_lossy(&calls)
            .lines()
            .filter(|line| serde_json::from_str::<Value>(line).unwrap()[0] == "start")
            .count(),
        4
    );
    fs::remove_file(binary).unwrap();
    let (tx, _rx) = mpsc::channel(8);
    assert!(matches!(
        f.engine
            .reproduce_review("native-engine".into(), authorization.clone(), tx)
            .await
            .unwrap(),
        Reply::SourceReproduction {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(fs::read(f.dir.path().join("calls.jsonl")).unwrap(), calls);
    assert_eq!(
        serde_json::to_value(
            lock(&f.engine.shared.store)
                .unwrap()
                .budget(&f.admission.session_id)
                .unwrap()
        )
        .unwrap(),
        budget_before
    );
    f.provider.assert_no_more_requests();
    let store = lock(&f.engine.shared.store).unwrap();
    let reproduction_id = store
        .native_reproduction_by_command("native-engine")
        .unwrap()
        .unwrap()
        .id;
    let repair = zero_protocol::review_repair::ReviewRepairPlan {
        schema_version: 1,
        reproduction_id,
        deadline_ms: 30000,
        max_executions: 8,
        materialize: zero_protocol::repair::MaterializeRequest {
            baseline: authorization.plan.snapshot.clone(),
            target: "app.rs".into(),
            allowed_paths: vec!["app.rs".into()],
            protected_paths: vec!["z-tool.sh".into()],
            expected_preimage_sha256: authorization
                .plan
                .snapshot
                .files
                .iter()
                .find(|f| f.path == "app.rs")
                .unwrap()
                .digest
                .clone(),
            replacement: "pub fn greeting() -> &'static str { \"safe\\n\" }\n".into(),
        },
    };
    let mut too_few = repair.clone();
    too_few.max_executions = 7;
    assert!(review_repair::assess(&store, &too_few).is_err());
    assert!(review_repair::prepare(&store, &too_few, &|| Ok(())).is_err());
    let mut wrong_target = repair.clone();
    wrong_target.materialize.target = "z-tool.sh".into();
    assert!(review_repair::assess(&store, &wrong_target).is_err());
    assert!(review_repair::prepare(&store, &wrong_target, &|| Ok(())).is_err());
    assert!(review_repair::prepare(&store, &repair, &|| Err("cancelled".into())).is_err());
    let prepared = review_repair::prepare(&store, &repair, &|| Ok(())).unwrap();
    let assessed = review_repair::assess(&store, &repair).unwrap();
    assert_eq!(
        assessed.reproduction_operation_id,
        store
            .native_reproduction(&repair.reproduction_id)
            .unwrap()
            .operation
            .id
    );
    assert_eq!(
        assessed.reproduction_evidence_sha256,
        store
            .native_reproduction_evidence_digest(&repair.reproduction_id)
            .unwrap()
    );
    let derived = prepared.materialize_request().clone();
    let execution_baseline = prepared.execution_baseline().clone();
    let binding = prepared.binding().clone();
    let first = zero_repair::materialize_checked(&derived, &|| Ok(())).unwrap();
    let second = zero_repair::materialize_checked(&derived, &|| Ok(())).unwrap();
    assert_ne!(first.snapshot().root, second.snapshot().root);
    assert_eq!(first.receipt(), second.receipt());
    assert_eq!(first.receipt(), prepared.expected_receipt());
    let safe = prepared.candidate_plan(&first).unwrap();
    assert_eq!(
        serde_json::to_value(&safe.plan().cases[0].expected).unwrap(),
        serde_json::to_value(&authorization.plan.cases[0].safe_expected).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&safe.plan().cases[1]).unwrap(),
        serde_json::to_value(&authorization.plan.cases[1]).unwrap()
    );
    assert_eq!(
        fs::read(Path::new(&first.snapshot().root).join("z-unread.bin")).unwrap(),
        [0, 255, 1, 128]
    );
    assert_eq!(
        fs::read(Path::new(&first.snapshot().root).join("app.rs")).unwrap(),
        repair.materialize.replacement.as_bytes()
    );
    let stage_root = derived.baseline.root.clone();
    first.cleanup().unwrap();
    second.cleanup().unwrap();
    prepared.remove().unwrap();
    assert!(!Path::new(&stage_root).exists());
    review_repair::validate_binding(&store, &repair, &execution_baseline, &derived, &binding)
        .unwrap();
    for (field, value) in serde_json::to_value(&binding).unwrap().as_object().unwrap() {
        let mut changed = serde_json::to_value(&binding).unwrap();
        changed[field] = if value.is_number() {
            json!(99)
        } else {
            json!("forged")
        };
        let changed = serde_json::from_value(changed).unwrap();
        assert!(
            review_repair::validate_binding(
                &store,
                &repair,
                &execution_baseline,
                &derived,
                &changed
            )
            .is_err(),
            "accepted forged {field}"
        );
    }
    let mut changed = repair.clone();
    changed.deadline_ms += 1;
    assert!(
        review_repair::validate_binding(&store, &changed, &execution_baseline, &derived, &binding)
            .is_err()
    );
    assert_eq!(fs::read(f.dir.path().join("calls.jsonl")).unwrap(), calls);
    drop(store);
    let repair_backend = include_str!("../../zero-executor/tests/fixtures/fake-docker.py")
        .replace("sys.stderr.write(\"fixture diagnostic\\n\")", "pass")
        .replace("{\"name\": name, \"id\": container_id}", "{\"name\": name, \"id\": container_id, \"argv\": args}")
        .replace("sys.stdout.buffer.write(sys.stdin.buffer.read())", "sys.stdout.buffer.write(b'safe\\n' if 'z-tool.sh' in ' '.join(json.loads(state.read_text())['argv']) else b'')");
    let binary = f.dir.path().join("no-backend");
    fs::write(&binary, repair_backend).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let (tx, mut rx) = mpsc::channel(64);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let repaired = f
        .engine
        .repair_review("native-repair-engine".into(), repair.clone(), tx)
        .await
        .unwrap();
    drain.await.unwrap();
    let Reply::SourceRepair {
        operation,
        result: Some(result),
        duplicate: false,
    } = repaired
    else {
        panic!("wrong native repair reply");
    };
    assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
    assert_eq!(
        result.status,
        zero_protocol::repair::RepairValidationStatus::ValidatedCandidateForPlan
    );
    assert_eq!(result.phases.len(), 2);
    assert!(
        result
            .phases
            .iter()
            .all(|p| p.observations.children.len() == 4)
    );
    assert!(result.cleanup_recovery.is_empty());
    assert!(!result.vulnerability_reportable);
    let record = lock(&f.engine.shared.store)
        .unwrap()
        .native_repair_by_command("native-repair-engine")
        .unwrap()
        .unwrap();
    fs::remove_file(binary).unwrap();
    native_repair_export::tests::assert_retained_provenance(
        &f.dir.path().join("state.db"),
        &record.id,
    );
    let before_retry = fs::read(f.dir.path().join("calls.jsonl")).unwrap();
    let (tx, _rx) = mpsc::channel(8);
    assert!(matches!(
        f.engine
            .repair_review("native-repair-engine".into(), repair, tx)
            .await
            .unwrap(),
        Reply::SourceRepair {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(
        fs::read(f.dir.path().join("calls.jsonl")).unwrap(),
        before_retry
    );
    assert_eq!(
        serde_json::to_value(
            lock(&f.engine.shared.store)
                .unwrap()
                .budget(&f.admission.session_id)
                .unwrap()
        )
        .unwrap(),
        budget_before
    );
    f.engine.shutdown().await.unwrap();
}

fn native_case_corruption_rejected(
    path: &Path,
    reproduction: &str,
    session: &str,
    child: &str,
    owner: &str,
) {
    for change in 0..9 {
        let copy = tempfile::tempdir().unwrap();
        let copied = copy.path().join("corrupted.db");
        let original = rusqlite::Connection::open(path).unwrap();
        original
            .execute("VACUUM INTO ?1", [copied.to_str().unwrap()])
            .unwrap();
        drop(original);
        let db = rusqlite::Connection::open(&copied).unwrap();
        match change {
            0 | 1 => {
                db.execute(
                    "DELETE FROM operation_artifacts WHERE operation_id=?1",
                    [child],
                )
                .unwrap();
                db.execute("DELETE FROM operations WHERE id=?1", [child])
                    .unwrap();
                if change == 0 {
                    db.execute("DELETE FROM events WHERE session_id=?1 AND kind='command_admitted' AND json_extract(payload,'$.id')=?2", rusqlite::params![session,child]).unwrap();
                } else {
                    // Keep only artifact/physical evidence for the missing case.
                    db.execute("DELETE FROM events WHERE session_id=?1 AND kind IN ('command_admitted','operation_started') AND json_extract(payload,'$.id')=?2", rusqlite::params![session,child]).unwrap();
                }
            }
            2 => {
                db.execute("UPDATE events SET payload=json_set(payload,'$.owner','other-owner') WHERE session_id=?1 AND kind='native_reproduction_effect_started' AND json_extract(payload,'$.operation_id')=?2",rusqlite::params![session,child]).unwrap();
            }
            3 => {
                db.execute("UPDATE events SET payload=json_set(payload,'$.request_sha256',?3) WHERE session_id=?1 AND kind='native_reproduction_effect_started' AND json_extract(payload,'$.operation_id')=?2",rusqlite::params![session,child,format!("sha256:{}","0".repeat(64))]).unwrap();
            }
            4 => {
                db.execute("DELETE FROM operation_artifacts WHERE operation_id=?1 AND name='reproduction.request'",[child]).unwrap();
            }
            5 => {
                db.execute("DELETE FROM events WHERE session_id=?1 AND kind='native_reproduction_effect_started' AND json_extract(payload,'$.operation_id')=?2",rusqlite::params![session,child]).unwrap();
            }
            6 => {
                db.execute("DELETE FROM operation_artifacts WHERE operation_id=?1 AND name='native_reproduction.effect_start'",[child]).unwrap();
            }
            7 => {
                db.execute("UPDATE artifacts SET bytes=x'00' WHERE digest=(SELECT digest FROM operation_artifacts WHERE operation_id=?1 AND name='native_reproduction.effect_start')",[child]).unwrap();
            }
            _ => {
                db.execute("DELETE FROM events WHERE session_id=?1 AND kind='native_reproduction_effect_started' AND json_extract(payload,'$.operation_id')=?2",rusqlite::params![session,child]).unwrap();
                db.execute("DELETE FROM operation_artifacts WHERE operation_id=?1 AND name='native_reproduction.effect_start'",[child]).unwrap();
            }
        }
        drop(db);
        let mut copied_store = zero_store::Store::open(&copied).unwrap();
        assert!(
            copied_store.native_reproduction(reproduction).is_err(),
            "accepted corrupt case inventory {change}"
        );
        assert!(
            copied_store
                .admit_native_reproduction_case(reproduction, owner, 0, 0)
                .is_err(),
            "replayed corrupted slot {change}"
        );
        assert!(
            copied_store
                .begin_native_reproduction_effect(reproduction, child, owner)
                .is_err(),
            "replayed corrupted effect {change}"
        );
    }
}
