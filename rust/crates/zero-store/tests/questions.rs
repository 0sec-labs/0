use serde_json::json;
use zero_protocol::{
    Operation, OperationStatus,
    questions::{
        OperatorDecision as Decision, OperatorQuestionRequest as Request,
        OperatorQuestionStatus as Status,
    },
};
use zero_store::Store;
fn valid_actor_request() -> serde_json::Value {
    let sha = format!("sha256:{}", "a".repeat(64));
    let value = json!({"provider":"fixture","model":"fixture","instructions":"unchanged","prompt":"original","max_turns":3,"reservation_per_turn":1,"execution":{"execution_id":"profile","image":"fixture:local","snapshot":{"id":"s","root":"/tmp/source","digest":sha,"files":[{"path":"entry","digest":sha,"bytes":0}]},"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":1024}});
    let request: zero_protocol::agent::AgentRequest = serde_json::from_value(value).unwrap();
    request.validate_capabilities().unwrap();
    serde_json::to_value(request).unwrap()
}

fn request() -> Request {
    serde_json::from_value(json!({"questions":[{"header":"Choose","question":"Which local fixture?","options":[{"label":"A"},{"label":"B"}],"allow_custom":true}]})).unwrap()
}
fn answer() -> Decision {
    serde_json::from_value(json!({"type":"answer","answers":[{"question_index":0,"selected_indices":[1],"custom_text":"évidence"}]})).unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    session: String,
    actor: Operation,
    origin: Operation,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("state.db")).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let session = store.create_session("g", 100).unwrap().id;
        let mut request_payload = valid_actor_request();
        request_payload["operator_questions"] = json!(true);
        let actor = store
            .admit_command(
                &session,
                "actor",
                &json!({"kind":"offline_snapshot_agent","request":request_payload}),
            )
            .unwrap()
            .operation;
        let actor = store.begin_operation(&actor.id, "owner").unwrap();
        let origin=store.admit_command(&session,&format!("{}:model:0",actor.id),&json!({"kind":"agent_inference","parent_operation":actor.id,"request":{"tools":[{"name":"ask_operator"}]}})).unwrap().operation;
        store.begin_operation(&origin.id, "owner").unwrap();
        let completion = json!({"status":"completed","response_id":"r","content":[{"type":"tool_call","id":"ask","name":"ask_operator","arguments":request()}],"usage":null,"usage_is_final":false,"replay":[],"error":null});
        let origin = store
            .settle_operation(&origin.id, "owner", OperationStatus::Succeeded, &completion)
            .unwrap();
        Self {
            dir,
            store,
            session,
            actor,
            origin,
        }
    }
    fn create(&mut self) -> zero_protocol::questions::OperatorQuestionRecord {
        self.store
            .create_operator_question(
                &self.session,
                &self.actor.id,
                "owner",
                &format!("{}:tool:0:0", self.actor.id),
                "ask",
                &self.origin.id,
                &request(),
            )
            .unwrap()
    }
    fn sql(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.dir.path().join("state.db")).unwrap()
    }
}
#[test]
fn answer_is_atomic_durable_readonly_and_exact_retry_survives_owner_loss() {
    let mut f = Fixture::new();
    let q = f.create();
    assert_eq!(q.status, Status::Pending);
    let (r, receipt, dup) = f
        .store
        .decide_operator_question(
            &f.session,
            "decision",
            &q.operation_id,
            &q.request_sha256,
            &answer(),
            "owner",
        )
        .unwrap();
    assert!(!dup);
    assert_eq!(r.status, Status::Answered);
    assert_eq!(r.decision, Some(receipt.clone()));
    assert_eq!(
        f.store
            .operator_question_output(&f.session, &q.operation_id)
            .unwrap()["authorizes_nothing"],
        true
    );
    f.store.claim_engine_epoch("new-owner").unwrap();
    let retry = f
        .store
        .decide_operator_question(
            &f.session,
            "decision",
            &q.operation_id,
            &q.request_sha256,
            &answer(),
            "not-current",
        )
        .unwrap();
    assert!(retry.2);
    assert_eq!(retry.1, receipt);
    assert!(
        f.store
            .decide_operator_question(
                &f.session,
                "decision",
                &q.operation_id,
                &q.request_sha256,
                &Decision::Dismiss,
                "owner"
            )
            .is_err()
    );
    let reader = Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    assert_eq!(
        reader
            .get_operator_question(&f.session, &q.operation_id)
            .unwrap()
            .status,
        Status::Answered
    );
    assert_eq!(
        reader
            .operator_questions(&f.session, Some(&f.actor.id), 0, 10)
            .unwrap()
            .len(),
        1
    );
    assert!(
        reader
            .operator_questions(&f.session, None, q.sequence, 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        f.store.get_operation(&f.actor.id).unwrap().payload["request"]["instructions"],
        "unchanged"
    );
}
#[test]
fn cancellation_dismissal_and_restart_are_distinct_terminal_dispositions() {
    for action in ["dismiss", "cancel", "restart"] {
        let mut f = Fixture::new();
        let q = f.create();
        let expected = match action {
            "dismiss" => {
                f.store
                    .decide_operator_question(
                        &f.session,
                        "d",
                        &q.operation_id,
                        &q.request_sha256,
                        &Decision::Dismiss,
                        "owner",
                    )
                    .unwrap();
                Status::Dismissed
            }
            "cancel" => {
                f.store
                    .cancel_operator_question(&f.session, &q.operation_id, "owner")
                    .unwrap();
                Status::Cancelled
            }
            _ => {
                f.store.claim_engine_epoch("next").unwrap();
                Status::Interrupted
            }
        };
        assert_eq!(
            f.store
                .get_operator_question(&f.session, &q.operation_id)
                .unwrap()
                .status,
            expected
        );
        assert!(
            f.store
                .decide_operator_question(
                    &f.session,
                    "late",
                    &q.operation_id,
                    &q.request_sha256,
                    &answer(),
                    "owner"
                )
                .is_err()
        );
        if action == "restart" {
            assert!(
                f.store
                    .operator_question_output(&f.session, &q.operation_id)
                    .is_err()
            );
        }
    }
}
#[test]
fn failed_decision_event_rolls_back_both_answer_and_tool_settlement() {
    let mut f = Fixture::new();
    let q = f.create();
    f.sql().execute_batch("CREATE TRIGGER fail_question BEFORE INSERT ON events WHEN NEW.kind='operation_settled' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(
        f.store
            .decide_operator_question(
                &f.session,
                "d",
                &q.operation_id,
                &q.request_sha256,
                &answer(),
                "owner"
            )
            .is_err()
    );
    assert_eq!(
        f.store
            .get_operator_question(&q.session_id, &q.operation_id)
            .unwrap()
            .status,
        Status::Pending
    );
    assert!(
        f.store
            .operator_question_decision_by_command(&f.session, "d")
            .unwrap()
            .is_none()
    );
    f.sql().execute_batch("DROP TRIGGER fail_question").unwrap();
    assert!(
        !f.store
            .decide_operator_question(
                &f.session,
                "d",
                &q.operation_id,
                &q.request_sha256,
                &answer(),
                "owner"
            )
            .unwrap()
            .2
    );
}
#[test]
fn answer_and_cancel_race_has_one_durable_winner() {
    let mut f = Fixture::new();
    let q = f.create();
    let path = f.dir.path().join("state.db");
    let mut second = Store::open(&path).unwrap();
    let (s, k, h) = (
        f.session.clone(),
        q.operation_id.clone(),
        q.request_sha256.clone(),
    );
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let b = barrier.clone();
    let task = std::thread::spawn(move || {
        b.wait();
        second.decide_operator_question(&s, "answer", &k, &h, &answer(), "owner")
    });
    barrier.wait();
    let cancelled = f
        .store
        .cancel_operator_question(&f.session, &q.operation_id, "owner")
        .unwrap();
    let result = task.join().unwrap();
    let finalq = f
        .store
        .get_operator_question(&f.session, &q.operation_id)
        .unwrap();
    assert_eq!(cancelled.status, finalq.status);
    assert!(matches!(
        finalq.status,
        Status::Answered | Status::Cancelled
    ));
    assert_eq!(result.is_ok(), finalq.status == Status::Answered);
}
#[test]
fn request_call_and_read_witness_tampering_fail_closed() {
    for mutation in [
        "index",
        "request",
        "origin",
        "decision",
        "outcome",
        "oversized_id",
    ] {
        let mut f = Fixture::new();
        let q = f.create();
        f.store
            .decide_operator_question(
                &f.session,
                "d",
                &q.operation_id,
                &q.request_sha256,
                &answer(),
                "owner",
            )
            .unwrap();
        let c = f.sql();
        c.pragma_update(None, "foreign_keys", false).unwrap();
        match mutation {
            "index" => {
                c.execute("UPDATE operator_questions SET sequence=1", [])
                    .unwrap();
            }
            "request" => {
                c.execute("UPDATE operations SET payload=json_set(payload,'$.request.questions[0].question','forged') WHERE id=?1",[&q.operation_id]).unwrap();
            }
            "origin" => {
                c.execute("UPDATE operations SET outcome=json_set(outcome,'$.content[0].arguments.questions[0].question','forged') WHERE id=?1",[&f.origin.id]).unwrap();
            }
            "decision" => {
                c.execute(
                    "UPDATE operator_question_decisions SET decision=?1",
                    ["{\"type\":\"dismiss\"}"],
                )
                .unwrap();
            }
            "outcome" => {
                c.execute(
                    "UPDATE operations SET outcome='{}' WHERE id=?1",
                    [&q.operation_id],
                )
                .unwrap();
            }
            _ => {
                c.execute(
                    "UPDATE operator_questions SET actor_operation_id=?1",
                    ["x".repeat(4097)],
                )
                .unwrap();
            }
        }
        assert!(
            f.store
                .get_operator_question(&f.session, &q.operation_id)
                .is_err(),
            "{mutation}"
        );
        assert!(
            f.store
                .operator_question_decision_by_command(&f.session, "d")
                .is_err(),
            "{mutation}"
        );
    }
}
#[test]
fn original_call_and_owner_are_required_before_question_admission() {
    let mut f = Fixture::new();
    let before = f.store.events(&f.session, 0, 100).unwrap().len();
    for (owner, call, origin) in [
        ("wrong", "ask", f.origin.id.as_str()),
        ("owner", "other", f.origin.id.as_str()),
        ("owner", "ask", f.actor.id.as_str()),
    ] {
        assert!(
            f.store
                .create_operator_question(
                    &f.session,
                    &f.actor.id,
                    owner,
                    &format!("{}:tool:0:0", f.actor.id),
                    call,
                    origin,
                    &request()
                )
                .is_err()
        );
    }
    assert_eq!(before, f.store.events(&f.session, 0, 100).unwrap().len());
    let q = f.create();
    let other = f.store.create_session("g", 100).unwrap().id;
    assert!(
        f.store
            .get_operator_question(&other, &q.operation_id)
            .is_err()
    );
    assert!(
        f.store
            .operator_questions(&other, None, 0, 100)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn schema_seven_migration_preserves_journal_and_readonly_never_migrates() {
    let f = Fixture::new();
    let path = f.dir.path().join("state.db");
    let original = f.store.get_operation(&f.actor.id).unwrap().payload;
    drop(f.store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TABLE web_triage_decisions; DROP INDEX http_receipt_events; DROP INDEX http_rate_events; DROP TABLE http_rates; DROP TABLE http_dispatches; DROP TABLE http_accounts; DROP TABLE tool_approval_consumptions; DROP TABLE tool_approval_decisions; DROP TABLE tool_approvals; DROP TABLE operator_question_decisions; DROP TABLE operator_questions; PRAGMA user_version=7;").unwrap();
    drop(conn);
    assert!(Store::open_read_only(&path).is_err());
    let store = Store::open(&path).unwrap();
    assert_eq!(store.get_operation(&f.actor.id).unwrap().payload, original);
    assert!(
        store
            .operator_questions(&f.session, None, 0, 100)
            .unwrap()
            .is_empty()
    );
    drop(store);
    assert!(Store::open_read_only(&path).is_ok());
}

#[test]
fn large_packets_page_without_skipping_and_share_one_cached_origin() {
    let mut f = Fixture::new();
    let mut request = request();
    request.questions[0].question = "x".repeat(4096);
    request.questions[0].options.as_mut().unwrap()[0].description = Some("y".repeat(1024));
    let mut questions = Vec::new();
    for i in 0..4 {
        let mut q = request.questions[0].clone();
        q.header = format!("Q{i}");
        questions.push(q);
    }
    request.questions = questions;
    let mut completion = f.origin.outcome.clone().unwrap();
    completion["content"]=json!((0..32).map(|i|json!({"type":"tool_call","id":format!("ask{i}"),"name":"ask_operator","arguments":request})).collect::<Vec<_>>());
    f.sql()
        .execute(
            "UPDATE operations SET outcome=?2 WHERE id=?1",
            rusqlite::params![f.origin.id, completion.to_string()],
        )
        .unwrap();
    let mut expected = Vec::new();
    for i in 0..32 {
        let q = f
            .store
            .create_operator_question(
                &f.session,
                &f.actor.id,
                "owner",
                &format!("{}:tool:0:{i}", f.actor.id),
                &format!("ask{i}"),
                &f.origin.id,
                &request,
            )
            .unwrap();
        let answers = (0..4)
            .map(|i| json!({"question_index":i,"custom_text":"é".repeat(7000)}))
            .collect::<Vec<_>>();
        let decision: Decision =
            serde_json::from_value(json!({"type":"answer","answers":answers})).unwrap();
        f.store
            .decide_operator_question(
                &f.session,
                &format!("decision{i}"),
                &q.operation_id,
                &q.request_sha256,
                &decision,
                "owner",
            )
            .unwrap();
        expected.push(q.operation_id);
    }
    let mut cursor = 0;
    let mut got = Vec::new();
    let mut pages = 0;
    loop {
        let page = f
            .store
            .operator_questions(&f.session, None, cursor, 100)
            .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= 1024 * 1024);
        if page.is_empty() {
            break;
        }
        pages += 1;
        cursor = page.last().unwrap().sequence;
        got.extend(page.into_iter().map(|q| q.operation_id));
    }
    assert!(pages > 1);
    assert_eq!(got, expected);
}
