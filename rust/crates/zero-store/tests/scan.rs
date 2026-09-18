#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_protocol::{model::ResponsesRequest, scan::*, session::OperationStatus};
use zero_store::{ScanAdmission, Store};
fn hash(v: &Value) -> String {
    zero_web_verification::hash(v).unwrap()
}
fn prepared() -> ScanAdmission {
    let profile:ScanProfile=serde_json::from_value(json!({"schema_version":1,"kind":"scoped_http","provider":"p","model":"m","instructions":"Host instructions","http_profile":"target","budget_limit":10,"currency":"units","reservation_per_turn":6,"max_turns":3,"max_hypotheses":2,"deadline_ms":60000})).unwrap();
    let scan_id = uuid::Uuid::new_v4().to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let limits=serde_json::from_value(json!({"model_micro_usd":10,"model_calls":4,"http_requests":4,"http_request_body_bytes":1000,"http_response_decoded_bytes":2097152,"experiments":2,"runs":4,"max_parallel_runs":1})).unwrap();
    let policy = zero_http::normalize_policy(
        zero_protocol::strategy_search::search_fixture_profile("http://127.0.0.1:8080/", &limits)
            .unwrap(),
    )
    .unwrap();
    let target = "http://127.0.0.1:8080/";
    let root_command = format!("scan:{scan_id}:root");
    let pd = hash(&serde_json::to_value(&policy).unwrap());
    let context = json!({"schema_version":1,"profile_name":"target","profile":policy,"profile_sha256":pd,"original_root_command":root_command,"account_id":hash(&json!({"session_id":session_id,"original_root_command":root_command,"profile_sha256":pd}))});
    let request = profile.request(target).unwrap();
    let template:ResponsesRequest=serde_json::from_value(json!({"model":"m","instructions":request.instructions,"input":[],"max_output_tokens":8192,"tools":[{"name":"http_request","description":"HTTP","parameters":{"type":"object"}},{"name":"submit_web_hypotheses","description":"Submit","parameters":{"type":"object"}}]})).unwrap();
    let pins = json!({"p":{"endpoint":"http://127.0.0.1:9090/responses","wire_api":"responses","rates":{"input":1,"cached_input":1,"output":1}}});
    ScanAdmission {
        scan_id,
        session_id,
        controller_operation_id: uuid::Uuid::new_v4().to_string(),
        root_operation_id: uuid::Uuid::new_v4().to_string(),
        input_target: target.into(),
        target: target.into(),
        profile_name: "scan".into(),
        profile,
        provider_context: serde_json::from_value(pins.clone()).unwrap(),
        root_payload: json!({"kind":"scoped_web_agent","request":request,"endpoint":pins["p"]["endpoint"],"rates":pins["p"]["rates"],"http_context":context,"http_output_version":2,"scan_template":template}),
    }
}
fn setup() -> (tempfile::TempDir, Store, ScanAdmission) {
    let d = tempfile::tempdir().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    s.claim_engine_epoch("owner").unwrap();
    (d, s, prepared())
}
fn inference(s: &mut Store, a: &ScanAdmission, turn: u32) -> zero_protocol::Operation {
    let mut request = a.root_payload["scan_template"].clone();
    request["input"] = json!([{"role":"user","content":a.root_payload["request"]["prompt"]}]);
    s.admit_owned_batch(&a.session_id,"owner",&[(format!("{}:model:{turn}",a.root_operation_id),json!({"kind":"agent_inference","parent_operation":a.root_operation_id,"request":request,"endpoint":a.root_payload["endpoint"],"rates":a.root_payload["rates"],"wire_api":"responses"}))]).unwrap().remove(0)
}
fn complete(s: &mut Store, id: &str) {
    s.settle_operation(id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","response_id":"r","content":[{"type":"text","text":"Continue"}],"usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0},"usage_is_final":true,"replay":[],"error":null})).unwrap();
}
#[test]
fn atomic_graph_retry_and_owner_loss_are_inert() {
    let (d, mut s, a) = setup();
    let admitted = s.admit_scan("run", "owner", &a).unwrap();
    assert!(!admitted.duplicate);
    assert_eq!(s.scan_snapshot(&a.scan_id).unwrap().budget.limit, 10);
    let n = rusqlite::Connection::open(d.path().join("db")).unwrap();
    assert_eq!(
        n.query_row("SELECT count(*) FROM http_accounts", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        1
    );
    let mut other = prepared();
    other.input_target = a.input_target.clone();
    assert!(
        s.admit_scan("run", "unknown-owner", &other)
            .unwrap()
            .duplicate
    );
    other.input_target.push_str("changed");
    assert!(s.admit_scan("run", "owner", &other).is_err());
    s.claim_engine_epoch("next").unwrap();
    assert_eq!(
        s.scan_snapshot(&a.scan_id).unwrap().root_status,
        OperationStatus::Unknown
    );
    assert!(s.admit_scan("run", "next", &a).unwrap().duplicate);
    drop(s);
    let readonly = Store::open_read_only(d.path().join("db")).unwrap();
    assert_eq!(
        readonly.scan_by_command("run").unwrap().unwrap().id,
        a.scan_id
    );
    assert_eq!(readonly.scan_page(None, 32).unwrap().scans.len(), 1);
}
#[test]
fn rollback_at_binding_or_account_insert_leaves_no_session_or_operations() {
    for table in ["scans", "http_accounts"] {
        let (d, mut s, a) = setup();
        let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
        c.execute_batch(&format!(
            "CREATE TRIGGER deny BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT,'test'); END;"
        ))
        .unwrap();
        assert!(s.admit_scan("run", "owner", &a).is_err());
        for table in [
            "scans",
            "sessions",
            "operations",
            "artifacts",
            "http_accounts",
        ] {
            assert_eq!(
                c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, u32>(0))
                    .unwrap(),
                0
            );
        }
    }
}
#[test]
fn generic_root_widened_template_and_unknown_http_call_are_rejected() {
    let (_d, mut s, a) = setup();
    s.admit_scan("run", "owner", &a).unwrap();
    for payload in [
        json!({"kind":"responses_inference"}),
        a.root_payload.clone(),
        json!({"kind":"snapshot"}),
    ] {
        assert!(s.admit_command(&a.session_id, "bypass", &payload).is_err());
    }
    let mut request = a.root_payload["scan_template"].clone();
    request["tools"][0]["parameters"] = json!({"type":"object","properties":{"widened":{}}});
    let forged = json!({"kind":"agent_inference","parent_operation":a.root_operation_id,"request":request,"endpoint":a.root_payload["endpoint"],"rates":a.root_payload["rates"]});
    assert!(
        s.admit_command(
            &a.session_id,
            &format!("{}:model:0", a.root_operation_id),
            &forged
        )
        .is_err()
    );
    assert!(s.admit_command(&a.session_id,&format!("{}:tool:0:0",a.root_operation_id),&json!({"kind":"agent_http","parent_operation":a.root_operation_id,"http_context":a.root_payload["http_context"],"call_id":"invented","request":{}})).is_err());
    let op = inference(&mut s, &a, 0);
    assert!(s.reserve_budget(&a.session_id, &op.id, 5).is_err());
    s.reserve_budget(&a.session_id, &op.id, 6).unwrap();
    assert!(
        s.reconcile_budget(&a.session_id, &op.id, 0, "manual")
            .is_err()
    );
}
#[test]
fn budget_denial_is_committed_but_not_terminal_without_root_cause() {
    let (d, mut s, a) = setup();
    s.admit_scan("run", "owner", &a).unwrap();
    let first = inference(&mut s, &a, 0);
    s.reserve_budget(&a.session_id, &first.id, 6).unwrap();
    s.settle_budget(&a.session_id, &first.id, 5).unwrap();
    complete(&mut s, &first.id);
    let second = inference(&mut s, &a, 1);
    assert!(matches!(
        s.reserve_budget(&a.session_id, &second.id, 6),
        Err(zero_store::Error::BudgetExceeded)
    ));
    assert_eq!(s.budget(&a.session_id).unwrap().reserved, 0);
    assert!(!s.scan_terminal_budget_denied(&a.scan_id).unwrap());
    s.append_operation_event(
        &a.root_operation_id,
        "owner",
        "scan_terminal_budget_denied",
        &json!({"operation_id":second.id}),
    )
    .unwrap();
    assert!(s.scan_terminal_budget_denied(&a.scan_id).unwrap());
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    c.execute("UPDATE events SET payload=json_set(payload,'$.charged',NULL) WHERE kind='scan_budget_denied'",[]).unwrap();
    assert!(s.scan_terminal_budget_denied(&a.scan_id).is_err());
}
#[test]
fn cancellation_closes_admission_but_allows_final_known_charge() {
    let (_d, mut s, a) = setup();
    s.admit_scan("run", "owner", &a).unwrap();
    let first = inference(&mut s, &a, 0);
    s.reserve_budget(&a.session_id, &first.id, 6).unwrap();
    assert!(
        s.request_scan_stop(&a.scan_id, "owner", ScanCloseReason::Cancelled)
            .unwrap()
    );
    assert!(
        !s.request_scan_stop(&a.scan_id, "owner", ScanCloseReason::Deadline)
            .unwrap()
    );
    s.settle_budget(&a.session_id, &first.id, 3).unwrap();
    complete(&mut s, &first.id);
    assert!(
        s.admit_command(
            &a.session_id,
            "new",
            &json!({"kind":"agent_inference","parent_operation":a.root_operation_id})
        )
        .is_err()
    );
    assert_eq!(
        s.scan_snapshot(&a.scan_id).unwrap().phase,
        ScanPhase::Cancelling
    );
}
#[test]
fn deleted_projection_or_corrupt_intent_never_frees_command_or_session() {
    for corruption in [
        "DELETE FROM scans",
        "UPDATE scans SET record='{}'",
        "UPDATE artifacts SET bytes=x'00'",
    ] {
        let (d, mut s, a) = setup();
        s.admit_scan("run", "owner", &a).unwrap();
        let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
        c.execute(corruption, []).unwrap();
        assert!(s.scan_by_command("run").is_err());
        assert!(
            s.admit_command(
                &a.session_id,
                "bypass",
                &json!({"kind":"responses_inference"})
            )
            .is_err()
        );
        assert!(s.admit_scan("run", "owner", &a).is_err());
    }
}

