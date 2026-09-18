//! Read-only export shares the same provenance gate as reproduction.
use super::*;
use zero_protocol::source::SourceReport;

/// Inspect a completed review without taking engine ownership or reading source files.
pub fn read_source_report(
    state: &Path,
    session: &str,
    operation: &str,
) -> Result<SourceReport, EngineError> {
    let store = Store::open_read_only(state)?;
    let validated = source_provenance::load(&store, session, operation)?;
    let attachments = store.operation_artifacts(operation)?;
    // Only submission provenance belongs in this export. The agent may also
    // retain unrelated execution or continuation artifacts.
    let artifacts = attachments
        .into_iter()
        .filter(|(name, _)| {
            matches!(
                name.as_str(),
                "source.bundle" | "source.request" | "source.completion" | "source.review"
            )
        })
        .collect();
    Ok(SourceReport {
        schema_version: 1,
        report_kind: zero_protocol::source::SourceReportKind::SourceHypotheses,
        verification_state: zero_protocol::source::VerificationState::Unverified,
        security_conclusion: zero_protocol::source::SecurityConclusion::NotEstablished,
        session_id: session.into(),
        operation_id: operation.into(),
        snapshot_sha256: validated.snapshot.digest,
        review: validated.review,
        artifacts,
    })
}
