use super::*;

#[cfg(unix)]
#[test]
fn symlink_db_alias_shares_owner_and_hardlink_alias_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let engine = Engine::open(&path, None).unwrap();
    let symlink = dir.path().join("symlink.db");
    std::os::unix::fs::symlink(&path, &symlink).unwrap();
    assert!(Engine::open(&symlink, None).is_err());
    let hardlink = dir.path().join("hardlink.db");
    std::fs::hard_link(&path, &hardlink).unwrap();
    assert!(Engine::open(&hardlink, None).is_err());
    std::fs::remove_file(hardlink).unwrap();
    drop(engine);
    assert!(Engine::open(symlink, None).is_ok());
}

#[cfg(unix)]
#[test]
fn lock_links_are_rejected_without_touching_the_target() {
    for hard in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let target = dir.path().join("sentinel");
        std::fs::write(&target, b"unchanged").unwrap();
        let lock = dir.path().join("state.db.engine-lock");
        if hard {
            std::fs::hard_link(&target, &lock).unwrap();
        } else {
            std::os::unix::fs::symlink(&target, &lock).unwrap();
        }
        assert!(Engine::open(&path, None).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"unchanged");
        assert!(!path.exists());
    }
}

#[test]
fn torn_legacy_owner_text_cannot_redirect_sqlite_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let engine = Engine::open(&path, None).unwrap();
    let operation = {
        let mut store = engine.shared.store.lock().unwrap();
        let session = store.create_session("g", 1).unwrap();
        let admission = store
            .admit_command(&session.id, "cmd", &serde_json::json!({}))
            .unwrap();
        store
            .begin_operation(&admission.operation.id, &engine.shared.owner)
            .unwrap()
    };
    drop(engine);
    let lock = dir.path().join("state.db.engine-lock");
    let unrelated = uuid::Uuid::new_v4().to_string();
    std::fs::write(&lock, &unrelated).unwrap();
    let restarted = Engine::open(path, None).unwrap();
    assert_eq!(
        restarted
            .shared
            .store
            .lock()
            .unwrap()
            .get_operation(&operation.id)
            .unwrap()
            .status,
        OperationStatus::Unknown
    );
    assert_eq!(std::fs::read_to_string(lock).unwrap(), unrelated);
}

#[test]
fn exclusive_owner_recovers_uncertain_effects_without_replaying() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let engine = Engine::open(&path, None).unwrap();
    assert!(Engine::open(&path, None).is_err());
    let operation_id = {
        let mut store = engine.shared.store.lock().unwrap();
        let session = store.create_session("generation-1", 100).unwrap();
        let admitted = store
            .admit_command(
                &session.id,
                "command-1",
                &serde_json::json!({"effect":"uncertain"}),
            )
            .unwrap();
        store
            .begin_operation(&admitted.operation.id, &engine.shared.owner)
            .unwrap();
        admitted.operation.id
    };
    drop(engine);
    let restarted = Engine::open(&path, Some(PathBuf::from("/nonexistent/docker"))).unwrap();
    let store = restarted.shared.store.lock().unwrap();
    let recovered = store.get_operation(&operation_id).unwrap();
    assert_eq!(recovered.status, OperationStatus::Unknown);
    assert_eq!(store.list_sessions().unwrap().len(), 1);
}

#[tokio::test]
async fn shutdown_closes_admission_and_session_state_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested/state.db");
    let engine = Engine::open(&path, None).unwrap();
    let (tx, _rx) = mpsc::channel(8);
    let Reply::Session { session } = engine
        .handle(
            Command::SessionCreate {
                generation: "g1".into(),
                budget_limit: 99,
            },
            tx.clone(),
        )
        .await
    else {
        panic!("session create failed")
    };
    engine.shutdown().await.unwrap();
    assert!(matches!(
        engine
            .handle(
                Command::SessionCreate {
                    generation: "g2".into(),
                    budget_limit: 99
                },
                tx.clone()
            )
            .await,
        Reply::Error { .. }
    ));
    drop(engine);
    let restarted = Engine::open(&path, None).unwrap();
    assert!(
        matches!(restarted.handle(Command::SessionGet { session_id: session.id }, tx).await, Reply::Session { session: persisted } if persisted.generation == "g1" && persisted.budget_limit == 99)
    );
}

#[tokio::test]
async fn worker_panic_closes_admission_marks_unknown_and_unblocks_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path().join("state.db"), None).unwrap();
    let (session_id, operation_id) = {
        let mut store = engine.shared.store.lock().unwrap();
        let session = store.create_session("g", 10).unwrap();
        let admission = store
            .admit_command(&session.id, "panic-command", &serde_json::json!({}))
            .unwrap();
        store
            .begin_operation(&admission.operation.id, &engine.shared.owner)
            .unwrap();
        (session.id, admission.operation.id)
    };
    let cancel = CancellationToken::new();
    engine.shared.control.lock().unwrap().active.insert(
        session_id.clone(),
        Active {
            command_id: "panic-command".into(),
            execution_id: "e".into(),
            cancel: cancel.clone(),
        },
    );
    let guard = WorkerGuard::new(&engine.shared, &session_id, &operation_id, cancel.clone());
    let worker = tokio::spawn(async move {
        let _guard = guard;
        panic!("fixture worker failure");
    });
    assert!(worker.await.is_err());
    tokio::time::timeout(std::time::Duration::from_secs(1), engine.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert!(cancel.is_cancelled());
    assert!(engine.shared.control.lock().unwrap().closing);
    assert_eq!(
        engine
            .shared
            .store
            .lock()
            .unwrap()
            .get_operation(&operation_id)
            .unwrap()
            .status,
        OperationStatus::Unknown
    );
}
