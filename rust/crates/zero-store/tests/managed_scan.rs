#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_protocol::managed_scan::ManagedScanGrant;
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
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn grant(a: &ScanAdmission) -> ManagedScanGrant {
    serde_json::from_value(json!({
        "contract_version":"0sec-native-http/v1",
        "cloud_scan_id":uuid::Uuid::new_v4().to_string(),
        "organization_id":uuid::Uuid::new_v4().to_string(),
        "dispatch_id":uuid::Uuid::new_v4().to_string(),
        "grant_revision":"host-v1",
        "expires_at_ms":now()+600000,
        "target":a.target,
        "scan_profile_name":a.profile_name,
        "scan_profile":a.profile,
        "http_policy":a.root_payload["http_context"]["profile"],
        "providers":a.provider_context,
    }))
    .unwrap()
}
#[test]
fn atomic_managed_admission_has_one_original_account_and_exact_inert_retry() {
    let (d, mut s, a) = setup();
    let g = grant(&a);
    let first = s
        .admit_managed_scan(&g.command_id(), "owner", &a, &g)
        .unwrap();
    assert!(!first.duplicate);
    assert_eq!(
        serde_json::to_value(s.scan_managed_grant(&a.scan_id).unwrap()).unwrap(),
        json!(g)
    );
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    for (table, count) in [
        ("sessions", 1),
        ("operations", 2),
        ("http_accounts", 1),
        ("scans", 1),
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            count
        );
    }
    let events: u64 = c
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap();
    let mut retry = prepared();
    retry.root_payload = json!({"no_current_configuration":true});
    assert!(
        s.admit_managed_scan(&g.command_id(), "retired-owner", &retry, &g)
            .unwrap()
            .duplicate
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, u64>(0))
            .unwrap(),
        events
    );
    assert!(s.admit_scan(&g.command_id(), "owner", &a).is_err());
    let mut changed = g.clone();
    changed.grant_revision.push_str("-changed");
    assert!(
        s.admit_managed_scan(&g.command_id(), "owner", &a, &changed)
            .is_err()
    );
    assert_eq!(s.scan_snapshot(&a.scan_id).unwrap().budget.reserved, 0);
}
#[test]
fn standalone_intent_bytes_and_replay_mode_are_unchanged() {
    let (_d, mut s, a) = setup();
    let g = grant(&a);
    let result = s.admit_scan(&g.command_id(), "owner", &a).unwrap();
    assert!(s.scan_managed_grant(&a.scan_id).unwrap().is_none());
    let expected = json!({"schema_version":1,"kind":"native_scan_intent","admission":a,"command_id":g.command_id(),"created_at_ms":result.scan.created_at_ms,"deadline_at_ms":result.scan.created_at_ms+a.profile.deadline_ms});
    assert_eq!(result.scan.intent_sha256, hash(&expected));
    assert_eq!(
        s.artifact(&result.scan.intent_sha256).unwrap(),
        serde_json::to_vec(&expected).unwrap()
    );
    assert!(
        s.admit_managed_scan(&g.command_id(), "owner", &a, &g)
            .is_err()
    );
    assert!(
        s.admit_scan(&g.command_id(), "owner", &a)
            .unwrap()
            .duplicate
    );
}
#[test]
fn fresh_grant_mismatches_or_expiry_never_create_any_scan_state() {
    for field in [
        "command",
        "target",
        "profile_name",
        "profile",
        "http",
        "provider",
        "expired",
        "nonnormalized",
    ] {
        let (d, mut s, a) = setup();
        let mut g = grant(&a);
        let mut command = g.command_id();
        match field {
            "command" => command.push_str("other"),
            "target" => g.target.push_str("different"),
            "profile_name" => g.scan_profile_name.push_str("other"),
            "profile" => g.scan_profile.instructions.push_str("changed"),
            "http" => g.http_policy.budget.max_requests += 1,
            "provider" => g.providers.get_mut("p").unwrap().rates.input += 1,
            "expired" => g.expires_at_ms = now() - 1,
            "nonnormalized" => g.http_policy.allowed_methods.push("get".into()),
            _ => unreachable!(),
        }
        assert!(
            s.admit_managed_scan(&command, "owner", &a, &g).is_err(),
            "{field}"
        );
        let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
        for table in [
            "sessions",
            "scans",
            "operations",
            "http_accounts",
            "artifacts",
        ] {
            assert_eq!(
                c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, u64>(0))
                    .unwrap(),
                0,
                "{field} {table}"
            );
        }
    }
}
#[test]
fn grant_deadline_caps_effects_but_expired_recovery_and_exact_retry_remain_readable() {
    let (d, mut s, a) = setup();
    let mut g = grant(&a);
    g.expires_at_ms = now() + 500;
    let first = s
        .admit_managed_scan(&g.command_id(), "owner", &a, &g)
        .unwrap();
    assert_eq!(first.scan.deadline_at_ms, g.expires_at_ms);
    let mut request = a.root_payload["scan_template"].clone();
    request["input"] = json!([{"role":"user","content":a.root_payload["request"]["prompt"]}]);
    let inference=s.admit_owned_batch(&a.session_id,"owner",&[(format!("{}:model:0",a.root_operation_id),json!({"kind":"agent_inference","parent_operation":a.root_operation_id,"request":request,"endpoint":a.root_payload["endpoint"],"rates":a.root_payload["rates"],"wire_api":"responses"}))]).unwrap().remove(0);
    std::thread::sleep(std::time::Duration::from_millis(510));
    assert!(
        s.reserve_budget(&a.session_id, &inference.id, a.profile.reservation_per_turn)
            .is_err()
    );
    assert_eq!(s.budget(&a.session_id).unwrap().reserved, 0);
    assert!(
        s.request_scan_stop(&a.scan_id, "owner", ScanCloseReason::Deadline)
            .unwrap()
    );
    assert_eq!(
        s.scan_snapshot(&a.scan_id).unwrap().close_reason,
        Some(ScanCloseReason::Deadline)
    );
    assert!(
        s.admit_command(
            &a.session_id,
            "bypass",
            &json!({"kind":"responses_inference"})
        )
        .is_err()
    );
    assert_eq!(
        s.scan_record(&a.scan_id).unwrap().deadline_at_ms,
        g.expires_at_ms
    );
    assert!(
        s.admit_managed_scan(&g.command_id(), "owner", &a, &g)
            .unwrap()
            .duplicate
    );
    s.claim_engine_epoch("next").unwrap();
    assert_eq!(
        s.scan_snapshot(&a.scan_id).unwrap().root_status,
        OperationStatus::Unknown
    );
    drop(s);
    let readonly = Store::open_read_only(d.path().join("db")).unwrap();
    assert_eq!(
        json!(readonly.scan_managed_grant(&a.scan_id).unwrap()),
        json!(g)
    );
    let view = readonly.scan_read_snapshot(&a.scan_id).unwrap();
    assert_eq!(
        json!(view.scan_managed_grant(&a.scan_id).unwrap()),
        json!(g)
    );
}
#[test]
fn deleted_or_modified_projection_and_witness_never_free_managed_identity() {
    for mutation in [
        "DELETE FROM scans",
        "UPDATE scans SET record='{}'",
        "DELETE FROM events WHERE kind='scan_created'",
        "UPDATE events SET payload=json_set(payload,'$.intent_sha256','changed') WHERE kind='scan_created'",
        "UPDATE artifacts SET bytes=x'00'",
        "DELETE FROM operation_artifacts WHERE name='scan.intent'",
    ] {
        let (d, mut s, a) = setup();
        let g = grant(&a);
        s.admit_managed_scan(&g.command_id(), "owner", &a, &g)
            .unwrap();
        let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
        c.execute(mutation, []).unwrap();
        assert!(s.scan_managed_grant(&a.scan_id).is_err(), "{mutation}");
        assert!(
            s.admit_managed_scan(&g.command_id(), "owner", &a, &g)
                .is_err(),
            "{mutation}"
        );
        assert!(
            s.admit_scan(&g.command_id(), "owner", &a).is_err(),
            "{mutation}"
        );
        assert!(
            s.admit_command(
                &a.session_id,
                "escape",
                &json!({"kind":"responses_inference"})
            )
            .is_err(),
            "{mutation}"
        );
    }
}
#[test]
fn managed_atomic_admission_rolls_back_after_account_failure() {
    let (d, mut s, a) = setup();
    let g = grant(&a);
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    c.execute_batch(
        "CREATE TRIGGER deny BEFORE INSERT ON http_accounts BEGIN SELECT RAISE(ABORT,'test'); END;",
    )
    .unwrap();
    assert!(
        s.admit_managed_scan(&g.command_id(), "owner", &a, &g)
            .is_err()
    );
    for table in [
        "sessions",
        "operations",
        "scans",
        "artifacts",
        "events",
        "http_accounts",
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            0
        );
    }
}
// Rehash an altered intent and all public hash references, so rejection cannot
// be attributed only to a stale content digest or mismatched event pointer.
fn rebind_intent(c: &rusqlite::Connection, old: &str, intent: &Value) {
    let digest = hash(intent);
    c.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
    c.execute(
        "UPDATE artifacts SET digest=?2,bytes=?3 WHERE digest=?1",
        rusqlite::params![old, digest, serde_json::to_vec(intent).unwrap()],
    )
    .unwrap();
    c.execute(
        "UPDATE scans SET intent_sha256=?2,record=replace(record,?1,?2) WHERE intent_sha256=?1",
        rusqlite::params![old, digest],
    )
    .unwrap();
    c.execute(
        "UPDATE operation_artifacts SET digest=?2 WHERE digest=?1",
        rusqlite::params![old, digest],
    )
    .unwrap();
    c.execute(
        "UPDATE events SET payload=replace(payload,?1,?2)",
        rusqlite::params![old, digest],
    )
    .unwrap();
    let mut q = c.prepare("SELECT id,payload FROM operations").unwrap();
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for (id, payload) in rows {
        let payload = payload.replace(old, &digest);
        let value: Value = serde_json::from_str(&payload).unwrap();
        c.execute(
            "UPDATE operations SET payload=?2,payload_hash=?3 WHERE id=?1",
            rusqlite::params![id, payload, hash(&value).strip_prefix("sha256:").unwrap()],
        )
        .unwrap();
    }
}
#[test]
fn reconstructed_intent_rejects_unknown_fields_and_grant_authority_even_after_rehash() {
    for mutation in [
        "unknown_intent",
        "null_grant",
        "unknown_grant",
        "grant_policy",
        "deadline",
    ] {
        let (d, mut s, a) = setup();
        let g = grant(&a);
        let admitted = s
            .admit_managed_scan(&g.command_id(), "owner", &a, &g)
            .unwrap();
        let mut intent: Value =
            serde_json::from_slice(&s.artifact(&admitted.scan.intent_sha256).unwrap()).unwrap();
        match mutation {
            "unknown_intent" => intent["managed_override"] = json!({"ignore_deadline":true}),
            "null_grant" => intent["managed_grant"] = Value::Null,
            "unknown_grant" => intent["managed_grant"]["ignore_expiry"] = json!(true),
            "grant_policy" => intent["managed_grant"]["scan_profile"]["budget_limit"] = json!(100),
            "deadline" => intent["deadline_at_ms"] = json!(g.expires_at_ms + 1),
            _ => unreachable!(),
        }
        let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
        rebind_intent(&c, &admitted.scan.intent_sha256, &intent);
        assert!(s.scan_managed_grant(&a.scan_id).is_err(), "{mutation}");
        assert!(s.scan_snapshot(&a.scan_id).is_err(), "{mutation}");
    }
}
