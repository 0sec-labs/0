#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_report::{WebReportFormat as Format, WebWorkflowReport, render_web_report as render};
fn fixture() -> WebWorkflowReport {
    serde_json::from_str(include_str!("fixtures/web.json")).unwrap()
}
fn hash(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}
#[test]
fn canonical_schema_roundtrips_and_formats_keep_citation_and_partial_limits() {
    let mut r = fixture();
    r.observations_truncated = true;
    let restored: WebWorkflowReport =
        serde_json::from_str(&render(&r, Format::Json).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        serde_json::to_value(restored).unwrap()
    );
    for f in [Format::Markdown, Format::Html] {
        let out = render(&r, f).unwrap();
        for text in [
            "unverified",
            "not established",
            "claim-1",
            "http-1",
            "Possible cross-object response",
            "same static identity",
            "target",
        ] {
            assert!(out.contains(text), "{text}: {out}");
        }
        assert!(out.contains(&"a".repeat(64)));
        assert!(out.contains("Bounded prefix only"));
    }
}
#[test]
fn empty_and_cancelled_runs_remain_inspectable_without_a_clean_verdict() {
    let mut r = fixture();
    r.run.review = None;
    r.run.agent_status = Some(zero_protocol::agent::AgentStatus::Cancelled);
    r.run.operation_status = zero_protocol::OperationStatus::Cancelled;
    r.run.error = Some("Cancelled after one response".into());
    for f in [Format::Json, Format::Markdown, Format::Html] {
        let out = render(&r, f).unwrap();
        assert!(out.contains("Cancelled") || out.contains("cancelled"));
        assert!(out.contains("http-1"));
        assert!(!out.contains("No vulnerabilities"));
        assert!(out.contains("unverified"));
    }
    let mut r = fixture();
    r.run.review.as_mut().unwrap().hypotheses.clear();
    assert!(
        render(&r, Format::Html)
            .unwrap()
            .contains("not established")
    );
}
#[test]
fn hostile_claims_headers_urls_and_errors_are_inert() {
    let mut r = fixture();
    let hostile =
        "[click](javascript:alert(1))\n<script>attack</script><img src=x onerror=attack>\u{1b}";
    r.run.review.as_mut().unwrap().hypotheses[0].claim.title = hostile.into();
    let e = r.observations[0].evidence.as_mut().unwrap();
    e.headers.push(("x-untrusted".into(), hostile.into()));
    e.url = Some(hostile.into());
    let md = render(&r, Format::Markdown).unwrap();
    assert!(!md.contains("[click](javascript:"));
    assert!(!md.contains("<script>"));
    assert!(!md.contains('\u{1b}'));
    let html = render(&r, Format::Html).unwrap();
    assert!(!html.contains("<script>"));
    assert!(!html.contains("<img"));
    assert!(!html.contains("href="));
    assert!(html.contains("&lt;script&gt;"));
    assert!(html.contains("Content-Security-Policy"));
}
fn linked() -> WebWorkflowReport {
    let mut value = serde_json::to_value(fixture()).unwrap();
    let cases = json!([{"name":"attack","role":"attack","request":{"url":"http://127.0.0.1:1234/target/one","method":"GET"},"expected":{"status":200,"body_sha256":hash('b')}},{"name":"control","role":"legitimate_control","request":{"url":"http://127.0.0.1:1234/target/two","method":"GET"},"expected":{"status":403,"body_sha256":hash('c')}}]);
    let mut attempts = vec![];
    let mut children = vec![];
    for repeat in 0..2 {
        for (name, status, body) in [("attack", 200, 'b'), ("control", 403, 'c')] {
            let id = format!("verify-{repeat}-{name}");
            children.push(id.clone());
            attempts.push(json!({"case_name":name,"repeat_index":repeat,"operation_id":id,"operation_status":"succeeded","request_sha256":hash('d'),"response_manifest_sha256":hash('e'),"status":status,"body_sha256":hash(body),"complete":true,"possible_dispatch":true}));
        }
    }
    value["verifications"] = json!([{"operation_id":"verification-1","operation_status":"succeeded","plan":{"schema_version":1,"oracle_version":"zero-web-exact-response-v1","web_operation_id":"review","web_review_sha256":hash('5'),"hypothesis_id":"claim-1","state_mode":"same_static_identity_existing_target","repeats":2,"cases":cases},"intent_sha256":hash('6'),"approved_intent_sha256":hash('6'),"outcome":{"assessment":{"schema_version":1,"disposition":"observed_for_plan","oracle_version":"zero-web-exact-response-v1","plan_sha256":hash('7'),"expected_attempts":4,"completed_attempts":4,"observed_attempts":2,"control_attempts":2,"reasons":["All cases matched their frozen expectations"],"vulnerability_reportable":false},"attempts":attempts,"children":children,"artifacts":{},"stop":null,"error":null}}]);
    serde_json::from_value(value).unwrap()
}
#[test]
fn observed_link_is_plan_qualified_and_unknown_cancelled_are_not_promoted() {
    let r = linked();
    for f in [Format::Json, Format::Markdown, Format::Html] {
        let out = render(&r, f).unwrap();
        assert!(out.contains("observed_for_plan") || out.contains("observed\\_for\\_plan"));
        assert!(out.contains("unverified"));
        assert!(!out.contains("Verified finding"));
    }
    for status in ["unknown", "cancelled"] {
        let mut v = serde_json::to_value(&r).unwrap();
        v["verifications"][0]["operation_status"] = status.into();
        v["verifications"][0]["outcome"]["stop"] = status.into();
        v["verifications"][0]["outcome"]["assessment"]["disposition"] = status.into();
        let parsed: WebWorkflowReport = serde_json::from_value(v).unwrap();
        assert!(render(&parsed, Format::Json).is_ok());
    }
}
#[test]
fn mismatched_citations_links_and_reportability_are_rejected() {
    let r = linked();
    let base = serde_json::to_value(r).unwrap();
    let mutations: [(&str, Value); 6] = [
        (
            "/run/review/hypotheses/0/claim/citations/0/part/length",
            json!(5),
        ),
        ("/verifications/0/plan/web_operation_id", json!("foreign")),
        (
            "/verifications/0/outcome/assessment/vulnerability_reportable",
            json!(true),
        ),
        ("/observations/0/evidence/operation_id", json!("foreign")),
        ("/verifications/0/outcome/children/0", json!("wrong")),
        ("/schema_version", json!(2)),
    ];
    for (path, value) in mutations {
        let mut edited = base.clone();
        *edited.pointer_mut(path).unwrap() = value;
        let parsed: WebWorkflowReport = serde_json::from_value(edited).unwrap();
        assert!(render(&parsed, Format::Json).is_err(), "{path}");
    }
}
fn experimental() -> WebWorkflowReport {
    let mut r = fixture();
    r.experiments
        .push(serde_json::from_str(include_str!("fixtures/web_experiment.json")).unwrap());
    r
}
#[test]
fn experiments_preserve_old_json_and_distinguish_predictions_from_observations() {
    assert!(
        serde_json::to_value(fixture())
            .unwrap()
            .get("experiments")
            .is_none()
    );
    let r = experimental();
    let json = render(&r, Format::Json).unwrap();
    let restored: WebWorkflowReport = serde_json::from_str(&json).unwrap();
    assert_eq!(
        serde_json::to_value(r).unwrap(),
        serde_json::to_value(restored).unwrap()
    );
    for format in [Format::Markdown, Format::Html] {
        let out = render(&experimental(), format).unwrap();
        for label in [
            "Model conjecture",
            "Model predictions",
            "Independent measured feedback",
            "previous-experiment",
            "existing target state",
            "Unverified",
        ] {
            assert!(out.contains(label), "{label}");
        }
        assert!(!out.contains("<script>"));
        if matches!(format, Format::Markdown) {
            assert!(!out.contains("[link](javascript:"));
        } else {
            assert!(!out.contains("href="));
        }
        assert!(out.contains(&hash('3')) || out.contains(&"3".repeat(64)));
    }
}
#[test]
fn active_and_cancelled_experiments_do_not_invent_success_or_require_terminal_claims() {
    let mut r = experimental();
    r.run.review = None;
    r.experiments[0].operation_status = zero_protocol::OperationStatus::Running;
    r.experiments[0].outcome = None;
    assert!(
        render(&r, Format::Html)
            .unwrap()
            .contains("no terminal assessment")
    );
    let mut r = experimental();
    r.run.review = None;
    let e = &mut r.experiments[0];
    e.operation_status = zero_protocol::OperationStatus::Cancelled;
    let o = e.outcome.as_mut().unwrap();
    o.stop = Some(zero_protocol::web::WebVerificationStop::Cancelled);
    o.attempts.clear();
    o.children.clear();
    o.assessment.disposition = zero_protocol::verification::Disposition::Cancelled;
    o.assessment.completed_attempts = 0;
    o.assessment.observed_attempts = 0;
    o.assessment.control_attempts = 0;
    assert!(render(&r, Format::Json).unwrap().contains("cancelled"));
}
#[test]
fn experiment_scope_prediction_identity_attempt_order_and_reportability_are_checked() {
    let base = serde_json::to_value(experimental()).unwrap();
    for (path, value) in [
        ("/experiments/0/web_operation_id", json!("foreign")),
        ("/experiments/0/session_id", json!("foreign")),
        ("/experiments/0/operation_status", json!("unknown")),
        (
            "/experiments/0/outcome/assessment/observed_attempts",
            json!(1),
        ),
        (
            "/experiments/0/hypothesis/title",
            json!("different conjecture"),
        ),
        (
            "/experiments/0/outcome/assessment/plan_sha256",
            json!(hash('9')),
        ),
        (
            "/experiments/0/outcome/assessment/vulnerability_reportable",
            json!(true),
        ),
        ("/experiments/0/outcome/attempts/0/repeat_index", json!(1)),
        ("/experiments/0/outcome/children/0", json!("wrong")),
        ("/experiments/0/policy/max_cases", json!(1)),
    ] {
        let mut v = base.clone();
        *v.pointer_mut(path).unwrap() = value;
        let r: WebWorkflowReport = serde_json::from_value(v).unwrap();
        assert!(render(&r, Format::Json).is_err(), "{path}");
    }
    let mut r = experimental();
    r.experiments.push(r.experiments[0].clone());
    assert!(render(&r, Format::Json).is_err());
}