#[test]
fn elapsed_deadline_refuses_new_reservations_and_records_stop() {
    let (_d, mut s, mut a) = setup();
    a.profile.deadline_ms = 1;
    s.admit_scan("run", "owner", &a).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(3));
    assert!(
        s.admit_command(
            &a.session_id,
            "late",
            &json!({"kind":"agent_inference","parent_operation":a.root_operation_id})
        )
        .is_err()
    );
    assert!(
        s.request_scan_stop(&a.scan_id, "owner", ScanCloseReason::Deadline)
            .unwrap()
    );
    assert_eq!(
        s.scan_snapshot(&a.scan_id).unwrap().close_reason,
        Some(ScanCloseReason::Deadline)
    );
}
#[test]
fn concurrent_command_retry_has_one_original_account() {
    let (d, s, a) = setup();
    drop(s);
    let mut left = Store::open(d.path().join("db")).unwrap();
    let mut right = Store::open(d.path().join("db")).unwrap();
    let b = prepared();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let wait = barrier.clone();
    let first = std::thread::spawn(move || {
        wait.wait();
        left.admit_scan("same", "owner", &a).unwrap()
    });
    let second = std::thread::spawn(move || {
        barrier.wait();
        right.admit_scan("same", "owner", &b).unwrap()
    });
    let (first, second) = (first.join().unwrap(), second.join().unwrap());
    assert_eq!(first.scan, second.scan);
    assert_ne!(first.duplicate, second.duplicate);
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    for table in ["scans", "sessions", "http_accounts"] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            1
        );
    }
}
#[test]
fn forged_budget_projection_is_not_displayed_as_measured() {
    let (d, mut s, a) = setup();
    s.admit_scan("run", "owner", &a).unwrap();
    let op = inference(&mut s, &a, 0);
    s.reserve_budget(&a.session_id, &op.id, 6).unwrap();
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    c.execute("UPDATE reservations SET charged=0", []).unwrap();
    assert!(s.scan_snapshot(&a.scan_id).is_err());
}

