#![allow(clippy::unwrap_used)]
use serde_json::json;
use zero_protocol::{agent::AgentRequest, queue::QueuedAgentStatus as Status};
use zero_store::{OperationStatus, Store};
fn request(prompt: &str) -> AgentRequest {
    serde_json::from_value(json!({"provider":"p","model":"m","instructions":"i","prompt":prompt,"execution":{"execution_id":"e","image":"local","argv":["true"],"snapshot":{"id":"s","root":"/tmp/source","digest":format!("sha256:{}","a".repeat(64)),"files":[{"path":"a","bytes":0,"digest":format!("sha256:{}","b".repeat(64))}]},"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024},"max_turns":2,"reservation_per_turn":10})).unwrap()
}
fn admit(store: &mut Store, session: &str, id: &str) -> String {
    let row = store.resolve_queued_agent(session, id).unwrap();
    let op = store
        .admit_command(
            session,
            &row.run_command_id,
            &json!({"kind":"offline_snapshot_agent","request":row.resolved_request.unwrap()}),
        )
        .unwrap()
        .operation;
    store.begin_operation(&op.id, "owner").unwrap();
    op.id
}
#[test]
fn fifo_retry_dependency_resolution_and_restart_are_durable() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("state.db");
    let mut s = Store::open(&path).unwrap();
    let session = s.create_session("g", 100).unwrap().id;
    let (a, duplicate) = s
        .enqueue_agent(&session, "a", &request("first"), &None)
        .unwrap();
    assert!(!duplicate);
    let (b, _) = s
        .enqueue_agent(&session, "b", &request("second"), &Some(a.id.clone()))
        .unwrap();
    assert!(s.resolve_queued_agent(&session, &b.id).is_err());
    assert!(
        s.enqueue_agent(&session, "a", &request("changed"), &None)
            .is_err()
    );
    let op = admit(&mut s, &session, &a.id);
    assert_eq!(
        s.queued_agent(&session, &a.id).unwrap().status,
        Status::Running
    );
    assert!(s.cancel_queued_agent(&session, &a.id).is_err());
    s.settle_operation(
        &op,
        "owner",
        OperationStatus::Succeeded,
        &json!({"status":"completed"}),
    )
    .unwrap();
    let resolved = s.resolve_queued_agent(&session, &b.id).unwrap();
    assert_eq!(resolved.resolved_request.unwrap().continuation_of, Some(op));
    drop(s);
    let mut s = Store::open(&path).unwrap();
    assert!(
        s.enqueue_agent(&session, "a", &request("first"), &None)
            .unwrap()
            .1
    );
    assert_eq!(
        s.queued_agent(&session, &a.id).unwrap().status,
        Status::Succeeded
    );
    assert_eq!(
        s.resolve_queued_agent(&session, &b.id)
            .unwrap()
            .run_command_id,
        b.run_command_id
    );
    let page = s.queued_agents(&session, 0, 1).unwrap();
    assert_eq!(page[0].id, a.id);
    assert_eq!(
        s.queued_agents(&session, page[0].sequence, 1).unwrap()[0].id,
        b.id
    );
}
#[test]
fn cancellation_skips_fifo_but_does_not_satisfy_continuation() {
    let d = tempfile::tempdir().unwrap();
    let mut s = Store::open(d.path().join("s")).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let (a, _) = s
        .enqueue_agent(&session, "a", &request("a"), &None)
        .unwrap();
    s.resolve_queued_agent(&session, &a.id).unwrap();
    assert_eq!(
        s.cancel_queued_agent(&session, &a.id).unwrap().status,
        Status::Cancelled
    );
    assert_eq!(
        s.cancel_queued_agent(&session, &a.id).unwrap().status,
        Status::Cancelled
    );
    assert!(s.resolve_queued_agent(&session, &a.id).is_err());
    let (b, _) = s
        .enqueue_agent(&session, "b", &request("b"), &Some(a.id.clone()))
        .unwrap();
    assert!(s.resolve_queued_agent(&session, &b.id).is_err());
    s.cancel_queued_agent(&session, &b.id).unwrap();
    let (c, _) = s
        .enqueue_agent(&session, "c", &request("c"), &None)
        .unwrap();
    assert!(s.resolve_queued_agent(&session, &c.id).is_ok());
}
#[test]
fn recovery_preserves_unknown_and_blocks_dependent_prompts() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("s");
    let mut s = Store::open(&path).unwrap();
    s.claim_engine_epoch("owner").unwrap();
    let session = s.create_session("g", 100).unwrap().id;
    let (a, _) = s
        .enqueue_agent(&session, "a", &request("a"), &None)
        .unwrap();
    let op = admit(&mut s, &session, &a.id);
    let (b, _) = s
        .enqueue_agent(&session, "b", &request("b"), &Some(a.id.clone()))
        .unwrap();
    s.reserve_budget(&session, &op, 10).unwrap();
    drop(s);
    let mut s = Store::open(&path).unwrap();
    s.claim_engine_epoch("new").unwrap();
    let row = s.resolve_queued_agent(&session, &a.id).unwrap();
    assert_eq!(row.status, Status::Unknown);
    assert_eq!(row.operation_id, Some(op.clone()));
    assert!(s.begin_operation(&op, "new").is_err());
    assert!(s.resolve_queued_agent(&session, &b.id).is_err());
    assert_eq!(s.budget(&session).unwrap().reserved, 10);
}
#[test]
fn limits_retry_before_cap_and_pages_are_bounded() {
    let d = tempfile::tempdir().unwrap();
    let mut s = Store::open(d.path().join("s")).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let large = request(&"a".repeat(120 * 1024));
    for i in 0..50 {
        s.enqueue_agent(&session, &i.to_string(), &large, &None)
            .unwrap();
    }
    assert!(s.enqueue_agent(&session, "0", &large, &None).unwrap().1);
    assert!(
        s.enqueue_agent(&session, "overflow", &large, &None)
            .is_err()
    );
    let page = s.queued_agents(&session, 0, 100).unwrap();
    assert!(page.len() < 50);
    assert!(serde_json::to_vec(&page).unwrap().len() <= 1024 * 1024);
    let mut cursor = 0;
    let mut count = 0;
    loop {
        let p = s.queued_agents(&session, cursor, 100).unwrap();
        if p.is_empty() {
            break;
        }
        cursor = p.last().unwrap().sequence;
        count += p.len();
    }
    assert_eq!(count, 50);
    assert!(
        s.enqueue_agent(
            &session,
            "oversized",
            &request(&"x".repeat(128 * 1024)),
            &None
        )
        .is_err()
    );
    assert!(s.queued_agents(&session, 0, 0).is_err());
    assert!(s.queued_agents(&session, 0, 101).is_err());
}
#[test]
fn predecessor_scope_conflict_and_operation_identity_are_checked() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("s");
    let mut s = Store::open(&path).unwrap();
    let a = s.create_session("g", 0).unwrap().id;
    let b = s.create_session("g", 0).unwrap().id;
    let (row, _) = s.enqueue_agent(&a, "a", &request("a"), &None).unwrap();
    assert!(
        s.enqueue_agent(&b, "b", &request("b"), &Some(row.id.clone()))
            .is_err()
    );
    let mut req = request("b");
    req.continuation_of = Some("op".into());
    assert!(
        s.enqueue_agent(&a, "b", &req, &Some(row.id.clone()))
            .is_err()
    );
    s.resolve_queued_agent(&a, &row.id).unwrap();
    s.admit_command(
        &a,
        &row.run_command_id,
        &json!({"kind":"offline_snapshot_agent","request":request("forged")}),
    )
    .unwrap();
    assert!(s.queued_agent(&a, &row.id).is_err());
    assert!(s.resolve_queued_agent(&a, &row.id).is_err());
}
#[test]
fn v4_migration_preserves_artifacts_and_readonly_never_migrates() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("s");
    let mut s = Store::open(&path).unwrap();
    let session = s.create_session("g", 10).unwrap().id;
    let op = s
        .admit_command(&session, "c", &json!({}))
        .unwrap()
        .operation
        .id;
    s.begin_operation(&op, "o").unwrap();
    let digest = s
        .retain_operation_artifact(&op, "o", "evidence", b"actual retained bytes")
        .unwrap();
    drop(s);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP INDEX campaign_root_lifecycle; DROP INDEX campaign_exposure_witness; DROP TABLE campaign_debits; DROP TABLE campaign_exposures; DROP TABLE campaign_runs; DROP TABLE strategy_sessions; DROP TABLE campaigns; DROP INDEX web_experiment_quota_events; DROP TABLE web_experiment_admissions; DROP TABLE web_triage_decisions; DROP INDEX http_receipt_events; DROP INDEX http_rate_events; DROP TABLE http_rates; DROP TABLE http_dispatches; DROP TABLE http_accounts; DROP TABLE tool_approval_consumptions; DROP TABLE tool_approval_decisions; DROP TABLE tool_approvals; DROP TABLE operator_question_decisions; DROP TABLE operator_questions; DROP TABLE agent_steering; DROP TABLE agent_steering_windows; DROP TABLE source_triage_decisions; DROP TABLE agent_inputs; PRAGMA user_version=4;",
    )
    .unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open_read_only(&path).is_err());
    assert_eq!(before, std::fs::read(&path).unwrap());
    let mut s = Store::open(&path).unwrap();
    assert_eq!(s.artifact(&digest).unwrap(), b"actual retained bytes");
    assert_eq!(
        s.get_operation(&op).unwrap().status,
        OperationStatus::Running
    );
    let (q, _) = s
        .enqueue_agent(&session, "q", &request("q"), &None)
        .unwrap();
    let mut reader = Store::open_read_only(&path).unwrap();
    assert_eq!(
        reader.queued_agent(&session, &q.id).unwrap().status,
        Status::Pending
    );
    assert!(reader.cancel_queued_agent(&session, &q.id).is_err());
}

