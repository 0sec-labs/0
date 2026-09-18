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
fn experiment() -> FrozenExperiment {
    let host = fixture();
    FrozenExperiment::new(
        "session",
        "actor",
        "inference",
        "call",
        zero_protocol::web_experiment::WebExperimentPolicy {
            schema_version: 1,
            max_experiments: 2,
            max_cases: 4,
            max_repeats: 3,
        },
        zero_protocol::web_experiment::WebExperimentProposal {
            hypothesis: zero_protocol::web_experiment::WebExperimentHypothesis {
                title: "Model prediction".into(),
                explanation: "Chosen by model, not security proof".into(),
                prior_revision: None,
            },
            purpose: "Distinguish attack and control responses".into(),
            cases: host.plan().cases.clone(),
            repeats: 2,
        },
        host.intent()["http_context"].clone(),
        None,
    )
    .unwrap()
}
#[test]
fn experiment_has_real_actor_origin_and_shared_measurement_without_fake_review() {
    let p = experiment();
    assert!(p.intent().get("plan").is_none());
    assert!(p.intent().get("web_operation_id").is_none());
    assert_eq!(p.intent()["actor_operation_id"], "actor");
    let q = FrozenExperiment::from_intent(p.intent()).unwrap();
    assert_eq!(q.intent_sha256(), p.intent_sha256());
    assert_eq!(
        q.request(0, 0).unwrap().headers["content-type"],
        "application/json"
    );
    assert!(q.proposal().cases[0].request.headers.is_empty());
    let host = fixture();
    let attempts = observations(&host);
    let result = assess(&p, &attempts, None).unwrap();
    assert_eq!(result.disposition, Disposition::ObservedForPlan);
    assert!(!result.vulnerability_reportable);
    assert_eq!(result.plan_sha256, p.matrix_sha256());
    let child = p.child_payload("experiment", 0, 0).unwrap();
    assert_eq!(child["origin"]["kind"], "frozen_agent_experiment");
    assert_eq!(child["origin"]["intent_sha256"], p.intent_sha256());
    assert!(child.get("call_id").is_none());
}
#[test]
fn experiment_policy_origin_prediction_revision_and_gate_all_bind_identity() {
    let p = experiment();
    for (key, value) in [
        ("actor_operation_id", json!("different")),
        ("hypothesis", json!({"title":"forged"})),
        ("matrix_sha256", json!(format!("sha256:{}", "0".repeat(64)))),
        ("oracle_version", json!("model-pass")),
    ] {
        let mut bad = p.intent().clone();
        bad[key] = value;
        assert!(FrozenExperiment::from_intent(&bad).is_err(), "{key}");
    }
    let mut proposal = p.proposal().clone();
    proposal.hypothesis.prior_revision = Some(zero_protocol::web_experiment::WebPriorRevision {
        operation_id: "previous".into(),
        hypothesis_sha256: format!("sha256:{}", "a".repeat(64)),
    });
    let revised = FrozenExperiment::new(
        "session",
        "actor",
        "inference",
        "call",
        p.policy().clone(),
        proposal,
        p.intent()["http_context"].clone(),
        Some(zero_protocol::approvals::ToolApprovalPolicy {
            require_approval: vec!["http_request".into()],
        }),
    )
    .unwrap();
    assert!(revised.approval_required());
    assert_ne!(p.hypothesis_sha256(), revised.hypothesis_sha256());
    assert_ne!(p.intent_sha256(), revised.intent_sha256());
    assert_eq!(p.matrix_sha256(), revised.matrix_sha256());
    let mut policy = p.policy().clone();
    policy.max_repeats = 2;
    let mut proposal = p.proposal().clone();
    proposal.repeats = 3;
    assert!(
        FrozenExperiment::new(
            "session",
            "actor",
            "inference",
            "call",
            policy,
            proposal,
            p.intent()["http_context"].clone(),
            None
        )
        .is_err()
    );
}
#[test]
fn experiment_rejects_caller_success_fields_scope_escape_and_oversized_parent() {
    let p = experiment();
    let mut forged = serde_json::to_value(p.proposal()).unwrap();
    forged["vulnerability_reportable"] = json!(true);
    assert!(
        serde_json::from_value::<zero_protocol::web_experiment::WebExperimentProposal>(forged)
            .is_err()
    );
    let mut proposal = p.proposal().clone();
    proposal.cases[0].request.url = "https://ungranted.invalid".into();
    assert!(
        FrozenExperiment::new(
            "session",
            "actor",
            "inference",
            "call",
            p.policy().clone(),
            proposal,
            p.intent()["http_context"].clone(),
            None
        )
        .is_err()
    );
    let mut proposal = p.proposal().clone();
    for c in &mut proposal.cases {
        c.request.body = Some("\u{0001}".repeat(600_000));
    }
    assert!(
        FrozenExperiment::new(
            "session",
            "actor",
            "inference",
            "call",
            p.policy().clone(),
            proposal,
            p.intent()["http_context"].clone(),
            None
        )
        .is_err()
    );
}
#[test]
fn experiment_roundtrip_retains_host_attribution_without_claiming_caller_headers() {
    let p = experiment();
    let mut context = p.intent()["http_context"].clone();
    let mut profile: zero_protocol::http::HttpProfilePolicy =
        serde_json::from_value(context["profile"].clone()).unwrap();
    profile.attribution = Some(zero_protocol::http::HttpAttribution {
        headers: std::collections::BTreeMap::from([(
            "x-fixture-attribution".into(),
            "host-owned".into(),
        )]),
        user_agent_token: Some("fixture-agent".into()),
    });
    let profile = zero_http::normalize_policy(profile).unwrap();
    let digest = hash(&profile).unwrap();
    context["profile"] = serde_json::to_value(profile).unwrap();
    context["profile_sha256"] = json!(digest);
    context["account_id"] = json!(
        hash(
            &json!({"session_id":"session","original_root_command":"root","profile_sha256":digest})
        )
        .unwrap()
    );
    let p = FrozenExperiment::new(
        "session",
        "actor",
        "inference",
        "call",
        p.policy().clone(),
        p.proposal().clone(),
        context,
        None,
    )
    .unwrap();
    let r = FrozenExperiment::from_intent(p.intent()).unwrap();
    assert_eq!(r.intent_sha256(), p.intent_sha256());
    assert_eq!(
        r.intent()["http_context"]["profile"]["attribution"]["headers"]["x-fixture-attribution"],
        "host-owned"
    );
    assert!(r.proposal().cases[0].request.headers.is_empty());
}
