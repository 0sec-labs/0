use serde_json::{Value, json};
use zero_protocol::{Operation, OperationStatus, steering::AgentSteeringStatus as Status};
use zero_store::Store;
fn valid_actor_request() -> serde_json::Value {
    let sha = format!("sha256:{}", "a".repeat(64));
    let value = json!({"provider":"fixture","model":"fixture","instructions":"unchanged","prompt":"original","max_turns":3,"reservation_per_turn":1,"execution":{"execution_id":"profile","image":"fixture:local","snapshot":{"id":"s","root":"/tmp/source","digest":sha,"files":[{"path":"entry","digest":sha,"bytes":0}]},"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":1024}});
    let request: zero_protocol::agent::AgentRequest = serde_json::from_value(value).unwrap();
    request.validate_capabilities().unwrap();
    serde_json::to_value(request).unwrap()
}

fn setup() -> (tempfile::TempDir, Store, String, Operation) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("state.db")).unwrap();
    let session = store.create_session("g", 100).unwrap().id;
    let op = store
        .admit_command(
            &session,
            "actor",
            &json!({"kind":"offline_snapshot_agent","request":valid_actor_request()}),
        )
        .unwrap()
        .operation;
    let op = store.begin_operation(&op.id, "owner").unwrap();
    (dir, store, session, op)
}
fn payload(op: &Operation, items: &[zero_protocol::steering::SteeringInput]) -> Value {
    let mut p = json!({"kind":"agent_inference","parent_operation":op.id,"request":{"input":items.iter().map(|m|json!({"role":"user","content":m.prompt})).collect::<Vec<_>>()}});
    if !items.is_empty() {
        p["steering"] = json!(items);
    }
    p
}
#[test]
fn capture_retry_seal_restart_and_readonly_preserve_exact_intent() {
    let (dir, mut store, s, op) = setup();
    let (a, duplicate) = store
        .enqueue_agent_steering(&s, &op.id, "a", "first é")
        .unwrap();
    assert!(!duplicate);
    assert!(
        !store
            .seal_agent_steering(&s, &op.id, "owner", false)
            .unwrap()
    );
    let selected = store.pending_agent_steering(&s, &op.id, "owner").unwrap();
    store
        .enqueue_agent_steering(&s, &op.id, "b", "later")
        .unwrap();
    let inference = store
        .admit_steered_inference(
            &s,
            &op.id,
            "owner",
            "model0",
            &payload(&op, &selected),
            &selected,
        )
        .unwrap();
    assert_eq!(store.inference_steering(&inference).unwrap(), selected);
    assert!(
        store
            .admit_steered_inference(
                &s,
                &op.id,
                "owner",
                "again",
                &payload(&op, &selected),
                &selected
            )
            .is_err()
    );
    let retry = store
        .enqueue_agent_steering(&s, &op.id, "a", "first é")
        .unwrap();
    assert!(retry.1);
    assert_eq!(retry.0.id, a.id);
    assert_eq!(retry.0.status, Status::Captured);
    assert!(
        store
            .enqueue_agent_steering(&s, &op.id, "a", "changed")
            .is_err()
    );
    assert!(
        store
            .seal_agent_steering(&s, &op.id, "owner", true)
            .unwrap()
    );
    assert!(
        store
            .enqueue_agent_steering(&s, &op.id, "c", "late")
            .is_err()
    );
    assert!(
        store
            .pending_agent_steering(&s, &op.id, "owner")
            .unwrap()
            .is_empty()
    );
    let b = store
        .enqueue_agent_steering(&s, &op.id, "b", "later")
        .unwrap();
    assert!(b.1);
    assert_eq!(b.0.status, Status::Undelivered);
    store
        .settle_operation(&op.id, "owner", OperationStatus::Succeeded, &json!({}))
        .unwrap();
    drop(store);
    let ro = Store::open_read_only(dir.path().join("state.db")).unwrap();
    let rows = ro.agent_steering(&s, &op.id, 0, 1).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, a.id);
    let next = ro.agent_steering(&s, &op.id, rows[0].sequence, 1).unwrap();
    assert_eq!(next[0].status, Status::Undelivered);
    assert_eq!(ro.inference_steering(&inference).unwrap(), selected);
}
#[test]
fn epoch_recovery_never_recaptures_unknown_requests_or_pending_messages() {
    let (dir, mut store, s, op) = setup();
    store
        .enqueue_agent_steering(&s, &op.id, "a", "captured")
        .unwrap();
    let selected = store.pending_agent_steering(&s, &op.id, "owner").unwrap();
    let inf = store
        .admit_steered_inference(
            &s,
            &op.id,
            "owner",
            "model",
            &payload(&op, &selected),
            &selected,
        )
        .unwrap();
    store
        .enqueue_agent_steering(&s, &op.id, "b", "not captured")
        .unwrap();
    drop(store);
    let mut store = Store::open(dir.path().join("state.db")).unwrap();
    store.claim_engine_epoch("next-owner").unwrap();
    let rows = store.agent_steering(&s, &op.id, 0, 10).unwrap();
    assert_eq!(rows[0].status, Status::Captured);
    assert_eq!(rows[1].status, Status::Undelivered);
    assert_eq!(
        store.get_operation(&inf.id).unwrap().status,
        OperationStatus::Unknown
    );
    assert!(
        store
            .enqueue_agent_steering(&s, &op.id, "new", "no replay")
            .is_err()
    );
    assert!(
        store
            .enqueue_agent_steering(&s, &op.id, "b", "not captured")
            .unwrap()
            .1
    );
}
#[test]
fn atomic_capture_rolls_back_on_event_failure_and_rejects_wrong_authority() {
    let (dir, mut store, s, op) = setup();
    store
        .enqueue_agent_steering(&s, &op.id, "a", "one")
        .unwrap();
    let selected = store.pending_agent_steering(&s, &op.id, "owner").unwrap();
    assert!(store.pending_agent_steering(&s, &op.id, "wrong").is_err());
    assert!(
        store
            .admit_steered_inference(
                &s,
                &op.id,
                "wrong",
                "m",
                &payload(&op, &selected),
                &selected
            )
            .is_err()
    );
    let conn = rusqlite::Connection::open(dir.path().join("state.db")).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_model BEFORE INSERT ON events WHEN NEW.kind='operation_started' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(
        store
            .admit_steered_inference(
                &s,
                &op.id,
                "owner",
                "m",
                &payload(&op, &selected),
                &selected
            )
            .is_err()
    );
    assert!(store.get_operation_by_command(&s, "m").is_err());
    assert_eq!(
        store.pending_agent_steering(&s, &op.id, "owner").unwrap(),
        selected
    );
    conn.execute_batch("DROP TRIGGER reject_model;").unwrap();
    let other = store.create_session("g", 1).unwrap().id;
    assert!(store.agent_steering(&other, &op.id, 0, 10).is_err());
}
#[test]
fn forged_rows_receipts_and_inference_payloads_cannot_rewrite_captured_text() {
    for mutation in 0..4 {
        let (dir, mut store, s, op) = setup();
        let (m, _) = store
            .enqueue_agent_steering(&s, &op.id, "a", "original")
            .unwrap();
        let selected = store.pending_agent_steering(&s, &op.id, "owner").unwrap();
        let inf = store
            .admit_steered_inference(
                &s,
                &op.id,
                "owner",
                "model",
                &payload(&op, &selected),
                &selected,
            )
            .unwrap();
        let conn = rusqlite::Connection::open(dir.path().join("state.db")).unwrap();
        match mutation {
            0 => {
                conn.execute(
                    "UPDATE agent_steering SET prompt='forged' WHERE id=?1",
                    [&m.id],
                )
                .unwrap();
            }
            1 => {
                conn.execute("UPDATE agent_steering SET inference_operation_id=NULL,capture_sequence=NULL WHERE id=?1",[&m.id]).unwrap();
            }
            2 => {
                conn.execute("UPDATE operations SET payload=json_set(payload,'$.steering[0].prompt','forged') WHERE id=?1",[&inf.id]).unwrap();
            }
            _ => {
                conn.execute("UPDATE operations SET payload=json_set(payload,'$.request.input[0].content','forged') WHERE id=?1",[&inf.id]).unwrap();
            }
        }
        let current = store.get_operation(&inf.id).unwrap();
        assert!(
            store.inference_steering(&current).is_err(),
            "mutation{mutation}"
        );
    }
}
#[test]
fn bounded_pages_pending_total_caps_and_legacy_empty_receipts() {
    let (_dir, mut store, s, op) = setup();
    let prompt = format!("x{}", "\u{1}".repeat(16383));
    for i in 0..32 {
        store
            .enqueue_agent_steering(&s, &op.id, &format!("m{i}"), &prompt)
            .unwrap();
    }
    assert!(
        store
            .enqueue_agent_steering(&s, &op.id, "overflow", "x")
            .is_err()
    );
    assert!(
        store
            .enqueue_agent_steering(&s, &op.id, "m0", &prompt)
            .unwrap()
            .1
    );
    let first = store.agent_steering(&s, &op.id, 0, 100).unwrap();
    assert!(!first.is_empty() && first.len() < 32);
    assert!(serde_json::to_vec(&first).unwrap().len() <= 1024 * 1024);
    let next = store
        .agent_steering(&s, &op.id, first.last().unwrap().sequence, 100)
        .unwrap();
    assert_eq!(next[0].sequence > first.last().unwrap().sequence, true);
    for batch in 0..4 {
        let selected = store.pending_agent_steering(&s, &op.id, "owner").unwrap();
        store
            .admit_steered_inference(
                &s,
                &op.id,
                "owner",
                &format!("model{batch}"),
                &payload(&op, &selected),
                &selected,
            )
            .unwrap();
        if batch < 3 {
            for i in 0..32 {
                store
                    .enqueue_agent_steering(&s, &op.id, &format!("batch{batch}-{i}"), "small")
                    .unwrap();
            }
        }
    }
    assert!(
        store
            .enqueue_agent_steering(&s, &op.id, "total-overflow", "x")
            .is_err()
    );
    let old = store
        .admit_command(
            &s,
            "old",
            &json!({"kind":"agent_inference","parent_operation":op.id,"request":{}}),
        )
        .unwrap()
        .operation;
    assert!(store.inference_steering(&old).unwrap().is_empty());
}
#[test]
fn schema6_migrates_and_readonly_does_not_migrate() {
    let (dir, store, s, op) = setup();
    drop(store);
    let path = dir.path().join("state.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP INDEX campaign_root_lifecycle; DROP INDEX campaign_exposure_witness; DROP TABLE campaign_debits; DROP TABLE campaign_exposures; DROP TABLE campaign_runs; DROP TABLE campaigns; DROP INDEX web_experiment_quota_events; DROP TABLE web_experiment_admissions; DROP TABLE web_triage_decisions; DROP INDEX http_receipt_events; DROP INDEX http_rate_events; DROP TABLE http_rates; DROP TABLE http_dispatches; DROP TABLE http_accounts; DROP TABLE tool_approval_consumptions; DROP TABLE tool_approval_decisions; DROP TABLE tool_approvals; DROP TABLE operator_question_decisions; DROP TABLE operator_questions; DROP TABLE agent_steering; DROP TABLE agent_steering_windows; PRAGMA user_version=6;",
    )
    .unwrap();
    drop(conn);
    assert!(Store::open_read_only(&path).is_err());
    let mut store = Store::open(&path).unwrap();
    store
        .enqueue_agent_steering(&s, &op.id, "new", "preserved")
        .unwrap();
    assert_eq!(
        store.get_operation(&op.id).unwrap().status,
        OperationStatus::Running
    );
    assert!(Store::open_read_only(&path).is_ok());
}

