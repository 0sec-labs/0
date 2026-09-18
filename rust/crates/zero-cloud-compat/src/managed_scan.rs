//! Explicit managed scan framing; no HTTP publication, authority grants, or scans.
//! Callers must supply a Store-validated captured grant, snapshot and optional report.
//! A matching JSON hash authenticates bytes, not the host that asserted the grant.
use crate::Error;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};
use zero_protocol::{
    managed_scan::*,
    scan::*,
    source::{ClaimedSeverity, VerificationState},
};
fn invalid(message: &'static str) -> Error {
    Error::Invalid(message)
}
fn equal(a: &impl Serialize, b: &impl Serialize) -> Result<bool, Error> {
    Ok(serde_json::to_value(a)? == serde_json::to_value(b)?)
}
fn bytes(v: &impl Serialize, limit: usize) -> Result<Vec<u8>, Error> {
    managed_json_bytes(v, limit).map_err(|_| invalid("managed wire bounds or integer precision"))
}
fn digest(b: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(b))
}
fn canonical_hash(value: &impl Serialize) -> Result<String, Error> {
    Ok(digest(&bytes(
        &serde_json::to_value(value)?,
        MAX_MANAGED_TERMINAL_BYTES,
    )?))
}
/// Returns the hash of the canonical public grant. Expiry is checked only at fresh admission.
pub fn validate_managed_grant(grant: &ManagedScanGrant) -> Result<String, Error> {
    grant.validate().map_err(|_| invalid("managed grant"))?;
    canonical_hash(grant)
}
/// Strict bounded decoding before a host configures any private credential handles.
pub fn parse_managed_grant(raw: &[u8]) -> Result<ManagedScanGrant, Error> {
    if raw.len() > MAX_MANAGED_GRANT_BYTES {
        return Err(invalid("managed grant size"));
    }
    let grant: ManagedScanGrant = serde_json::from_slice(raw)?;
    validate_managed_grant(&grant)?;
    Ok(grant)
}
/// Conversion is not source attestation: the caller authenticates original Store witnesses.
pub fn managed_terminal(
    grant: &ManagedScanGrant,
    snapshot: &ScanSnapshot,
    report: Option<&ScanReport>,
) -> Result<ManagedScanTerminal, Error> {
    let grant_sha256 = validate_managed_grant(grant)?;
    if snapshot.phase != ScanPhase::Terminal {
        return Err(invalid(
            "managed terminal requires drained or recovered terminal state",
        ));
    }
    if let Some(report) = report {
        bytes(report, MAX_MANAGED_TERMINAL_BYTES)?;
        if report.scan != snapshot.scan {
            return Err(invalid("report scan differs"));
        }
    }
    let outcome = snapshot
        .result
        .as_ref()
        .map(|r| r.outcome.clone())
        .or_else(|| report.map(|r| r.outcome.clone()));
    if let (Some(o), Some(r)) = (&outcome, report) {
        if !equal(o, &r.outcome)? {
            return Err(invalid("report and terminal outcome differ"));
        }
    }
    let publication = match snapshot.result.as_ref().map(|r| &r.publication) {
        Some(ScanPublication::Retained { report_sha256 }) => match report {
            Some(r) => ManagedScanPublication::Retained {
                report_sha256: report_sha256.clone(),
                report: Box::new(r.clone()),
            },
            None => ManagedScanPublication::Unavailable {
                reason: "retained_report_unavailable".into(),
                report: None,
            },
        },
        Some(ScanPublication::ReportTooLarge) => ManagedScanPublication::ReportTooLarge {
            report: report.cloned().map(Box::new),
        },
        Some(ScanPublication::Unavailable { reason }) => ManagedScanPublication::Unavailable {
            reason: reason.clone(),
            report: report.cloned().map(Box::new),
        },
        None => ManagedScanPublication::Unavailable {
            reason: "controller_report_unavailable".into(),
            report: report.cloned().map(Box::new),
        },
    };
    let mut terminal = ManagedScanTerminal {
        contract_version: MANAGED_SCAN_CONTRACT.into(),
        cloud_scan_id: grant.cloud_scan_id.clone(),
        organization_id: grant.organization_id.clone(),
        dispatch_id: grant.dispatch_id.clone(),
        grant_sha256,
        scan: snapshot.scan.clone(),
        controller_status: snapshot.controller_status,
        root_status: snapshot.root_status,
        close_reason: snapshot.close_reason,
        budget: snapshot.budget.clone(),
        http_usage: snapshot.http_usage.clone(),
        currency: snapshot.currency,
        outcome,
        native_publication: snapshot.result.as_ref().map(|r| r.publication.clone()),
        publication,
        enforcement: ManagedEnforcementAvailability::default(),
    };
    // Recovery observations can exceed the compact envelope cap. Preserve their exact
    // original outcome and source IDs, and omit the optional whole report rather than truncate it.
    if !matches!(
        terminal.publication,
        ManagedScanPublication::Retained { .. }
    ) && managed_json_bytes(&terminal, MAX_MANAGED_COMPACT_BYTES).is_err()
    {
        match &mut terminal.publication {
            ManagedScanPublication::ReportTooLarge { report }
            | ManagedScanPublication::Unavailable { report, .. } => *report = None,
            _ => {}
        }
    }
    validate_managed_terminal(&terminal, grant)?;
    Ok(terminal)
}
/// Recheck the external envelope against the controller's independently captured grant.
pub fn validate_managed_terminal(
    terminal: &ManagedScanTerminal,
    grant: &ManagedScanGrant,
) -> Result<(), Error> {
    terminal
        .validate()
        .map_err(|_| invalid("managed terminal disposition"))?;
    if terminal.grant_sha256 != validate_managed_grant(grant)?
        || terminal.cloud_scan_id != grant.cloud_scan_id
        || terminal.organization_id != grant.organization_id
        || terminal.dispatch_id != grant.dispatch_id
        || terminal.scan.command_id != grant.command_id()
        || terminal.scan.profile_name != grant.scan_profile_name
        || terminal.scan.target != grant.target
        || terminal.scan.input_target != grant.target
        || terminal.scan.profile_sha256 != canonical_hash(&grant.scan_profile)?
        || terminal.currency != grant.scan_profile.currency
        || terminal.budget.limit != grant.scan_profile.budget_limit
        || terminal.scan.created_at_ms >= grant.expires_at_ms
        || terminal.scan.deadline_at_ms
            != terminal
                .scan
                .created_at_ms
                .checked_add(grant.scan_profile.deadline_ms)
                .ok_or_else(|| invalid("deadline overflow"))?
                .min(grant.expires_at_ms)
    {
        return Err(invalid("managed grant cross-binding differs"));
    }
    let profile_sha256 = canonical_hash(&grant.http_policy)?;
    let account = canonical_hash(
        &json!({"session_id":terminal.scan.session_id,"original_root_command":format!("scan:{}:root",terminal.scan.id),"profile_sha256":profile_sha256}),
    )?;
    if account != terminal.scan.http_account_id
        || terminal.http_usage.requests > grant.http_policy.budget.max_requests
        || terminal.http_usage.request_body_bytes > grant.http_policy.budget.max_request_body_bytes
        || terminal
            .http_usage
            .response_charged_bytes
            .checked_add(terminal.http_usage.response_reserved_bytes)
            .is_none_or(|n| n > grant.http_policy.budget.max_response_decoded_bytes)
    {
        return Err(invalid("original HTTP account or usage differs"));
    }
    if terminal
        .outcome
        .as_ref()
        .is_some_and(|o| o.summary.submitted_hypotheses > grant.scan_profile.max_hypotheses)
    {
        return Err(invalid("submitted hypotheses exceed captured grant"));
    }
    validate_report(terminal)?;
    let report = match &terminal.publication {
        ManagedScanPublication::Retained { report, .. } => Some(report),
        ManagedScanPublication::ReportTooLarge { report }
        | ManagedScanPublication::Unavailable { report, .. } => report.as_ref(),
    };
    if let Some(web) = report.and_then(|r| r.web.as_ref()) {
        if web.run.authority.profile_name != grant.scan_profile.http_profile
            || web.run.authority.profile_sha256 != profile_sha256
            || web.run.authority.account_id != account
            || !equal(&web.run.authority.profile, &grant.http_policy)?
        {
            return Err(invalid("report HTTP authority differs"));
        }
    }
    Ok(())
}
fn validate_report(t: &ManagedScanTerminal) -> Result<(), Error> {
    let report = match &t.publication {
        ManagedScanPublication::Retained {
            report_sha256,
            report,
        } => {
            if digest(&bytes(report, MAX_SCAN_REPORT_BYTES)?) != *report_sha256 {
                return Err(invalid("native report hash differs"));
            }
            Some(report)
        }
        ManagedScanPublication::ReportTooLarge { report }
        | ManagedScanPublication::Unavailable { report, .. } => report.as_ref(),
    };
    if let Some(r) = report {
        if let Some(web) = &r.web {
            if web.schema_version != 1
                || web.verification_state != VerificationState::Unverified
                || web.security_conclusion
                    != zero_protocol::source::SecurityConclusion::NotEstablished
                || web.run.session_id != t.scan.session_id
                || web.run.operation_id != t.scan.root_operation_id
                || web.run.command_id != format!("scan:{}:root", t.scan.id)
                || web.run.operation_status != t.root_status
                || web.run.agent_status != r.outcome.agent_status
                || !web.verifications.is_empty()
            {
                return Err(invalid("web report identity or verification differs"));
            }
            let mut observed = std::collections::BTreeSet::new();
            if web.observations.len() > 128 {
                return Err(invalid("observation count exceeds native report bound"));
            }
            for observation in &web.observations {
                let op = &observation.operation;
                if !canonical_uuid(&op.operation_id)
                    || !canonical_uuid(&op.actor_operation_id)
                    || !observed.insert(&op.operation_id)
                {
                    return Err(invalid("invalid or duplicate observation identity"));
                }
                if let Some(e) = &observation.evidence {
                    if e.session_id != t.scan.session_id
                        || e.operation_id != op.operation_id
                        || e.operation_status != op.operation_status
                        || op.response_manifest_sha256.as_ref() != Some(&e.response_manifest_sha256)
                        || !zero_protocol::is_sha256(&e.response_manifest_sha256)
                        || !zero_protocol::is_sha256(&e.retained_body_sha256)
                        || e.retained_bytes > 16 * 1024 * 1024
                        || e.headers.len() > 128
                        || e.headers
                            .iter()
                            .map(|(k, v)| k.len().saturating_add(v.len()))
                            .sum::<usize>()
                            > 65536
                        || (e.complete
                            && op.operation_status != zero_protocol::OperationStatus::Succeeded)
                    {
                        return Err(invalid("HTTP observation metadata correlation differs"));
                    }
                }
            }
            let mut summary = ScanClaimSummary::default();
            if let Some(review) = &web.run.review {
                for h in &review.hypotheses {
                    if h.state != VerificationState::Unverified {
                        return Err(invalid("managed claims cannot be verified"));
                    }
                    summary.submitted_hypotheses += 1;
                    match h.claim.claimed_severity {
                        ClaimedSeverity::Critical => summary.claimed_critical += 1,
                        ClaimedSeverity::High => summary.claimed_high += 1,
                        ClaimedSeverity::Medium => summary.claimed_medium += 1,
                        ClaimedSeverity::Low => summary.claimed_low += 1,
                        ClaimedSeverity::Info => summary.claimed_info += 1,
                    }
                }
                if web.run.artifacts.get("web.review") != r.outcome.review_sha256.as_ref() {
                    return Err(invalid("review artifact differs"));
                }
            } else if r.outcome.review_sha256.is_some() {
                return Err(invalid("structured review absent"));
            }
            if summary != r.outcome.summary {
                return Err(invalid("claimed severity summary differs"));
            }
            for experiment in &web.experiments {
                if experiment.session_id != t.scan.session_id
                    || experiment.web_operation_id != t.scan.root_operation_id
                    || experiment
                        .outcome
                        .as_ref()
                        .is_some_and(|o| o.assessment.vulnerability_reportable)
                {
                    return Err(invalid("experiment is foreign or claims verification"));
                }
            }
        }
    }
    Ok(())
}
/// Serialize and validate fully before creating a temporary file. No environment-selected paths.
/// The returned digest covers the exact committed bytes (including their final newline).
/// On Unix, success includes parent-directory synchronization. Unsupported platforms
/// or directory-sync failures return an error even if rename already committed;
/// callers must not emit a success marker for that uncertain publication.
pub fn write_managed_terminal(
    path: &Path,
    terminal: &ManagedScanTerminal,
) -> Result<ManagedScanFile, Error> {
    terminal
        .validate()
        .map_err(|_| invalid("managed terminal"))?;
    validate_report(terminal)?;
    let limit = if matches!(
        terminal.publication,
        ManagedScanPublication::Retained { .. }
    ) {
        MAX_MANAGED_TERMINAL_BYTES
    } else {
        MAX_MANAGED_COMPACT_BYTES
    };
    let mut raw = bytes(terminal, limit.saturating_sub(1))?;
    raw.push(b'\n');
    let result = ManagedScanFile {
        file_sha256: digest(&raw),
        bytes: raw.len() as u64,
    };
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(&raw)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| Error::Io(e.error))?;
    sync_parent(parent)?;
    Ok(result)
}
// A post-rename directory-sync error means publication is uncertain: the file may
// already exist, but the caller receives no success metadata and emits no marker.
#[cfg(unix)]
fn sync_parent(parent: &Path) -> Result<(), Error> {
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}
#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> Result<(), Error> {
    Err(Error::Io(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "durable managed publication requires supported directory synchronization",
    )))
}

