#![cfg(target_os = "linux")]
//! Engine ownership tests. Fake Docker proves lifecycle bookkeeping only;
//! the ignored local-archive test additionally exercises an actual microVM.
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
use tokio::sync::mpsc;
use zero_engine::Engine;
use zero_executor::pin_snapshot;
use zero_protocol::{
    Command, ExecutionEvent, ExecutionStatus, OperationStatus, Reply,
    sandbox::{SandboxBackend, SandboxCleanup, SandboxEvent, SandboxRecovery, SandboxRequest},
};

struct Fixture {
    dir: tempfile::TempDir,
    request: SandboxRequest,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("docker");
        fs::write(
            &binary,
            include_bytes!("../../zero-executor/tests/fixtures/fake-docker.py"),
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("scenario.txt"), scenario).unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("main.js"),
            "console.log('engine microvm proof')",
        )
        .unwrap();
        let request = SandboxRequest {
            execution_id: "sandbox-test".into(),
            backend: SandboxBackend::Docker {
                image: "local:fixture".into(),
            },
            snapshot: pin_snapshot(&source).unwrap(),
            argv: vec!["node".into(), "main.js".into()],
            build_argv: None,
            stdin: Some("owned bytes".into()),
            timeout_ms: 2000,
            memory_mb: 128,
            cpus: 0.5,
            max_output_bytes: 2048,
        };
        Self { dir, request }
    }
    fn open(&self) -> Engine {
        Engine::open_with_backends(
            self.dir.path().join("engine.sqlite"),
            Some(self.dir.path().join("docker")),
            None,
        )
        .unwrap()
    }
    fn command(&self, session: &str) -> Command {
        Command::RunSandbox {
            session_id: session.into(),
            command_id: "once".into(),
            request: self.request.clone(),
        }
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.dir.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
}
async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, _rx) = mpsc::channel(128);
    tokio::time::timeout(Duration::from_secs(150), engine.handle(command, tx))
        .await
        .unwrap()
}
async fn session(engine: &Engine) -> String {
    match call(
        engine,
        Command::SessionCreate {
            generation: "pinned-generation".into(),
            budget_limit: 100,
        },
    )
    .await
    {
        Reply::Session { session } => session.id,
        reply => panic!("{reply:?}"),
    }
}
async fn budget(engine: &Engine, session: &str) -> zero_protocol::BudgetSnapshot {
    match call(
        engine,
        Command::SessionBudget {
            session_id: session.into(),
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => budget,
        reply => panic!("{reply:?}"),
    }
}
#[tokio::test]
async fn explicit_docker_backend_settles_and_exact_retry_after_restart_has_no_effect() {
    let f = Fixture::new("echo");
    let engine = f.open();
    let s = session(&engine).await;
    let id = match call(&engine, f.command(&s)).await {
        Reply::Sandbox {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            assert_eq!(result.stdout, b"owned bytes");
            assert!(matches!(result.cleanup, SandboxCleanup::Confirmed));
            operation.id
        }
        reply => panic!("{reply:?}"),
    };
    let calls = f.calls();
    assert_eq!(calls.iter().filter(|v| v[0] == "create").count(), 1);
    assert_eq!(budget(&engine, &s).await.charged, 0);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.open();
    match call(&engine, f.command(&s)).await {
        Reply::Sandbox {
            operation,
            result: Some(result),
            duplicate: true,
        } => {
            assert_eq!(operation.id, id);
            assert_eq!(operation.status, OperationStatus::Succeeded);
            assert_eq!(result.stdout, b"owned bytes");
        }
        reply => panic!("{reply:?}"),
    }
    assert_eq!(f.calls(), calls);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn fractional_microvm_profile_rejects_before_admission_and_never_falls_back() {
    let mut f = Fixture::new("echo");
    let engine = f.open();
    let s = session(&engine).await;
    f.request.backend = SandboxBackend::Smolvm {
        image_archive: "/not-an-authorized-archive".into(),
        archive_digest: format!("sha256:{}", "0".repeat(64)),
        storage_gb: 1,
    };
    assert!(
        matches!(call(&engine,f.command(&s)).await,Reply::Error{message,..} if message.contains("integer CPUs"))
    );
    assert!(f.calls().is_empty());
    match call(
        &engine,
        Command::SessionEvents {
            session_id: s,
            after_sequence: 0,
            limit: 100,
        },
    )
    .await
    {
        Reply::SessionEvents { events } => {
            assert!(!events.iter().any(|event| event.kind == "command_admitted"))
        }
        reply => panic!("{reply:?}"),
    }
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn explicit_cancel_reaches_owned_backend_and_settles_after_cleanup() {
    let f = Fixture::new("cancel");
    let engine = Arc::new(f.open());
    let s = session(&engine).await;
    let owner = engine.clone();
    let command = f.command(&s);
    let (tx, mut rx) = mpsc::channel(128);
    let running = tokio::spawn(async move { owner.handle(command, tx).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(event) = rx.recv().await {
            if matches!(
                event,
                ExecutionEvent::Sandbox {
                    event: SandboxEvent::Output { .. }
                }
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
                session_id: s.clone(),
                execution_id: f.request.execution_id.clone()
            }
        )
        .await,
        Reply::Cancelled { accepted: true, .. }
    ));
    match running.await.unwrap() {
        Reply::Sandbox {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Cancelled);
            assert_eq!(result.status, ExecutionStatus::Cancelled);
            assert!(matches!(result.cleanup, SandboxCleanup::Confirmed));
        }
        reply => panic!("{reply:?}"),
    }
    assert!(!f.dir.path().join("container.json").exists());
    assert_eq!(budget(&engine, &s).await.reserved, 0);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn unconfirmed_teardown_is_durable_unknown_and_never_replayed() {
    let mut f = Fixture::new("cleanup-fail");
    f.request.timeout_ms = 300;
    let engine = f.open();
    let s = session(&engine).await;
    let retained = match call(&engine, f.command(&s)).await {
        Reply::Sandbox {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Unknown);
            match result.cleanup {
                SandboxCleanup::Unconfirmed {
                    recovery:
                        SandboxRecovery::Docker {
                            snapshot_dir: Some(path),
                            ..
                        },
                } => path,
                other => panic!("{other:?}"),
            }
        }
        reply => panic!("{reply:?}"),
    };
    assert!(std::path::Path::new(&retained).exists());
    let calls = f.calls();
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.open();
    assert!(
        matches!(call(&engine,f.command(&s)).await,Reply::Sandbox{operation,duplicate:true,..} if operation.status==OperationStatus::Unknown)
    );
    assert_eq!(f.calls(), calls);
    engine.shutdown().await.unwrap();
    // Fixture has no daemon/container; its launcher already reaped. Dispose only
    // these test-owned retained bytes, never an actual uncertain guest's mount.
    fs::remove_dir_all(retained).unwrap();
}

/// Two deterministic loopback responses; the guest execution is still real.
async fn model_fixture() -> (String, tokio::task::JoinHandle<Vec<Value>>) {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for turn in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            loop {
                let mut bytes = [0; 4096];
                let n = stream.read(&mut bytes).await.unwrap();
                assert!(n > 0);
                data.extend_from_slice(&bytes[..n]);
                assert!(data.len() < 1_000_000);
                if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                    let len = String::from_utf8_lossy(&data[..end])
                        .lines()
                        .find_map(|line| {
                            let (k, v) = line.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if data.len() >= end + 4 + len {
                        requests
                            .push(serde_json::from_slice(&data[end + 4..end + 4 + len]).unwrap());
                        break;
                    }
                }
            }
            let output = if turn == 0 {
                json!([{"type":"function_call","call_id":"real-vm-call","name":"execute_snapshot","arguments":json!({"argv":["node","main.js"]}).to_string()}])
            } else {
                json!([{"type":"message","content":[{"type":"output_text","text":"microvm inspection complete"}]}])
            };
            let body = format!(
                "data: {}\n\n",
                json!({"type":"response.completed","response":{"id":format!("turn-{turn}"),"status":"completed","output":output,"usage":{"input_tokens":1,"output_tokens":1}}})
            );
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    (url, task)
}
fn configure(engine: &Engine, url: &str) {
    use zero_provider::{Endpoint, ProviderClient};
    engine
        .configure_provider(
            "fixture",
            ProviderClient::new(
                Endpoint::responses(url, None).unwrap(),
                Duration::from_secs(10),
                65536,
            )
            .unwrap(),
            zero_protocol::model::Rates {
                input: 1_000_000,
                cached_input: 1_000_000,
                output: 1_000_000,
            },
        )
        .unwrap();
}
#[tokio::test]
#[ignore = "actual microVM; requires ZERO_SMOLVM_SMOKE_ARCHIVE and qualified nonroot KVM profile; no pulls/paid provider"]
async fn real_microvm_engine_and_agent_ownership_accounting_and_durable_retry() {
    use zero_protocol::agent::{AgentRequest, AgentStatus};
    let archive = std::env::var("ZERO_SMOLVM_SMOKE_ARCHIVE")
        .expect("explicit existing local archive required");
    let hash = std::process::Command::new("sha256sum")
        .arg(&archive)
        .output()
        .unwrap();
    assert!(hash.status.success());
    let digest = format!(
        "sha256:{}",
        String::from_utf8(hash.stdout)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
    );
    let mut f = Fixture::new("must-not-use-docker");
    f.request.backend = SandboxBackend::Smolvm {
        image_archive: archive.into(),
        archive_digest: digest,
        storage_gb: 4,
    };
    f.request.timeout_ms = 120000;
    f.request.memory_mb = 2048;
    f.request.cpus = 2.0;
    let engine = f.open();
    let s = session(&engine).await;
    match call(&engine, f.command(&s)).await {
        Reply::Sandbox {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
            assert_eq!(result.stdout, b"engine microvm proof\n");
            assert!(matches!(result.cleanup, SandboxCleanup::Confirmed));
        }
        reply => panic!("{reply:?}"),
    }
    assert!(f.calls().is_empty());
    let (url, http) = model_fixture().await;
    configure(&engine, &url);
    let request = AgentRequest {
        plugin_tools: vec![],
        continuation_of: None,
        source_review_operation_id: None,
        source_snapshot_tools: false,
        source_submission_max_hypotheses: None,
        provider: "fixture".into(),
        context_policy: None,
        delegation_policy: None,
        operator_questions: false,
        http_profile: None,
        tool_approval_policy: None,
        model: "loopback".into(),
        instructions: "Only execute the offered snapshot tool".into(),
        prompt: "Inspect this pinned fixture".into(),
        execution: f.request.clone().into(),
        max_turns: 3,
        reservation_per_turn: 5,
    };
    let agent_command = || Command::RunAgent {
        session_id: s.clone(),
        command_id: "agent-once".into(),
        request: request.clone(),
    };
    let parent = match call(&engine, agent_command()).await {
        Reply::Agent {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
            assert_eq!(result.status, AgentStatus::Completed);
            assert_eq!((result.turns, result.tool_calls), (2, 1));
            operation.id
        }
        reply => panic!("{reply:?}"),
    };
    let requests = tokio::time::timeout(Duration::from_secs(2), http)
        .await
        .unwrap()
        .unwrap();
    let replay = requests[1]["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["type"] == "function_call_output")
        .unwrap();
    let output: Value = serde_json::from_str(replay["output"].as_str().unwrap()).unwrap();
    assert_eq!(output["stdout_text"], "engine microvm proof\n");
    assert_eq!(budget(&engine, &s).await.charged, 4);
    assert_eq!(budget(&engine, &s).await.reserved, 0);
    assert!(f.calls().is_empty());
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.open();
    configure(&engine, &url); // Endpoint no longer listening: retry must not call it.
    assert!(
        matches!(call(&engine,f.command(&s)).await,Reply::Sandbox{duplicate:true,operation,..} if operation.status==OperationStatus::Succeeded)
    );
    assert!(
        matches!(call(&engine,agent_command()).await,Reply::Agent{duplicate:true,operation,..} if operation.id==parent && operation.status==OperationStatus::Succeeded)
    );
    assert_eq!(budget(&engine, &s).await.charged, 4);
    assert!(f.calls().is_empty());
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn admitted_identity_is_durable_before_any_backend_event_and_supports_cancel() {
    let f = Fixture::new("hang");
    let engine = Arc::new(f.open());
    let s = session(&engine).await;
    let owner = engine.clone();
    let command = f.command(&s);
    let (tx, mut rx) = mpsc::channel(128);
    let worker = tokio::spawn(async move { owner.handle(command, tx).await });
    let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let operation_id = match event {
        ExecutionEvent::Admitted {
            session_id,
            command_id,
            operation_id,
            execution_id,
        } => {
            assert_eq!(session_id, s);
            assert_eq!(command_id, "once");
            assert_eq!(execution_id, f.request.execution_id);
            let store = zero_store::Store::open(f.dir.path().join("engine.sqlite")).unwrap();
            let operation = store.get_operation(&operation_id).unwrap();
            assert_eq!(operation.status, OperationStatus::Running);
            assert_eq!(operation.session_id, session_id);
            assert_eq!(operation.command_id, command_id);
            operation_id
        }
        other => panic!("admission must precede backend events: {other:?}"),
    };
    assert!(matches!(
        call(
            &engine,
            Command::Cancel {
                session_id: s.clone(),
                execution_id: f.request.execution_id.clone()
            }
        )
        .await,
        Reply::Cancelled { accepted: true, .. }
    ));
    match worker.await.unwrap() {
        Reply::Sandbox { operation, .. } => {
            assert_eq!(operation.id, operation_id);
            assert_eq!(operation.status, OperationStatus::Cancelled);
        }
        other => panic!("{other:?}"),
    }
    let (tx, mut rx) = mpsc::channel(1);
    assert!(matches!(
        engine.handle(f.command(&s), tx).await,
        Reply::Sandbox {
            duplicate: true,
            ..
        }
    ));
    assert!(
        rx.recv().await.is_none(),
        "exact retry must not emit a new admission"
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn undeliverable_admission_cancels_before_backend_launch() {
    for full in [false, true] {
        let f = Fixture::new("echo");
        let engine = f.open();
        let s = session(&engine).await;
        let (tx, rx) = mpsc::channel(1);
        let _receiver = if full {
            tx.try_send(ExecutionEvent::Admitted {
                session_id: "occupied".into(),
                command_id: "occupied".into(),
                operation_id: "occupied".into(),
                execution_id: "occupied".into(),
            })
            .unwrap();
            Some(rx)
        } else {
            drop(rx);
            None
        };
        match engine.handle(f.command(&s), tx).await {
            Reply::Sandbox {
                operation,
                result: Some(result),
                duplicate: false,
            } => {
                assert_eq!(operation.status, OperationStatus::Cancelled);
                assert!(matches!(result.cleanup, SandboxCleanup::NotCreated));
            }
            other => panic!("{other:?}"),
        }
        assert!(f.calls().is_empty());
        assert_eq!(budget(&engine, &s).await.reserved, 0);
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn inference_admission_delivery_failure_releases_known_unsent_reservation() {
    let f = Fixture::new("echo");
    let engine = f.open();
    let s = session(&engine).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    configure(&engine, &url);
    let (tx, rx) = mpsc::channel(1);
    drop(rx);
    let reply = engine
        .handle(
            Command::Infer {
                session_id: s.clone(),
                command_id: "unsent".into(),
                provider: "fixture".into(),
                request: zero_protocol::model::ResponsesRequest {
                    model: "fixture".into(),
                    instructions: "fixture".into(),
                    input: vec![json!({"role":"user","content":"hello"})],
                    tools: vec![],
                    max_output_tokens: 32,
                },
                reservation: 5,
            },
            tx,
        )
        .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err(),
        "pre-cancelled admission must not dispatch HTTP"
    );
    let accounting = budget(&engine, &s).await;
    assert_eq!(accounting.charged, 0);
    assert_eq!(
        accounting.reserved, 0,
        "known-unsent cancellation must release its hold: {reply:?}"
    );
    assert!(
        matches!(reply,Reply::Inference{operation,..} if operation.status==OperationStatus::Cancelled)
    );
    engine.shutdown().await.unwrap();
}
