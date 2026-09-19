#![allow(clippy::unwrap_used)]
use rusqlite::Connection;
use serde_json::json;
use zero_store::{Error, Store};
fn prior(conn: &Connection) {
    conn.execute_batch("DROP INDEX native_repair_admission_command; DROP INDEX native_repair_parent_command; DROP INDEX native_repair_command; DROP TABLE native_repairs; PRAGMA user_version=20;").unwrap();
}
fn version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap()
}
#[test]
fn exact_schema_twenty_migrates_without_changing_existing_journal_or_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let session = store.create_session("legacy", 10).unwrap();
    let op = store
        .admit_command(&session.id, "legacy-command", &json!({"kind":"legacy"}))
        .unwrap()
        .operation;
    store.begin_operation(&op.id, "owner").unwrap();
    let digest = store
        .retain_operation_artifact(&op.id, "owner", "legacy", b"exact bytes")
        .unwrap();
    let operation = serde_json::to_value(store.get_operation(&op.id).unwrap()).unwrap();
    let events = serde_json::to_value(store.events(&session.id, 0, 100).unwrap()).unwrap();
    drop(store);
    let conn = Connection::open(&path).unwrap();
    prior(&conn);
    assert!(matches!(
        Store::open_read_only(&path),
        Err(Error::Schema(20))
    ));
    assert_eq!(version(&conn), 20);
    let store = Store::open(&path).unwrap();
    assert_eq!(version(&conn), 21);
    assert_eq!(
        serde_json::to_value(store.get_operation(&op.id).unwrap()).unwrap(),
        operation
    );
    assert_eq!(
        serde_json::to_value(store.events(&session.id, 0, 100).unwrap()).unwrap(),
        events
    );
    assert_eq!(store.artifact(&digest).unwrap(), b"exact bytes");
    assert!(store.native_repair_by_command("missing").unwrap().is_none());
    assert!(Store::open_read_only(&path).is_ok());
}
#[test]
fn altered_prior_schema_is_rejected_before_any_native_repair_ddl() {
    for change in [
        "CREATE INDEX unexpected ON sessions(created_at_ms);",
        "DROP INDEX native_reproduction_command; CREATE INDEX native_reproduction_command ON events(session_id);",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        drop(Store::open(&path).unwrap());
        let conn = Connection::open(&path).unwrap();
        prior(&conn);
        conn.execute_batch(change).unwrap();
        assert!(matches!(Store::open(&path), Err(Error::ForeignDatabase)));
        assert_eq!(version(&conn), 20);
        let count: u64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name LIKE 'native_repair%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
}
