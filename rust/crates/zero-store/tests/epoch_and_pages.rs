use serde_json::json;
use zero_store::{Error, OperationStatus, Store};

#[test]
fn epoch_recovery_and_owner_publication_rollback_together() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    store.claim_engine_epoch("old").unwrap();
    let session = store.create_session("g", 10).unwrap();
    let operation = store
        .admit_command(&session.id, "cmd", &json!({}))
        .unwrap()
        .operation;
    store.begin_operation(&operation.id, "old").unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER stop_epoch BEFORE UPDATE ON engine_epoch BEGIN SELECT RAISE(ABORT,'injected epoch failure'); END;").unwrap();
    assert!(store.claim_engine_epoch("new").is_err());
    assert_eq!(
        store.get_operation(&operation.id).unwrap().status,
        OperationStatus::Running
    );
    let epoch: String = conn
        .query_row("SELECT owner FROM engine_epoch", [], |r| r.get(0))
        .unwrap();
    assert_eq!(epoch, "old");
    conn.execute_batch("DROP TRIGGER stop_epoch").unwrap();
    assert_eq!(store.claim_engine_epoch("new").unwrap(), 1);
    assert_eq!(
        store.get_operation(&operation.id).unwrap().status,
        OperationStatus::Unknown
    );
    assert!(store.claim_engine_epoch("new").is_err());
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert!(
        reopened
            .admit_command(&session.id, "cmd", &json!({}))
            .unwrap()
            .duplicate
    );
    assert!(reopened.begin_operation(&operation.id, "new").is_err());
}

#[test]
fn v1_migration_recovers_all_pre_epoch_owners_and_keeps_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 10).unwrap();
    let op = store
        .admit_command(&session.id, "cmd", &json!({}))
        .unwrap()
        .operation;
    store.begin_operation(&op.id, "legacy-owner").unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP INDEX http_receipt_events; DROP INDEX http_rate_events; DROP TABLE http_rates; DROP TABLE http_dispatches; DROP TABLE http_accounts; DROP TABLE tool_approval_consumptions; DROP TABLE tool_approval_decisions; DROP TABLE tool_approvals; DROP TABLE operator_question_decisions; DROP TABLE operator_questions; DROP TABLE agent_steering; DROP TABLE agent_steering_windows; DROP TABLE source_triage_decisions; DROP TABLE agent_inputs; DROP TABLE operation_artifacts; DROP TABLE artifacts; ALTER TABLE sessions DROP COLUMN generation_epoch; DROP TABLE engine_epoch; PRAGMA user_version=1;")
        .unwrap();
    drop(conn);
    let mut store = Store::open(&path).unwrap();
    // Opening alone must not claim/recover the database.
    assert_eq!(
        store.get_operation(&op.id).unwrap().status,
        OperationStatus::Running
    );
    assert_eq!(store.claim_engine_epoch("new").unwrap(), 1);
    assert_eq!(
        store.get_operation(&op.id).unwrap().status,
        OperationStatus::Unknown
    );
    assert_eq!(store.get_session(&session.id).unwrap().generation, "g");
}

#[test]
fn view_only_foreign_database_is_not_claimed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("foreign.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE VIEW foreign_view AS SELECT 1 AS n")
        .unwrap();
    assert!(matches!(Store::open(&path), Err(Error::ForeignDatabase)));
    assert_eq!(
        conn.query_row("PRAGMA application_id", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT n FROM foreign_view", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn pages_stop_at_byte_budget_and_continue_at_last_returned_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("state.db")).unwrap();
    let session = store.create_session("g", 10).unwrap();
    let payload = json!({"text":"x".repeat(1024*1024)});
    for n in 0..5 {
        store
            .admit_command(&session.id, &format!("c{n}"), &payload)
            .unwrap();
    }
    let first = store.events(&session.id, 0, 10000).unwrap();
    assert!(first.len() < 6);
    assert!(serde_json::to_vec(&first).unwrap().len() <= 4 * 1024 * 1024);
    let second = store
        .events(&session.id, first.last().unwrap().sequence, 10000)
        .unwrap();
    assert_eq!(first.len() + second.len(), 6);
    assert_eq!(
        second.first().unwrap().sequence,
        first.last().unwrap().sequence + 1
    );
}

#[test]
fn oversized_event_is_explicit_error_without_skipping_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("state.db")).unwrap();
    let session = store.create_session("g", 10).unwrap();
    store
        .admit_command(&session.id, "big", &json!({"text":"x".repeat(5*1024*1024)}))
        .unwrap();
    let first = store.events(&session.id, 0, 10).unwrap();
    assert_eq!(first.len(), 1);
    for _ in 0..2 {
        let error = store
            .events(&session.id, first[0].sequence, 10)
            .unwrap_err();
        assert!(error.to_string().contains("event 2 exceeds"));
    }
}

#[test]
fn ownerless_admission_recovers_as_not_started_atomically_without_replay() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    store.claim_engine_epoch("old").unwrap();
    let session = store.create_session("g", 10).unwrap();
    let op = store
        .admit_command(&session.id, "cmd", &json!({"task":"once"}))
        .unwrap()
        .operation;
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER stop_epoch BEFORE UPDATE ON engine_epoch BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    assert!(store.claim_engine_epoch("new").is_err());
    assert_eq!(
        store.get_operation(&op.id).unwrap().status,
        OperationStatus::Admitted
    );
    assert!(
        !store
            .events(&session.id, 0, 100)
            .unwrap()
            .iter()
            .any(|e| e.kind == "operation_not_started")
    );
    conn.execute_batch("DROP TRIGGER stop_epoch").unwrap();
    assert_eq!(store.claim_engine_epoch("new").unwrap(), 1);
    let recovered = store.get_operation(&op.id).unwrap();
    assert_eq!(recovered.status, OperationStatus::Failed);
    assert!(recovered.owner.is_none());
    assert_eq!(recovered.outcome.as_ref().unwrap()["reason"], "not_started");
    assert_eq!(
        recovered.outcome.as_ref().unwrap()["external_effects_started"],
        false
    );
    let retry = store
        .admit_command(&session.id, "cmd", &json!({"task":"once"}))
        .unwrap();
    assert!(retry.duplicate);
    assert_eq!(retry.operation.status, OperationStatus::Failed);
    assert!(store.begin_operation(&op.id, "new").is_err());
    assert_eq!(store.claim_engine_epoch("third").unwrap(), 0);
    assert_eq!(
        store
            .events(&session.id, 0, 100)
            .unwrap()
            .iter()
            .filter(|e| e.kind == "operation_not_started")
            .count(),
        1
    );
}