#[test]
fn original_http_ledger_distinguishes_complete_bytes_from_uncertain_holds() {
    for complete_response in [false, true] {
        let (d, mut s, a) = setup();
        let admitted = s.admit_scan("run", "owner", &a).unwrap();
        let inference = inference(&mut s, &a, 0);
        let args = json!({"url":a.target,"method":"GET","headers":{},"body":null});
        s.settle_operation(&inference.id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","response_id":"r","content":[{"type":"tool_call","id":"call","name":"http_request","arguments":args}],"usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0},"usage_is_final":true,"replay":[],"error":null})).unwrap();
        let policy =
            serde_json::from_value(a.root_payload["http_context"]["profile"].clone()).unwrap();
        let intent =
            zero_http::normalize_intent(&policy, serde_json::from_value(args).unwrap()).unwrap();
        let effect=s.admit_owned_batch(&a.session_id,"owner",&[(format!("{}:tool:0:0",a.root_operation_id),json!({"kind":"agent_http","parent_operation":a.root_operation_id,"http_context":a.root_payload["http_context"],"http_output_version":2,"call_id":"call","request":intent}))]).unwrap().remove(0);
        let hop = json!({"index":0,"host":"127.0.0.1","profile_sha256":a.root_payload["http_context"]["profile_sha256"],"url":a.target,"method":"GET","addresses":["127.0.0.1:8080"],"selected_address":"127.0.0.1:8080","request_body_bytes":0,"response_decoded_limit":policy.limits.max_response_decoded_bytes});
        let mut forged = hop.clone();
        forged["url"] = json!("http://127.0.0.1:8080/forged");
        assert!(
            s.admit_http_hop(
                &a.session_id,
                &effect.id,
                "owner",
                &admitted.scan.http_account_id,
                &forged,
                1000
            )
            .is_err()
        );
        let receipt = match s
            .admit_http_hop(
                &a.session_id,
                &effect.id,
                "owner",
                &admitted.scan.http_account_id,
                &hop,
                1000,
            )
            .unwrap()
        {
            zero_store::HttpAdmission::Admitted { receipt } => receipt,
            _ => panic!("permit expected"),
        };
        let usage = s.scan_snapshot(&a.scan_id).unwrap().http_usage;
        assert_eq!(usage.requests, 1);
        assert_eq!(
            usage.response_reserved_bytes,
            policy.limits.max_response_decoded_bytes
        );
        s.observe_http_headers(
            &a.session_id,
            &effect.id,
            "owner",
            &receipt,
            200,
            None,
            1000,
        )
        .unwrap();
        s.settle_http_hop(&a.session_id,&effect.id,"owner",&receipt,&json!({"index":0,"permit":{"id":receipt},"status":200,"request_body_bytes":0,"response_wire_bytes":23,"response_decoded_bytes":23,"complete":complete_response,"error":if complete_response{Value::Null}else{json!("cancelled")}})).unwrap();
        let usage = s.scan_snapshot(&a.scan_id).unwrap().http_usage;
        assert_eq!(
            usage.response_charged_bytes,
            if complete_response { 23 } else { 0 }
        );
        assert_eq!(
            usage.response_reserved_bytes,
            if complete_response {
                0
            } else {
                policy.limits.max_response_decoded_bytes
            }
        );
        let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
        c.execute("DELETE FROM http_dispatches", []).unwrap();
        assert!(s.scan_snapshot(&a.scan_id).is_err());
    }
}