#[test]
fn event_failure_rolls_back_queue_mutations() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("s");
    let mut s = Store::open(&path).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER stop_queue_event BEFORE INSERT ON events WHEN NEW.kind LIKE 'agent_input_%' BEGIN SELECT RAISE(ABORT,'injected queue event failure'); END;").unwrap();
    assert!(
        s.enqueue_agent(&session, "a", &request("a"), &None)
            .is_err()
    );
    assert!(s.queued_agents(&session, 0, 100).unwrap().is_empty());
    conn.execute_batch("DROP TRIGGER stop_queue_event;")
        .unwrap();
    let (q, _) = s
        .enqueue_agent(&session, "a", &request("a"), &None)
        .unwrap();
    conn.execute_batch("CREATE TRIGGER stop_queue_event BEFORE INSERT ON events WHEN NEW.kind LIKE 'agent_input_%' BEGIN SELECT RAISE(ABORT,'injected queue event failure'); END;").unwrap();
    assert!(s.resolve_queued_agent(&session, &q.id).is_err());
    assert!(
        s.queued_agent(&session, &q.id)
            .unwrap()
            .resolved_request
            .is_none()
    );
    assert!(s.cancel_queued_agent(&session, &q.id).is_err());
    assert_eq!(
        s.queued_agent(&session, &q.id).unwrap().status,
        Status::Pending
    );
}
#[test]
fn concurrent_enqueue_deduplicates_once() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("s");
    let mut s = Store::open(&path).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let session = session.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut store = Store::open(path).unwrap();
                barrier.wait();
                store
                    .enqueue_agent(&session, "same", &request("prompt"), &None)
                    .unwrap()
            })
        })
        .collect();
    let mut results = handles.into_iter().map(|h| h.join().unwrap());
    let first = results.next().unwrap();
    let second = results.next().unwrap();
    assert_eq!(first.0.id, second.0.id);
    assert_ne!(first.1, second.1);
    assert_eq!(s.queued_agents(&session, 0, 100).unwrap().len(), 1);
}
#[test]
fn oversized_persisted_request_is_rejected_without_advancing_page() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("s");
    let mut s = Store::open(&path).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let (q, _) = s
        .enqueue_agent(&session, "a", &request("a"), &None)
        .unwrap();
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute(
        "UPDATE agent_inputs SET request=?1 WHERE id=?2",
        rusqlite::params!["x".repeat(128 * 1024 + 1), q.id],
    )
    .unwrap();
    assert!(s.queued_agents(&session, 0, 100).is_err());
}
#[test]
fn turn_limit_and_ownerless_admission_are_not_completed_predecessors() {
    for admitted_only in [false, true] {
        let d = tempfile::tempdir().unwrap();
        let mut s = Store::open(d.path().join("s")).unwrap();
        s.claim_engine_epoch("owner").unwrap();
        let session = s.create_session("g", 0).unwrap().id;
        let (a, _) = s
            .enqueue_agent(&session, "a", &request("a"), &None)
            .unwrap();
        let resolved = s.resolve_queued_agent(&session, &a.id).unwrap();
        let op = s
            .admit_command(
                &session,
                &resolved.run_command_id,
                &json!({"kind":"offline_snapshot_agent","request":resolved.resolved_request}),
            )
            .unwrap()
            .operation
            .id;
        if admitted_only {
            s.claim_engine_epoch("new").unwrap();
        } else {
            s.begin_operation(&op, "owner").unwrap();
            s.settle_operation(
                &op,
                "owner",
                OperationStatus::Failed,
                &json!({"status":"turn_limit"}),
            )
            .unwrap();
        }
        assert_eq!(
            s.queued_agent(&session, &a.id).unwrap().status,
            Status::Failed
        );
        let (b, _) = s
            .enqueue_agent(&session, "b", &request("b"), &Some(a.id.clone()))
            .unwrap();
        assert!(s.resolve_queued_agent(&session, &b.id).is_err());
        assert_eq!(
            s.resolve_queued_agent(&session, &a.id)
                .unwrap()
                .operation_id,
            Some(op)
        );
    }
}

