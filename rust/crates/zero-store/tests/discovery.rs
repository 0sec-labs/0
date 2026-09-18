#![allow(clippy::unwrap_used)]
use rusqlite::{Connection, params};
use serde_json::json;
use zero_protocol::OperationStatus;
use zero_store::Store;

fn review(store: &mut Store, session: &str, command: &str) -> (String, String) {
    let op = store
        .admit_command(
            session,
            command,
            &json!({"kind":"source_hypothesis_review","request":"PRIVATE-REQUEST"}),
        )
        .unwrap()
        .operation;
    store.begin_operation(&op.id, "owner").unwrap();
    // Discovery makes no validity claim about these artifact bytes.
    let digest = store
        .retain_operation_artifact(&op.id, "owner", "source.review", b"not a validated review")
        .unwrap();
    (op.id, digest)
}
fn noise(conn: &Connection, session: &str, count: u32) {
    for _ in 0..count {
        conn.execute("INSERT INTO events(session_id,sequence,kind,payload) SELECT ?1,coalesce(max(sequence),0)+1,'unrelated','deliberately not JSON' FROM events WHERE session_id=?1",[session]).unwrap();
    }
}
#[test]
fn bounded_raw_journal_windows_allow_empty_pages_and_resume_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 10).unwrap().id;
    let (op, digest) = review(&mut store, &session, "review");
    let conn = Connection::open(&path).unwrap();
    noise(&conn, &session, 260);
    let maximum: u64 = conn
        .query_row(
            "SELECT max(sequence) FROM events WHERE session_id=?1",
            [&session],
            |r| r.get(0),
        )
        .unwrap();
    let first = store.source_reviews(&session, None, 32).unwrap();
    assert!(first.reviews.is_empty());
    assert_eq!(first.next_before_sequence, Some(maximum - 127));
    drop(store);
    drop(conn);
    let store = Store::open_read_only(&path).unwrap();
    let second = store
        .source_reviews(&session, first.next_before_sequence, 32)
        .unwrap();
    assert!(second.reviews.is_empty());
    assert_eq!(second.next_before_sequence, Some(maximum - 255));
    let third = store
        .source_reviews(&session, second.next_before_sequence, 32)
        .unwrap();
    assert_eq!(third.reviews.len(), 1);
    assert!(third.next_before_sequence.is_none());
    assert_eq!(third.reviews[0].operation_id, op);
    assert_eq!(third.reviews[0].source_review_sha256, digest);
    assert_eq!(third.reviews[0].sequence, 2);
}
#[test]
fn candidate_limit_preserves_every_status_and_never_mixes_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 10).unwrap().id;
    let other = store.create_session("g", 10).unwrap().id;
    let statuses = [
        ("admitted", OperationStatus::Admitted),
        ("running", OperationStatus::Running),
        ("succeeded", OperationStatus::Succeeded),
        ("failed", OperationStatus::Failed),
        ("cancelled", OperationStatus::Cancelled),
        ("unknown", OperationStatus::Unknown),
    ];
    let conn = Connection::open(&path).unwrap();
    let mut expected = Vec::new();
    for (raw, status) in statuses {
        let (op, _) = review(&mut store, &session, raw);
        conn.execute(
            "UPDATE operations SET status=?2 WHERE id=?1",
            params![op, raw],
        )
        .unwrap();
        expected.push((op, status));
        review(&mut store, &other, raw);
    }
    let mut cursor = None;
    let mut observed = Vec::new();
    loop {
        let page = store.source_reviews(&session, cursor, 1).unwrap();
        for candidate in page.reviews {
            observed.push((candidate.operation_id, candidate.operation_status));
        }
        cursor = page.next_before_sequence;
        if cursor.is_none() {
            break;
        }
    }
    expected.reverse();
    assert_eq!(observed, expected);
    assert_eq!(
        store
            .source_reviews(&other, None, 32)
            .unwrap()
            .reviews
            .len(),
        6
    );
    for bad in [0, 33] {
        assert!(store.source_reviews(&session, None, bad).is_err());
    }
    assert!(store.source_reviews(&session, Some(u64::MAX), 1).is_err());
    assert!(store.source_reviews("absent", None, 1).is_err());
    assert!(
        store
            .source_reviews(&session, Some(0), 1)
            .unwrap()
            .reviews
            .is_empty()
    );
}
#[test]
fn readonly_catalog_never_recovers_or_parses_current_request_outcome_or_artifact_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let session = store.create_session("g", 10).unwrap().id;
    let (op, digest) = review(&mut store, &session, "running");
    store.reserve_budget(&session, &op, 7).unwrap();
    let conn = Connection::open(&path).unwrap();
    conn.execute("UPDATE operations SET payload=CAST(zeroblob(33554433) AS TEXT),outcome='invalid outcome JSON' WHERE id=?1",[&op]).unwrap();
    conn.execute(
        "UPDATE artifacts SET bytes=?2 WHERE digest=?1",
        params![digest, b"CORRUPT-SECRET-ARTIFACT".as_slice()],
    )
    .unwrap();
    let before = std::fs::read(&path).unwrap();
    let readonly = Store::open_read_only(&path).unwrap();
    let page = readonly.source_reviews(&session, None, 32).unwrap();
    assert_eq!(page.reviews.len(), 1);
    assert_eq!(page.reviews[0].operation_status, OperationStatus::Running);
    let wire = serde_json::to_string(&page).unwrap();
    for secret in [
        "PRIVATE-REQUEST",
        "CORRUPT-SECRET-ARTIFACT",
        "invalid outcome",
    ] {
        assert!(!wire.contains(secret));
    }
    assert!(
        readonly.artifact(&digest).is_err(),
        "detail integrity still rejects corrupted bytes"
    );
    assert_eq!(readonly.budget(&session).unwrap().reserved, 7);
    assert_eq!(
        conn.query_row("SELECT owner FROM engine_epoch", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "owner"
    );
    assert_eq!(before, std::fs::read(&path).unwrap());
}
#[test]
fn corrupt_metadata_is_an_explicit_error() {
    for mutation in [
        "UPDATE operations SET session_id='foreign'",
        "UPDATE operations SET command_id='other'",
        "UPDATE operations SET status='impossible'",
        "UPDATE operations SET status=printf('%04000d',1)",
        "UPDATE operation_artifacts SET digest='not-a-digest'",
        "UPDATE events SET payload='not JSON' WHERE kind='command_admitted'",
        "UPDATE events SET payload=json_set(payload,'$.session_id','foreign') WHERE kind='command_admitted'",
        "UPDATE events SET payload=json_set(payload,'$.status','running') WHERE kind='command_admitted'",
        "UPDATE events SET payload=json_set(payload,'$.id','missing') WHERE kind='command_admitted'",
        "UPDATE events SET payload=json_set(payload,'$.command_id','') WHERE kind='command_admitted'",
        "UPDATE events SET kind=printf('%0200d',1) WHERE kind='command_admitted'",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = Store::open(&path).unwrap();
        let session = store.create_session("g", 10).unwrap().id;
        review(&mut store, &session, "one");
        let mutation_conn = Connection::open(&path).unwrap();
        mutation_conn
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        mutation_conn.execute_batch(mutation).unwrap();
        assert!(
            store.source_reviews(&session, None, 32).is_err(),
            "accepted {mutation}"
        );
    }
}
#[test]
fn first_oversized_admission_errors_and_quota_stops_before_consuming_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 10).unwrap().id;
    let (op, _) = review(&mut store, &session, "one");
    let conn = Connection::open(&path).unwrap();
    let sequence: u64 = conn
        .query_row(
            "SELECT sequence FROM events WHERE session_id=?1 AND kind='command_admitted'",
            [&session],
            |r| r.get(0),
        )
        .unwrap();
    conn.execute("UPDATE events SET payload=CAST(zeroblob(33554433) AS TEXT) WHERE session_id=?1 AND sequence=?2",params![session,sequence]).unwrap();
    let page = store.source_reviews(&session, None, 32).unwrap();
    assert!(page.reviews.is_empty());
    assert_eq!(page.next_before_sequence, Some(sequence + 1));
    let error = store
        .source_reviews(&session, page.next_before_sequence, 32)
        .unwrap_err()
        .to_string();
    assert!(error.contains("32 MiB"));
    assert!(error.contains("cursor unchanged"));
    assert_eq!(
        store.get_operation(&op).unwrap().status,
        OperationStatus::Running
    );
}
#[test]
fn aggregate_decode_budget_paginates_large_admissions_without_skips() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 10).unwrap().id;
    let mut expected = Vec::new();
    for i in 0..6 {
        let op = store
            .admit_command(
                &session,
                &format!("large{i}"),
                &json!({"private":"x".repeat(12*1024*1024)}),
            )
            .unwrap()
            .operation;
        store.begin_operation(&op.id, "owner").unwrap();
        store
            .retain_operation_artifact(&op.id, "owner", "source.review", b"review")
            .unwrap();
        expected.push(op.id);
    }
    let first = store.source_reviews(&session, None, 32).unwrap();
    assert!(!first.reviews.is_empty());
    assert!(first.reviews.len() < 6);
    assert!(first.next_before_sequence.is_some());
    let second = store
        .source_reviews(&session, first.next_before_sequence, 32)
        .unwrap();
    assert!(second.next_before_sequence.is_none());
    let observed: Vec<_> = first
        .reviews
        .into_iter()
        .chain(second.reviews)
        .map(|r| r.operation_id)
        .collect();
    expected.reverse();
    assert_eq!(observed, expected);
}
#[test]
fn escaped_candidate_page_bound_keeps_unconsumed_candidate_on_next_page() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 10).unwrap().id;
    let mut expected = Vec::new();
    for i in 0..32 {
        let (op, _) = review(
            &mut store,
            &session,
            &format!("{i}{}", "\u{0001}".repeat(4000)),
        );
        expected.push(op);
    }
    let mut cursor = None;
    let mut observed = Vec::new();
    let mut pages = 0;
    loop {
        let page = store.source_reviews(&session, cursor, 32).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= 512 * 1024);
        observed.extend(page.reviews.iter().map(|r| r.operation_id.clone()));
        cursor = page.next_before_sequence;
        pages += 1;
        if cursor.is_none() {
            break;
        }
    }
    expected.reverse();
    assert_eq!(observed, expected);
    assert!(pages > 1);
}
