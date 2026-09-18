#![allow(clippy::unwrap_used)]
mod common;
use common::*;
use std::collections::BTreeMap;
use zero_http::*;
#[test]
fn scope_wildcards_paths_and_host_overrides_fail_closed() {
    let mut p = policy("http://localhost".into());
    p.in_scope = vec!["*.example.test".into()];
    p.out_of_scope = vec!["denied.example.test".into()];
    p.allowed_path_prefixes = vec!["/api".into()];
    for url in [
        "http://example.test/api",
        "http://notexample.test/api",
        "http://denied.example.test/api",
        "http://ok.example.test/apixyz",
        "http://ok.example.test/api/%2fsecret",
        "http://ok.example.test/api/%252fsecret",
    ] {
        assert!(normalize_intent(&p, args(url)).is_err(), "{url}");
    }
    assert!(normalize_intent(&p, args("http://ok.example.test/api/item")).is_ok());
    let mut a = args("http://ok.example.test/api");
    a.headers.insert("Host".into(), "elsewhere".into());
    assert!(normalize_intent(&p, a).is_err());
}
#[test]
fn canonical_policy_hash_and_rate_override_collisions() {
    let mut p = policy("http://LOCALHOST.:80".into());
    p.rate
        .per_host
        .insert("EXAMPLE.TEST.".into(), p.rate.default.clone());
    let normalized = normalize_policy(p.clone()).unwrap();
    assert_eq!(normalized.base_url, "http://localhost/");
    assert!(normalized.rate.per_host.contains_key("example.test"));
    let value = serde_json::to_value(&normalized).unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        profile_sha256(&normalized).unwrap(),
        format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&value).unwrap())
        )
    );
    p.rate
        .per_host
        .insert("example.test".into(), p.rate.default.clone());
    assert_eq!(normalize_policy(p).unwrap_err(), ErrorCode::Invalid);
}
#[test]
fn auth_descriptor_and_known_public_values_are_bound() {
    let mut p = policy("http://localhost".into());
    let auth = StaticAuth::new(
        "revision".into(),
        p.base_url.clone(),
        BTreeMap::from([("authorization".into(), "Bearer secret-auth-canary".into())]),
    )
    .unwrap();
    p.auth = Some(auth.descriptor().clone());
    let c = client(p, Some(auth));
    let mut a = args("/");
    a.headers.insert("authorization".into(), "different".into());
    assert_eq!(c.prepare(a).err(), Some(ErrorCode::Scope));
    let mut a = args("/");
    a.body = Some("secret-auth-canary".into());
    assert_eq!(c.prepare(a).err(), Some(ErrorCode::Secret));
    assert!(
        StaticAuth::new(
            "revision".into(),
            "http://localhost".into(),
            BTreeMap::from([("Host".into(), "evil".into())])
        )
        .is_err()
    );
}
#[test]
fn escaped_secret_is_rejected_before_json_persistence() {
    let mut p = policy("http://localhost".into());
    let auth = StaticAuth::new(
        "revision".into(),
        p.base_url.clone(),
        BTreeMap::from([("x-api-key".into(), "a-quoted-\"-secret".into())]),
    )
    .unwrap();
    p.auth = Some(auth.descriptor().clone());
    let c = client(p, Some(auth));
    let mut a = args("/");
    a.body = Some("a-quoted-\"-secret".into());
    assert_eq!(c.prepare(a).err(), Some(ErrorCode::Secret));
}
#[test]
fn encoded_path_denials_unicode_and_dot_segments_share_canonical_identity() {
    let mut p = policy("http://localhost".into());
    p.denied_path_prefixes = vec!["/admin".into(), "/café".into()];
    for path in [
        "/admin",
        "/%61dmin",
        "/%61%64%6Din/child",
        "/api/../admin",
        "/api/%2e%2e/admin",
        "/caf%C3%A9",
        "/caf%c3%a9/child",
        "/café",
    ] {
        assert_eq!(
            normalize_intent(&p, args(path)).unwrap_err(),
            ErrorCode::Scope,
            "{path}"
        );
    }
    p.denied_path_prefixes.clear();
    p.allowed_path_prefixes = vec!["/café".into()];
    for path in ["/caf%C3%A9", "/caf%c3%a9/child", "/café"] {
        assert!(normalize_intent(&p, args(path)).is_ok(), "{path}");
    }
    assert!(normalize_intent(&p, args("/caf%C3%A9other")).is_err());
    p.allowed_path_prefixes = vec!["/%61pi/../caf%C3%A9".into()];
    assert!(normalize_intent(&p, args("/café/child")).is_ok());
    for path in [
        "/caf%C3%A9/%2fadmin",
        "/caf%C3%A9/%00",
        "/caf%C3%A9/%FF",
        "/caf%C3%A9/%252e",
    ] {
        assert!(normalize_intent(&p, args(path)).is_err(), "{path}");
    }
}
