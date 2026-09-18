#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_report::{SourceReport, SourceReportFormat, render_source_report};
fn digest(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}
fn fixture() -> SourceReport {
    serde_json::from_value(json!({
        "schema_version":1,"report_kind":"source_hypotheses","verification_state":"unverified","security_conclusion":"not_established","session_id":"session-1","operation_id":"review-1","snapshot_sha256":digest('1'),
        "review":{"version":1,"bundle_sha256":digest('2'),"snapshot_sha256":digest('1'),"request_sha256":digest('3'),"completion_sha256":digest('4'),"model":"fixture-model","provider_response_id":"provider-response","submission_call_id":"submission-call","hypotheses":[
            {"id":"hypothesis-1","state":"unverified","claim":{"title":"Possible input issue","claimed_severity":"high","explanation":"This is a source hypothesis, not a behavioral verification.","citations":[{"path":"src/file.rs","sha256":digest('5'),"start_line":2,"end_line":4}]}}
        ]},
        "artifacts":{"source.bundle":digest('2'),"source.request":digest('3'),"source.completion":digest('4'),"source.review":digest('6')}
    })).unwrap()
}
#[test]
fn json_roundtrips_one_typed_schema_without_legacy_findings_or_private_snapshot_data() {
    let report = fixture();
    let value: Value =
        serde_json::from_str(&render_source_report(&report, SourceReportFormat::Json).unwrap())
            .unwrap();
    let restored: SourceReport = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(&report).unwrap()
    );
    assert_eq!(value["report_kind"], "source_hypotheses");
    assert_eq!(value["verification_state"], "unverified");
    assert_eq!(value["security_conclusion"], "not_established");
    assert_eq!(
        value["review"],
        serde_json::to_value(&report.review).unwrap()
    );
    assert_eq!(
        value["artifacts"],
        serde_json::to_value(&report.artifacts).unwrap()
    );
    assert_eq!(value["session_id"], "session-1");
    assert_eq!(value["operation_id"], "review-1");
    for absent in [
        "findings",
        "target",
        "summary",
        "executionSuccessful",
        "snapshot",
        "root",
        "startedAt",
        "cost",
        "total_cost_usd",
    ] {
        assert!(value.get(absent).is_none(), "{absent}");
    }
}
#[test]
fn human_formats_include_complete_useful_provenance_and_exact_citation_ranges() {
    let report = fixture();
    for format in [SourceReportFormat::Markdown, SourceReportFormat::Html] {
        let out = render_source_report(&report, format).unwrap();
        assert!(out.contains("Source Hypothesis Report"));
        assert!(out.contains("unverified"));
        assert!(out.contains("not established"));
        for expected in [
            "session-1",
            "review-1",
            "fixture-model",
            "provider-response",
            "submission-call",
            "Possible input issue",
            "hypothesis-1",
            "src/file.rs:2–4",
        ] {
            assert!(out.contains(expected), "{expected}");
        }
        for c in ['1', '2', '3', '4', '5', '6'] {
            assert!(out.contains(&digest(c)));
        }
        assert!(out.contains("Claimed severity:"));
        assert!(!out.contains("Verified finding"));
        assert_eq!(out, render_source_report(&report, format).unwrap());
    }
}
#[test]
fn empty_reports_explicitly_remain_unverified_in_every_format() {
    let mut report = fixture();
    report.review.hypotheses.clear();
    report.review.provider_response_id = None;
    for format in [
        SourceReportFormat::Json,
        SourceReportFormat::Markdown,
        SourceReportFormat::Html,
    ] {
        let out = render_source_report(&report, format).unwrap();
        assert!(out.contains("unverified"));
        assert!(!out.contains("passed all tests"));
        assert!(!out.contains("No vulnerabilities"));
        if !matches!(format, SourceReportFormat::Json) {
            assert!(out.contains("No hypotheses reported"));
            assert!(out.contains("does not establish target safety"));
            assert!(out.contains("not supplied"));
        }
    }
}
#[test]
fn hostile_model_and_journal_text_cannot_inject_markup_or_links() {
    let mut report = fixture();
    let attack = "[link](javascript:alert(1))\n# heading <script>boom</script> | \"quoted\"\u{1b}";
    report.session_id = attack.into();
    report.review.model = attack.into();
    report.review.provider_response_id = Some(attack.into());
    report.review.hypotheses[0].claim.title = attack.into();
    report.review.hypotheses[0].claim.explanation = attack.into();
    report.review.hypotheses[0].claim.citations[0].path =
        "src/<img src=x onerror=boom>[link].rs".into();
    report
        .artifacts
        .insert("<script>artifact</script>".into(), digest('7'));
    let md = render_source_report(&report, SourceReportFormat::Markdown).unwrap();
    assert!(md.contains(
        "\\[link\\](javascript:alert(1))<br>\\# heading &lt;script&gt;boom&lt;/script&gt; \\|"
    ));
    assert!(md.contains("src/&lt;img src=x onerror=boom&gt;\\[link\\].rs"));
    assert!(!md.contains('\u{1b}'));
    assert!(!md.contains("<script>"));
    let html = render_source_report(&report, SourceReportFormat::Html).unwrap();
    for forbidden in ["<script", "<img", "<a ", "\u{1b}"] {
        assert!(!html.contains(forbidden));
    }
    assert!(html.contains("&quot;quoted&quot;"));
    assert!(html.contains("Content-Security-Policy"));
    assert!(html.contains("&lt;script&gt;artifact&lt;/script&gt;"));
}
#[test]
fn bad_versions_hash_links_citations_and_resource_limits_fail_for_all_formats() {
    for mutation in 0..13 {
        let mut report = fixture();
        match mutation {
            0 => report.schema_version = 2,
            1 => report.review.version = 2,
            2 => report.snapshot_sha256 = digest('0'),
            3 => report.review.bundle_sha256 = "not-a-hash".into(),
            4 => {
                report.artifacts.remove("source.review");
            }
            5 => {
                report
                    .artifacts
                    .insert("source.request".into(), digest('0'));
            }
            6 => report.review.hypotheses[0].claim.citations[0].path = "../secret".into(),
            7 => report.review.hypotheses[0].claim.citations[0].start_line = 0,
            8 => report.review.hypotheses[0].claim.citations[0].end_line = 1,
            9 => report.review.hypotheses[0].claim.citations.clear(),
            10 => report.review.hypotheses[0].claim.explanation = "x".repeat(16385),
            11 => report.review.hypotheses = vec![report.review.hypotheses[0].clone(); 33],
            _ => report
                .review
                .hypotheses
                .push(report.review.hypotheses[0].clone()),
        }
        for format in [
            SourceReportFormat::Json,
            SourceReportFormat::Markdown,
            SourceReportFormat::Html,
        ] {
            assert!(
                render_source_report(&report, format).is_err(),
                "mutation {mutation}"
            );
        }
    }
}
#[test]
fn rendering_claimed_severity_never_changes_verification_state() {
    use zero_protocol::source::ClaimedSeverity;
    for severity in [
        ClaimedSeverity::Critical,
        ClaimedSeverity::High,
        ClaimedSeverity::Medium,
        ClaimedSeverity::Low,
        ClaimedSeverity::Info,
    ] {
        let mut report = fixture();
        report.review.hypotheses[0].claim.claimed_severity = severity;
        let out = render_source_report(&report, SourceReportFormat::Json).unwrap();
        let value: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["review"]["hypotheses"][0]["state"], "unverified");
        assert_eq!(value["security_conclusion"], "not_established");
    }
}

#[test]
fn reserved_labels_reject_claims_of_verification_or_legacy_scan_semantics() {
    for (field, invalid) in [
        ("report_kind", "scan_report"),
        ("verification_state", "verified"),
        ("security_conclusion", "safe"),
    ] {
        let mut value = serde_json::to_value(fixture()).unwrap();
        value[field] = json!(invalid);
        assert!(serde_json::from_value::<SourceReport>(value).is_err());
        let mut value = serde_json::to_value(fixture()).unwrap();
        value.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<SourceReport>(value).is_err());
    }
}
