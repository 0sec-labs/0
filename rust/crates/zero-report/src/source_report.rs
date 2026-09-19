//! Native hypothesis presentation. The caller must separately validate journal provenance.
use crate::html::Html;
use crate::markdown::{Lines, escape};
use crate::{Error, MAX_REPORT_BYTES, Result, SourceReport, bounded_pretty};
use zero_protocol::{
    is_sha256,
    source::{ClaimedSeverity, VerificationState},
};
#[derive(Debug, Clone, Copy)]
pub enum SourceReportFormat {
    Json,
    Markdown,
    Html,
    Sarif,
}
const NOTICE: &str = "All source hypotheses remain unverified. Citation and provenance hashes identify retained evidence; they do not establish a vulnerability, a validated repair, or target safety.";
/// Render a native source report without converting it to legacy findings.
/// Checks structural consistency and resource limits; does not read artifacts,
/// validate journal ownership, reproduce behavior, or authorize disclosure.
pub fn render_source_report(report: &SourceReport, format: SourceReportFormat) -> Result<String> {
    validate(report)?;
    match format {
        SourceReportFormat::Json => {
            let value = serde_json::to_value(report).map_err(|_| Error::Json)?;
            bounded_pretty(&value, 4 * MAX_REPORT_BYTES)
        }
        SourceReportFormat::Markdown => markdown(report),
        SourceReportFormat::Html => html(report),
        SourceReportFormat::Sarif => crate::source_sarif::render(report),
    }
}
fn bounded_text(value: &str, limit: usize, field: &'static str) -> Result<()> {
    if value.is_empty() || value.len() > limit {
        return Err(Error::Field(field));
    }
    Ok(())
}
pub(crate) fn validate(report: &SourceReport) -> Result<()> {
    if !matches!(report.schema_version, 1 | 2) || report.review.version != 1 {
        return Err(Error::Field("source report version"));
    }
    bounded_text(&report.session_id, 512, "session_id")?;
    bounded_text(&report.operation_id, 512, "operation_id")?;
    if report.snapshot_sha256 != report.review.snapshot_sha256
        || ![
            &report.snapshot_sha256,
            &report.review.bundle_sha256,
            &report.review.request_sha256,
            &report.review.completion_sha256,
        ]
        .iter()
        .all(|s| is_sha256(s))
    {
        return Err(Error::Field("source report identity"));
    }
    if report.review.hypotheses.len() > 32 || report.artifacts.len() > 256 {
        return Err(Error::Limit);
    }
    bounded_text(&report.review.model, 512, "model")?;
    bounded_text(&report.review.submission_call_id, 512, "submission_call_id")?;
    if let Some(id) = &report.review.provider_response_id {
        bounded_text(id, 4096, "provider_response_id")?;
    }
    for (name, digest) in &report.artifacts {
        bounded_text(name, 256, "artifact name")?;
        if !is_sha256(digest) {
            return Err(Error::Field("artifact digest"));
        }
    }
    for (name, expected) in [
        ("source.bundle", &report.review.bundle_sha256),
        ("source.request", &report.review.request_sha256),
        ("source.completion", &report.review.completion_sha256),
    ] {
        if report.artifacts.get(name) != Some(expected) {
            return Err(Error::Field("source artifact identity"));
        }
    }
    if !report.artifacts.contains_key("source.review") {
        return Err(Error::Field("source review artifact"));
    }
    let mut ids = std::collections::HashSet::new();
    for hypothesis in &report.review.hypotheses {
        bounded_text(&hypothesis.id, 512, "hypothesis id")?;
        if !ids.insert(&hypothesis.id) || hypothesis.state != VerificationState::Unverified {
            return Err(Error::Field("hypothesis identity/state"));
        }
        bounded_text(&hypothesis.claim.title, 1024, "claim title")?;
        bounded_text(&hypothesis.claim.explanation, 16384, "claim explanation")?;
        if hypothesis.claim.citations.is_empty() || hypothesis.claim.citations.len() > 32 {
            return Err(Error::Field("citations"));
        }
        for citation in &hypothesis.claim.citations {
            bounded_text(&citation.path, 4096, "citation path")?;
            if citation.path.contains(['\\', ':'])
                || citation.path.chars().any(char::is_control)
                || citation
                    .path
                    .split('/')
                    .any(|s| s.is_empty() || s == "." || s == "..")
                || !is_sha256(&citation.sha256)
                || citation.start_line == 0
                || citation.end_line < citation.start_line
            {
                return Err(Error::Field("citation"));
            }
        }
    }
    validate_links(report)
}
fn severity(value: &ClaimedSeverity) -> &'static str {
    match value {
        ClaimedSeverity::Info => "info",
        ClaimedSeverity::Low => "low",
        ClaimedSeverity::Medium => "medium",
        ClaimedSeverity::High => "high",
        ClaimedSeverity::Critical => "critical",
    }
}
fn provenance(report: &SourceReport) -> Vec<(&'static str, &str)> {
    vec![
        ("Session", &report.session_id),
        ("Operation", &report.operation_id),
        ("Snapshot SHA-256", &report.snapshot_sha256),
        ("Source bundle SHA-256", &report.review.bundle_sha256),
        ("Provider request SHA-256", &report.review.request_sha256),
        (
            "Provider completion SHA-256",
            &report.review.completion_sha256,
        ),
        ("Model", &report.review.model),
        (
            "Provider response ID",
            report
                .review
                .provider_response_id
                .as_deref()
                .unwrap_or("not supplied"),
        ),
        ("Submission call ID", &report.review.submission_call_id),
    ]
}
fn markdown(report: &SourceReport) -> Result<String> {
    let mut out = Lines(String::new());
    out.line("# 0sec Source Hypothesis Report")?;
    out.line("")?;
    out.line("**Verification state: unverified. Security conclusion: not established.**")?;
    out.line("")?;
    out.line(NOTICE)?;
    out.line("")?;
    out.line("## Provenance")?;
    out.line("")?;
    out.line("| Field | Value |")?;
    out.line("|-------|-------|")?;
    for (label, value) in provenance(report) {
        out.line(&format!("| {label} | {} |", escape(value)))?;
    }
    out.line("")?;
    out.line("## Hypotheses")?;
    out.line("")?;
    if report.review.hypotheses.is_empty() {
        out.line("No hypotheses reported. This does not establish target safety or complete test coverage.")?;
    }
    for (index, hypothesis) in report.review.hypotheses.iter().enumerate() {
        out.line(&format!(
            "### {}. {}",
            index + 1,
            escape(&hypothesis.claim.title)
        ))?;
        out.line("")?;
        out.line(&format!("- **Hypothesis ID:** {}", escape(&hypothesis.id)))?;
        out.line("- **State:** unverified")?;
        out.line(&format!(
            "- **Claimed severity:** {}",
            severity(&hypothesis.claim.claimed_severity)
        ))?;
        out.line(&format!(
            "- **Explanation:** {}",
            escape(&hypothesis.claim.explanation)
        ))?;
        out.line("")?;
        out.line("**Citations:**")?;
        for citation in &hypothesis.claim.citations {
            out.line(&format!(
                "- {}:{}–{}; SHA-256: {}",
                escape(&citation.path),
                citation.start_line,
                citation.end_line,
                escape(&citation.sha256)
            ))?;
        }
        out.line("")?;
    }
    out.line("## Retained artifact hashes")?;
    out.line("")?;
    for (name, digest) in &report.artifacts {
        out.line(&format!("- **{}:** {}", escape(name), escape(digest)))?;
    }
    for (heading, fields) in workflow_sections(report)? {
        out.line("")?;
        out.line(&format!("## {}", escape(&heading)))?;
        out.line("")?;
        for (label, value) in fields {
            out.line(&format!("- **{}:** {}", escape(&label), escape(&value)))?;
        }
    }
    Ok(out.0)
}
fn html(report: &SourceReport) -> Result<String> {
    let mut out = Html(String::new());
    out.raw("<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><title>0sec Source Hypothesis Report</title><style>")?;
    out.raw(include_str!("report.css"))?;
    out.raw("</style></head><body><h1>0sec Source Hypothesis Report</h1><p><strong>Verification state: unverified. Security conclusion: not established.</strong></p>")?;
    out.field(
        "<p class=\"notice\">",
        NOTICE,
        "</p><h2>Provenance</h2><dl>",
    )?;
    for (label, value) in provenance(report) {
        out.field("<dt>", label, "</dt>")?;
        out.field("<dd>", value, "</dd>")?;
    }
    out.raw("</dl><h2>Hypotheses</h2>")?;
    if report.review.hypotheses.is_empty() {
        out.raw("<p>No hypotheses reported. This does not establish target safety or complete test coverage.</p>")?;
    }
    for hypothesis in &report.review.hypotheses {
        out.field(
            "<section class=\"finding-card\"><h3>",
            &hypothesis.claim.title,
            "</h3>",
        )?;
        out.field(
            "<p>Hypothesis ID: ",
            &hypothesis.id,
            "</p><p>State: unverified</p>",
        )?;
        out.field(
            "<p>Claimed severity: ",
            severity(&hypothesis.claim.claimed_severity),
            "</p>",
        )?;
        out.field(
            "<p class=\"finding-desc\">",
            &hypothesis.claim.explanation,
            "</p><h4>Citations</h4><ul>",
        )?;
        for citation in &hypothesis.claim.citations {
            out.field("<li>", &citation.path, ":")?;
            out.raw(&format!(
                "{}–{}; SHA-256: ",
                citation.start_line, citation.end_line
            ))?;
            out.text(&citation.sha256)?;
            out.raw("</li>")?;
        }
        out.raw("</ul></section>")?;
    }
    out.raw("<h2>Retained artifact hashes</h2><dl>")?;
    for (name, digest) in &report.artifacts {
        out.field("<dt>", name, "</dt>")?;
        out.field("<dd>", digest, "</dd>")?;
    }
    out.raw("</dl>")?;
    for (heading, fields) in workflow_sections(report)? {
        out.field("<section><h2>", &heading, "</h2><dl>")?;
        for (label, value) in fields {
            out.field("<dt>", &label, "</dt>")?;
            out.field("<dd>", &value, "</dd>")?;
        }
        out.raw("</dl></section>")?;
    }
    out.raw("</body></html>")?;
    Ok(out.0)
}

