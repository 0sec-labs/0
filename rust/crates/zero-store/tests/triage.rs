#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_protocol::triage::SourceFindingStatus as Status;
use zero_store::{OperationStatus, Store};
fn hypothesis() -> String {
    format!("sha256:{}", "a".repeat(64))
}
fn source(
    store: &mut Store,
    session: &str,
    command: &str,
    adaptive: bool,
) -> (String, String, Value) {
    let review = json!({"version":1,"bundle_sha256":format!("sha256:{}","b".repeat(64)),"snapshot_sha256":format!("sha256:{}","c".repeat(64)),"request_sha256":format!("sha256:{}","d".repeat(64)),"completion_sha256":format!("sha256:{}","e".repeat(64)),"model":"fixture","provider_response_id":null,"submission_call_id":"submit","hypotheses":[{"id":hypothesis(),"state":"unverified","claim":{"title":"Unverified hypothesis","claimed_severity":"low","explanation":"Model claim only","citations":[{"path":"app.rs","sha256":format!("sha256:{}","f".repeat(64)),"start_line":1,"end_line":1}]}}]});
    let kind = if adaptive {
        "offline_snapshot_agent"
    } else {
        "source_hypothesis_review"
    };
    let op = store
        .admit_command(session, command, &json!({"kind":kind}))
        .unwrap()
        .operation
        .id;
    store.begin_operation(&op, "owner").unwrap();
    let digest = store
        .retain_operation_artifact(
            &op,
            "owner",
            "source.review",
            &serde_json::to_vec(&review).unwrap(),
        )
        .unwrap();
    let outcome = json!({"review":review,"artifacts":{"source.review":digest},"inference_operation":null,"external_effects_started":true,"error":null});
    let outcome = if adaptive {
        json!({"status":"completed","error":null,"source_recovery_path":null,"source_review":outcome})
    } else {
        outcome
    };
    store
        .settle_operation(&op, "owner", OperationStatus::Succeeded, &outcome)
        .unwrap();
    (op, digest, review)
}
#[test]
fn defaults_reads_decisions_and_historical_retries_preserve_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s");
    let mut s = Store::open(&path).unwrap();
    let session = s.create_session("g", 100).unwrap().id;
    let (op, digest, review) = source(&mut s, &session, "source", false);
    let original = s.get_operation(&op).unwrap();
    let bytes = s.artifact(&digest).unwrap();
    let file_before = std::fs::read(&path).unwrap();
    let rows = s.source_findings(&session, &op, 0, 32).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, Status::New);
    assert_eq!(rows[0].revision, 0);
    assert!(rows[0].last_decision.is_none());
    assert!(
        s.source_finding_with_history(&session, &op, &hypothesis(), 0, 50)
            .unwrap()
            .1
            .is_empty()
    );
    assert_eq!(file_before, std::fs::read(&path).unwrap());
    s.reserve_budget(&session, "uncertain-provider", 7).unwrap();
    let (accepted, first, duplicate) = s
        .triage_source_finding(
            &session,
            "decision-1",
            &op,
            &hypothesis(),
            Status::Accepted,
            0,
            "reviewed manually",
        )
        .unwrap();
    assert!(!duplicate);
    assert_eq!(accepted.revision, 1);
    let (suppressed, _, _) = s
        .triage_source_finding(
            &session,
            "decision-2",
            &op,
            &hypothesis(),
            Status::Suppressed,
            1,
            "not actionable",
        )
        .unwrap();
    assert_eq!(suppressed.revision, 2);
    let (current, retried, duplicate) = s
        .triage_source_finding(
            &session,
            "decision-1",
            &op,
            &hypothesis(),
            Status::Accepted,
            0,
            "reviewed manually",
        )
        .unwrap();
    assert!(duplicate);
    assert_eq!(retried, first);
    assert_eq!(current.status, Status::Suppressed);
    assert_eq!(current.revision, 2);
    let (reopened, _, _) = s
        .triage_source_finding(
            &session,
            "decision-3",
            &op,
            &hypothesis(),
            Status::New,
            2,
            "",
        )
        .unwrap();
    assert_eq!(reopened.revision, 3);
    let (same, _, _) = s
        .triage_source_finding(
            &session,
            "decision-4",
            &op,
            &hypothesis(),
            Status::New,
            3,
            "additional note",
        )
        .unwrap();
    assert_eq!(same.revision, 4);
    assert_eq!(s.budget(&session).unwrap().reserved, 7);
    assert_eq!(s.artifact(&digest).unwrap(), bytes);
    assert_eq!(
        serde_json::to_value(s.get_operation(&op).unwrap()).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    assert_eq!(
        serde_json::to_value(same.hypothesis).unwrap(),
        review["hypotheses"][0]
    );
    drop(s);
    let s = Store::open_read_only(&path).unwrap();
    let (current, history) = s
        .source_finding_with_history(&session, &op, &hypothesis(), 0, 50)
        .unwrap();
    assert_eq!(current.revision, 4);
    assert_eq!(history.len(), 4);
    assert_eq!(history[0], first);
}
#[test]
fn revision_conflicts_and_changed_command_retries_are_inert() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("s")).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let (op, _, _) = source(&mut s, &session, "source", false);
    s.triage_source_finding(
        &session,
        "decision",
        &op,
        &hypothesis(),
        Status::Accepted,
        0,
        "note",
    )
    .unwrap();
    let events = s.events(&session, 0, 100).unwrap().len();
    for (command, status, revision, note) in [
        ("other", Status::Suppressed, 0, "note"),
        ("decision", Status::Suppressed, 0, "note"),
        ("decision", Status::Accepted, 1, "note"),
        ("decision", Status::Accepted, 0, "changed"),
    ] {
        assert!(
            s.triage_source_finding(
                &session,
                command,
                &op,
                &hypothesis(),
                status,
                revision,
                note
            )
            .is_err()
        );
    }
    assert_eq!(s.events(&session, 0, 100).unwrap().len(), events);
    assert_eq!(
        s.source_finding(&session, &op, &hypothesis())
            .unwrap()
            .revision,
        1
    );
}
#[test]
fn identical_hypothesis_ids_in_distinct_source_operations_are_separate() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("s")).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let other = s.create_session("g", 0).unwrap().id;
    let (a, _, _) = source(&mut s, &session, "a", false);
    let (b, _, _) = source(&mut s, &session, "b", true);
    s.triage_source_finding(
        &session,
        "decision",
        &a,
        &hypothesis(),
        Status::Accepted,
        0,
        "",
    )
    .unwrap();
    assert_eq!(
        s.source_finding(&session, &b, &hypothesis())
            .unwrap()
            .status,
        Status::New
    );
    assert!(
        s.triage_source_finding(
            &session,
            "decision",
            &b,
            &hypothesis(),
            Status::Accepted,
            0,
            ""
        )
        .is_err()
    );
    assert!(s.source_findings(&other, &a, 0, 32).is_err());
    assert!(
        s.triage_source_finding(&other, "other", &a, &hypothesis(), Status::New, 0, "")
            .is_err()
    );
    assert!(
        s.source_finding(&session, &a, &format!("sha256:{}", "0".repeat(64)))
            .is_err()
    );
    // Execution and triage command IDs are intentionally separate namespaces.
    s.triage_source_finding(&session, "a", &b, &hypothesis(), Status::Accepted, 0, "")
        .unwrap();
}
#[test]
fn event_failure_rolls_back_decision_and_status_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s");
    let mut s = Store::open(&path).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let (op, _, _) = source(&mut s, &session, "source", false);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER stop_triage BEFORE INSERT ON events WHEN NEW.kind='source_finding_triaged' BEGIN SELECT RAISE(ABORT,'injected event failure'); END;").unwrap();
    assert!(
        s.triage_source_finding(&session, "d", &op, &hypothesis(), Status::Accepted, 0, "")
            .is_err()
    );
    assert_eq!(
        s.source_finding(&session, &op, &hypothesis())
            .unwrap()
            .revision,
        0
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM source_triage_decisions", [], |r| r
            .get::<_, u64>(0))
            .unwrap(),
        0
    );
    conn.execute_batch("DROP TRIGGER stop_triage;").unwrap();
    assert!(
        !s.triage_source_finding(&session, "d", &op, &hypothesis(), Status::Accepted, 0, "")
            .unwrap()
            .2
    );
}
#[test]
fn concurrent_compare_and_swap_has_exactly_one_winner() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s");
    let mut s = Store::open(&path).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let (op, _, _) = source(&mut s, &session, "source", false);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|i| {
            let path = path.clone();
            let session = session.clone();
            let op = op.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut s = Store::open(path).unwrap();
                barrier.wait();
                s.triage_source_finding(
                    &session,
                    &format!("d{i}"),
                    &op,
                    &hypothesis(),
                    Status::Accepted,
                    0,
                    "",
                )
                .is_ok()
            })
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .filter(|b| *b)
            .count(),
        1
    );
    assert_eq!(
        s.source_finding(&session, &op, &hypothesis())
            .unwrap()
            .revision,
        1
    );
}
#[test]
fn bounded_history_paginates_beyond_128_without_losing_decisions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s");
    let mut s = Store::open(&path).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let (op, _, _) = source(&mut s, &session, "source", false);
    let note = "é".repeat(2048);
    assert!(
        s.triage_source_finding(
            &session,
            "too-long",
            &op,
            &hypothesis(),
            Status::Accepted,
            0,
            &format!("{note}x")
        )
        .is_err()
    );
    for rev in 0..135 {
        s.triage_source_finding(
            &session,
            &format!("d{rev}"),
            &op,
            &hypothesis(),
            Status::Accepted,
            rev,
            &note,
        )
        .unwrap();
    }
    let mut cursor = 0;
    let mut count = 0;
    loop {
        let (current, page) = s
            .source_finding_with_history(&session, &op, &hypothesis(), cursor, 100)
            .unwrap();
        assert_eq!(current.revision, 135);
        assert!(
            serde_json::to_vec(&json!({"finding":current,"history":page}))
                .unwrap()
                .len()
                < 1024 * 1024
        );
        if page.is_empty() {
            break;
        }
        assert_eq!(page[0].revision, cursor + 1);
        cursor = page.last().unwrap().revision;
        count += page.len();
    }
    assert_eq!(count, 135);
    for limit in [0, 101] {
        assert!(
            s.source_finding_history(&session, &op, &hypothesis(), 0, limit)
                .is_err()
        );
    }
    assert!(
        s.source_finding_history(&session, &op, &hypothesis(), u64::MAX, 1)
            .is_err()
    );
    assert!(
        s.triage_source_finding(
            &session,
            "overflow",
            &op,
            &hypothesis(),
            Status::Accepted,
            u64::MAX,
            ""
        )
        .is_err()
    );
}
#[test]
fn corrupt_and_replaced_reviews_cannot_rebind_existing_triage() {
    for mutation in [
        "bytes",
        "attachment",
        "consistent_replacement",
        "outcome",
        "status",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s");
        let mut s = Store::open(&path).unwrap();
        let session = s.create_session("g", 0).unwrap().id;
        let (op, digest, mut review) = source(&mut s, &session, "source", false);
        s.triage_source_finding(
            &session,
            "decision",
            &op,
            &hypothesis(),
            Status::Accepted,
            0,
            "",
        )
        .unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        match mutation {
            "bytes" => {
                conn.execute(
                    "UPDATE artifacts SET bytes=X'00' WHERE digest=?1",
                    [&digest],
                )
                .unwrap();
            }
            "attachment" => {
                conn.execute(
                    "DELETE FROM operation_artifacts WHERE operation_id=?1",
                    [&op],
                )
                .unwrap();
            }
            "outcome" => {
                conn.execute("UPDATE operations SET outcome=json_set(outcome,'$.review.model','forged') WHERE id=?1",[&op]).unwrap();
            }
            "status" => {
                conn.execute("UPDATE operations SET status='unknown' WHERE id=?1", [&op])
                    .unwrap();
            }
            "consistent_replacement" => {
                use sha2::{Digest, Sha256};
                review["hypotheses"][0]["claim"]["explanation"] = json!("altered");
                let bytes = serde_json::to_vec(&review).unwrap();
                let replacement = format!("sha256:{:x}", Sha256::digest(&bytes));
                conn.execute(
                    "INSERT INTO artifacts(digest,bytes) VALUES(?1,?2)",
                    rusqlite::params![replacement, bytes],
                )
                .unwrap();
                conn.execute(
                    "UPDATE operation_artifacts SET digest=?1 WHERE operation_id=?2",
                    rusqlite::params![replacement, op],
                )
                .unwrap();
                let outcome =
                    json!({"review":review,"artifacts":{"source.review":replacement},"error":null});
                conn.execute(
                    "UPDATE operations SET outcome=?1 WHERE id=?2",
                    rusqlite::params![serde_json::to_string(&outcome).unwrap(), op],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            s.source_findings(&session, &op, 0, 32).is_err(),
            "{mutation}"
        );
        assert!(
            s.triage_source_finding(&session, "another", &op, &hypothesis(), Status::New, 1, "")
                .is_err()
        );
    }
}
#[test]
fn schema5_migration_preserves_source_queue_budget_and_readonly_refuses_migration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s");
    let mut s = Store::open(&path).unwrap();
    let session = s.create_session("g", 100).unwrap().id;
    let (op, digest, _) = source(&mut s, &session, "source", false);
    s.reserve_budget(&session, "held", 7).unwrap();
    drop(s);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP INDEX campaign_root_lifecycle; DROP INDEX campaign_exposure_witness; DROP TABLE campaign_debits; DROP TABLE campaign_exposures; DROP TABLE campaign_runs; DROP INDEX native_reproduction_admission_command; DROP INDEX native_reproduction_parent_command; DROP INDEX native_reproduction_command; DROP TABLE native_reproductions; DROP INDEX source_archive_command; DROP TABLE source_archives; DROP INDEX review_command_created; DROP TABLE reviews; DROP INDEX scan_command_created; DROP TABLE scans; DROP TABLE strategy_search_selections; DROP TABLE strategy_search_evaluations; DROP TABLE strategy_search_proposals; DROP TABLE strategy_searches; DROP TABLE strategy_sessions; DROP TABLE campaigns; DROP INDEX web_experiment_quota_events; DROP TABLE web_experiment_admissions; DROP TABLE web_triage_decisions; DROP INDEX http_receipt_events; DROP INDEX http_rate_events; DROP TABLE http_rates; DROP TABLE http_dispatches; DROP TABLE http_accounts; DROP TABLE tool_approval_consumptions; DROP TABLE tool_approval_decisions; DROP TABLE tool_approvals; DROP TABLE operator_question_decisions; DROP TABLE operator_questions; DROP TABLE agent_steering; DROP TABLE agent_steering_windows; DROP TABLE source_triage_decisions; PRAGMA user_version=5;")
        .unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    assert!(Store::open_read_only(&path).is_err());
    assert_eq!(before, std::fs::read(&path).unwrap());
    let mut s = Store::open(&path).unwrap();
    assert_eq!(s.budget(&session).unwrap().reserved, 7);
    assert!(!s.artifact(&digest).unwrap().is_empty());
    assert!(s.queued_agents(&session, 0, 100).unwrap().is_empty());
    s.triage_source_finding(&session, "d", &op, &hypothesis(), Status::Accepted, 0, "")
        .unwrap();
    let mut reader = Store::open_read_only(&path).unwrap();
    assert_eq!(
        reader
            .source_finding(&session, &op, &hypothesis())
            .unwrap()
            .revision,
        1
    );
    assert!(
        reader
            .triage_source_finding(
                &session,
                "forbidden",
                &op,
                &hypothesis(),
                Status::New,
                1,
                ""
            )
            .is_err()
    );
}

fn install_review(store: &mut Store, session: &str, review: &Value) -> String {
    let op = store
        .admit_command(
            session,
            "large-review",
            &json!({"kind":"source_hypothesis_review"}),
        )
        .unwrap()
        .operation
        .id;
    store.begin_operation(&op, "owner").unwrap();
    let digest = store
        .retain_operation_artifact(
            &op,
            "owner",
            "source.review",
            &serde_json::to_vec(review).unwrap(),
        )
        .unwrap();
    store
        .settle_operation(
            &op,
            "owner",
            OperationStatus::Succeeded,
            &json!({"review":review,"artifacts":{"source.review":digest},"error":null}),
        )
        .unwrap();
    op
}
#[test]
fn large_valid_claim_shapes_list_in_stable_byte_bounded_pages() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("s")).unwrap();
    let session = s.create_session("g", 0).unwrap().id;
    let (_, _, mut review) = source(&mut s, &session, "template", false);
    let mut claim = review["hypotheses"][0].clone();
    claim["claim"]["explanation"] = json!("e".repeat(8192));
    claim["claim"]["citations"]=json!((0..16).map(|i|json!({"path":format!("{}f{i}.rs","segment/".repeat(450)),"sha256":format!("sha256:{}","f".repeat(64)),"start_line":1,"end_line":1})).collect::<Vec<_>>());
    review["hypotheses"] = json!(
        (0..32)
            .map(|i| {
                let mut h = claim.clone();
                h["id"] = json!(format!("sha256:{i:064x}"));
                h
            })
            .collect::<Vec<_>>()
    );
    assert!(serde_json::to_vec(&review).unwrap().len() > 1024 * 1024);
    let op = install_review(&mut s, &session, &review);
    let mut offset = 0;
    let mut seen = Vec::new();
    loop {
        let page = s.source_findings(&session, &op, offset, 32).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() < 1024 * 1024);
        if page.is_empty() {
            break;
        }
        if offset == 0 {
            assert!(page.len() < 32);
        }
        offset += page.len() as u32;
        seen.extend(page.into_iter().map(|r| r.hypothesis.id));
    }
    assert_eq!(seen.len(), 32);
    assert_eq!(
        seen,
        review["hypotheses"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    );
    s.triage_source_finding(
        &session,
        "large-decision",
        &op,
        &seen[31],
        Status::Accepted,
        0,
        "",
    )
    .unwrap();
    assert_eq!(
        s.source_finding(&session, &op, &seen[31]).unwrap().revision,
        1
    );
    for limit in [0, 33] {
        assert!(s.source_findings(&session, &op, 0, limit).is_err());
    }
    assert!(
        s.source_findings(&session, &op, u32::MAX, 32)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn oversized_record_and_mutation_reply_fail_before_commit() {
    for giant in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path().join("s")).unwrap();
        let session = s.create_session("g", 0).unwrap().id;
        let (_, _, mut review) = source(&mut s, &session, "template", false);
        let page_limit = 1024 * 1024 - 4096;
        review["hypotheses"][0]["claim"]["explanation"] = json!("x".repeat(if giant {
            page_limit + 1
        } else {
            page_limit - 5000
        }));
        let op = install_review(&mut s, &session, &review);
        let before = s.events(&session, 0, 100).unwrap().len();
        if giant {
            assert!(s.source_finding(&session, &op, &hypothesis()).is_err());
            assert!(
                s.source_finding_with_history(&session, &op, &hypothesis(), 0, 50)
                    .is_err()
            );
        } else {
            assert!(s.source_finding(&session, &op, &hypothesis()).is_ok());
        }
        assert!(
            s.triage_source_finding(
                &session,
                "blocked",
                &op,
                &hypothesis(),
                Status::Accepted,
                0,
                &"n".repeat(4096)
            )
            .is_err()
        );
        assert_eq!(s.events(&session, 0, 100).unwrap().len(), before);
    }
}
