#![allow(clippy::unwrap_used)]
use rusqlite::{Connection, params};
use serde_json::json;
use zero_protocol::OperationStatus;
use zero_store::Store;

#[test]
fn forward_http_catalog_crosses_large_unrelated_events_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 10).unwrap().id;
    let other = store.create_session("g", 10).unwrap().id;
    let conn = Connection::open(&path).unwrap();
    for _ in 0..260 {
        conn.execute("INSERT INTO events(session_id,sequence,kind,payload) SELECT ?1,coalesce(max(sequence),0)+1,'inference_request','unparsed noise' FROM events WHERE session_id=?1",[&session]).unwrap();
    }
    conn.execute(
        "UPDATE events SET payload=zeroblob(8388609) WHERE session_id=?1 AND sequence=2",
        [&session],
    )
    .unwrap();
    let op = store
        .admit_command(
            &session,
            "http",
            &json!({"kind":"agent_http","parent_operation":"actor"}),
        )
        .unwrap()
        .operation;
    store
        .admit_command(
            &other,
            "other-http",
            &json!({"kind":"agent_http","parent_operation":"other"}),
        )
        .unwrap();
    store.begin_operation(&op.id, "owner").unwrap();
    // A catalog never loads current request/outcome or claims evidence validity.
    conn.execute(
        "UPDATE operations SET payload='invalid json',outcome='invalid json' WHERE id=?1",
        [&op.id],
    )
    .unwrap();
    let first = store.http_operation_candidates(&session, None, 32).unwrap();
    assert!(first.operations.is_empty());
    assert_eq!(first.next_after_sequence, Some(128));
    drop(store);
    let store = Store::open_read_only(&path).unwrap();
    let second = store
        .http_operation_candidates(&session, first.next_after_sequence, 32)
        .unwrap();
    assert!(second.operations.is_empty());
    assert_eq!(second.next_after_sequence, Some(256));
    let third = store
        .http_operation_candidates(&session, second.next_after_sequence, 32)
        .unwrap();
    assert!(third.next_after_sequence.is_none());
    assert_eq!(third.operations.len(), 1);
    let candidate = &third.operations[0];
    assert_eq!(candidate.operation_id, op.id);
    assert_eq!(candidate.actor_operation_id, "actor");
    assert_eq!(candidate.operation_status, OperationStatus::Running);
    assert!(candidate.response_manifest_sha256.is_none());
    assert!(
        store
            .http_operation_candidates(&session, Some(u64::MAX), 1)
            .is_err()
    );
    assert!(store.http_operation_candidates(&session, None, 0).is_err());
    assert!(store.http_operation_candidates("absent", None, 1).is_err());
    conn.execute(
        "UPDATE operations SET session_id=?2 WHERE id=?1",
        params![op.id, other],
    )
    .unwrap();
    assert!(
        store
            .http_operation_candidates(&session, Some(261), 32)
            .is_err()
    );
}

#[test]
fn web_roots_remain_discoverable_without_a_terminal_review() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 10).unwrap().id;
    let request = json!({"provider":"p","model":"m","instructions":"i","prompt":"p","http_profile":"test","web_submission_max_hypotheses":2,"max_turns":2,"reservation_per_turn":10});
    let mut expected = vec![];
    let conn = Connection::open(&path).unwrap();
    for status in [
        "admitted",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "unknown",
    ] {
        let op = store
            .admit_command(
                &session,
                status,
                &json!({"kind":"scoped_web_agent","request":request}),
            )
            .unwrap()
            .operation;
        conn.execute("UPDATE operations SET status=?2,payload='not current JSON',outcome='not current JSON' WHERE id=?1",params![op.id,status]).unwrap();
        expected.push(op.id);
    }
    drop(store);
    let store = Store::open_read_only(&path).unwrap();
    let page = store.web_runs(&session, None, 32).unwrap();
    assert!(page.next_before_sequence.is_none());
    assert_eq!(page.runs.len(), 6);
    expected.reverse();
    assert_eq!(
        page.runs
            .iter()
            .map(|r| r.operation_id.clone())
            .collect::<Vec<_>>(),
        expected
    );
    assert!(page.runs.iter().all(|r| r.web_review_sha256.is_none()));
    conn.execute("UPDATE events SET payload=json_set(payload,'$.payload.kind','offline_snapshot_agent') WHERE session_id=?1 AND kind='command_admitted'",[&session]).unwrap();
    assert!(store.web_runs(&session, None, 32).is_err());
}
