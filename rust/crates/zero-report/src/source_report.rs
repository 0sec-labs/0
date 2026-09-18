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
    }
}
fn bounded_text(value: &str, limit: usize, field: &'static str) -> Result<()> {
    if value.is_empty() || value.len() > limit {
        return Err(Error::Field(field));
    }
    Ok(())
}
fn validate(report: &SourceReport) -> Result<()> {
    if report.schema_version != 1 || report.review.version != 1 {
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
    Ok(())
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
    out.raw("</dl></body></html>")?;
    Ok(out.0)
}
