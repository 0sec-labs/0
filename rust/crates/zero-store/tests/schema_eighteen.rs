#![allow(clippy::unwrap_used)]
use rusqlite::{Connection, params, types::Value};
use serde_json::json;
use zero_store::{Error, Store};

type Rows = Vec<(String, Vec<Vec<Value>>)>;

fn retained_rows(conn: &Connection) -> Rows {
    let mut tables = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('reviews','source_archives','native_reproductions','native_repairs') ORDER BY name")
        .unwrap();
    let names = tables
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    names
        .into_iter()
        .map(|name| {
            let mut statement = conn
                .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                .unwrap();
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| (0..columns).map(|i| row.get(i)).collect())
                .unwrap()
                .collect::<rusqlite::Result<Vec<Vec<Value>>>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}

fn version(conn: &Connection) -> u32 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn historical(conn: &Connection, version: u32) {
    conn.execute_batch("DROP INDEX native_repair_admission_command; DROP INDEX native_repair_parent_command; DROP INDEX native_repair_command; DROP TABLE native_repairs; DROP INDEX native_reproduction_admission_command; DROP INDEX native_reproduction_parent_command; DROP INDEX native_reproduction_command; DROP TABLE native_reproductions; DROP INDEX source_archive_command; DROP TABLE source_archives; DROP INDEX review_command_created; DROP TABLE reviews;")
        .unwrap();
    if version == 16 {
        conn.execute_batch("DROP INDEX scan_command_created; DROP TABLE scans;")
            .unwrap();
    }
    conn.pragma_update(None, "user_version", version).unwrap();
}

#[test]
fn populated_seventeen_upgrade_preserves_all_rows_and_readonly_never_migrates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    store.claim_engine_epoch("original-owner").unwrap();
    let session = store.create_session("original-generation", 100).unwrap();
    let root = store
        .admit_command(&session.id, "root", &json!({"retained":"root"}))
        .unwrap()
        .operation;
    let controller = store
        .admit_command(&session.id, "controller", &json!({"retained":"controller"}))
        .unwrap()
        .operation;
    store.begin_operation(&root.id, "original-owner").unwrap();
    let digest = store
        .retain_operation_artifact(&root.id, "original-owner", "intent", b"original intent")
        .unwrap();
    store
        .reserve_budget(&session.id, "reservation", 13)
        .unwrap();
    drop(store);
    let conn = Connection::open(&path).unwrap();
    conn.execute("INSERT INTO scans(sequence,id,command_id,session_id,controller_operation_id,root_operation_id,intent_sha256,record,binding_sequence,close_reason,close_sequence) VALUES(1,'scan','scan-command',?1,?2,?3,?4,'original record',2,'deadline',3)", params![session.id,controller.id,root.id,digest]).unwrap();
    historical(&conn, 17);
    let before = retained_rows(&conn);
    assert!(matches!(
        Store::open_read_only(&path),
        Err(Error::Schema(17))
    ));
    assert_eq!(version(&conn), 17);
    assert_eq!(retained_rows(&conn), before);

    drop(Store::open(&path).unwrap());
    assert_eq!(version(&conn), 21);
    assert_eq!(retained_rows(&conn), before);
    let reader = Store::open_read_only(&path).unwrap();
    assert_eq!(reader.artifact(&digest).unwrap(), b"original intent");
    assert_eq!(
        reader.get_operation(&root.id).unwrap().owner.as_deref(),
        Some("original-owner")
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM reviews", [], |row| row
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
    drop(Store::open(&path).unwrap());
    assert_eq!(retained_rows(&conn), before);
}

#[test]
fn changed_historical_schemas_reject_before_any_migration() {
    for prior in [16, 17] {
        for change in [
            "CREATE INDEX unauthorized_index ON sessions(created_at_ms)",
            "DROP INDEX http_rate_events; CREATE INDEX http_rate_events ON events(session_id)",
            "DROP TABLE engine_epoch; CREATE TABLE engine_epoch(singleton INTEGER PRIMARY KEY,owner TEXT NOT NULL)",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("state.db");
            drop(Store::open(&path).unwrap());
            let conn = Connection::open(&path).unwrap();
            historical(&conn, prior);
            conn.execute_batch(change).unwrap();
            let before = retained_rows(&conn);
            assert!(
                matches!(Store::open(&path), Err(Error::ForeignDatabase)),
                "schema {prior}: {change}"
            );
            assert_eq!(version(&conn), prior);
            assert_eq!(retained_rows(&conn), before);
            assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('reviews','review_command_created')", [], |row| row.get::<_, u32>(0)).unwrap(), 0);
        }
    }
}

#[test]
fn review_schema_is_exact_and_enforces_byte_and_close_constraints() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let session = store.create_session("generation", 100).unwrap();
    let root = store
        .admit_command(&session.id, "root", &json!({}))
        .unwrap()
        .operation;
    let controller = store
        .admit_command(&session.id, "controller", &json!({}))
        .unwrap()
        .operation;
    store.begin_operation(&root.id, "owner").unwrap();
    let digest = store
        .retain_operation_artifact(&root.id, "owner", "intent", b"intent")
        .unwrap();
    drop(store);
    let conn = Connection::open(&path).unwrap();
    assert_eq!(version(&conn), 21);
    let (scan_sql, review_sql): (String, String) = conn.query_row("SELECT (SELECT sql FROM sqlite_schema WHERE name='scans'),(SELECT sql FROM sqlite_schema WHERE name='reviews')", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert_eq!(
        review_sql,
        scan_sql.replacen("CREATE TABLE scans", "CREATE TABLE reviews", 1)
    );
    // Exercise the SQL checks independently of the higher-level review API.
    let insert = "INSERT INTO reviews(sequence,id,command_id,session_id,controller_operation_id,root_operation_id,intent_sha256,record,binding_sequence,close_reason,close_sequence) VALUES(1,'review','command',?5,?6,?7,?8,?1,?2,?3,?4)";
    for (record, binding, reason, sequence) in [
        ("é".repeat(32769), 1, None, None),
        (String::new(), 0, None, None),
        (String::new(), 1, Some("other"), Some(1)),
        (String::new(), 1, Some("cancelled"), None),
        (String::new(), 1, None, Some(1)),
    ] {
        assert!(
            conn.execute(
                insert,
                params![
                    record,
                    binding,
                    reason,
                    sequence,
                    session.id,
                    controller.id,
                    root.id,
                    digest
                ]
            )
            .is_err()
        );
    }
    conn.execute(
        insert,
        params![
            "é".repeat(32768),
            1,
            "cancelled",
            1,
            session.id,
            controller.id,
            root.id,
            digest
        ],
    )
    .unwrap();
    assert!(Store::open_read_only(&path).is_ok());
    conn.execute_batch("DROP INDEX review_command_created; CREATE INDEX review_command_created ON events(json_extract(payload,'$.command_id')) WHERE kind='scan_created';").unwrap();
    assert!(matches!(
        Store::open_read_only(&path),
        Err(Error::ForeignDatabase)
    ));
}
