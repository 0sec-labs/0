#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_protocol::{review::*, session::OperationStatus};
use zero_store::{ReviewAdmission, Store};
fn hash(v: &Value) -> String {
    zero_web_verification::hash(v).unwrap()
}
fn prepared() -> ReviewAdmission {
    let profile:ReviewProfile=serde_json::from_value(json!({"schema_version":1,"provider":"p","model":"m","instructions":"Host review","question":"Inspect input handling","execution":{"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"budget_limit":10,"currency":"units","reservation_per_turn":6,"max_turns":3,"max_hypotheses":2,"deadline_ms":60000})).unwrap();
    let files = json!([{"path":"app.rs","digest":format!("sha256:{}","b".repeat(64)),"bytes":10}]);
    let snapshot: zero_protocol::SnapshotPin = serde_json::from_value(
        json!({"id":"source","root":"/source","files":files,"digest":hash(&files)}),
    )
    .unwrap();
    let root = uuid::Uuid::new_v4().to_string();
    let request = profile.request(snapshot.clone(), &root).unwrap();
    let tools: Vec<_> = [
        "list_source_files",
        "read_source_lines",
        "search_source_text",
        "execute_snapshot",
        "submit_source_hypotheses",
    ]
    .into_iter()
    .map(|name| json!({"name":name,"description":"Host tool","parameters":{"type":"object"}}))
    .collect();
    let template = json!({"model":"m","instructions":request.instructions,"input":[],"max_output_tokens":8192,"tools":tools});
    let pins = json!({"p":{"endpoint":"http://127.0.0.1:9090/responses","wire_api":"responses","rates":{"input":1,"cached_input":1,"output":1}}});
    ReviewAdmission {
        review_id: uuid::Uuid::new_v4().to_string(),
        session_id: uuid::Uuid::new_v4().to_string(),
        controller_operation_id: uuid::Uuid::new_v4().to_string(),
        root_operation_id: root,
        input_path: "./source".into(),
        canonical_path: "/source".into(),
        profile_name: "local".into(),
        profile,
        snapshot,
        root_payload: json!({"kind":"offline_snapshot_agent","request":request,"endpoint":pins["p"]["endpoint"],"rates":pins["p"]["rates"],"review_template":template}),
        provider_context: serde_json::from_value(pins).unwrap(),
    }
}
fn setup() -> (tempfile::TempDir, Store, ReviewAdmission) {
    let d = tempfile::tempdir().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    s.claim_engine_epoch("owner").unwrap();
    (d, s, prepared())
}
#[test]
fn atomic_capture_is_readable_without_source_config_or_replaying_after_owner_loss() {
    let (d, mut s, a) = setup();
    let admitted = s.admit_review("run", "owner", &a).unwrap();
    assert!(!admitted.duplicate);
    let before = s.review_snapshot(&a.review_id).unwrap();
    assert_eq!(before.budget.limit, 10);
    assert_eq!(before.budget.reserved, 0);
    assert_eq!(before.review.snapshot_sha256, a.snapshot.digest);
    assert_eq!(
        s.review_by_session(&a.session_id).unwrap().unwrap(),
        before.review
    );
    let mut retry = prepared();
    retry.profile.provider = "no-config".into();
    retry.snapshot.root = "/deleted".into();
    assert!(
        s.admit_review("run", "no-current-owner", &retry)
            .unwrap()
            .duplicate
    );
    retry.input_path = "./different".into();
    assert!(s.admit_review("run", "owner", &retry).is_err());
    s.claim_engine_epoch("next").unwrap();
    let recovered = s.review_snapshot(&a.review_id).unwrap();
    assert_eq!(recovered.controller_status, OperationStatus::Unknown);
    assert_eq!(recovered.root_status, OperationStatus::Unknown);
    assert!(s.admit_review("run", "next", &a).unwrap().duplicate);
    drop(s);
    let read = Store::open_read_only(d.path().join("db")).unwrap();
    assert_eq!(
        read.review_by_command("run").unwrap().unwrap(),
        before.review
    );
    assert!(read.review_by_command("missing").unwrap().is_none());
}
#[test]
fn late_insert_failure_rolls_back_the_entire_review_graph() {
    for table in ["reviews", "operation_artifacts"] {
        let (d, mut s, a) = setup();
        let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
        c.execute_batch(&format!(
            "CREATE TRIGGER deny BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT,'fixture'); END;"
        ))
        .unwrap();
        assert!(s.admit_review("run", "owner", &a).is_err());
        for t in [
            "reviews",
            "sessions",
            "operations",
            "artifacts",
            "events",
            "reservations",
        ] {
            assert_eq!(
                c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r
                    .get::<_, u64>(0))
                    .unwrap(),
                0,
                "{t}"
            );
        }
    }
}
#[test]
fn changed_snapshot_provider_or_template_authority_is_rejected_before_admission() {
    for mutate in 0..7 {
        let (d, mut s, mut a) = setup();
        match mutate {
            0 => a.snapshot.files[0].bytes += 1,
            1 => a.root_payload["rates"]["input"] = json!(99),
            2 => a.root_payload["http_context"] = json!({}),
            3 => a.root_payload["review_template"]["tools"][0]["name"] = json!("http_request"),
            4 => {
                a.root_payload["request"]["execution"]["backend"]["image"] =
                    json!(format!("sha256:{}", "c".repeat(64)))
            }
            5 => a.canonical_path = "/different".into(),
            _ => a.root_operation_id = a.controller_operation_id.clone(),
        }
        assert!(
            s.admit_review("run", "owner", &a).is_err(),
            "mutation{mutate}"
        );
        let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn cancellation_is_owned_durable_idempotent_and_does_not_fake_terminal_success() {
    let (d, mut s, a) = setup();
    s.admit_review("run", "owner", &a).unwrap();
    assert!(
        s.request_review_stop(&a.review_id, "other", ReviewCloseReason::Cancelled)
            .is_err()
    );
    assert!(
        s.request_review_stop(&a.review_id, "owner", ReviewCloseReason::Deadline)
            .is_err()
    );
    assert!(
        s.request_review_stop(&a.review_id, "owner", ReviewCloseReason::Cancelled)
            .unwrap()
    );
    assert!(
        !s.request_review_stop(&a.review_id, "owner", ReviewCloseReason::Cancelled)
            .unwrap()
    );
    let r = s.review_snapshot(&a.review_id).unwrap();
    assert_eq!(r.close_reason, Some(ReviewCloseReason::Cancelled));
    assert_eq!(r.root_status, OperationStatus::Running);
    drop(s);
    let r = Store::open_read_only(d.path().join("db"))
        .unwrap()
        .review_snapshot(&a.review_id)
        .unwrap();
    assert_eq!(r.close_reason, Some(ReviewCloseReason::Cancelled));
}
#[test]
fn generic_effects_and_budget_mutations_stay_closed_until_dedicated_controller_is_wired() {
    let (_d, mut s, a) = setup();
    s.admit_review("run", "owner", &a).unwrap();
    for payload in [
        a.root_payload.clone(),
        json!({"kind":"snapshot"}),
        json!({"kind":"agent_inference","parent_operation":a.root_operation_id}),
        json!({"kind":"agent_source_tool","parent_operation":a.root_operation_id}),
    ] {
        assert!(s.admit_command(&a.session_id, "bypass", &payload).is_err());
        assert!(
            s.admit_owned_batch(&a.session_id, "owner", &[("bypass".into(), payload)])
                .is_err()
        );
    }
    assert!(s.reserve_budget(&a.session_id, "invented", 6).is_err());
    assert!(
        s.reconcile_budget(&a.session_id, "invented", 0, "trust me")
            .is_err()
    );
    assert_eq!(s.review_snapshot(&a.review_id).unwrap().budget.reserved, 0);
}
#[test]
fn deleted_binding_or_changed_witness_cannot_remove_authority_or_enable_retry() {
    for sql in [
        "DELETE FROM reviews",
        "UPDATE reviews SET record=json_set(record,'$.canonical_path','/other')",
        "DELETE FROM events WHERE kind='review_created'",
        "DELETE FROM operation_artifacts WHERE name='review.intent'",
        "UPDATE operations SET payload=json_set(payload,'$.request.model','other') WHERE json_extract(payload,'$.kind')='offline_snapshot_agent'",
    ] {
        let (d, mut s, a) = setup();
        s.admit_review("run", "owner", &a).unwrap();
        let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
        c.execute_batch(sql).unwrap();
        assert!(s.review_by_command("run").is_err(), "{sql}");
        assert!(s.admit_review("run", "owner", &a).is_err(), "{sql}");
        assert!(
            s.admit_command(
                &a.session_id,
                "bypass",
                &json!({"kind":"responses_inference"})
            )
            .is_err(),
            "{sql}"
        );
    }
}
#[test]
fn stopped_projection_requires_exact_journal_witness() {
    let (d, mut s, a) = setup();
    s.admit_review("run", "owner", &a).unwrap();
    s.request_review_stop(&a.review_id, "owner", ReviewCloseReason::Cancelled)
        .unwrap();
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    c.execute(
        "UPDATE reviews SET close_reason=NULL,close_sequence=NULL",
        [],
    )
    .unwrap();
    assert!(s.review_snapshot(&a.review_id).is_err());
}
#[test]
fn wrong_owner_and_oversized_intent_leave_no_state() {
    let (_d, mut s, mut a) = setup();
    assert!(s.admit_review("run", "other", &a).is_err());
    a.root_payload["review_template"]["tools"][0]["description"] =
        json!("x".repeat(2 * 1024 * 1024));
    assert!(s.admit_review("run", "owner", &a).is_err());
    assert!(s.review_by_command("run").unwrap().is_none());
}
