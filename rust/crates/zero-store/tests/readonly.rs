#![allow(clippy::unwrap_used, clippy::expect_used)]
use serde_json::json;
use zero_store::{OperationStatus, Store};
#[test]
fn retained_source_bytes_are_hash_checked_and_running_owner_is_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut writer = Store::open(&path).unwrap();
    writer.claim_engine_epoch("active-owner").unwrap();
    let session = writer.create_session("source", 100).unwrap();
    let operation = writer
        .admit_command(&session.id, "review", &json!({}))
        .unwrap()
        .operation
        .id;
    writer.begin_operation(&operation, "active-owner").unwrap();
    let digest = writer
        .retain_operation_artifact(
            &operation,
            "active-owner",
            "source-bundle",
            b"retained source bytes",
        )
        .unwrap();
    let event_count = writer.events(&session.id, 0, 100).unwrap().len();
    let before = std::fs::read(&path).unwrap();
    let mut reader = Store::open_read_only(&path).unwrap();
    assert_eq!(
        reader.operation_artifacts(&operation).unwrap()["source-bundle"],
        digest
    );
    assert_eq!(reader.artifact(&digest).unwrap(), b"retained source bytes");
    let record = reader.get_operation(&operation).unwrap();
    assert_eq!(record.status, OperationStatus::Running);
    assert_eq!(record.owner.as_deref(), Some("active-owner"));
    assert_eq!(before, std::fs::read(&path).unwrap());
    assert!(reader.create_session("forbidden", 0).is_err());
    assert!(reader.claim_engine_epoch("intruder").is_err());
    assert!(
        reader
            .retain_operation_artifact(&operation, "active-owner", "new", b"forbidden")
            .is_err()
    );
    assert_eq!(
        writer.events(&session.id, 0, 100).unwrap().len(),
        event_count
    );
    let conn = rusqlite::Connection::open(&path).unwrap();
    let owner: String = conn
        .query_row(
            "SELECT owner FROM engine_epoch WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(owner, "active-owner");
    writer
        .retain_operation_artifact(&operation, "active-owner", "later", b"new active output")
        .unwrap();
    assert!(
        reader
            .operation_artifacts(&operation)
            .unwrap()
            .contains_key("later")
    );
    conn.execute(
        "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
        rusqlite::params![b"corruption".as_slice(), digest],
    )
    .unwrap();
    assert!(reader.artifact(&digest).is_err());
}
#[test]
fn missing_database_is_not_created() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.db");
    assert!(Store::open_read_only(&path).is_err());
    assert!(!path.exists());
}
#[test]
fn rejected_foreign_wal_database_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("foreign.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE unrelated(value TEXT);")
        .unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open_read_only(&path).is_err());
    assert_eq!(before, std::fs::read(&path).unwrap());
    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let mode: String = conn
        .pragma_query_value(None, "journal_mode", |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}
#[test]
fn older_or_future_schema_is_never_migrated() {
    for version in [3, 4, 5, 7] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        drop(Store::open(&path).unwrap());
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("DROP TABLE operation_artifacts; DROP TABLE artifacts;")
            .unwrap();
        conn.pragma_update(None, "user_version", version).unwrap();
        drop(conn);
        let before = std::fs::read(&path).unwrap();
        assert!(Store::open_read_only(&path).is_err());
        assert_eq!(before, std::fs::read(&path).unwrap());
        let conn = rusqlite::Connection::open(&path).unwrap();
        let actual: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(actual, version);
        let exists: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='artifacts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists, 0);
    }
}
#[test]
fn views_extra_objects_and_lookalike_tables_are_rejected() {
    for change in [
        "DROP TABLE artifacts; CREATE VIEW artifacts AS SELECT 'x' AS digest,X'00' AS bytes;",
        "CREATE VIEW unrelated AS SELECT 1;",
        "CREATE VIEW sqliteXshadow AS SELECT 1;",
        "CREATE INDEX extra_index ON artifacts(digest);",
        "DROP TABLE operation_artifacts; CREATE TABLE operation_artifacts(operation_id TEXT,name TEXT,digest TEXT);",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        drop(Store::open(&path).unwrap());
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(change).unwrap();
        drop(conn);
        assert!(Store::open_read_only(&path).is_err(), "{change}");
    }
}
#[cfg(unix)]
#[test]
fn leaf_symlink_is_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    drop(Store::open(&path).unwrap());
    let link = dir.path().join("link.db");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(Store::open_read_only(&link).is_err());
    assert!(Store::open_read_only(&path).is_ok());
}
