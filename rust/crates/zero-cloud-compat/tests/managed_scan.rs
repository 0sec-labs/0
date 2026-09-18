#![allow(clippy::unwrap_used)]
use serde_json::json;
use sha2::{Digest, Sha256};
#[path = "support/managed_scan.rs"]
mod fixtures;
use fixtures::{fixture, hash, id};
use zero_cloud_compat::managed_scan::*;
use zero_protocol::{OperationStatus, agent::AgentStatus, managed_scan::*, scan::*, web::*};
#[test]
fn completed_empty_review_preserves_exact_native_and_committed_wire_hashes() {
    let (g, s, r) = fixture();
    let terminal = managed_terminal(&g, &s, Some(&r)).unwrap();
    assert_eq!(
        terminal
            .outcome
            .as_ref()
            .unwrap()
            .summary
            .submitted_hypotheses,
        0
    );
    assert!(!terminal.outcome.as_ref().unwrap().vulnerability_reportable);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("terminal.json");
    let file = write_managed_terminal(&path, &terminal).unwrap();
    let raw = std::fs::read(path).unwrap();
    assert_eq!(
        file.file_sha256,
        format!("sha256:{:x}", Sha256::digest(&raw))
    );
    assert_eq!(file.bytes, raw.len() as u64);
    assert_eq!(raw.last(), Some(&b'\n'));
    let decoded: ManagedScanTerminal = serde_json::from_slice(&raw).unwrap();
    validate_managed_terminal(&decoded, &g).unwrap();
    let marker = result_marker(&terminal, &file).unwrap();
    assert!(marker.starts_with("0SEC_NATIVE_RESULT="));
    assert_eq!(marker.lines().count(), 1);
    assert!(!marker.contains("0SEC_RESULT="));
    let mut wrong = file;
    wrong.file_sha256 = format!("sha256:{}", "f".repeat(64));
    assert!(result_marker(&terminal, &wrong).is_err());
}
#[test]
fn changed_grant_native_account_report_or_usd_provenance_rejects() {
    let (g, s, r) = fixture();
    let terminal = managed_terminal(&g, &s, Some(&r)).unwrap();
    for field in [
        "cloud_scan_id",
        "organization_id",
        "dispatch_id",
        "grant_sha256",
    ] {
        let mut value = serde_json::to_value(&terminal).unwrap();
        value[field] = json!(if field == "grant_sha256" {
            format!("sha256:{}", "d".repeat(64))
        } else {
            id(100)
        });
        let t = serde_json::from_value(value).unwrap();
        assert!(validate_managed_terminal(&t, &g).is_err(), "{field}");
    }
    let mut changed = g.clone();
    changed.grant_revision = "new-revision".into();
    assert!(validate_managed_terminal(&terminal, &changed).is_err());
    changed = g.clone();
    changed.scan_profile.currency = ScanCurrency::Units;
    assert!(validate_managed_terminal(&terminal, &changed).is_err());
    let mut bad = s.clone();
    bad.scan.http_account_id = format!("sha256:{}", "e".repeat(64));
    assert!(managed_terminal(&g, &bad, None).is_err());
    let mut bad_report = r.clone();
    bad_report.web.as_mut().unwrap().run.error = Some("changed".into());
    assert!(managed_terminal(&g, &s, Some(&bad_report)).is_err());
    let mut bad = s.clone();
    bad.budget.charged = 4;
    assert!(managed_terminal(&g, &bad, Some(&r)).is_err());
}
#[test]
fn completed_holds_and_verification_invention_reject_even_with_rehashed_report() {
    let (g, s, r) = fixture();
    for mode in ["model_hold", "http_hold", "verified", "close", "summary"] {
        let mut snapshot = s.clone();
        let mut report = r.clone();
        match mode {
            "model_hold" => {
                report.outcome.budget.reserved = 10;
                snapshot.budget.reserved = 10;
            }
            "http_hold" => {
                report.outcome.http_usage.response_reserved_bytes = 4096;
                snapshot.http_usage.response_reserved_bytes = 4096;
            }
            "verified" => report.outcome.vulnerability_reportable = true,
            "close" => {
                report.outcome.close_reason = Some(ScanCloseReason::Cancelled);
                snapshot.close_reason = Some(ScanCloseReason::Cancelled);
            }
            _ => report.outcome.summary.submitted_hypotheses = 1,
        };
        snapshot.result = Some(ScanResult {
            outcome: report.outcome.clone(),
            publication: ScanPublication::Retained {
                report_sha256: hash(&report),
            },
        });
        assert!(
            managed_terminal(&g, &snapshot, Some(&report)).is_err(),
            "{mode}"
        );
    }
}
#[test]
fn recovery_without_report_never_invents_native_outcome_or_drops_holds() {
    let (g, mut s, _) = fixture();
    s.controller_status = OperationStatus::Unknown;
    s.root_status = OperationStatus::Unknown;
    s.result = None;
    s.budget.reserved = 10;
    s.http_usage.response_reserved_bytes = 4096;
    let t = managed_terminal(&g, &s, None).unwrap();
    assert!(t.outcome.is_none() && t.native_publication.is_none());
    assert_eq!(t.budget.reserved, 10);
    assert_eq!(t.http_usage.response_reserved_bytes, 4096);
    assert!(matches!(
        t.publication,
        ManagedScanPublication::Unavailable { report: None, .. }
    ));
    let (g, s, _) = fixture();
    let t = managed_terminal(&g, &s, None).unwrap();
    assert!(matches!(
        t.native_publication,
        Some(ScanPublication::Retained { .. })
    ));
    assert_eq!(
        t.outcome.unwrap().completeness,
        ScanCompleteness::CompletedWorkflow
    );
    assert!(matches!(
        t.publication,
        ManagedScanPublication::Unavailable { .. }
    ));
}
#[test]
fn strict_json_safe_integer_and_expansion_bounds_reject() {
    let (g, _, _) = fixture();
    let mut v = serde_json::to_value(&g).unwrap();
    v["expires_at_ms"] = json!(MAX_SAFE_INTEGER + 1);
    assert!(parse_managed_grant(&serde_json::to_vec(&v).unwrap()).is_err());
    v = serde_json::to_value(&g).unwrap();
    v["grant_revision"] = json!("\0".repeat(MAX_MANAGED_GRANT_BYTES));
    assert!(parse_managed_grant(&serde_json::to_vec(&v).unwrap()).is_err());
    v = serde_json::to_value(&g).unwrap();
    v["secret"] = json!("forbidden");
    assert!(parse_managed_grant(&serde_json::to_vec(&v).unwrap()).is_err());
    let raw = serde_json::to_string(&g).unwrap();
    let duplicate=raw.replace("\"providers\":{\"fixture\":", "\"providers\":{\"fixture\":{\"endpoint\":\"https://evil.test\",\"wire_api\":\"responses\",\"rates\":{\"input\":0,\"cached_input\":0,\"output\":0}},\"fixture\":");
    assert_ne!(raw, duplicate);
    assert!(parse_managed_grant(duplicate.as_bytes()).is_err());
    assert!(managed_json_bytes(&json!({"n":1.5}), 100).is_err());
    assert!(managed_json_bytes(&"\0".repeat(100), 200).is_err());
    assert!(!canonical_uuid("12345678-1234-4234-8234-ABCDEF000000"));
}
#[test]
fn output_failure_preserves_old_file_and_emits_no_success_metadata() {
    let (g, s, r) = fixture();
    let t = managed_terminal(&g, &s, Some(&r)).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("terminal.json");
    std::fs::write(&path, b"old report").unwrap();
    let mut invalid = t.clone();
    invalid.outcome.as_mut().unwrap().vulnerability_reportable = true;
    assert!(write_managed_terminal(&path, &invalid).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"old report");
    let destination = dir.path().join("directory");
    std::fs::create_dir(&destination).unwrap();
    std::fs::write(destination.join("old"), b"retained").unwrap();
    assert!(write_managed_terminal(&destination, &t).is_err());
    assert_eq!(std::fs::read(destination.join("old")).unwrap(), b"retained");
    assert!(write_managed_terminal(&dir.path().join("missing/terminal"), &t).is_err());
}
#[test]
fn compact_publication_retains_actual_outcome_and_omits_oversized_recovery_whole() {
    let (g, mut s, mut r) = fixture();
    s.result.as_mut().unwrap().publication = ScanPublication::ReportTooLarge;
    r.kind = ScanReportKind::Compact;
    r.web = None;
    let t = managed_terminal(&g, &s, Some(&r)).unwrap();
    assert!(matches!(
        t.publication,
        ManagedScanPublication::ReportTooLarge { report: Some(_) }
    ));
    let (g, mut s, mut r) = fixture();
    s.result = None;
    s.controller_status = OperationStatus::Unknown;
    s.root_status = OperationStatus::Unknown;
    s.budget.reserved = 10;
    r.kind = ScanReportKind::Recovery;
    r.outcome.root_status = OperationStatus::Unknown;
    r.outcome.agent_status = None;
    r.outcome.budget = s.budget.clone();
    r.outcome.completeness = ScanCompleteness::Partial;
    r.outcome.stop_reason = ScanStopReason::Unknown;
    r.outcome.completed_at_ms = 0;
    r.outcome.review_sha256 = None;
    let web = r.web.as_mut().unwrap();
    web.run.operation_status = OperationStatus::Unknown;
    web.run.agent_status = None;
    web.run.review = None;
    web.run.error = Some("x".repeat(MAX_MANAGED_COMPACT_BYTES));
    let t = managed_terminal(&g, &s, Some(&r)).unwrap();
    assert_eq!(
        t.outcome.as_ref().unwrap().stop_reason,
        ScanStopReason::Unknown
    );
    assert!(matches!(
        t.publication,
        ManagedScanPublication::Unavailable { report: None, .. }
    ));
}
#[test]
fn recovered_controller_cannot_claim_submitted_and_native_publication_is_not_invented() {
    let (g, s, _) = fixture();
    let t = managed_terminal(&g, &s, None).unwrap();
    let mut bad = t.clone();
    bad.controller_status = OperationStatus::Unknown;
    bad.native_publication = None;
    bad.publication = ManagedScanPublication::Unavailable {
        reason: "controller_report_unavailable".into(),
        report: None,
    };
    assert!(validate_managed_terminal(&bad, &g).is_err());
    let mut bad = t.clone();
    bad.native_publication = Some(ScanPublication::Retained {
        report_sha256: "garbage".into(),
    });
    assert!(validate_managed_terminal(&bad, &g).is_err());
    let mut bad = t;
    bad.native_publication = None;
    assert!(validate_managed_terminal(&bad, &g).is_err());
}
#[test]
fn rehashed_foreign_or_contradictory_observation_rejects() {
    let (g, s, r) = fixture();
    let manifest = format!("sha256:{}", "f".repeat(64));
    for mode in ["foreign_session", "wrong_operation", "unknown_complete"] {
        let mut report = r.clone();
        let status = if mode == "unknown_complete" {
            OperationStatus::Unknown
        } else {
            OperationStatus::Succeeded
        };
        report
            .web
            .as_mut()
            .unwrap()
            .observations
            .push(WebReportObservation {
                operation: WebHttpOperation {
                    sequence: 5,
                    operation_id: id(20),
                    actor_operation_id: s.scan.root_operation_id.clone(),
                    operation_status: status,
                    response_manifest_sha256: Some(manifest.clone()),
                },
                evidence: Some(HttpEvidenceMetadata {
                    session_id: if mode == "foreign_session" {
                        id(99)
                    } else {
                        s.scan.session_id.clone()
                    },
                    operation_id: if mode == "wrong_operation" {
                        id(21)
                    } else {
                        id(20)
                    },
                    operation_status: status,
                    response_manifest_sha256: manifest.clone(),
                    retained_body_sha256: manifest.clone(),
                    retained_bytes: 0,
                    complete: true,
                    url: Some(g.target.clone()),
                    status: Some(200),
                    headers: vec![],
                    wire_bytes: 0,
                    decoded_bytes: 0,
                    artifacts: Default::default(),
                }),
                error: None,
            });
        let mut snapshot = s.clone();
        snapshot.result.as_mut().unwrap().publication = ScanPublication::Retained {
            report_sha256: hash(&report),
        };
        assert!(
            managed_terminal(&g, &snapshot, Some(&report)).is_err(),
            "{mode}"
        );
    }
}
#[test]
fn every_retained_partial_reason_remains_partial_with_original_close_and_usage() {
    for stop in [
        ScanStopReason::StoppedWithoutSubmission,
        ScanStopReason::TurnLimit,
        ScanStopReason::BudgetLimit,
        ScanStopReason::Deadline,
        ScanStopReason::Cancelled,
        ScanStopReason::Failed,
        ScanStopReason::Unknown,
    ] {
        let (g, mut s, mut r) = fixture();
        let (root, agent) = match stop {
            ScanStopReason::StoppedWithoutSubmission => {
                (OperationStatus::Succeeded, AgentStatus::Completed)
            }
            ScanStopReason::TurnLimit => (OperationStatus::Failed, AgentStatus::TurnLimit),
            ScanStopReason::Cancelled | ScanStopReason::Deadline => {
                (OperationStatus::Cancelled, AgentStatus::Cancelled)
            }
            ScanStopReason::Unknown => (OperationStatus::Unknown, AgentStatus::Unknown),
            _ => (OperationStatus::Failed, AgentStatus::Failed),
        };
        s.root_status = root;
        s.close_reason = match stop {
            ScanStopReason::Cancelled => Some(ScanCloseReason::Cancelled),
            ScanStopReason::Deadline => Some(ScanCloseReason::Deadline),
            _ => None,
        };
        r.outcome.root_status = root;
        r.outcome.agent_status = Some(agent.clone());
        r.outcome.close_reason = s.close_reason;
        r.outcome.stop_reason = stop;
        r.outcome.completeness = ScanCompleteness::Partial;
        r.outcome.review_sha256 = None;
        if stop == ScanStopReason::Unknown {
            s.budget.reserved = 10;
            r.outcome.budget.reserved = 10;
        }
        let web = r.web.as_mut().unwrap();
        web.run.operation_status = root;
        web.run.agent_status = Some(agent);
        web.run.review = None;
        s.result = Some(ScanResult {
            outcome: r.outcome.clone(),
            publication: ScanPublication::Retained {
                report_sha256: hash(&r),
            },
        });
        let t = managed_terminal(&g, &s, Some(&r)).unwrap();
        assert_eq!(t.outcome.as_ref().unwrap().stop_reason, stop);
        assert_eq!(
            t.outcome.as_ref().unwrap().completeness,
            ScanCompleteness::Partial
        );
    }
}
#[test]
fn inconsistent_native_metadata_rejects_but_measured_cost_overrun_is_preserved() {
    let (g, s, r) = fixture();
    for mode in [
        "completed_before_start",
        "zero_sequence",
        "reused_native_id",
        "empty_deadline",
    ] {
        let mut snapshot = s.clone();
        let mut report = r.clone();
        match mode {
            "completed_before_start" => report.outcome.completed_at_ms = 999,
            "zero_sequence" => {
                snapshot.scan.sequence = 0;
                report.scan.sequence = 0;
            }
            "reused_native_id" => {
                snapshot.scan.controller_operation_id = snapshot.scan.root_operation_id.clone();
                report.scan = snapshot.scan.clone();
            }
            _ => {
                snapshot.scan.deadline_at_ms = snapshot.scan.created_at_ms;
                report.scan = snapshot.scan.clone();
            }
        }
        snapshot.result = Some(ScanResult {
            outcome: report.outcome.clone(),
            publication: ScanPublication::Retained {
                report_sha256: hash(&report),
            },
        });
        assert!(
            managed_terminal(&g, &snapshot, Some(&report)).is_err(),
            "{mode}"
        );
    }
    let mut snapshot = s;
    let mut report = r;
    snapshot.budget.charged = 101;
    report.outcome.budget.charged = 101;
    snapshot.result = Some(ScanResult {
        outcome: report.outcome.clone(),
        publication: ScanPublication::Retained {
            report_sha256: hash(&report),
        },
    });
    let terminal = managed_terminal(&g, &snapshot, Some(&report)).unwrap();
    assert_eq!(terminal.budget.charged, 101);
    assert_eq!(terminal.budget.limit, 100);
    let mut oversized = terminal;
    oversized
        .outcome
        .as_mut()
        .unwrap()
        .summary
        .submitted_hypotheses = g.scan_profile.max_hypotheses + 1;
    oversized.outcome.as_mut().unwrap().summary.claimed_low = g.scan_profile.max_hypotheses + 1;
    oversized.publication = ManagedScanPublication::Unavailable {
        reason: "retained_report_unavailable".into(),
        report: None,
    };
    assert!(validate_managed_terminal(&oversized, &g).is_err());
}

