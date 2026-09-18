#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_protocol::http::*;
fn policy() -> Value {
    json!({"schema_version":1,"base_url":"https://target.example/api/","in_scope":["target.example"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":["/api"],"denied_path_prefixes":[],"allowed_methods":["GET","POST"],"allowed_headers":["content-type"],"limits":{"timeout_ms":30000,"max_request_body_bytes":1048576,"max_response_wire_bytes":16777216,"max_response_decoded_bytes":16777216,"max_request_header_bytes":65536,"max_request_headers":128,"max_response_header_bytes":65536,"max_response_headers":128,"max_dns_answers":64,"max_dns_cname_depth":8,"max_dns_queries":16},"rate":{"default":{"requests_per_interval":5,"interval_ms":1000,"burst":1},"per_host":{},"jitter_ms":0},"budget":{"max_requests":10,"max_request_body_bytes":10485760,"max_response_decoded_bytes":167772160}})
}
#[test]
fn explicit_policy_limits_and_roundtrip_are_integer_and_strict() {
    let policy: HttpProfilePolicy = serde_json::from_value(policy()).unwrap();
    policy.validate().unwrap();
    assert_eq!(policy.redirect, HttpRedirectPolicy::Manual);
    assert_eq!(
        serde_json::from_slice::<HttpProfilePolicy>(&serde_json::to_vec(&policy).unwrap()).unwrap(),
        policy
    );
    for (field, value) in [
        ("timeout_ms", 0),
        ("timeout_ms", 120001),
        ("max_request_body_bytes", 1048577),
        ("max_response_wire_bytes", 16777217),
        ("max_response_decoded_bytes", 16777217),
        ("max_request_header_bytes", 65537),
        ("max_request_headers", 129),
        ("max_response_header_bytes", 65537),
        ("max_response_headers", 129),
        ("max_dns_answers", 65),
        ("max_dns_cname_depth", 9),
        ("max_dns_queries", 17),
    ] {
        let mut v = serde_json::to_value(&policy).unwrap();
        v["limits"][field] = value.into();
        assert!(
            serde_json::from_value::<HttpProfilePolicy>(v)
                .unwrap()
                .validate()
                .is_err(),
            "{field}"
        );
    }
    for extra in ["allow_public_network", "cookies", "proxy", "insecure_tls"] {
        let mut v = serde_json::to_value(&policy).unwrap();
        v[extra] = true.into();
        assert!(serde_json::from_value::<HttpProfilePolicy>(v).is_err());
    }
}
#[test]
fn post_default_and_header_duplicate_rejection_do_not_accept_model_scope_knobs() {
    let request: HttpRequestArguments = serde_json::from_str(r#"{"url":"/api"}"#).unwrap();
    assert_eq!(request.method, "POST");
    assert!(request.headers.is_empty());
    request.validate().unwrap();
    for raw in [
        r#"{"url":"/","headers":{"X-Test":"one","x-test":"two"}}"#,
        r#"{"url":"/","headers":{"x-test":"one","x-test":"two"}}"#,
        r#"{"url":"/","headers":{"x-test":"a\r\nb"}}"#,
        r#"{"url":"/","profile":"other"}"#,
        r#"{"url":"/","redirect":"follow"}"#,
        r#"{"url":"/","auth":"other"}"#,
    ] {
        assert!(serde_json::from_str::<HttpRequestArguments>(raw).is_err());
    }
    let mut request = request;
    request.headers.insert("X-Test".into(), "one".into());
    request.headers.insert("x-test".into(), "two".into());
    assert!(
        request.validate().is_err(),
        "constructed maps must also reject collisions"
    );
}
#[test]
fn rate_redirect_and_rule_boundaries_require_explicit_supported_authority() {
    let mut v = policy();
    v["redirect"] = json!({"mode":"follow","max_hops":5});
    let p: HttpProfilePolicy = serde_json::from_value(v.clone()).unwrap();
    p.validate().unwrap();
    v["redirect"]["max_hops"] = 6.into();
    assert!(
        serde_json::from_value::<HttpProfilePolicy>(v)
            .unwrap()
            .validate()
            .is_err()
    );
    for (field, value) in [
        ("requests_per_interval", 0),
        ("requests_per_interval", 10001),
        ("interval_ms", 0),
        ("interval_ms", 3600001),
        ("burst", 0),
        ("burst", 1001),
    ] {
        let mut v = policy();
        v["rate"]["default"][field] = value.into();
        assert!(
            serde_json::from_value::<HttpProfilePolicy>(v)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    let mut v = policy();
    v["rate"]["jitter_ms"] = 1001.into();
    assert!(
        serde_json::from_value::<HttpProfilePolicy>(v)
            .unwrap()
            .validate()
            .is_err()
    );
    let mut v = policy();
    v["allowed_headers"] = json!(["X-Test", "x-test"]);
    assert!(
        serde_json::from_value::<HttpProfilePolicy>(v)
            .unwrap()
            .validate()
            .is_err()
    );
    let mut v = policy();
    v["allowed_methods"] = json!(["CONNECT"]);
    assert!(
        serde_json::from_value::<HttpProfilePolicy>(v)
            .unwrap()
            .validate()
            .is_err()
    );
}

#[test]
fn repeated_rate_override_keys_cannot_silently_overwrite_host_authority() {
    for names in [
        ("target.example", "target.example"),
        ("Target.example", "target.example"),
    ] {
        let rate = r#"{"requests_per_interval":1,"interval_ms":1000,"burst":1}"#;
        let raw = format!(
            r#"{{"default":{rate},"per_host":{{"{}":{rate},"{}":{rate}}},"jitter_ms":0}}"#,
            names.0, names.1
        );
        assert!(serde_json::from_str::<HttpRatePolicy>(&raw).is_err());
    }
}

#[test]
fn omitted_http_profile_preserves_legacy_serialized_agent_identity() {
    let original = json!({"provider":"fixture","model":"fixture","instructions":"fixed","prompt":"task","max_turns":2,"reservation_per_turn":10,"execution":{"execution_id":"fixture","image":"local:test","snapshot":{"root":"/fixture","id":"sha256:a","digest":"sha256:a","files":[]},"argv":["true"],"build_argv":null,"stdin":null,"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}});
    let mut request: zero_protocol::agent::AgentRequest =
        serde_json::from_value(original.clone()).unwrap();
    assert!(request.http_profile.is_none());
    assert_eq!(serde_json::to_value(&request).unwrap(), original);
    request.http_profile = Some("target".into());
    let mut changed = serde_json::to_value(&request).unwrap();
    assert_eq!(
        changed.as_object_mut().unwrap().remove("http_profile"),
        Some(json!("target"))
    );
    assert_eq!(changed, original);
}
