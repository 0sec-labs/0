#![allow(clippy::unwrap_used)]
use super::*;
use std::time::Duration;

#[tokio::test]
async fn shutdown_waits_for_worker_ownership_even_after_active_registration_is_removed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let engine = Engine::open(&path, None).unwrap();
    let mut guard = {
        let _control = engine.shared.control.lock().unwrap();
        WorkerGuard::new(
            Arc::clone(&engine.shared),
            "settled-session",
            "settled-operation",
            CancellationToken::new(),
        )
    };
    guard.settled = true;
    // Model the guard destructor boundary: no registered work remains, but the
    // worker still owns Shared. No sleeps or lock-acquisition retries hide it.
    assert!(engine.shared.control.lock().unwrap().active.is_empty());
    assert_eq!(engine.shared.workers.count.load(Ordering::Acquire), 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), engine.shutdown())
            .await
            .is_err()
    );
    let weak = Arc::downgrade(&engine.shared);
    drop(guard);
    engine.shutdown().await.unwrap();
    assert_eq!(Arc::strong_count(&engine.shared), 1);
    drop(engine);
    assert!(weak.upgrade().is_none());
    assert!(Engine::open(&path, None).is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_execution_reply_releases_worker_before_immediate_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("main"), "fixture").unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    let path = dir.path().join("state.db");
    for iteration in 0..64 {
        let engine = Engine::open(&path, Some(dir.path().join("must-not-execute"))).unwrap();
        let session = engine
            .shared
            .store
            .lock()
            .unwrap()
            .create_session("g", 1)
            .unwrap()
            .id;
        let (events, receiver) = mpsc::channel(1);
        drop(receiver); // cancel admission before backend dispatch
        let request = zero_protocol::sandbox::SandboxRequest {
            execution_id: format!("run-{iteration}"),
            backend: zero_protocol::sandbox::SandboxBackend::Docker {
                image: "fixture:local".into(),
            },
            snapshot: snapshot.clone(),
            argv: vec!["true".into()],
            build_argv: None,
            stdin: None,
            timeout_ms: 1000,
            memory_mb: 128,
            cpus: 1.0,
            max_output_bytes: 1024,
        };
        let result = engine
            .handle(
                Command::RunSandbox {
                    session_id: session,
                    command_id: format!("cmd-{iteration}"),
                    request,
                },
                events,
            )
            .await;
        assert!(
            matches!(result, Reply::Sandbox { operation, .. } if operation.status==OperationStatus::Cancelled)
        );
        assert_eq!(engine.shared.workers.count.load(Ordering::Acquire), 0);
        assert_eq!(Arc::strong_count(&engine.shared), 1);
        engine.shutdown().await.unwrap();
        drop(engine);
        // Reopen exactly once on each iteration. A delayed worker Arc is a failure.
        let reopened = Engine::open(&path, None).unwrap();
        drop(reopened);
    }
}

#[tokio::test]
async fn completion_notification_follows_release_of_last_engine_reference() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let engine = Engine::open(&path, None).unwrap();
    let weak = Arc::downgrade(&engine.shared);
    let workers = Arc::clone(&engine.shared.workers);
    let mut guard = WorkerGuard::new(
        Arc::clone(&engine.shared),
        "session",
        "operation",
        CancellationToken::new(),
    );
    guard.settled = true;
    drop(engine);
    let notification = workers.changed.notified();
    drop(guard);
    notification.await;
    assert_eq!(workers.count.load(Ordering::Acquire), 0);
    assert!(weak.upgrade().is_none());
    assert!(Engine::open(path, None).is_ok());
}
