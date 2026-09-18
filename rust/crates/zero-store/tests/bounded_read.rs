use serde_json::json;
use zero_store::Store;

#[test]
fn shared_budget_rejects_before_decode_and_reopens_readonly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("bounded", 10).unwrap();
    let operation = store
        .admit_command(&session.id, "c", &json!({"text":"x".repeat(2048)}))
        .unwrap()
        .operation;
    store.begin_operation(&operation.id, "owner").unwrap();
    let digest = store
        .retain_operation_artifact(&operation.id, "owner", "data", &vec![1; 4096])
        .unwrap();
    drop(store);
    let store = Store::open_read_only(&path).unwrap();
    let mut budget = 4095;
    assert!(store.artifact_bounded(&digest, 8192, &mut budget).is_err());
    assert_eq!(budget, 4095);
    budget = 8192;
    assert_eq!(
        store
            .artifact_bounded(&digest, 4096, &mut budget)
            .unwrap()
            .len(),
        4096
    );
    assert_eq!(budget, 4096);
    assert!(store.get_operation_bounded(&operation.id, &mut 1).is_err());
    assert_eq!(
        store
            .get_operation_by_command_bounded(&session.id, "c", &mut budget)
            .unwrap()
            .id,
        operation.id
    );
    assert!(budget < 4096);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "UPDATE operations SET payload=?1 WHERE id=?2",
        rusqlite::params!["!".repeat(1024), operation.id],
    )
    .unwrap();
    let error = store
        .get_operation_bounded(&operation.id, &mut 100)
        .unwrap_err();
    assert!(error.to_string().contains("budget"));
    conn.execute(
        "INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,999,'bad',?2)",
        rusqlite::params![session.id, "!".repeat(1024)],
    )
    .unwrap();
    let error = store
        .events_bounded(&session.id, 998, 1, &mut 100)
        .unwrap_err();
    assert!(error.to_string().contains("budget"));
    assert!(
        store
            .events_bounded(&session.id, 0, 1, &mut 8192)
            .unwrap()
            .len()
            == 1
    );
}
