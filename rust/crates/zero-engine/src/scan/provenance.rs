use super::*;
struct Facts {
    root: Operation,
    unresolved: bool,
}
fn facts(store: &Store, scan: &ScanRecord) -> Result<Facts, EngineError> {
    store.validate_session_admission_closure(&scan.session_id)?;
    let mut remaining = 64 * 1024 * 1024;
    let mut events = vec![];
    let mut after = 0;
    loop {
        let page = store.events_bounded(&scan.session_id, after, 256, &mut remaining)?;
        if page.is_empty() {
            break;
        }
        for e in page {
            after = e.sequence;
            events.push(e);
            if events.len() > 65536 {
                return Err(error("scan journal exceeds bounded count"));
            }
        }
    }
    let mut unresolved = false;
    for event in events.iter().filter(|e| e.kind == "command_admitted") {
        let id = event.payload["id"]
            .as_str()
            .ok_or_else(|| error("scan admission identity absent"))?;
        let op = store.get_operation_bounded(id, &mut remaining)?;
        if op.session_id != scan.session_id || event.payload["payload"] != op.payload {
            return Err(error("scan operation authority differs"));
        }
        match op.status {
            OperationStatus::Unknown => {
                store.validate_unknown_operation(&op)?;
                if op.id != scan.controller_operation_id {
                    unresolved = true;
                }
            }
            OperationStatus::Running | OperationStatus::Admitted => {
                if op.id != scan.controller_operation_id {
                    unresolved = true;
                }
            }
            _ => {
                let terminal: Vec<_> = events
                    .iter()
                    .filter(|e| e.kind == "operation_settled" && e.payload["id"] == op.id)
                    .collect();
                if terminal.len() != 1 || terminal[0].payload != serde_json::to_value(&op)? {
                    return Err(error("scan terminal operation witness differs"));
                }
            }
        }
    }
    Ok(Facts {
        root: store.get_operation_bounded(&scan.root_operation_id, &mut remaining)?,
        unresolved,
    })
}
pub(super) fn compose(
    store: &Store,
    snapshot: &ScanSnapshot,
    kind: ScanReportKind,
    completed_at_ms: u64,
) -> Result<ScanReport, EngineError> {
    let scan = &snapshot.scan;
    let f = facts(store, scan)?;
    let result: Option<AgentResult> = f
        .root
        .outcome
        .clone()
        .and_then(|v| serde_json::from_value(v).ok());
    if matches!(
        f.root.status,
        OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled
    ) && result.is_none()
    {
        return Err(error("scan actor terminal outcome absent"));
    }
    let (web, cursor) = crate::web_read::workflow_report_with_cursor(
        store,
        &scan.session_id,
        &scan.root_operation_id,
        &[],
    )?;
    let mut summary = ScanClaimSummary::default();
    if let Some(review) = &web.run.review {
        for hypothesis in &review.hypotheses {
            summary.submitted_hypotheses += 1;
            match hypothesis.claim.claimed_severity {
                ClaimedSeverity::Critical => summary.claimed_critical += 1,
                ClaimedSeverity::High => summary.claimed_high += 1,
                ClaimedSeverity::Medium => summary.claimed_medium += 1,
                ClaimedSeverity::Low => summary.claimed_low += 1,
                ClaimedSeverity::Info => summary.claimed_info += 1,
            }
        }
    }
    let agent_status = result.as_ref().map(|r| r.status.clone());
    let review_sha256 = web
        .run
        .review
        .as_ref()
        .and_then(|_| web.run.artifacts.get("web.review").cloned());
    let unknown = f.unresolved
        || snapshot.controller_status == OperationStatus::Unknown
        || snapshot.budget.reserved > 0
        || snapshot.http_usage.response_reserved_bytes > 0;
    let stop_reason = if unknown {
        ScanStopReason::Unknown
    } else if let Some(reason) = snapshot.close_reason {
        match reason {
            ScanCloseReason::Cancelled => ScanStopReason::Cancelled,
            ScanCloseReason::Deadline => ScanStopReason::Deadline,
        }
    } else if review_sha256.is_some() {
        ScanStopReason::Submitted
    } else if store.scan_terminal_budget_denied(&scan.id)? {
        ScanStopReason::BudgetLimit
    } else {
        match agent_status {
            Some(AgentStatus::Completed) => ScanStopReason::StoppedWithoutSubmission,
            Some(AgentStatus::TurnLimit) => ScanStopReason::TurnLimit,
            Some(AgentStatus::Cancelled) => ScanStopReason::Cancelled,
            Some(AgentStatus::Unknown) => ScanStopReason::Unknown,
            _ => ScanStopReason::Failed,
        }
    };
    let outcome = ScanOutcome {
        schema_version: 1,
        scan_id: scan.id.clone(),
        root_status: f.root.status,
        agent_status,
        stop_reason,
        close_reason: snapshot.close_reason,
        http_usage: snapshot.http_usage.clone(),
        completeness: if stop_reason == ScanStopReason::Submitted {
            ScanCompleteness::CompletedWorkflow
        } else {
            ScanCompleteness::Partial
        },
        started_at_ms: scan.created_at_ms,
        completed_at_ms,
        review_sha256,
        budget: snapshot.budget.clone(),
        currency: snapshot.currency,
        summary,
        security_conclusion: SecurityConclusion::NotEstablished,
        vulnerability_reportable: false,
        error_code: match stop_reason {
            ScanStopReason::Failed => Some("actor_failed".into()),
            ScanStopReason::Unknown => Some("unresolved_execution".into()),
            _ => None,
        },
    };
    let mut report = ScanReport {
        schema_version: 1,
        kind,
        scan: scan.clone(),
        outcome,
        web: Some(web),
        observations_next_after_sequence: cursor,
    };
    if kind == ScanReportKind::Compact {
        report.web = None;
        return Ok(report);
    }
    let mut after = 0;
    for _ in 0..32 {
        let page = crate::web_experiment_read::experiments(
            store,
            &scan.session_id,
            &scan.root_operation_id,
            after,
            32,
        )?;
        for candidate in page.experiments {
            let detail = crate::web_experiment_read::experiment(
                store,
                &scan.session_id,
                &scan.root_operation_id,
                &candidate.operation_id,
            )?;
            report
                .web
                .as_mut()
                .ok_or_else(|| error("scan web report absent"))?
                .experiments
                .push(detail);
            if encode(&report)?.is_none() {
                report.kind = ScanReportKind::Compact;
                report.web = None;
                return Ok(report);
            }
        }
        match page.next_after_sequence {
            None => return Ok(report),
            Some(next) if next > after => after = next,
            _ => return Err(error("scan experiment cursor did not advance")),
        }
    }
    // All retained experiments remain discoverable; publishing an incomplete matrix
    // as a complete report would hide investigation evidence.
    report.kind = ScanReportKind::Compact;
    report.web = None;
    Ok(report)
}
fn retained(
    store: &Store,
    snapshot: &ScanSnapshot,
    result: &ScanResult,
) -> Result<ScanReport, EngineError> {
    let controller = store.get_operation(&snapshot.scan.controller_operation_id)?;
    if controller.status != OperationStatus::Succeeded {
        return Err(error("published scan result requires succeeded controller"));
    }
    let attachments = store.operation_artifacts(&controller.id)?;
    let (name, digest, kind) = match &result.publication {
        ScanPublication::Retained { report_sha256 } => {
            ("scan.report", report_sha256, ScanReportKind::Retained)
        }
        ScanPublication::ReportTooLarge => (
            "scan.compact",
            attachments
                .get("scan.compact")
                .ok_or_else(|| error("compact scan report absent"))?,
            ScanReportKind::Compact,
        ),
        ScanPublication::Unavailable { .. } => return Err(error("scan report was not published")),
    };
    if attachments.get(name) != Some(digest) {
        return Err(error("scan report attachment differs"));
    }
    let mut budget = MAX_SCAN_REPORT_BYTES;
    let bytes = store.artifact_bounded(digest, MAX_SCAN_REPORT_BYTES, &mut budget)?;
    let report: ScanReport = serde_json::from_slice(&bytes)?;
    if report.kind != kind
        || report.scan != snapshot.scan
        || !same(&report.outcome, &result.outcome)?
    {
        return Err(error("scan report identity differs"));
    }
    let mut expected = compose(store, snapshot, kind, report.outcome.completed_at_ms)?;
    if kind == ScanReportKind::Compact {
        expected.web = None;
    }
    if !same(&expected, &report)? {
        return Err(error("scan report does not match retained investigation"));
    }
    Ok(report)
}
pub(super) fn snapshot(store: &Store, id: &str) -> Result<ScanSnapshot, EngineError> {
    // Metadata and accounting remain available even when the full evidence closure
    // exceeds the independently reassessed report read budget.
    Ok(store.scan_snapshot(id)?)
}
pub(super) fn report(store: &Store, id: &str) -> Result<ScanReport, EngineError> {
    let snapshot = store.scan_snapshot(id)?;
    if let Some(result) = &snapshot.result {
        return retained(store, &snapshot, result);
    }
    compose(store, &snapshot, ScanReportKind::Recovery, 0)
}