#[test]
fn resolved_request_cannot_change_original_intent_before_or_after_dispatch() {
    let changes = [
        ("prompt", json!("forged")),
        ("model", json!("other")),
        ("provider", json!("other")),
        ("instructions", json!("forged")),
        ("max_turns", json!(99)),
        ("reservation_per_turn", json!(999)),
        ("continuation_of", json!("forged-op")),
        ("source_snapshot_tools", json!(true)),
        (
            "plugin_tools",
            json!([{"alias":"alias","plugin":"plugin","tool":"tool"}]),
        ),
    ];
    for (field, value) in changes {
        for dispatched in [false, true] {
            let d = tempfile::tempdir().unwrap();
            let path = d.path().join("s");
            let mut s = Store::open(&path).unwrap();
            let session = s.create_session("g", 0).unwrap().id;
            let (q, _) = s
                .enqueue_agent(&session, "a", &request("original"), &None)
                .unwrap();
            let resolved = s.resolve_queued_agent(&session, &q.id).unwrap();
            let mut changed = serde_json::to_value(resolved.resolved_request.unwrap()).unwrap();
            changed[field] = value.clone();
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute(
                "UPDATE agent_inputs SET resolved_request=?1 WHERE id=?2",
                rusqlite::params![serde_json::to_string(&changed).unwrap(), q.id],
            )
            .unwrap();
            if dispatched {
                s.admit_command(
                    &session,
                    &q.run_command_id,
                    &json!({"kind":"offline_snapshot_agent","request":changed}),
                )
                .unwrap();
            }
            assert!(
                s.queued_agent(&session, &q.id).is_err(),
                "{field}, dispatched={dispatched}"
            );
            assert!(s.resolve_queued_agent(&session, &q.id).is_err());
        }
    }
}
#[test]
fn resolved_dependency_validates_exact_parent_identity_without_recursive_history() {
    for mutation in [
        "wrong_continuation",
        "later_sequence",
        "foreign_session",
        "failed_parent",
        "wrong_kind",
        "wrong_parent_request",
        "cancelled_parent",
    ] {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("s");
        let mut s = Store::open(&path).unwrap();
        let session = s.create_session("g", 0).unwrap().id;
        let (a, _) = s
            .enqueue_agent(&session, "a", &request("a"), &None)
            .unwrap();
        let op = admit(&mut s, &session, &a.id);
        s.settle_operation(
            &op,
            "owner",
            OperationStatus::Succeeded,
            &json!({"status":"completed"}),
        )
        .unwrap();
        let (b, _) = s
            .enqueue_agent(&session, "b", &request("b"), &Some(a.id.clone()))
            .unwrap();
        s.resolve_queued_agent(&session, &b.id).unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        match mutation {
            "wrong_continuation" => {
                conn.execute("UPDATE agent_inputs SET resolved_request=json_set(resolved_request,'$.continuation_of','forged') WHERE id=?1",[&b.id]).unwrap();
            }
            "later_sequence" => {
                conn.execute("UPDATE agent_inputs SET sequence=99 WHERE id=?1", [&a.id])
                    .unwrap();
            }
            "foreign_session" => {
                let foreign = s.create_session("other", 0).unwrap().id;
                conn.execute(
                    "UPDATE agent_inputs SET session_id=?1 WHERE id=?2",
                    rusqlite::params![foreign, a.id],
                )
                .unwrap();
            }
            "failed_parent" => {
                conn.execute("UPDATE operations SET status='failed' WHERE id=?1", [&op])
                    .unwrap();
            }
            "wrong_kind" => {
                conn.execute(
                    "UPDATE operations SET payload=json_set(payload,'$.kind','other') WHERE id=?1",
                    [&op],
                )
                .unwrap();
            }
            "wrong_parent_request" => {
                conn.execute("UPDATE operations SET payload=json_set(payload,'$.request.prompt','forged') WHERE id=?1",[&op]).unwrap();
            }
            "cancelled_parent" => {
                conn.execute("UPDATE agent_inputs SET cancelled=1 WHERE id=?1", [&a.id])
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(s.queued_agent(&session, &b.id).is_err(), "{mutation}");
        assert!(s.resolve_queued_agent(&session, &b.id).is_err());
    }
}

#[test]
fn queued_web_actor_is_typed_and_terminal_submission_cannot_feed_a_continuation() {
    let mut store = Store::open(":memory:").unwrap();
    let session = store.create_session("g", 100).unwrap().id;
    let mut web = request("web");
    web.execution = None;
    web.http_profile = Some("scope".into());
    web.web_submission_max_hypotheses = Some(2);
    let (first, _) = store.enqueue_agent(&session, "web", &web, &None).unwrap();
    let (next, _) = store
        .enqueue_agent(&session, "after", &web, &Some(first.id.clone()))
        .unwrap();
    let resolved = store.resolve_queued_agent(&session, &first.id).unwrap();
    let op = store
        .admit_command(
            &session,
            &resolved.run_command_id,
            &json!({"kind":"scoped_web_agent","request":resolved.resolved_request}),
        )
        .unwrap()
        .operation;
    store.begin_operation(&op.id, "owner").unwrap();
    store
        .settle_operation(
            &op.id,
            "owner",
            OperationStatus::Succeeded,
            &json!({"status":"completed"}),
        )
        .unwrap();
    assert_eq!(
        store.queued_agent(&session, &first.id).unwrap().status,
        Status::Succeeded
    );
    assert!(store.resolve_queued_agent(&session, &next.id).is_err());
    assert!(
        store
            .queued_agent(&session, &next.id)
            .unwrap()
            .resolved_request
            .is_none()
    );
}
