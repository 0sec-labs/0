use super::*;

fn fixture() -> (Store, String, Value, String) {
    fixture_at(":memory:")
}
fn fixture_at(path: impl AsRef<std::path::Path>) -> (Store, String, Value, String) {
    let mut store = Store::open(path).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let session = store.create_session("gen", 1000).unwrap().id;
    let profile = json!({"schema_version":1,"base_url":"http://localhost/","in_scope":["localhost"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":["/"],"denied_path_prefixes":[],"allowed_methods":["GET","POST"],"allowed_headers":[],"redirect":{"mode":"manual"},"limits":{"timeout_ms":1000,"max_request_body_bytes":100,"max_response_wire_bytes":100,"max_response_decoded_bytes":100,"max_request_header_bytes":100,"max_request_headers":10,"max_response_header_bytes":100,"max_response_headers":10,"max_dns_answers":10,"max_dns_cname_depth":2,"max_dns_queries":10},"rate":{"default":{"requests_per_interval":1,"interval_ms":1000,"burst":1},"per_host":{},"jitter_ms":0},"budget":{"max_requests":3,"max_request_body_bytes":10,"max_response_decoded_bytes":150}});
    let digest = hash(&profile).unwrap();
    let account =
        hash(&json!({"session_id":session,"original_root_command":"root","profile_sha256":digest}))
            .unwrap();
    let context = json!({"schema_version":1,"profile_name":"test","profile":profile,"profile_sha256":digest,"account_id":account,"original_root_command":"root"});
    store
        .admit_owned_batch(
            &session,
            "owner",
            &[(
                "root".into(),
                json!({"kind":"offline_snapshot_agent","request":{"http_profile":"test"},"http_context":context}),
            )],
        )
        .unwrap();
    store.ensure_http_account(&session, &context).unwrap();
    (store, session, context, account)
}
fn effect(store: &mut Store, session: &str, context: &Value, name: &str) -> String {
    store
        .admit_owned_batch(
            session,
            "owner",
            &[(
                name.into(),
                json!({"kind":"agent_http","http_context":context}),
            )],
        )
        .unwrap()[0]
        .id
        .clone()
}
fn intent(context: &Value) -> Value {
    json!({"index":0,"host":"localhost","profile_sha256":context["profile_sha256"],"url":"http://localhost/","method":"POST","addresses":["127.0.0.1:80"],"selected_address":"127.0.0.1:80","request_body_bytes":2,"response_decoded_limit":100})
}
fn permit(result: HttpAdmission) -> String {
    match result {
        HttpAdmission::Admitted { receipt } => receipt,
        _ => panic!("expected permit"),
    }
}
fn observation(id: &str, complete: bool, decoded: u64) -> Value {
    json!({"index":0,"permit":{"id":id},"status":200,"request_body_bytes":2,"response_wire_bytes":decoded,"response_decoded_bytes":decoded,"complete":complete,"error":if complete{Value::Null}else{json!("cancelled")}})
}
#[test]
fn shared_siblings_refund_only_known_complete_and_cannot_replay() {
    let (mut s, session, c, a) = fixture();
    let e1 = effect(&mut s, &session, &c, "one");
    let e2 = effect(&mut s, &session, &c, "two");
    let i = intent(&c);
    let p = permit(
        s.admit_http_hop(&session, &e1, "owner", &a, &i, 1000)
            .unwrap(),
    );
    assert!(matches!(
        s.admit_http_hop(&session, &e2, "owner", &a, &i, 2000),
        Err(Error::BudgetExceeded)
    ));
    s.observe_http_headers(&session, &e1, "owner", &p, 200, None, 1000)
        .unwrap();
    let o = observation(&p, true, 20);
    s.settle_http_hop(&session, &e1, "owner", &p, &o).unwrap();
    s.settle_http_hop(&session, &e1, "owner", &p, &o).unwrap();
    assert_eq!(
        s.admit_http_hop(&session, &e2, "owner", &a, &i, 1500)
            .unwrap(),
        HttpAdmission::WaitUntil { unix_ms: 2000 }
    );
    let p2 = permit(
        s.admit_http_hop(&session, &e2, "owner", &a, &i, 2000)
            .unwrap(),
    );
    assert!(
        s.admit_http_hop(&session, &e2, "owner", &a, &i, 3000)
            .is_err()
    );
    s.settle_http_hop(&session, &e2, "owner", &p2, &observation(&p2, false, 10))
        .unwrap();
    let rows = s.read_http_dispatches(&session, &e2).unwrap();
    assert_eq!(rows[0]["charged_response_decoded_bytes"], 100);
    assert!(
        s.settle_http_hop(&session, &e2, "owner", &p2, &observation(&p2, true, 10))
            .is_err()
    );
}
#[test]
fn cooldown_is_shared_and_recovery_never_releases_uncertain_reservation() {
    let (mut s, session, c, a) = fixture();
    let i = intent(&c);
    let e = effect(&mut s, &session, &c, "one");
    let p = permit(
        s.admit_http_hop(&session, &e, "owner", &a, &i, 1000)
            .unwrap(),
    );
    s.observe_http_headers(&session, &e, "owner", &p, 429, Some(80_000), 1000)
        .unwrap();
    let mut o = observation(&p, true, 0);
    o["status"] = json!(429);
    s.settle_http_hop(&session, &e, "owner", &p, &o).unwrap();
    let e2 = effect(&mut s, &session, &c, "two");
    assert_eq!(
        s.admit_http_hop(&session, &e2, "owner", &a, &i, 2000)
            .unwrap(),
        HttpAdmission::WaitUntil { unix_ms: 80_000 }
    );
    permit(
        s.admit_http_hop(&session, &e2, "owner", &a, &i, 80_000)
            .unwrap(),
    );
    s.claim_engine_epoch("next").unwrap();
    assert!(
        s.admit_http_hop(&session, &e2, "owner", &a, &i, 100_000)
            .is_err()
    );
    s.ensure_http_account(&session, &c).unwrap();
    let e3 = s
        .admit_owned_batch(
            &session,
            "next",
            &[(
                "three".into(),
                json!({"kind":"agent_http","http_context":c}),
            )],
        )
        .unwrap()[0]
        .id
        .clone();
    assert!(matches!(
        s.admit_http_hop(&session, &e3, "next", &a, &i, 100_000),
        Err(Error::BudgetExceeded)
    ));
    assert_eq!(s.read_http_dispatches(&session, &e2).unwrap().len(), 1);
}
#[test]
fn account_authority_and_owner_mismatch_have_no_dispatch_side_effects() {
    let (mut s, session, c, a) = fixture();
    let e = effect(&mut s, &session, &c, "one");
    let i = intent(&c);
    assert!(s.admit_http_hop(&session, &e, "other", &a, &i, 0).is_err());
    let mut wrong = c.clone();
    wrong["profile"]["budget"]["max_requests"] = json!(999);
    assert!(s.ensure_http_account(&session, &wrong).is_err());
    let mut bad = i.clone();
    bad["index"] = json!(1);
    assert!(
        s.admit_http_hop(&session, &e, "owner", &a, &bad, 0)
            .is_err()
    );
    assert!(s.read_http_dispatches(&session, &e).unwrap().is_empty());
}

#[test]
fn changing_projection_or_journal_witness_cannot_forge_a_dispatch_receipt() {
    for change_event in [false, true] {
        let (mut s, session, c, a) = fixture();
        let e = effect(&mut s, &session, &c, "one");
        let p = permit(
            s.admit_http_hop(&session, &e, "owner", &a, &intent(&c), 1000)
                .unwrap(),
        );
        s.observe_http_headers(&session, &e, "owner", &p, 200, None, 1000)
            .unwrap();
        s.settle_http_hop(&session, &e, "owner", &p, &observation(&p, true, 20))
            .unwrap();
        assert_eq!(s.read_http_dispatches(&session, &e).unwrap().len(), 1);
        if change_event {
            s.conn.execute("UPDATE events SET payload=json_set(payload,'$.charged_response_decoded_bytes',0) WHERE kind='http_hop_settled'",[]).unwrap();
        } else {
            s.conn
                .execute(
                    "UPDATE http_dispatches SET charged_bytes=0 WHERE id=?1",
                    [&p],
                )
                .unwrap();
        }
        assert!(s.read_http_dispatches(&session, &e).is_err());
    }
}

#[test]
fn two_connections_cannot_overspend_shared_response_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let (mut store, session, context, account) = fixture_at(&path);
    let first = effect(&mut store, &session, &context, "first");
    let second = effect(&mut store, &session, &context, "second");
    drop(store);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers = [first, second]
        .into_iter()
        .map(|effect| {
            let (path, session, context, account, barrier) = (
                path.clone(),
                session.clone(),
                context.clone(),
                account.clone(),
                barrier.clone(),
            );
            std::thread::spawn(move || {
                let mut store = Store::open(path).unwrap();
                barrier.wait();
                store.admit_http_hop(
                    &session,
                    &effect,
                    "owner",
                    &account,
                    &intent(&context),
                    1000,
                )
            })
        })
        .collect::<Vec<_>>();
    let results = workers
        .into_iter()
        .map(|w| w.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Ok(HttpAdmission::Admitted { .. })))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(Error::BudgetExceeded)))
            .count(),
        1
    );
}

