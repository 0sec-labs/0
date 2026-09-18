#![allow(clippy::unwrap_used)]
use serde_json::json;
use zero_store::{OperationStatus, Store};

#[test]
fn owned_batch_is_ordered_fresh_only_and_recovers_without_restarting_children() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    store.claim_engine_epoch("first").unwrap();
    let session = store.create_session("baseline", 100).unwrap();
    let intents = vec![
        ("group".into(), json!({"kind":"group"})),
        ("one".into(), json!({"parent":"root","task":1})),
        ("two".into(), json!({"parent":"root","task":2})),
    ];
    let before = store.events(&session.id, 0, 100).unwrap().len();
    let ops = store
        .admit_owned_batch(&session.id, "first", &intents)
        .unwrap();
    assert_eq!(
        ops.iter()
            .map(|op| op.command_id.as_str())
            .collect::<Vec<_>>(),
        vec!["group", "one", "two"]
    );
    assert!(ops.iter().all(|op| op.status == OperationStatus::Running && op.owner.as_deref() == Some("first")));
    let events = store.events(&session.id, 0, 100).unwrap();
    assert_eq!(events.len(), before + 6);
    for (pair, op) in events[before..].chunks_exact(2).zip(&ops) {
        assert_eq!(pair[0].kind, "command_admitted");
        assert_eq!(pair[0].payload["status"], "admitted");
        assert!(pair[0].payload["owner"].is_null());
        assert_eq!(pair[1].kind, "operation_started");
        assert_eq!(pair[1].payload["id"], op.id);
    }
    assert!(
        store
            .admit_owned_batch(&session.id, "first", &intents)
            .is_err()
    );
    assert_eq!(
        store.events(&session.id, 0, 100).unwrap().len(),
        events.len()
    );
    let budget = store.budget(&session.id).unwrap();
    assert_eq!((budget.charged, budget.reserved), (0, 0));
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    reopened.claim_engine_epoch("second").unwrap();
    for op in ops {
        assert_eq!(
            reopened.get_operation(&op.id).unwrap().status,
            OperationStatus::Unknown
        );
        assert!(reopened.begin_operation(&op.id, "second").is_err());
    }
}

#[test]
fn conflicting_later_command_and_event_failure_leave_no_partial_batch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("baseline", 100).unwrap();
    store
        .admit_command(&session.id, "existing", &json!({}))
        .unwrap();
    let before = store.events(&session.id, 0, 100).unwrap().len();
    assert!(
        store
            .admit_owned_batch(
                &session.id,
                "owner",
                &[("first".into(), json!({})), ("existing".into(), json!({})),]
            )
            .is_err()
    );
    assert!(
        store
            .get_operation_by_command(&session.id, "first")
            .is_err()
    );
    assert_eq!(store.events(&session.id, 0, 100).unwrap().len(), before);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_second_start BEFORE INSERT ON events WHEN NEW.kind='operation_started' AND json_extract(NEW.payload,'$.command_id')='second' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(
        store
            .admit_owned_batch(
                &session.id,
                "owner",
                &[("first".into(), json!({})), ("second".into(), json!({})),]
            )
            .is_err()
    );
    for command in ["first", "second"] {
        assert!(
            store
                .get_operation_by_command(&session.id, command)
                .is_err()
        );
    }
    assert_eq!(store.events(&session.id, 0, 100).unwrap().len(), before);
}

#[test]
fn invalid_or_oversized_intents_are_rejected_without_admission() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("state.db")).unwrap();
    let session = store.create_session("baseline", 100).unwrap();
    let before = store.events(&session.id, 0, 100).unwrap().len();
    for intents in [
        vec![],
        vec![("same".into(), json!({})), ("same".into(), json!({}))],
        (0..18)
            .map(|i| (format!("command-{i}"), json!({})))
            .collect(),
        vec![("large".into(), json!({"text":"x".repeat(4*1024*1024)}))],
        (0..9)
            .map(|i| {
                (
                    format!("aggregate-{i}"),
                    json!({"text":"x".repeat(4*1024*1024-32)}),
                )
            })
            .collect(),
    ] {
        assert!(
            store
                .admit_owned_batch(&session.id, "owner", &intents)
                .is_err()
        );
        assert_eq!(store.events(&session.id, 0, 100).unwrap().len(), before);
    }
}
