#![allow(clippy::unwrap_used)]
use rusqlite::{Connection, params};
use serde_json::json;
use zero_protocol::web::WebTriageStatus as Status;
use zero_store::{OperationStatus, Store};
fn fixture(store: &mut Store, session: &str) -> (String, String, String) {
    let hypothesis = format!("sha256:{}", "a".repeat(64));
    let digest = format!("sha256:{}", "b".repeat(64));
    let request = json!({"provider":"p","model":"m","instructions":"i","prompt":"p","http_profile":"test","web_submission_max_hypotheses":2,"max_turns":2,"reservation_per_turn":10});
    let op = store
        .admit_command(
            session,
            "web",
            &json!({"kind":"scoped_web_agent","request":request}),
        )
        .unwrap()
        .operation;
    store.begin_operation(&op.id, "owner").unwrap();
    let review = json!({"schema_version":1,"request_sha256":digest,"completion_sha256":digest,"submission_call_id":"submit","model":"m","provider_response_id":null,"hypotheses":[{"id":hypothesis,"state":"unverified","claim":{"title":"Observation","category":"response","explanation":"Model claim only","claimed_impact":"Unknown","claimed_severity":"low","citations":[]}}],"evidence":[]});
    let artifact = store
        .retain_operation_artifact(
            &op.id,
            "owner",
            "web.review",
            &serde_json::to_vec(&review).unwrap(),
        )
        .unwrap();
    store.settle_operation(&op.id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","error":null,"web_review":{"review":review,"artifacts":{"web.review":artifact},"inference_operation":"inference"}})).unwrap();
    (op.id, hypothesis, artifact)
}
#[test]
fn web_triage_cas_exact_retry_restart_and_witness_tamper() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 100).unwrap().id;
    let (op, hypothesis, digest) = fixture(&mut store, &session);
    let record = store.web_finding(&session, &op, &hypothesis).unwrap();
    assert_eq!(record.revision, 0);
    assert_eq!(record.web_review_sha256, digest);
    let (_, first, duplicate) = store
        .triage_web_finding(
            &session,
            "one",
            &op,
            &hypothesis,
            Status::Accepted,
            0,
            "reviewed",
        )
        .unwrap();
    assert!(!duplicate);
    assert!(
        store
            .triage_web_finding(
                &session,
                "stale",
                &op,
                &hypothesis,
                Status::Suppressed,
                0,
                ""
            )
            .is_err()
    );
    store
        .triage_web_finding(
            &session,
            "two",
            &op,
            &hypothesis,
            Status::Suppressed,
            1,
            "suppressed",
        )
        .unwrap();
    let (current, retry, duplicate) = store
        .triage_web_finding(
            &session,
            "one",
            &op,
            &hypothesis,
            Status::Accepted,
            0,
            "reviewed",
        )
        .unwrap();
    assert!(duplicate);
    assert_eq!(retry.id, first.id);
    assert_eq!(current.revision, 2);
    drop(store);
    let store = Store::open_read_only(&path).unwrap();
    let (current, history) = store
        .web_finding_with_history(&session, &op, &hypothesis, 0, 100)
        .unwrap();
    assert_eq!(current.status, Status::Suppressed);
    assert_eq!(history.len(), 2);
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "UPDATE web_triage_decisions SET note='changed' WHERE id=?1",
        [first.id],
    )
    .unwrap();
    assert!(
        store
            .web_finding_with_history(&session, &op, &hypothesis, 0, 100)
            .is_err()
    );
}
#[test]
fn deleted_decision_cannot_reset_web_revision() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let session = store.create_session("g", 100).unwrap().id;
    let (op, hypothesis, _) = fixture(&mut store, &session);
    store
        .triage_web_finding(&session, "one", &op, &hypothesis, Status::Accepted, 0, "")
        .unwrap();
    Connection::open(&path)
        .unwrap()
        .execute(
            "DELETE FROM web_triage_decisions WHERE web_operation_id=?1",
            params![op],
        )
        .unwrap();
    assert!(store.web_finding(&session, &op, &hypothesis).is_err());
    assert!(
        store
            .triage_web_finding(&session, "two", &op, &hypothesis, Status::New, 0, "")
            .is_err()
    );
}
