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
            SourceReportFormat::Sarif,
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

fn linked_fixture() -> SourceReport {
    let mut report = fixture();
    report.schema_version = 2;
    let assessment = json!({"schema_version":1,"oracle_version":"zero-verification-exact-output-v1","plan_digest":digest('7'),"hypothesis_id":"hypothesis-1","source_bundle_digest":digest('2'),"snapshot_digest":digest('1'),"evidence_digest":digest('8'),"disposition":"observed_for_plan","reasons":["complete_exact_observation"],"observed_attempts":4,"required_attempts":4,"vulnerability_reportable":false,"assessment_digest":digest('9')});
    report.reproductions.push(serde_json::from_value(json!({"operation_id":"reproduction-1","operation_status":"succeeded","assessment":assessment,"stop_reason":null,"children":["baseline-child-1"],"artifacts":{"reproduction.assessment":digest('9')}})).unwrap());
    let mut candidate = assessment.clone();
    candidate["snapshot_digest"] = json!(digest('a'));
    candidate["plan_digest"] = json!(digest('b'));
    report.repairs.push(serde_json::from_value(json!({"operation_id":"repair-1","reproduction_operation_id":"reproduction-1","operation_status":"succeeded","status":"validated_candidate_for_plan","original_plan_digest":digest('7'),"candidate_receipt":{"schema_version":1,"baseline_snapshot_sha256":digest('1'),"target":"src/file.rs","preimage_sha256":digest('5'),"replacement_sha256":digest('c'),"replacement_bytes":123,"candidate_snapshot_sha256":digest('a'),"policy_sha256":digest('d')},"phases":[{"name":"candidate","assessment":candidate,"children":["candidate-child-1"],"artifacts":{"candidate.assessment":digest('9')}},{"name":"reconstructed","assessment":candidate,"children":["reconstructed-child-1"],"artifacts":{"reconstructed.assessment":digest('9')}}],"cleanup_recovery_count":0,"artifacts":{"repair.validation_summary":digest('e')}})).unwrap());
    report
}
#[test]
fn linked_v2_roundtrips_and_renders_plan_scoped_evidence_without_promoting_hypotheses() {
    let report = linked_fixture();
    let json = render_source_report(&report, SourceReportFormat::Json).unwrap();
    let restored: SourceReport = serde_json::from_str(&json).unwrap();
    assert_eq!(
        serde_json::to_value(&restored).unwrap(),
        serde_json::to_value(&report).unwrap()
    );
    assert_eq!(
        restored.verification_state,
        zero_protocol::source::VerificationState::Unverified
    );
    for format in [SourceReportFormat::Markdown, SourceReportFormat::Html] {
        let out = render_source_report(&report, format).unwrap();
        for text in [
            "Frozen reproduction",
            "Plan-qualified repair",
            "Repair phase: candidate",
            "Repair phase: reconstructed",
            "reproduction-1",
            "repair-1",
            "baseline-child-1",
            "candidate-child-1",
            "reconstructed-child-1",
            "zero-verification-exact-output-v1",
            "complete",
            "Observed attempts",
            "Required attempts",
            "Cleanup recovery count",
            "Replacement bytes",
            "123",
            "src/file.rs",
        ] {
            assert!(out.contains(text), "{text}");
        }
        // Markdown escapes underscores; both surfaces retain the exact enum value
        // as plain rendered text, rather than rewriting it to 'verified'/'fixed'.
        assert!(out.contains("observed_for_plan") || out.contains("observed\\_for\\_plan"));
        assert!(
            out.contains("validated_candidate_for_plan")
                || out.contains("validated\\_candidate\\_for\\_plan")
        );
        assert!(out.contains("unverified"));
        assert!(out.contains("not established"));
        for c in ['1', '2', '7', '8', '9', 'a', 'b', 'c', 'd', 'e'] {
            assert!(out.contains(&digest(c)));
        }
        assert!(!out.contains("cleanup_recovery_path"));
    }
}
#[test]
fn v1_omits_empty_link_fields_and_versions_reject_incompatible_links() {
    let report = fixture();
    let out = render_source_report(&report, SourceReportFormat::Json).unwrap();
    assert!(!out.contains("reproductions"));
    assert!(!out.contains("repairs"));
    let mut v2 = report.clone();
    v2.schema_version = 2;
    assert!(render_source_report(&v2, SourceReportFormat::Json).is_err());
    let mut v1 = linked_fixture();
    v1.schema_version = 1;
    assert!(render_source_report(&v1, SourceReportFormat::Json).is_err());
}
#[test]
fn linked_identity_status_and_reportability_mismatches_fail_closed() {
    for mutation in 0..20 {
        let mut r = linked_fixture();
        match mutation {
            0 => r.reproductions[0].assessment.source_bundle_digest = digest('0'),
            1 => r.reproductions[0].assessment.snapshot_digest = digest('0'),
            2 => r.reproductions[0].assessment.hypothesis_id = "foreign".into(),
            3 => r.repairs[0].reproduction_operation_id = "foreign".into(),
            4 => r.repairs[0].original_plan_digest = digest('0'),
            5 => r.repairs[0].phases[0].assessment.snapshot_digest = digest('0'),
            6 => r.repairs[0].phases[0].assessment.vulnerability_reportable = true,
            7 => r.reproductions[0].assessment.vulnerability_reportable = true,
            8 => r.repairs[0].operation_id = r.operation_id.clone(),
            9 => r.repairs[0].phases[0].children = r.reproductions[0].children.clone(),
            10 => r.reproductions[0].operation_status = zero_protocol::OperationStatus::Running,
            11 => r.repairs[0].operation_status = zero_protocol::OperationStatus::Admitted,
            12 => r.repairs[0].cleanup_recovery_count = 1,
            13 => r.repairs[0].phases.pop().map(|_| ()).unwrap(),
            14 => {
                r.repairs[0]
                    .candidate_receipt
                    .as_mut()
                    .unwrap()
                    .preimage_sha256 = digest('0')
            }
            15 => r.repairs[0].phases[0].assessment.oracle_version = "different".into(),
            16 => r.repairs[0].phases.swap(0, 1),
            17 => {
                r.reproductions[0].stop_reason =
                    Some(zero_protocol::verification::ReproductionStop::SetupFailed)
            }
            18 => {
                r.reproductions[0].assessment.disposition =
                    zero_protocol::verification::Disposition::Unknown
            }
            _ => r.reproductions = vec![r.reproductions[0].clone(); 33],
        }
        for format in [
            SourceReportFormat::Json,
            SourceReportFormat::Markdown,
            SourceReportFormat::Html,
            SourceReportFormat::Sarif,
        ] {
            assert!(
                render_source_report(&r, format).is_err(),
                "mutation {mutation}"
            );
        }
    }
}
#[test]
fn cancelled_and_unknown_attempts_preserve_dispositions_and_stop_reasons() {
    use zero_protocol::{
        OperationStatus,
        repair::RepairValidationStatus,
        verification::{Disposition, ReproductionStop},
    };
    for (status, disposition, stop) in [
        (
            OperationStatus::Cancelled,
            Disposition::Inconclusive,
            ReproductionStop::Cancelled,
        ),
        (
            OperationStatus::Cancelled,
            Disposition::ObservedForPlan,
            ReproductionStop::Cancelled,
        ),
        (
            OperationStatus::Unknown,
            Disposition::Unknown,
            ReproductionStop::SupervisorFailed,
        ),
        (
            OperationStatus::Failed,
            Disposition::Inconclusive,
            ReproductionStop::SetupFailed,
        ),
    ] {
        let mut r = linked_fixture();
        r.repairs.clear();
        r.reproductions[0].operation_status = status;
        r.reproductions[0].assessment.disposition = disposition;
        r.reproductions[0].stop_reason = Some(stop);
        for format in [
            SourceReportFormat::Json,
            SourceReportFormat::Markdown,
            SourceReportFormat::Html,
            SourceReportFormat::Sarif,
        ] {
            let out = render_source_report(&r, format).unwrap();
            assert!(out.contains("unverified"));
        }
    }
    let mut r = linked_fixture();
    r.repairs[0].status = RepairValidationStatus::Unknown;
    r.repairs[0].operation_status = OperationStatus::Unknown;
    r.repairs[0].cleanup_recovery_count = 2;
    r.repairs[0].phases[1].assessment.disposition = Disposition::Unknown;
    let json = render_source_report(&r, SourceReportFormat::Json).unwrap();
    assert!(json.contains("\"cleanup_recovery_count\": 2"));
    assert!(!json.contains("/tmp"));
}
#[test]
fn hostile_link_identifiers_and_oracle_text_are_escaped_everywhere() {
    let mut r = linked_fixture();
    let attack = "<script>x</script>[click](evil)\n# header|";
    r.reproductions[0].operation_id = attack.into();
    r.repairs[0].reproduction_operation_id = attack.into();
    r.reproductions[0].assessment.oracle_version = attack.into();
    for phase in &mut r.repairs[0].phases {
        phase.assessment.oracle_version = attack.into();
    }
    r.reproductions[0].children[0] = format!("child {attack}");
    r.reproductions[0]
        .artifacts
        .insert(attack.into(), digest('f'));
    let html = render_source_report(&r, SourceReportFormat::Html).unwrap();
    assert!(!html.contains("<script>"));
    assert!(html.contains("&lt;script&gt;x&lt;/script&gt;"));
    let md = render_source_report(&r, SourceReportFormat::Markdown).unwrap();
    assert!(!md.contains("<script>"));
    assert!(md.contains("\\[click\\](evil)<br>\\# header\\|"));
}