#[test]
fn redirect_admission_binds_url_and_method_to_previous_complete_observation() {
    for status in [303, 307] {
        let (mut s, session, mut c, _) = fixture();
        c["profile"]["redirect"] = json!({"mode":"follow","max_hops":2});
        c["profile_sha256"] = json!(hash(&c["profile"]).unwrap());
        c["original_root_command"] = json!("redirect-root");
        let account=hash(&json!({"session_id":session,"original_root_command":"redirect-root","profile_sha256":c["profile_sha256"]})).unwrap();
        c["account_id"] = json!(account);
        s.admit_owned_batch(&session,"owner",&[("redirect-root".into(),json!({"kind":"offline_snapshot_agent","request":{"http_profile":"test"},"http_context":c}))]).unwrap();
        s.ensure_http_account(&session, &c).unwrap();
        let e = effect(&mut s, &session, &c, "redirect-effect");
        let initial = intent(&c);
        let p = permit(
            s.admit_http_hop(&session, &e, "owner", &account, &initial, 1000)
                .unwrap(),
        );
        let mut next = initial.clone();
        next["index"] = json!(1);
        next["url"] = json!("http://localhost/destination");
        if status == 303 {
            next["method"] = json!("GET");
            next["request_body_bytes"] = json!(0);
        }
        assert!(
            s.admit_http_hop(&session, &e, "owner", &account, &next, 2000)
                .is_err()
        );
        s.observe_http_headers(&session, &e, "owner", &p, status, None, 1000)
            .unwrap();
        let mut observed = observation(&p, true, 10);
        observed["status"] = json!(status);
        observed["redirect_url"] = next["url"].clone();
        s.settle_http_hop(&session, &e, "owner", &p, &observed)
            .unwrap();
        let mut forged = next.clone();
        forged["url"] = json!("http://localhost/other");
        assert!(
            s.admit_http_hop(&session, &e, "owner", &account, &forged, 2000)
                .is_err()
        );
        let mut forged = next.clone();
        forged["method"] = json!("DELETE");
        assert!(
            s.admit_http_hop(&session, &e, "owner", &account, &forged, 2000)
                .is_err()
        );
        permit(
            s.admit_http_hop(&session, &e, "owner", &account, &next, 2000)
                .unwrap(),
        );
        assert_eq!(s.read_http_dispatches(&session, &e).unwrap().len(), 2);
    }
}