/// Call only after write_managed_terminal succeeds; this metadata is never a stdout fallback report.
pub fn result_marker(
    terminal: &ManagedScanTerminal,
    file: &ManagedScanFile,
) -> Result<String, Error> {
    terminal
        .validate()
        .map_err(|_| invalid("managed terminal marker"))?;
    validate_report(terminal)?;
    let limit = if matches!(
        terminal.publication,
        ManagedScanPublication::Retained { .. }
    ) {
        MAX_MANAGED_TERMINAL_BYTES
    } else {
        MAX_MANAGED_COMPACT_BYTES
    };
    let mut raw = bytes(terminal, limit.saturating_sub(1))?;
    raw.push(b'\n');
    if file.file_sha256 != digest(&raw) || file.bytes != raw.len() as u64 {
        return Err(invalid("committed file identity differs"));
    }
    let publication = match terminal.publication {
        ManagedScanPublication::Retained { .. } => "retained",
        ManagedScanPublication::ReportTooLarge { .. } => "report_too_large",
        ManagedScanPublication::Unavailable { .. } => "unavailable",
    };
    Ok(format!(
        "0SEC_NATIVE_RESULT={}\n",
        serde_json::to_string(
            &json!({"contract_version":MANAGED_SCAN_CONTRACT,"cloud_scan_id":terminal.cloud_scan_id,"organization_id":terminal.organization_id,"dispatch_id":terminal.dispatch_id,"grant_sha256":terminal.grant_sha256,"native_scan_id":terminal.scan.id,"file_sha256":file.file_sha256,"bytes":file.bytes,"publication":publication})
        )?
    ))
}