fn terminal(status: zero_protocol::OperationStatus) -> bool {
    use zero_protocol::OperationStatus::*;
    matches!(status, Succeeded | Failed | Cancelled | Unknown)
}
fn artifact_map(artifacts: &std::collections::BTreeMap<String, String>) -> Result<()> {
    if artifacts.len() > 256 {
        return Err(Error::Limit);
    }
    for (name, digest) in artifacts {
        bounded_text(name, 256, "artifact name")?;
        if !is_sha256(digest) {
            return Err(Error::Field("artifact digest"));
        }
    }
    Ok(())
}
fn children(children: &[String], seen: &mut std::collections::HashSet<String>) -> Result<()> {
    if children.len() > 256 {
        return Err(Error::Limit);
    }
    for child in children {
        bounded_text(child, 512, "child operation")?;
        if !seen.insert(child.clone()) {
            return Err(Error::Field("duplicate operation"));
        }
    }
    Ok(())
}
fn assessment(
    report: &SourceReport,
    a: &zero_protocol::verification::Assessment,
    snapshot: &str,
) -> Result<()> {
    if a.schema_version != 1
        || a.vulnerability_reportable
        || a.source_bundle_digest != report.review.bundle_sha256
        || a.snapshot_digest != snapshot
        || !report
            .review
            .hypotheses
            .iter()
            .any(|h| h.id == a.hypothesis_id)
    {
        return Err(Error::Field("assessment source identity/reportability"));
    }
    bounded_text(&a.oracle_version, 256, "oracle version")?;
    if a.reasons.len() > 32
        || a.required_attempts > 256
        || a.required_attempts == 0
        || a.observed_attempts > 256
    {
        return Err(Error::Limit);
    }
    if [
        &a.plan_digest,
        &a.source_bundle_digest,
        &a.snapshot_digest,
        &a.evidence_digest,
        &a.assessment_digest,
    ]
    .iter()
    .any(|d| !is_sha256(d))
    {
        return Err(Error::Field("assessment digest"));
    }
    Ok(())
}
fn validate_links(report: &SourceReport) -> Result<()> {
    use zero_protocol::{
        OperationStatus, repair::RepairValidationStatus, verification::Disposition,
    };
    let count = report
        .reproductions
        .len()
        .checked_add(report.repairs.len())
        .ok_or(Error::Limit)?;
    if count > 32 {
        return Err(Error::Limit);
    }
    if (report.schema_version == 1 && count != 0) || (report.schema_version == 2 && count == 0) {
        return Err(Error::Field("source report link version"));
    }
    let mut seen = std::collections::HashSet::from([report.operation_id.clone()]);
    // Reserve parent IDs first so no child may alias a later linked parent.
    for (id, status) in report
        .reproductions
        .iter()
        .map(|r| (&r.operation_id, r.operation_status))
        .chain(
            report
                .repairs
                .iter()
                .map(|r| (&r.operation_id, r.operation_status)),
        )
    {
        bounded_text(id, 512, "linked operation")?;
        if !terminal(status) || !seen.insert(id.clone()) {
            return Err(Error::Field("linked operation status/identity"));
        }
    }
    for reproduction in &report.reproductions {
        if reproduction.operation_status == OperationStatus::Succeeded
            && (!matches!(
                reproduction.assessment.disposition,
                Disposition::ObservedForPlan | Disposition::NotObserved
            ) || reproduction.stop_reason.is_some())
        {
            return Err(Error::Field("reproduction success disposition"));
        }
        assessment(report, &reproduction.assessment, &report.snapshot_sha256)?;
        artifact_map(&reproduction.artifacts)?;
        children(&reproduction.children, &mut seen)?;
    }
    for repair in &report.repairs {
        let baseline = report
            .reproductions
            .iter()
            .find(|r| r.operation_id == repair.reproduction_operation_id)
            .ok_or(Error::Field("repair baseline operation"))?;
        if baseline.operation_status != OperationStatus::Succeeded
            || baseline.assessment.disposition != Disposition::ObservedForPlan
            || repair.original_plan_digest != baseline.assessment.plan_digest
            || repair.phases.len() > 2
            || repair.cleanup_recovery_count > 1024
        {
            return Err(Error::Field("repair baseline identity"));
        }
        artifact_map(&repair.artifacts)?;
        if let Some(receipt) = &repair.candidate_receipt {
            if receipt.schema_version != 1
                || receipt.baseline_snapshot_sha256 != report.snapshot_sha256
                || receipt.replacement_bytes > 128 * 1024
                || [
                    &receipt.preimage_sha256,
                    &receipt.replacement_sha256,
                    &receipt.candidate_snapshot_sha256,
                    &receipt.policy_sha256,
                ]
                .iter()
                .any(|d| !is_sha256(d))
            {
                return Err(Error::Field("candidate receipt"));
            }
            bounded_text(&receipt.target, 4096, "candidate target")?;
            let hypothesis = report
                .review
                .hypotheses
                .iter()
                .find(|h| h.id == baseline.assessment.hypothesis_id)
                .ok_or(Error::Field("repair hypothesis"))?;
            if !hypothesis
                .claim
                .citations
                .iter()
                .any(|c| c.path == receipt.target && c.sha256 == receipt.preimage_sha256)
            {
                return Err(Error::Field("candidate preimage citation"));
            }
        } else if !repair.phases.is_empty() {
            return Err(Error::Field("repair receipt absent"));
        }
        for (index, phase) in repair.phases.iter().enumerate() {
            if phase.name != ["candidate", "reconstructed"][index] {
                return Err(Error::Field("repair phase order"));
            }
            let receipt = repair
                .candidate_receipt
                .as_ref()
                .ok_or(Error::Field("repair receipt absent"))?;
            assessment(
                report,
                &phase.assessment,
                &receipt.candidate_snapshot_sha256,
            )?;
            if phase.assessment.hypothesis_id != baseline.assessment.hypothesis_id
                || phase.assessment.oracle_version != baseline.assessment.oracle_version
                || phase.assessment.required_attempts != baseline.assessment.required_attempts
            {
                return Err(Error::Field("repair oracle identity"));
            }
            children(&phase.children, &mut seen)?;
            artifact_map(&phase.artifacts)?;
        }
        if repair.status == RepairValidationStatus::ValidatedCandidateForPlan
            && (repair.operation_status != OperationStatus::Succeeded
                || repair.cleanup_recovery_count != 0
                || repair.phases.len() != 2
                || repair
                    .phases
                    .iter()
                    .any(|p| p.assessment.disposition != Disposition::ObservedForPlan))
        {
            return Err(Error::Field("repair validation incomplete"));
        }
    }
    Ok(())
}
fn wire(value: serde_json::Value) -> Result<String> {
    value.as_str().map(str::to_owned).ok_or(Error::Json)
}
type Fields = Vec<(String, String)>;
fn assessment_fields(a: &zero_protocol::verification::Assessment) -> Result<Fields> {
    let mut fields = vec![
        (
            "Assessment schema version".into(),
            a.schema_version.to_string(),
        ),
        (
            "Disposition".into(),
            wire(serde_json::to_value(a.disposition).map_err(|_| Error::Json)?)?,
        ),
        ("Oracle version".into(), a.oracle_version.clone()),
        ("Plan SHA-256".into(), a.plan_digest.clone()),
        ("Hypothesis ID".into(), a.hypothesis_id.clone()),
        (
            "Source bundle SHA-256".into(),
            a.source_bundle_digest.clone(),
        ),
        ("Snapshot SHA-256".into(), a.snapshot_digest.clone()),
        ("Evidence SHA-256".into(), a.evidence_digest.clone()),
        ("Assessment SHA-256".into(), a.assessment_digest.clone()),
        ("Observed attempts".into(), a.observed_attempts.to_string()),
        ("Required attempts".into(), a.required_attempts.to_string()),
        ("Vulnerability reportable".into(), "false".into()),
    ];
    for reason in &a.reasons {
        fields.push((
            "Reason".into(),
            wire(serde_json::to_value(reason).map_err(|_| Error::Json)?)?,
        ));
    }
    Ok(fields)
}
fn evidence_fields(
    fields: &mut Fields,
    children: &[String],
    artifacts: &std::collections::BTreeMap<String, String>,
) {
    for child in children {
        fields.push(("Child operation".into(), child.clone()));
    }
    for (name, digest) in artifacts {
        fields.push((format!("Artifact {name}"), digest.clone()));
    }
}
fn workflow_sections(report: &SourceReport) -> Result<Vec<(String, Fields)>> {
    let mut sections = Vec::new();
    for reproduction in &report.reproductions {
        let mut fields=vec![("Operation ID".into(),reproduction.operation_id.clone()),("Operation status".into(),wire(serde_json::to_value(reproduction.operation_status).map_err(|_|Error::Json)?)?), ("Scope".into(),"Observed outputs under an explicit frozen plan; no general vulnerability verification.".into())];
        if let Some(stop) = &reproduction.stop_reason {
            fields.push((
                "Stop reason".into(),
                wire(serde_json::to_value(stop).map_err(|_| Error::Json)?)?,
            ));
        }
        fields.extend(assessment_fields(&reproduction.assessment)?);
        evidence_fields(&mut fields, &reproduction.children, &reproduction.artifacts);
        sections.push(("Frozen reproduction".into(), fields));
    }
    for repair in &report.repairs {
        let mut fields=vec![("Operation ID".into(),repair.operation_id.clone()),("Baseline reproduction operation".into(),repair.reproduction_operation_id.clone()),("Operation status".into(),wire(serde_json::to_value(repair.operation_status).map_err(|_|Error::Json)?)?), ("Repair status".into(),wire(serde_json::to_value(&repair.status).map_err(|_|Error::Json)?)?), ("Original plan SHA-256".into(),repair.original_plan_digest.clone()),("Cleanup recovery count".into(),repair.cleanup_recovery_count.to_string()),("Scope".into(),"Candidate validation is limited to the frozen plan. No workspace application or general fixed-security claim.".into())];
        if let Some(receipt) = &repair.candidate_receipt {
            fields.extend([
                (
                    "Candidate receipt schema version".into(),
                    receipt.schema_version.to_string(),
                ),
                (
                    "Baseline snapshot SHA-256".into(),
                    receipt.baseline_snapshot_sha256.clone(),
                ),
                ("Candidate target".into(), receipt.target.clone()),
                ("Preimage SHA-256".into(), receipt.preimage_sha256.clone()),
                (
                    "Replacement SHA-256".into(),
                    receipt.replacement_sha256.clone(),
                ),
                (
                    "Replacement bytes".into(),
                    receipt.replacement_bytes.to_string(),
                ),
                (
                    "Candidate snapshot SHA-256".into(),
                    receipt.candidate_snapshot_sha256.clone(),
                ),
                (
                    "Authority policy SHA-256".into(),
                    receipt.policy_sha256.clone(),
                ),
            ]);
        }
        evidence_fields(&mut fields, &[], &repair.artifacts);
        sections.push(("Plan-qualified repair".into(), fields));
        for phase in &repair.phases {
            let mut fields = vec![("Repair operation ID".into(), repair.operation_id.clone())];
            fields.extend(assessment_fields(&phase.assessment)?);
            evidence_fields(&mut fields, &phase.children, &phase.artifacts);
            sections.push((format!("Repair phase: {}", phase.name), fields));
        }
    }
    Ok(sections)
}
