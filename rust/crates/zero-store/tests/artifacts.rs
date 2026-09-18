use serde_json::json;
use zero_store::{OperationStatus, Store};

#[test]
fn retained_artifacts_are_immutable_attributed_deduplicated_and_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("source", 100).unwrap();
    let operation = store
        .admit_command(&session.id, "review", &json!({}))
        .unwrap()
        .operation
        .id;
    assert!(
        store
            .retain_operation_artifact(&operation, "owner", "source", b"source bytes")
            .is_err()
    );
    store.begin_operation(&operation, "owner").unwrap();
    assert!(
        store
            .retain_operation_artifact(&operation, "impostor", "source", b"source bytes")
            .is_err()
    );
    let id = store
        .retain_operation_artifact(&operation, "owner", "source", b"source bytes")
        .unwrap();
    let count = store.events(&session.id, 0, 100).unwrap().len();
    assert_eq!(
        store
            .retain_operation_artifact(&operation, "owner", "source", b"source bytes")
            .unwrap(),
        id
    );
    assert_eq!(store.events(&session.id, 0, 100).unwrap().len(), count);
    assert!(
        store
            .retain_operation_artifact(&operation, "owner", "source", b"replacement")
            .is_err()
    );
    assert_eq!(store.artifact(&id).unwrap(), b"source bytes");
    store
        .settle_operation(
            &operation,
            "owner",
            OperationStatus::Succeeded,
            &json!({"source":id}),
        )
        .unwrap();
    assert_eq!(
        store
            .retain_operation_artifact(&operation, "owner", "source", b"source bytes")
            .unwrap(),
        id
    );
    assert!(
        store
            .retain_operation_artifact(&operation, "owner", "new", b"new")
            .is_err()
    );
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.operation_artifacts(&operation).unwrap()["source"], id);
    assert_eq!(store.artifact(&id).unwrap(), b"source bytes");
    let events = store.events(&session.id, 0, 100).unwrap();
    let event = events
        .iter()
        .find(|e| e.kind == "operation_artifact")
        .unwrap();
    assert_eq!(event.payload["digest"], id);
    assert!(!event.payload.to_string().contains("source bytes"));
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
        rusqlite::params![b"corrupt".as_slice(), id],
    )
    .unwrap();
    assert!(store.artifact(&id).is_err());
}

#[test]
fn artifact_event_failure_rolls_back_bytes_and_attachment_and_v3_migrates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("source", 100).unwrap();
    let op = store
        .admit_command(&session.id, "review", &json!({}))
        .unwrap()
        .operation
        .id;
    store.begin_operation(&op, "owner").unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP INDEX campaign_root_lifecycle; DROP INDEX campaign_exposure_witness; DROP TABLE campaign_debits; DROP TABLE campaign_exposures; DROP TABLE campaign_runs; DROP TABLE campaigns; DROP INDEX web_experiment_quota_events; DROP TABLE web_experiment_admissions; DROP TABLE web_triage_decisions; DROP INDEX http_receipt_events; DROP INDEX http_rate_events; DROP TABLE http_rates; DROP TABLE http_dispatches; DROP TABLE http_accounts; DROP TABLE tool_approval_consumptions; DROP TABLE tool_approval_decisions; DROP TABLE tool_approvals; DROP TABLE operator_question_decisions; DROP TABLE operator_questions; DROP TABLE agent_steering; DROP TABLE agent_steering_windows; DROP TABLE source_triage_decisions; DROP TABLE agent_inputs; DROP TABLE operation_artifacts; DROP TABLE artifacts; PRAGMA user_version=3;",
    )
    .unwrap();
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        store.get_operation(&op).unwrap().status,
        OperationStatus::Running
    );
    conn.execute_batch("CREATE TRIGGER deny_artifact_event BEFORE INSERT ON events WHEN NEW.kind='operation_artifact' BEGIN SELECT RAISE(FAIL,'injected'); END;").unwrap();
    assert!(
        store
            .retain_operation_artifact(&op, "owner", "source", b"bytes")
            .is_err()
    );
    assert!(store.operation_artifacts(&op).unwrap().is_empty());
    let count: i64 = conn
        .query_row("SELECT count(*) FROM artifacts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    conn.execute_batch("DROP TRIGGER deny_artifact_event;")
        .unwrap();
    assert!(
        store
            .retain_operation_artifact(&op, "owner", "../escape", b"x")
            .is_err()
    );
    assert!(
        store
            .retain_operation_artifact(
                &op,
                "owner",
                "large",
                &vec![0; zero_store::MAX_ARTIFACT_BYTES + 1]
            )
            .is_err()
    );
    for i in 0..64 {
        store
            .retain_operation_artifact(&op, "owner", &format!("a{i}"), b"same")
            .unwrap();
    }
    assert!(
        store
            .retain_operation_artifact(&op, "owner", "a65", b"same")
            .is_err()
    );
}