#[test]
fn captured_labels_and_exact_retries_require_the_original_capture_event() {
    for mutation in 0..2 {
        let (dir, mut store, s, op) = setup();
        let (message, _) = store
            .enqueue_agent_steering(&s, &op.id, "msg", "original")
            .unwrap();
        let selected = store.pending_agent_steering(&s, &op.id, "owner").unwrap();
        store
            .admit_steered_inference(
                &s,
                &op.id,
                "owner",
                "model",
                &payload(&op, &selected),
                &selected,
            )
            .unwrap();
        let conn = rusqlite::Connection::open(dir.path().join("state.db")).unwrap();
        if mutation == 0 {
            conn.execute(
                "UPDATE agent_steering SET capture_sequence=?2 WHERE id=?1",
                rusqlite::params![message.id, message.sequence],
            )
            .unwrap();
        } else {
            conn.execute(
                "UPDATE agent_steering SET inference_operation_id=?2 WHERE id=?1",
                rusqlite::params![message.id, op.id],
            )
            .unwrap();
        }
        assert!(store.agent_steering(&s, &op.id, 0, 10).is_err());
        assert!(store.agent_steering_by_command(&s, "msg").is_err());
        assert!(
            store
                .enqueue_agent_steering(&s, &op.id, "msg", "original")
                .is_err()
        );
    }
}

