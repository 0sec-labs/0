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
    assert!(Engine::open(&path, None).is_err()); // Worker still owns the lock.
    let notification = workers.changed.notified();
    drop(guard);
    notification.await;
    assert_eq!(workers.count.load(Ordering::Acquire), 0);
    assert!(weak.upgrade().is_none());
    assert!(Engine::open(path, None).is_ok());
}

#[cfg(target_os = "linux")]
#[test]
#[allow(unsafe_code)] // Only the signal-safe pre-exec synchronization fixture.
fn final_owner_release_is_not_delayed_by_a_child_waiting_before_exec() {
    use std::{
        io::{Read, Write},
        os::{
            fd::AsRawFd,
            unix::{net::UnixStream, process::CommandExt},
        },
        process::Command,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let engine = Engine::open(&path, None).unwrap();
    let (mut controller, child_socket) = UnixStream::pair().unwrap();
    controller
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let child_fd = child_socket.as_raw_fd();
    let mut command = Command::new("/bin/true");
    // SAFETY: after fork this callback calls only async-signal-safe read/write
    // on an already-open socket; it allocates nothing and acquires no Rust lock.
    unsafe {
        command.pre_exec(move || {
            let mut byte = 1u8;
            if libc::write(child_fd, (&byte as *const u8).cast(), 1) != 1
                || libc::read(child_fd, (&mut byte as *mut u8).cast(), 1) != 1
            {
                libc::_exit(125);
            }
            Ok(())
        });
    }
    let spawning = std::thread::spawn(move || {
        let mut child = command.spawn().unwrap();
        drop(child_socket);
        child.wait().unwrap()
    });
    let mut ready = [0];
    controller.read_exact(&mut ready).unwrap();
    // The other process has inherited the lock's open file description and is
    // deliberately stopped before exec can apply CLOEXEC. It does no DB work.
    assert!(Engine::open(&path, None).is_err());
    drop(engine);
    let reopened = Engine::open(&path, None);
    // Always release/reap the child before assertions, including on regression.
    controller.write_all(&[1]).unwrap();
    assert!(spawning.join().unwrap().success());
    assert!(
        reopened.is_ok(),
        "final owner left inherited lock held: {:?}",
        reopened.err()
    );
}

#[test]
fn dropped_controller_retires_its_actual_actor_without_overwriting_a_settled_actor() {
    for actor_finished in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path().join("state.db"), None).unwrap();
        let (session, operations) = {
            let mut store = engine.shared.store.lock().unwrap();
            let session = store.create_session("guard-fixture", 10).unwrap().id;
            let operations = store
                .admit_owned_batch(
                    &session,
                    &engine.shared.owner,
                    &[
                        (
                            "controller".into(),
                            serde_json::json!({"kind":"test_controller"}),
                        ),
                        ("actor".into(), serde_json::json!({"kind":"test_actor"})),
                    ],
                )
                .unwrap();
            if actor_finished {
                store
                    .settle_operation(
                        &operations[1].id,
                        &engine.shared.owner,
                        OperationStatus::Succeeded,
                        &serde_json::json!({"completed":true}),
                    )
                    .unwrap();
            }
            (session, operations)
        };
        let cancel = CancellationToken::new();
        let mut guard = WorkerGuard::new(
            Arc::clone(&engine.shared),
            &session,
            &operations[0].id,
            cancel.clone(),
        );
        guard.track_operation(&operations[1].id);
        drop(guard); // Models an unwinding controller before its durable settlement.
        assert!(cancel.is_cancelled());
        assert!(engine.shared.control.lock().unwrap().closing);
        let store = engine.shared.store.lock().unwrap();
        assert_eq!(
            store.get_operation(&operations[0].id).unwrap().status,
            OperationStatus::Unknown
        );
        assert_eq!(
            store.get_operation(&operations[1].id).unwrap().status,
            if actor_finished {
                OperationStatus::Succeeded
            } else {
                OperationStatus::Unknown
            }
        );
        store.validate_session_admission_closure(&session).unwrap();
        assert_eq!(engine.shared.workers.count.load(Ordering::Acquire), 0);
    }
}
