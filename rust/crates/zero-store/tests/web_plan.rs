#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_store::{OperationStatus, Store};
use zero_web_verification::{FrozenPlan, ORACLE_VERSION, hash};
fn fixture() -> (Store, String, Value, FrozenPlan) {
    let mut store = Store::open(":memory:").unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let session = store.create_session("g", 100).unwrap().id;
    let profile=zero_http::normalize_policy(serde_json::from_value(json!({"schema_version":1,"base_url":"http://localhost","in_scope":["localhost"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["POST"],"allowed_headers":[],"limits":{"timeout_ms":1000,"max_request_body_bytes":1048576,"max_response_wire_bytes":16777216,"max_response_decoded_bytes":16777216,"max_request_header_bytes":65536,"max_request_headers":128,"max_response_header_bytes":65536,"max_response_headers":128,"max_dns_answers":64,"max_dns_cname_depth":8,"max_dns_queries":16},"rate":{"default":{"requests_per_interval":5,"interval_ms":1000,"burst":5},"per_host":{},"jitter_ms":0},"budget":{"max_requests":100,"max_request_body_bytes":1000000,"max_response_decoded_bytes":100000000}})).unwrap()).unwrap();
    let digest = hash(&profile).unwrap();
    let context = json!({"schema_version":1,"profile_name":"fixture","profile":profile,"profile_sha256":digest,"account_id":hash(&json!({"session_id":session,"original_root_command":"root","profile_sha256":digest})).unwrap(),"original_root_command":"root"});
    let policy = json!({"require_approval":["http_request"]});
    let request = json!({"provider":"p","model":"m","instructions":"i","prompt":"p","http_profile":"fixture","web_submission_max_hypotheses":2,"max_turns":2,"reservation_per_turn":10,"tool_approval_policy":policy});
    let root=store.admit_owned_batch(&session,"owner",&[("root".into(),json!({"kind":"scoped_web_agent","request":request,"http_context":context,"http_output_version":2}))]).unwrap().remove(0);
    let hypothesis = format!("sha256:{}", "a".repeat(64));
    let review = json!({"schema_version":1,"request_sha256":digest,"completion_sha256":digest,"submission_call_id":"submit","model":"m","provider_response_id":null,"hypotheses":[{"id":hypothesis,"state":"unverified","claim":{"title":"Observation","category":"response","explanation":"Model claim only","claimed_impact":"Unknown","claimed_severity":"low","citations":[]}}],"evidence":[]});
    let artifact = store
        .retain_operation_artifact(
            &root.id,
            "owner",
            "web.review",
            &serde_json::to_vec(&review).unwrap(),
        )
        .unwrap();
    store.settle_operation(&root.id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","error":null,"web_review":{"review":review,"artifacts":{"web.review":artifact},"inference_operation":"inference"}})).unwrap();
    let plan=serde_json::from_value(json!({"schema_version":1,"oracle_version":ORACLE_VERSION,"web_operation_id":root.id,"web_review_sha256":artifact,"hypothesis_id":hypothesis,"state_mode":"same_static_identity_existing_target","repeats":2,"cases":[{"name":"attack","role":"attack","request":{"url":"/","body":"attack"},"expected":{"status":200,"body_sha256":digest}},{"name":"control","role":"legitimate_control","request":{"url":"/","body":"control"},"expected":{"status":200,"body_sha256":digest}}]})).unwrap();
    let frozen = FrozenPlan::new(
        &session,
        plan,
        context.clone(),
        Some(serde_json::from_value(policy).unwrap()),
    )
    .unwrap();
    (store, session, context, frozen)
}
fn payload(frozen: &FrozenPlan, approved: bool) -> Value {
    let mut request = json!({"plan":frozen.plan(),"expected_intent_sha256":frozen.intent_sha256()});
    if approved {
        request["approved_intent_sha256"] = json!(frozen.intent_sha256());
    }
    json!({"kind":"host_web_verification","request":request,"execution_intent":frozen.intent(),"intent_sha256":frozen.intent_sha256(),"plan_sha256":frozen.plan_sha256(),"http_context":frozen.intent()["http_context"],"http_output_version":2})
}
#[test]
fn host_plan_requires_exact_approval_and_binds_each_new_permit() {
    let (mut store, session, context, frozen) = fixture();
    let denied = store
        .admit_owned_batch(
            &session,
            "owner",
            &[("unapproved".into(), payload(&frozen, false))],
        )
        .unwrap()
        .remove(0);
    assert!(store.validate_web_verification_parent(&denied).is_err());
    let parent = store
        .admit_owned_batch(
            &session,
            "owner",
            &[("approved".into(), payload(&frozen, true))],
        )
        .unwrap()
        .remove(0);
    assert_eq!(
        store.validate_web_verification_parent(&parent).unwrap(),
        *frozen.intent()
    );
    let mut changed = parent.clone();
    changed.payload["request"]["approved_intent_sha256"] = json!("changed");
    assert!(store.validate_web_verification_parent(&changed).is_err());
    store.ensure_http_account(&session, &context).unwrap();
    let request = frozen.request(0, 0).unwrap();
    let effect = json!({"kind":"agent_http","parent_operation":parent.id,"origin":{"kind":"frozen_web_plan","plan_sha256":frozen.plan_sha256(),"case_index":0,"case_name":"attack","repeat_index":0},"http_context":context,"http_output_version":2,"request":request});
    let child = store
        .admit_owned_batch(
            &session,
            "owner",
            &[(format!("{}:web:case:0:0", parent.id), effect)],
        )
        .unwrap()
        .remove(0);
    let mut intent = json!({"index":0,"host":"localhost","profile_sha256":context["profile_sha256"],"url":request.url,"method":request.method,"addresses":["127.0.0.1:80"],"selected_address":"127.0.0.1:80","request_body_bytes":6,"response_decoded_limit":16777216});
    let account = context["account_id"].as_str().unwrap();
    intent["url"] = json!("http://localhost/changed");
    assert!(
        store
            .admit_http_hop(&session, &child.id, "owner", account, &intent, 1000)
            .is_err()
    );
    assert!(
        store
            .read_http_dispatches(&session, &child.id)
            .unwrap()
            .is_empty()
    );
    intent["url"] = json!(request.url);
    assert!(matches!(
        store.admit_http_hop(&session, &child.id, "owner", account, &intent, 1000),
        Ok(zero_store::HttpAdmission::Admitted { .. })
    ));
}