#[test]
fn valid_large_capture_witnesses_page_before_aggregate_read_budget() {
    let (_dir, mut store, s, op) = setup();
    for n in 0..10 {
        store
            .enqueue_agent_steering(&s, &op.id, &format!("m{n}"), "small prompt")
            .unwrap();
        let selected = store.pending_agent_steering(&s, &op.id, "owner").unwrap();
        let mut request = payload(&op, &selected);
        request["request"]["fixture_padding"] = json!("x".repeat(7 * 1024 * 1024));
        store
            .admit_steered_inference(
                &s,
                &op.id,
                "owner",
                &format!("model{n}"),
                &request,
                &selected,
            )
            .unwrap();
    }
    let first = store.agent_steering(&s, &op.id, 0, 100).unwrap();
    assert_eq!(first.len(), 9);
    let tail = store
        .agent_steering(&s, &op.id, first.last().unwrap().sequence, 100)
        .unwrap();
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0].command_id, "m9");
}

#[test]
fn final_boundary_race_never_accepts_and_silently_seals_a_message() {
    let (dir, mut store, s, op) = setup();
    for n in 0..12 {
        let operation = if n == 0 {
            op.clone()
        } else {
            let a = store
                .admit_command(&s, &format!("actor{n}"), &op.payload)
                .unwrap()
                .operation;
            store.begin_operation(&a.id, "owner").unwrap()
        };
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let path = dir.path().join("state.db");
        let session = s.clone();
        let actor = operation.id.clone();
        let other = barrier.clone();
        let enqueue = std::thread::spawn(move || {
            let mut writer = Store::open(path).unwrap();
            other.wait();
            writer.enqueue_agent_steering(&session, &actor, &format!("race{n}"), "do not lose me")
        });
        barrier.wait();
        let sealed = store
            .seal_agent_steering(&s, &operation.id, "owner", false)
            .unwrap();
        let inserted = enqueue.join().unwrap();
        assert_eq!(sealed, inserted.is_err());
        let messages = store.agent_steering(&s, &operation.id, 0, 10).unwrap();
        if sealed {
            assert!(messages.is_empty());
        } else {
            assert_eq!(messages[0].status, Status::Pending);
        }
    }
}