#[test]
fn opaque_organization_ids_preserve_case_and_exact_grant_binding() {
    for organization in [
        id(2),
        "Org_AbC0123456789-cloud".into(),
        "a".repeat(16),
        "Z".repeat(64),
    ] {
        let (mut grant, snapshot, report) = fixture();
        grant.organization_id = organization.clone();
        grant.validate().unwrap();
        let terminal = managed_terminal(&grant, &snapshot, Some(&report)).unwrap();
        assert_eq!(terminal.organization_id, organization);
        validate_managed_terminal(&terminal, &grant).unwrap();
        let parsed = parse_managed_grant(&serde_json::to_vec(&grant).unwrap()).unwrap();
        assert_eq!(parsed.organization_id, organization);
        if organization != organization.to_ascii_lowercase() {
            let mut changed = grant.clone();
            changed.organization_id = organization.to_ascii_lowercase();
            assert!(validate_managed_terminal(&terminal, &changed).is_err());
        }
    }
    for organization in [
        String::new(),
        "a".repeat(15),
        "a".repeat(65),
        "Org_AbC0123456789 cloud".into(),
        "Org_AbC0123456789/cloud".into(),
        "Org_AbC0123456789\n".into(),
        "Org_AbC0123456789é".into(),
    ] {
        let (mut grant, snapshot, report) = fixture();
        let mut terminal = managed_terminal(&grant, &snapshot, Some(&report)).unwrap();
        grant.organization_id = organization.clone();
        terminal.organization_id = organization;
        assert!(grant.validate().is_err());
        assert!(terminal.validate().is_err());
    }
}