#[test]
fn oversized_retry_after_cannot_disable_mandatory_shared_cooldown() {
    let (mut s, session, c, a) = fixture();
    let e = effect(&mut s, &session, &c, "one");
    let i = intent(&c);
    let p = permit(
        s.admit_http_hop(&session, &e, "owner", &a, &i, 1000)
            .unwrap(),
    );
    s.observe_http_headers(&session, &e, "owner", &p, 429, Some(u64::MAX), 1000)
        .unwrap();
    let mut observed = observation(&p, true, 0);
    observed["status"] = json!(429);
    s.settle_http_hop(&session, &e, "owner", &p, &observed)
        .unwrap();
    let sibling = effect(&mut s, &session, &c, "two");
    assert_eq!(
        s.admit_http_hop(&session, &sibling, "owner", &a, &i, 100_000)
            .unwrap(),
        HttpAdmission::WaitUntil {
            unix_ms: i64::MAX as u64
        }
    );
    assert_eq!(s.read_http_dispatches(&session, &e).unwrap().len(), 1);
}

#[test]
fn damaged_shared_account_cannot_release_quota_or_refill_rate_state() {
    for damage in [
        "delete_dispatch",
        "change_charge",
        "delete_rate",
        "refill_rate",
    ] {
        let (mut s, session, c, a) = fixture();
        let i = intent(&c);
        let first = effect(&mut s, &session, &c, "one");
        let second = effect(&mut s, &session, &c, "two");
        let p = permit(
            s.admit_http_hop(&session, &first, "owner", &a, &i, 1000)
                .unwrap(),
        );
        s.observe_http_headers(&session, &first, "owner", &p, 429, None, 1000)
            .unwrap();
        let mut observed = observation(&p, true, 20);
        observed["status"] = json!(429);
        s.settle_http_hop(&session, &first, "owner", &p, &observed)
            .unwrap();
        match damage {
            "delete_dispatch" => {
                s.conn
                    .execute("DELETE FROM http_dispatches WHERE id=?1", [&p])
                    .unwrap();
            }
            "change_charge" => {
                s.conn
                    .execute(
                        "UPDATE http_dispatches SET charged_bytes=0 WHERE id=?1",
                        [&p],
                    )
                    .unwrap();
            }
            "delete_rate" => {
                s.conn
                    .execute("DELETE FROM http_rates WHERE account_id=?1", [&a])
                    .unwrap();
            }
            "refill_rate" => {
                s.conn
                    .execute(
                        "UPDATE http_rates SET tokens=1000,cooldown_ms=0 WHERE account_id=?1",
                        [&a],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            s.admit_http_hop(&session, &second, "owner", &a, &i, 1001)
                .is_err(),
            "{damage}"
        );
        assert!(
            s.admit_http_hop(&session, &first, "owner", &a, &i, 1001)
                .is_err(),
            "{damage}"
        );
        if matches!(damage, "delete_dispatch" | "change_charge") {
            assert!(
                s.read_http_dispatches(&session, &first).is_err(),
                "{damage}"
            );
        }
    }
}

#[test]
fn altered_dispatch_host_cannot_redirect_a_response_cooldown() {
    let (mut s, session, c, a) = fixture();
    let i = intent(&c);
    let effect = effect(&mut s, &session, &c, "one");
    let receipt = permit(
        s.admit_http_hop(&session, &effect, "owner", &a, &i, 1000)
            .unwrap(),
    );
    s.conn
        .execute(
            "UPDATE http_dispatches SET host='different.invalid' WHERE id=?1",
            [&receipt],
        )
        .unwrap();
    assert!(
        s.observe_http_headers(&session, &effect, "owner", &receipt, 429, None, 1000)
            .is_err()
    );
    assert!(s.read_http_dispatches(&session, &effect).is_err());
    let headers: Option<String> = s
        .conn
        .query_row(
            "SELECT headers FROM http_dispatches WHERE id=?1",
            [&receipt],
            |r| r.get(0),
        )
        .unwrap();
    assert!(headers.is_none());
}
