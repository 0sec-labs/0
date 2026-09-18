#![allow(clippy::unwrap_used)]
use serde_json::json;
use zero_protocol::{OperationStatus, verification::Disposition, web::*};
use zero_web_verification::*;
fn fixture() -> FrozenPlan {
    let profile=zero_http::normalize_policy(serde_json::from_value(json!({"schema_version":1,"base_url":"http://localhost","in_scope":["localhost"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["POST"],"allowed_headers":[],"limits":{"timeout_ms":1000,"max_request_body_bytes":1048576,"max_response_wire_bytes":16777216,"max_response_decoded_bytes":16777216,"max_request_header_bytes":65536,"max_request_headers":128,"max_response_header_bytes":65536,"max_response_headers":128,"max_dns_answers":64,"max_dns_cname_depth":8,"max_dns_queries":16},"rate":{"default":{"requests_per_interval":5,"interval_ms":1000,"burst":5},"per_host":{},"jitter_ms":0},"budget":{"max_requests":100,"max_request_body_bytes":1000000,"max_response_decoded_bytes":1000000}})).unwrap()).unwrap();
    let digest = hash(&profile).unwrap();
    let context = json!({"schema_version":1,"profile_name":"fixture","profile":profile,"profile_sha256":digest,"account_id":hash(&json!({"session_id":"session","original_root_command":"root","profile_sha256":digest})).unwrap(),"original_root_command":"root"});
    let plan=serde_json::from_value(json!({"schema_version":1,"oracle_version":ORACLE_VERSION,"web_operation_id":"review","web_review_sha256":format!("sha256:{}","a".repeat(64)),"hypothesis_id":"hypothesis","state_mode":"same_static_identity_existing_target","repeats":2,"cases":[{"name":"attack","role":"attack","request":{"url":"/","body":"attack"},"expected":{"status":200,"body_sha256":format!("sha256:{}","b".repeat(64))}},{"name":"control","role":"legitimate_control","request":{"url":"/","body":"control"},"expected":{"status":200,"body_sha256":format!("sha256:{}","c".repeat(64))}}]})).unwrap();
    FrozenPlan::new("session", plan, context, None).unwrap()
}
fn observations(p: &FrozenPlan) -> Vec<WebVerificationAttempt> {
    let mut result = vec![];
    for repeat in 0..p.plan().repeats {
        for (index, c) in p.plan().cases.iter().enumerate() {
            result.push(WebVerificationAttempt {
                case_name: c.name.clone(),
                repeat_index: repeat,
                operation_id: format!("http-{repeat}-{index}"),
                operation_status: OperationStatus::Succeeded,
                request_sha256: p.request_sha256(index, repeat).unwrap(),
                response_manifest_sha256: Some(format!("sha256:{}", "d".repeat(64))),
                status: Some(c.expected.status),
                body_sha256: Some(c.expected.body_sha256.clone()),
                complete: true,
                possible_dispatch: true,
            });
        }
    }
    result
}
#[test]
fn complete_matrix_is_exact_observation_never_reportable() {
    let p = fixture();
    let a = assess(&p, &observations(&p), None).unwrap();
    assert_eq!(a.disposition, Disposition::ObservedForPlan);
    assert!(!a.vulnerability_reportable);
    assert_eq!(a.completed_attempts, 4);
    assert_eq!(
        FrozenPlan::from_intent(p.intent()).unwrap().intent_sha256(),
        p.intent_sha256()
    );
}
#[test]
fn controls_stability_and_request_identity_cannot_be_forged() {
    let p = fixture();
    for mode in 0..6 {
        let mut a = observations(&p);
        match mode {
            0 => a[1].body_sha256 = Some(format!("sha256:{}", "e".repeat(64))),
            1 => a[0].request_sha256 = format!("sha256:{}", "e".repeat(64)),
            2 => a[2].operation_id = a[0].operation_id.clone(),
            3 => {
                a.pop();
            }
            4 => a.swap(0, 1),
            _ => a[2].body_sha256 = Some(format!("sha256:{}", "e".repeat(64))),
        }
        assert_eq!(
            assess(&p, &a, None).unwrap().disposition,
            Disposition::Inconclusive,
            "mode{mode}"
        );
    }
}
#[test]
fn stable_negative_is_not_observed_not_false_positive() {
    let p = fixture();
    let mut a = observations(&p);
    for i in [0, 2] {
        a[i].status = Some(403);
    }
    assert_eq!(
        assess(&p, &a, None).unwrap().disposition,
        Disposition::NotObserved
    );
}
#[test]
fn cancelled_before_first_and_unknown_effect_override_missing_matrix() {
    let p = fixture();
    assert_eq!(
        assess(&p, &[], Some(WebVerificationStop::Cancelled))
            .unwrap()
            .disposition,
        Disposition::Cancelled
    );
    let mut a = observations(&p);
    a[0].operation_status = OperationStatus::Unknown;
    a[0].complete = false;
    assert_eq!(
        assess(&p, &a, Some(WebVerificationStop::Cancelled))
            .unwrap()
            .disposition,
        Disposition::Unknown
    );
}
#[test]
fn changed_account_missing_control_and_identical_requests_fail_freeze() {
    let p = fixture();
    let mut v = p.intent().clone();
    v["http_context"]["account_id"] = json!("wrong");
    assert!(FrozenPlan::from_intent(&v).is_err());
    let mut v = p.intent().clone();
    v["plan"]["cases"][1]["request"] = v["plan"]["cases"][0]["request"].clone();
    assert!(FrozenPlan::from_intent(&v).is_err());
    let mut v = p.intent().clone();
    v["plan"]["cases"][1]["role"] = json!("attack");
    assert!(FrozenPlan::from_intent(&v).is_err());
}
#[test]
fn authority_and_oracle_identity_change_full_intent() {
    let p = fixture();
    let mut v = p.intent().clone();
    v["inherited_tool_approval_policy"] = json!({"require_approval":["http_request"]});
    let q = FrozenPlan::from_intent(&v).unwrap();
    assert!(q.approval_required());
    assert_ne!(q.intent_sha256(), p.intent_sha256());
    assert_eq!(q.plan_sha256(), p.plan_sha256());
    let mut v = p.intent().clone();
    v["plan"]["oracle_version"] = json!("model-says-pass");
    assert!(FrozenPlan::from_intent(&v).is_err());
}
