use serde_json::json;
use zero_store::{Error, OperationStatus, Store};
#[test]
fn journal_and_generation_survive_reopen_and_exact_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("native.sqlite");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("sha256:g1", 100).unwrap();
    let admitted = store
        .admit_command(&session.id, "c1", &json!({"b":2,"a":{"x":1}}))
        .unwrap();
    store
        .begin_operation(&admitted.operation.id, "owner-a")
        .unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.get_session(&session.id).unwrap(), session);
    assert_eq!(
        store.get_operation(&admitted.operation.id).unwrap().status,
        OperationStatus::Running
    );
    let retry = store
        .admit_command(&session.id, "c1", &json!({"a":{"x":1},"b":2}))
        .unwrap();
    assert!(retry.duplicate);
    assert_eq!(retry.operation.id, admitted.operation.id);
    assert!(matches!(
        store.admit_command(&session.id, "c1", &json!({"b":3})),
        Err(Error::Conflict(_))
    ));
    assert!(
        store
            .begin_operation(&admitted.operation.id, "owner-a")
            .is_err()
    );
    assert!(
        store
            .settle_operation(
                &admitted.operation.id,
                "owner-b",
                OperationStatus::Succeeded,
                &json!(null)
            )
            .is_err()
    );
    store
        .settle_operation(
            &admitted.operation.id,
            "owner-a",
            OperationStatus::Succeeded,
            &json!({"exit":0}),
        )
        .unwrap();
    store
        .settle_operation(
            &admitted.operation.id,
            "owner-a",
            OperationStatus::Succeeded,
            &json!({"exit":0}),
        )
        .unwrap();
    let first = store.events(&session.id, 0, 2).unwrap();
    let second = store.events(&session.id, first[1].sequence, 2).unwrap();
    assert_eq!(
        first
            .iter()
            .chain(&second)
            .map(|e| e.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );
    assert!(store.events(&session.id, 4, 2).unwrap().is_empty());
}
#[test]
fn concurrent_admission_commits_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("native.sqlite");
    let session = Store::open(&path).unwrap().create_session("g", 10).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let path = path.clone();
            let id = session.id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut store = Store::open(path).unwrap();
                barrier.wait();
                store.admit_command(&id, "same", &json!([1, 2])).unwrap()
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| !r.duplicate).count(), 1);
    assert!(
        results
            .iter()
            .all(|r| r.operation.id == results[0].operation.id)
    );
    assert_eq!(
        Store::open(path)
            .unwrap()
            .events(&session.id, 0, 100)
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn budgets_persist_reservations_deduplicate_and_record_overage() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("native.sqlite");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 100).unwrap();
    store.reserve_budget(&session.id, "r1", 80).unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.budget(&session.id).unwrap().reserved, 80);
    assert!(matches!(
        store.reserve_budget(&session.id, "r2", 21),
        Err(Error::BudgetExceeded)
    ));
    store.reserve_budget(&session.id, "r1", 80).unwrap();
    assert!(store.reserve_budget(&session.id, "r1", 79).is_err());
    let settled = store.settle_budget(&session.id, "r1", 120).unwrap();
    assert_eq!((settled.reserved, settled.charged), (0, 120));
    drop(store);
    let mut store = Store::open(path).unwrap();
    assert_eq!(
        store.settle_budget(&session.id, "r1", 120).unwrap().charged,
        120
    );
    assert!(store.settle_budget(&session.id, "r1", 80).is_err());
    assert!(matches!(
        store.reserve_budget(&session.id, "r2", 1),
        Err(Error::BudgetExceeded)
    ));
    assert_eq!(store.events(&session.id, 0, 100).unwrap().len(), 3);
}
#[test]
fn recovery_is_explicit_owner_scoped_and_never_reexecutes() {
    let mut store = Store::open(":memory:").unwrap();
    let session = store.create_session("g", 1).unwrap();
    let a = store
        .admit_command(&session.id, "a", &json!(1))
        .unwrap()
        .operation;
    let b = store
        .admit_command(&session.id, "b", &json!(2))
        .unwrap()
        .operation;
    store.begin_operation(&a.id, "dead").unwrap();
    store.begin_operation(&b.id, "live").unwrap();
    assert_eq!(store.recover_owner("dead").unwrap(), 1);
    assert_eq!(store.recover_owner("dead").unwrap(), 0);
    assert_eq!(
        store.get_operation(&a.id).unwrap().status,
        OperationStatus::Unknown
    );
    assert_eq!(
        store.get_operation(&b.id).unwrap().status,
        OperationStatus::Running
    );
    assert!(store.begin_operation(&a.id, "new").is_err());
    assert!(
        store
            .admit_command(&session.id, "a", &json!(1))
            .unwrap()
            .duplicate
    );
}
#[test]
fn foreign_and_future_databases_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE findings(id TEXT);")
        .unwrap();
    drop(conn);
    assert!(matches!(Store::open(path), Err(Error::ForeignDatabase)));
    let path = dir.path().join("future.sqlite");
    drop(Store::open(&path).unwrap());
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "user_version", 3).unwrap();
    drop(conn);
    assert!(matches!(Store::open(path), Err(Error::Schema(3))));
}
#[test]
fn targeted_unknown_is_owner_checked_and_preserves_siblings() {
    let mut store = Store::open(":memory:").unwrap();
    let s = store.create_session("g", 10).unwrap();
    let a = store
        .admit_command(&s.id, "a", &json!(1))
        .unwrap()
        .operation;
    let b = store
        .admit_command(&s.id, "b", &json!(2))
        .unwrap()
        .operation;
    store.begin_operation(&a.id, "owner").unwrap();
    store.begin_operation(&b.id, "owner").unwrap();
    assert!(
        store
            .mark_operation_unknown(&a.id, "wrong", "panic")
            .is_err()
    );
    assert_eq!(
        store.get_operation(&a.id).unwrap().status,
        OperationStatus::Running
    );
    store
        .mark_operation_unknown(&a.id, "owner", "panic")
        .unwrap();
    store
        .mark_operation_unknown(&a.id, "owner", "panic")
        .unwrap();
    assert_eq!(
        store.get_operation(&a.id).unwrap().status,
        OperationStatus::Unknown
    );
    assert_eq!(
        store.get_operation(&b.id).unwrap().status,
        OperationStatus::Running
    );
}
#[test]
fn concurrent_reservations_cannot_overbook() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("native.sqlite");
    let session = Store::open(&path)
        .unwrap()
        .create_session("g", 100)
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|n| {
            let path = path.clone();
            let id = session.id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut store = Store::open(path).unwrap();
                barrier.wait();
                store.reserve_budget(&id, &format!("r{n}"), 60)
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(Error::BudgetExceeded)))
            .count(),
        1
    );
    assert_eq!(
        Store::open(path)
            .unwrap()
            .budget(&session.id)
            .unwrap()
            .reserved,
        60
    );
}
