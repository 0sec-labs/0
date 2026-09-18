//! Live engine telemetry uses local SSE fixtures, never a paid provider.
use serde_json::{Value, json};
use std::{
    fs,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
use zero_engine::Engine;
use zero_protocol::{
    Command, ExecutionEvent, Reply,
    model::{ProviderProgress, Rates},
    session::OperationStatus,
};
use zero_provider::{Endpoint, ProviderClient};
struct Http {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    ready: CancellationToken,
    release: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Http {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn event(value: Value) -> String {
    format!("data: {value}\n\n")
}
fn delta() -> String {
    event(
        json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"provisional text","session_id":"FORGED","operation_id":"FORGED","parent_operation_id":"FORGED","sequence":999}),
    )
}
fn final_response(source: bool, tool: bool) -> String {
    let output = if source {
        json!([{"type":"function_call","call_id":"submit","name":"submit_source_hypotheses","arguments":"{\"hypotheses\":[]}"}])
    } else if tool {
        json!([{"type":"function_call","call_id":"execute","name":"execute_snapshot","arguments":"{\"argv\":[\"echo\",\"fixture\"]}"}])
    } else {
        json!([{"type":"message","content":[{"type":"output_text","text":"authoritative final answer"}]}])
    };
    event(
        json!({"type":"response.completed","response":{"id":"fixture","status":"completed","output":output,"usage":{"input_tokens":1,"output_tokens":1}}}),
    )
}
impl Http {
    async fn new(first: String, ends: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/responses", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(vec![]));
        let captured = requests.clone();
        let ready = CancellationToken::new();
        let signal = ready.clone();
        let release = CancellationToken::new();
        let gate = release.clone();
        let task = tokio::spawn(async move {
            let mut index = 0;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = vec![];
                loop {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                    assert!(bytes.len() < 1_000_000);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let length = String::from_utf8_lossy(&bytes[..end])
                            .lines()
                            .find_map(|line| {
                                let (k, v) = line.split_once(':')?;
                                k.eq_ignore_ascii_case("content-length")
                                    .then(|| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            captured.lock().unwrap().push(
                                serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap(),
                            );
                            break;
                        }
                    }
                }
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                stream.write_all(first.as_bytes()).await.unwrap();
                if index == 0 {
                    signal.cancel();
                    gate.cancelled().await;
                }
                let end = ends.get(index).unwrap_or_else(|| ends.last().unwrap());
                stream.write_all(end.as_bytes()).await.unwrap();
                stream.shutdown().await.unwrap();
                index += 1;
            }
        });
        Self {
            url,
            requests,
            ready,
            release,
            task,
        }
    }
    fn configure(&self, engine: &Engine) {
        engine
            .configure_provider(
                "fixture",
                ProviderClient::new(
                    Endpoint::responses(&self.url, None).unwrap(),
                    Duration::from_secs(5),
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
}
async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, _rx) = mpsc::channel(64);
    engine.handle(command, tx).await
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
        other => panic!("{other:?}"),
    }
}
fn command(mode: &str, session: &str, source: &std::path::Path) -> Command {
    let snapshot = zero_executor::pin_snapshot(source).unwrap();
    let value = match mode {
        "direct" => {
            json!({"method":"infer","params":{"session_id":session,"command_id":"request","provider":"fixture","reservation":10,"request":{"model":"fixture","instructions":"fixture","input":[{"role":"user","content":"hello"}],"tools":[],"max_output_tokens":32}}})
        }
        "source" => {
            json!({"method":"review_source","params":{"session_id":session,"command_id":"request","request":{"provider":"fixture","model":"fixture","reservation":10,"source":{"snapshot":snapshot,"selected_files":["app.js"],"question":"fixture","max_hypotheses":1}}}})
        }
        _ => {
            json!({"method":"run_agent","params":{"session_id":session,"command_id":"request","request":{"provider":"fixture","model":"fixture","instructions":"fixture","prompt":"fixture","max_turns":3,"reservation_per_turn":10,"execution":{"execution_id":"fixture","image":"local:fixture","snapshot":snapshot,"argv":["echo","fixture"],"timeout_ms":2000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}}}})
        }
    };
    serde_json::from_value(value).unwrap()
}
fn outcome(reply: &Reply) -> (&zero_protocol::Operation, bool) {
    match reply {
        Reply::Inference {
            operation,
            duplicate,
            ..
        }
        | Reply::Agent {
            operation,
            duplicate,
            ..
        }
        | Reply::SourceReview {
            operation,
            duplicate,
            ..
        } => (operation, *duplicate),
        other => panic!("{other:?}"),
    }
}
async fn progress(rx: &mut mpsc::Receiver<ExecutionEvent>) -> ExecutionEvent {
    tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn paid_paths_emit_provisional_progress_before_completion_with_owned_identity_and_no_retry_replay()
 {
    for mode in ["direct", "agent", "source", "queued"] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("app.js"), "fixture\n").unwrap();
        let http = Http::new(delta(), vec![final_response(mode == "source", false)]).await;
        let engine = Arc::new(Engine::open(dir.path().join("state.db"), None).unwrap());
        http.configure(&engine);
        let session = session(&engine).await;
        let mut cmd = command(mode, &session, &source);
        if mode == "queued" {
            let request = match cmd {
                Command::RunAgent { request, .. } => request,
                _ => unreachable!(),
            };
            let input = match call(
                &engine,
                Command::QueueAgent {
                    session_id: session.clone(),
                    command_id: "queued".into(),
                    request,
                    after_input: None,
                },
            )
            .await
            {
                Reply::AgentQueued { input, .. } => input,
                other => panic!("{other:?}"),
            };
            cmd = Command::RunQueuedAgent {
                session_id: session.clone(),
                input_id: input.id,
            };
        }
        let (tx, mut events) = mpsc::channel(64);
        let (ptx, mut updates) = mpsc::channel(64);
        let owner = engine.clone();
        let request = cmd.clone();
        let task = tokio::spawn(async move { owner.handle_with_progress(request, tx, ptx).await });
        let admission = match progress(&mut events).await {
            ExecutionEvent::Admitted { operation_id, .. } => operation_id,
            other => panic!("{other:?}"),
        };
        let (paid, parent) = match progress(&mut updates).await {
            ExecutionEvent::ModelProgress {
                session_id,
                operation_id,
                parent_operation_id,
                sequence,
                progress: ProviderProgress::TextDelta { text, .. },
            } => {
                assert_eq!(session_id, session);
                assert_eq!(sequence, 1);
                assert_eq!(text, "provisional text");
                assert_ne!(operation_id, "FORGED");
                (operation_id, parent_operation_id)
            }
            other => panic!("{other:?}"),
        };
        assert!(!task.is_finished(), "progress must precede completion");
        if mode == "direct" {
            assert_eq!(paid, admission);
            assert!(parent.is_none());
        } else {
            assert_eq!(parent.as_deref(), Some(admission.as_str()));
            assert_ne!(paid, admission);
        }
        http.release.cancel();
        let reply = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome(&reply).0.status, OperationStatus::Succeeded);
        let store = zero_store::Store::open_read_only(dir.path().join("state.db")).unwrap();
        let child = store.get_operation(&paid).unwrap();
        assert_eq!(child.session_id, session);
        assert_eq!(child.status, OperationStatus::Succeeded);
        if mode != "direct" {
            assert_eq!(child.payload["parent_operation"], admission);
        }
        assert_eq!(store.budget(&session).unwrap().charged, 2);
        drop(store);
        fs::remove_dir_all(&source).unwrap();
        let (tx, _rx) = mpsc::channel(64);
        let (ptx, mut retry_updates) = mpsc::channel(64);
        let retry = engine.handle_with_progress(cmd, tx, ptx).await;
        assert!(outcome(&retry).1);
        assert_eq!(outcome(&retry).0.id, admission);
        assert!(retry_updates.try_recv().is_err());
        assert_eq!(http.requests.lock().unwrap().len(), 1);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn slow_or_closed_progress_observer_never_changes_completion_or_partial_usage_hold() {
    for (closed, truncated) in [(false, false), (true, false), (false, true)] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("app.js"), "fixture\n").unwrap();
        let first = delta().repeat(100);
        let http = Http::new(
            first,
            vec![if truncated {
                String::new()
            } else {
                final_response(false, false)
            }],
        )
        .await;
        let engine = Arc::new(Engine::open(dir.path().join("state.db"), None).unwrap());
        http.configure(&engine);
        let session = session(&engine).await;
        let (tx, mut events) = mpsc::channel(1);
        let (ptx, updates) = mpsc::channel(1);
        let observer = if closed {
            drop(updates);
            None
        } else {
            Some(updates)
        };
        let owner = engine.clone();
        let cmd = command("direct", &session, &source);
        let task = tokio::spawn(async move { owner.handle_with_progress(cmd, tx, ptx).await });
        assert!(matches!(
            progress(&mut events).await,
            ExecutionEvent::Admitted { .. }
        ));
        http.ready.cancelled().await;
        http.release.cancel();
        let reply = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            outcome(&reply).0.status,
            if truncated {
                OperationStatus::Unknown
            } else {
                OperationStatus::Succeeded
            }
        );
        let store = zero_store::Store::open_read_only(dir.path().join("state.db")).unwrap();
        let budget = store.budget(&session).unwrap();
        assert_eq!(
            (budget.charged, budget.reserved),
            if truncated { (0, 10) } else { (2, 0) }
        );
        drop(store);
        drop(observer);
        assert_eq!(http.requests.lock().unwrap().len(), 1);
        engine.shutdown().await.unwrap();
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn full_progress_channel_cannot_cancel_a_later_sandbox_tool() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("app.js"), "fixture\n").unwrap();
    let docker = dir.path().join("fake-docker");
    fs::write(
        &docker,
        include_bytes!("../../zero-executor/tests/fixtures/fake-docker.py"),
    )
    .unwrap();
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(dir.path().join("scenario.txt"), "echo").unwrap();
    let http = Http::new(
        delta().repeat(100),
        vec![final_response(false, true), final_response(false, false)],
    )
    .await;
    let engine = Arc::new(Engine::open(dir.path().join("state.db"), Some(docker)).unwrap());
    http.configure(&engine);
    let session = session(&engine).await;
    let (tx, mut events) = mpsc::channel(64);
    let (ptx, mut updates) = mpsc::channel(1);
    let owner = engine.clone();
    let cmd = command("agent", &session, &source);
    let task = tokio::spawn(async move { owner.handle_with_progress(cmd, tx, ptx).await });
    assert!(matches!(
        progress(&mut events).await,
        ExecutionEvent::Admitted { .. }
    ));
    http.ready.cancelled().await;
    http.release.cancel();
    // Deliberately never drain model telemetry until both inference rounds and
    // the real subprocess fixture have settled. Operational capacity is separate.
    let reply = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        outcome(&reply).0.status,
        OperationStatus::Succeeded,
        "{reply:?}"
    );
    assert!(matches!(
        updates.try_recv().unwrap(),
        ExecutionEvent::ModelProgress { .. }
    ));
    let calls = fs::read_to_string(dir.path().join("calls.jsonl")).unwrap();
    assert!(calls.contains("start"));
    assert!(calls.contains("rm"));
    assert_eq!(http.requests.lock().unwrap().len(), 2);
    let store = zero_store::Store::open_read_only(dir.path().join("state.db")).unwrap();
    let budget = store.budget(&session).unwrap();
    assert_eq!((budget.charged, budget.reserved), (4, 0));
    drop(store);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn shared_progress_and_operational_channel_is_rejected_before_admission() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("app.js"), "fixture\n").unwrap();
    let http = Http::new(delta(), vec![final_response(false, false)]).await;
    let engine = Engine::open(dir.path().join("state.db"), None).unwrap();
    http.configure(&engine);
    let session = session(&engine).await;
    let (tx, mut rx) = mpsc::channel(1);
    let reply = engine
        .handle_with_progress(command("direct", &session, &source), tx.clone(), tx)
        .await;
    assert!(matches!(reply, Reply::Error { .. }));
    assert!(rx.try_recv().is_err());
    assert!(http.requests.lock().unwrap().is_empty());
    let store = zero_store::Store::open_read_only(dir.path().join("state.db")).unwrap();
    assert!(matches!(
        store.get_operation_by_command(&session, "request"),
        Err(zero_store::Error::NotFound(_))
    ));
    drop(store);
    engine.shutdown().await.unwrap();
}