#[test]
fn sarif_preserves_evidence_without_promoting_claims_and_encodes_paths() {
    let mut report = linked_fixture();
    report.review.hypotheses[0].claim.citations[0].path = "src/a #?%ü.rs".into();
    report.repairs[0].candidate_receipt.as_mut().unwrap().target = "src/a #?%ü.rs".into();
    let output = render_source_report(&report, SourceReportFormat::Sarif).unwrap();
    let value: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["version"], "2.1.0");
    let run = &value["runs"][0];
    assert_eq!(
        run["properties"]["sourceReport"],
        serde_json::to_value(&report).unwrap()
    );
    assert!(run.get("invocations").is_none());
    let result = &run["results"][0];
    assert_eq!(result["kind"], "review");
    assert_eq!(result["level"], "note");
    assert_eq!(result["properties"]["claimedSeverity"], "high");
    assert_eq!(result["properties"]["verificationState"], "unverified");
    let location = &result["locations"][0];
    assert_eq!(
        location["physicalLocation"]["artifactLocation"]["uri"],
        "src/a%20%23%3F%25%C3%BC.rs"
    );
    assert_eq!(
        location["physicalLocation"]["region"],
        json!({"startLine":2,"endLine":4})
    );
    assert_eq!(location["properties"]["sha256"], digest('5'));
    assert_eq!(
        output,
        render_source_report(&report, SourceReportFormat::Sarif).unwrap()
    );
    // Optional local schema-validation artifact; never changes normal test behavior.
    if let Some(path) = std::env::var_os("ZERO_SOURCE_SARIF_TEST_OUTPUT") {
        std::fs::write(path, &output).unwrap();
    }
    report = fixture();
    report.review.hypotheses.clear();
    let empty: Value =
        serde_json::from_str(&render_source_report(&report, SourceReportFormat::Sarif).unwrap())
            .unwrap();
    assert_eq!(empty["runs"][0]["results"], json!([]));
    assert_eq!(
        empty["runs"][0]["properties"]["sourceReport"]["security_conclusion"],
        "not_established"
    );
}
