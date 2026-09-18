use serde_json::json;
use zero_store::{OperationStatus, Store};
#[test]
fn schema_v2_migration_keeps_unpinned_history_and_persists_distinct_activation_epochs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    let old = store.create_session("same-digest", 100).unwrap();
    let op = store
        .admit_command(&old.id, "cmd", &json!({"original":true}))
        .unwrap()
        .operation;
    store.begin_operation(&op.id, "owner").unwrap();
    store.reserve_budget(&old.id, &op.id, 7).unwrap();
    let before = store.events(&old.id, 0, 100).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP INDEX http_receipt_events; DROP INDEX http_rate_events; DROP TABLE http_rates; DROP TABLE http_dispatches; DROP TABLE http_accounts; DROP TABLE tool_approval_consumptions; DROP TABLE tool_approval_decisions; DROP TABLE tool_approvals; DROP TABLE operator_question_decisions; DROP TABLE operator_questions; DROP TABLE agent_steering; DROP TABLE agent_steering_windows; DROP TABLE source_triage_decisions; DROP TABLE agent_inputs; DROP TABLE operation_artifacts; DROP TABLE artifacts; ALTER TABLE sessions DROP COLUMN generation_epoch; PRAGMA user_version=2;")
        .unwrap();
    drop(conn);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.get_session(&old.id).unwrap(), old);
    assert_eq!(store.events(&old.id, 0, 100).unwrap(), before);
    assert_eq!(store.budget(&old.id).unwrap().reserved, 7);
    assert_eq!(
        store.get_operation(&op.id).unwrap().status,
        OperationStatus::Running
    );
    assert!(store.create_pinned_session("g", 0, 100).is_err());
    assert!(store.create_pinned_session("g", u64::MAX, 100).is_err());
    let first = store.create_pinned_session("same-digest", 1, 100).unwrap();
    let rollback = store.create_pinned_session("same-digest", 3, 100).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.get_session(&first.id).unwrap().generation_epoch,
        Some(1)
    );
    assert_eq!(
        store.get_session(&rollback.id).unwrap().generation_epoch,
        Some(3)
    );
    assert_eq!(store.get_session(&old.id).unwrap().generation_epoch, None);
    assert_eq!(store.list_sessions().unwrap().len(), 3);
    assert!(
        serde_json::to_value(&old)
            .unwrap()
            .get("generation_epoch")
            .is_none()
    );
}
#[test]
fn operation_details_are_owner_bound_atomic_bounded_and_allowed_after_settlement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 100).unwrap();
    let op = store
        .admit_command(&session.id, "cmd", &json!({}))
        .unwrap()
        .operation;
    assert!(
        store
            .append_operation_event(&op.id, "owner", "plugin.prepared", &json!({}))
            .is_err()
    );
    store.begin_operation(&op.id, "owner").unwrap();
    let before = store.events(&session.id, 0, 100).unwrap();
    assert!(
        store
            .append_operation_event(&op.id, "other", "plugin.prepared", &json!({}))
            .is_err()
    );
    assert!(
        store
            .append_operation_event(&op.id, "owner", "bad\nkind", &json!({}))
            .is_err()
    );
    assert!(
        store
            .append_operation_event(
                &op.id,
                "owner",
                "plugin.prepared",
                &json!("x".repeat(1024 * 1024))
            )
            .is_err()
    );
    assert_eq!(store.events(&session.id, 0, 100).unwrap(), before);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_detail BEFORE INSERT ON events WHEN NEW.kind='operation_detail' BEGIN SELECT RAISE(ABORT,'injected journal failure'); END;").unwrap();
    assert!(
        store
            .append_operation_event(
                &op.id,
                "owner",
                "plugin.prepared",
                &json!({"lease":"fixed"})
            )
            .is_err()
    );
    assert_eq!(store.events(&session.id, 0, 100).unwrap(), before);
    conn.execute_batch("DROP TRIGGER reject_detail").unwrap();
    let prepared = store
        .append_operation_event(
            &op.id,
            "owner",
            "plugin.prepared",
            &json!({"lease":"fixed","staging":"/tmp/owned-fixture"}),
        )
        .unwrap();
    assert_eq!(prepared.sequence, before.last().unwrap().sequence + 1);
    assert_eq!(prepared.kind, "operation_detail");
    assert_eq!(prepared.payload["kind"], "plugin.prepared");
    assert_eq!(prepared.payload["operation_id"], op.id);
    store
        .settle_operation(
            &op.id,
            "owner",
            OperationStatus::Succeeded,
            &json!({"result":"untrusted"}),
        )
        .unwrap();
    let released = store
        .append_operation_event(
            &op.id,
            "owner",
            "plugin.lease_released",
            &json!({"lease":"fixed"}),
        )
        .unwrap();
    assert_eq!(released.sequence, prepared.sequence + 2);
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.events(&session.id, released.sequence - 1, 1).unwrap(),
        vec![released]
    );
    assert_eq!(
        store.get_operation(&op.id).unwrap().status,
        OperationStatus::Succeeded
    );
}
