use serde_json::{Value, json};
use zero_protocol::{SnapshotPin, review::ReviewProfile};
fn raw() -> Value {
    json!({"schema_version":1,"provider":"p","model":"m","instructions":"Investigate authorized source", "question":"Investigate input handling",
        "execution":{"backend":{"type":"docker","image":"fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"timeout_ms":1000,"memory_mb":128,"cpus":1.0,"max_output_bytes":4096},
        "budget_limit":100,"currency":"units","reservation_per_turn":10,"max_turns":4,"max_hypotheses":4,"deadline_ms":60000})
}
fn pin() -> SnapshotPin {
    serde_json::from_value(json!({"id":"host-pin","root":"/source","digest":format!("sha256:{}","a".repeat(64)),"files":[{"path":"main.rs","digest":format!("sha256:{}","b".repeat(64)),"bytes":10}]})).unwrap()
}
fn profile(value: Value) -> ReviewProfile {
    serde_json::from_value(value).unwrap()
}
#[test]
fn compiler_preserves_host_snapshot_and_explicit_source_authority() {
    let p = profile(raw());
    let request = p.request(pin(), "review-root").unwrap();
    request.validate_capabilities().unwrap();
    let execution = request.snapshot_request().unwrap();
    assert_eq!(
        serde_json::to_value(&execution.snapshot).unwrap(),
        serde_json::to_value(pin()).unwrap()
    );
    assert_eq!(execution.execution_id, "review-root");
    assert!(execution.build_argv.is_none() && execution.stdin.is_none());
    assert!(request.source_snapshot_tools);
    assert_eq!(request.source_submission_max_hypotheses, Some(4));
    assert!(request.http_profile.is_none() && request.web_experiment_policy.is_none());
    assert!(request.web_submission_max_hypotheses.is_none() && request.plugin_tools.is_empty());
    assert!(request.source_review_operation_id.is_none() && request.continuation_of.is_none());
    assert!(!request.operator_questions && request.tool_approval_policy.is_none());
    assert!(
        request
            .prompt
            .contains("empty submission does not establish source safety")
    );
    assert!(request.prompt.contains(&p.question));
}
#[test]
fn budgets_and_deadlines_cannot_be_disabled_or_extended() {
    for (key, value) in [
        ("schema_version", 0),
        ("budget_limit", 0),
        ("reservation_per_turn", 0),
        ("reservation_per_turn", 101),
        ("max_turns", 0),
        ("max_turns", 33),
        ("max_hypotheses", 0),
        ("max_hypotheses", 33),
        ("deadline_ms", 0),
        ("deadline_ms", 86_400_001),
    ] {
        let mut v = raw();
        v[key] = json!(value);
        assert!(profile(v).validate().is_err(), "{key}={value}");
    }
    for key in ["provider", "model", "instructions", "question"] {
        for value in [" ".to_string(), "bad\0text".into(), "x".repeat(32769)] {
            let mut v = raw();
            v[key] = json!(value);
            assert!(profile(v).validate().is_err(), "{key}");
        }
    }
}
#[test]
fn profile_cannot_embed_credentials_mounts_or_additional_tools() {
    for key in [
        "snapshot",
        "root",
        "api_key",
        "http_profile",
        "plugin_tools",
        "execution_id",
    ] {
        let mut v = raw();
        v[key] = json!("untrusted");
        assert!(serde_json::from_value::<ReviewProfile>(v).is_err(), "{key}");
    }
    for key in [
        "snapshot",
        "argv",
        "stdin",
        "build_argv",
        "mounts",
        "network",
    ] {
        let mut v = raw();
        v["execution"][key] = json!("untrusted");
        assert!(serde_json::from_value::<ReviewProfile>(v).is_err(), "{key}");
    }
}
#[test]
fn roles_share_funding_and_cannot_expand_capabilities() {
    let mut v = raw();
    v["delegation_policy"] = json!({"max_parallel":1,"max_children":2,"roles":[{"name":"reader","provider":"p","model":"m","instructions":"Investigate","description":"A source reader","tools":["list_source_files","read_source_lines","search_source_text","execute_snapshot"],"max_turns":2,"reservation_per_turn":10}]});
    let request = profile(v.clone()).request(pin(), "review").unwrap();
    assert_eq!(
        serde_json::to_value(request.delegation_policy.unwrap()).unwrap(),
        v["delegation_policy"]
    );
    for tool in [
        "http_request",
        "run_web_experiment",
        "submit_source_hypotheses",
        "submit_web_hypotheses",
        "delegate_tasks",
        "activate",
        "arbitrary_plugin",
    ] {
        let mut bad = v.clone();
        bad["delegation_policy"]["roles"][0]["tools"] = json!([tool]);
        assert!(profile(bad).validate().is_err(), "{tool}");
    }
    v["delegation_policy"]["roles"][0]["reservation_per_turn"] = json!(101);
    assert!(profile(v).validate().is_err());
}
#[test]
fn backend_selection_retains_smolvm_identity_and_limits() {
    let mut v = raw();
    v["execution"]["backend"] = json!({"type":"smolvm","image_archive":"/images/offline.tar","archive_digest":format!("sha256:{}","c".repeat(64)),"storage_gb":4});
    let request = profile(v.clone()).request(pin(), "review").unwrap();
    assert_eq!(
        serde_json::to_value(request.snapshot_request().unwrap().backend).unwrap(),
        v["execution"]["backend"]
    );
    for (key, value) in [
        ("cpus", json!(0.5)),
        ("memory_mb", json!(0)),
        ("timeout_ms", json!(600001)),
        ("max_output_bytes", json!(255)),
    ] {
        let mut bad = v.clone();
        bad["execution"][key] = value;
        assert!(profile(bad).validate().is_err(), "{key}");
    }
    v["execution"]["backend"]["image_archive"] = json!("relative.tar");
    assert!(profile(v).validate().is_err());
}
#[test]
fn manifest_bounds_match_investigation_and_reject_ambiguous_paths() {
    let p = profile(raw());
    let mut snapshot = pin();
    snapshot.files[0].bytes = 64 * 1024 * 1024;
    p.request(snapshot.clone(), "review").unwrap();
    snapshot.files[0].bytes += 1;
    assert!(p.request(snapshot, "review").is_err());
    let mut snapshot = pin();
    snapshot.files = (0..4096)
        .map(|i| {
            let mut f = pin().files.remove(0);
            f.path = format!("file{i}");
            f
        })
        .collect();
    p.request(snapshot.clone(), "review").unwrap();
    let mut extra = pin().files.remove(0);
    extra.path = "extra".into();
    snapshot.files.push(extra);
    assert!(p.request(snapshot, "review").is_err());
    for path in ["../escape", "/absolute", "a:b", "a\nline", "a\\b"] {
        let mut snapshot = pin();
        snapshot.files[0].path = path.into();
        assert!(p.request(snapshot, "review").is_err(), "{path}");
    }
    let mut snapshot = pin();
    snapshot.files.clear();
    assert!(p.request(snapshot, "review").is_err());
    assert!(p.request(pin(), "invalid id").is_err());
}

#[test]
fn docker_authority_requires_an_immutable_image_and_never_a_tag() {
    for image in ["latest", "fixture:latest", "fixture@sha256:bad"] {
        let mut value = raw();
        value["execution"]["backend"]["image"] = json!(image);
        assert!(profile(value).validate().is_err());
    }
    let mut value = raw();
    value["execution"]["backend"]["image"] = json!(format!("sha256:{}", "d".repeat(64)));
    profile(value).validate().unwrap();
}

#[test]
fn rendered_source_question_checks_utf8_bytes_including_compiler_prefix() {
    let mut p = profile(raw());
    let prefix_bytes = p.request(pin(), "review").unwrap().prompt.len() - p.question.len();
    let available = zero_protocol::source::MAX_SOURCE_QUESTION_BYTES - prefix_bytes;
    p.question = "a".repeat(available);
    assert_eq!(p.request(pin(), "review").unwrap().prompt.len(), 16384);
    p.question.push('a');
    assert!(p.validate().is_err());
    p.question = "é".repeat(available / 2);
    p.request(pin(), "review").unwrap();
    p.question.push('é');
    assert!(p.validate().is_err());
}
