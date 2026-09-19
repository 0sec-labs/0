//! Read-only export shares the same provenance gate as reproduction.
use super::*;
use zero_protocol::source::SourceReport;

/// Inspect a completed review without taking engine ownership or reading source files.
pub fn read_source_report(
    state: &Path,
    session: &str,
    operation: &str,
) -> Result<SourceReport, EngineError> {
    read_source_workflow_report(state, session, operation, &[], &[])
}

/// Export explicitly selected, linked observation and repair operations.
/// A repair's baseline must also be explicitly selected; no journal-wide search
/// or implicit "latest" result can change the meaning of an export.
pub fn read_source_workflow_report(
    state: &Path,
    session: &str,
    operation: &str,
    reproduction_ids: &[String],
    repair_ids: &[String],
) -> Result<SourceReport, EngineError> {
    let store = Store::open_read_only(state)?;
    compose_from_store(&store, session, operation, reproduction_ids, repair_ids)
}

/// Compose against the caller's pinned view; never reopen the live database.
pub(super) fn compose_from_store(
    store: &Store,
    session: &str,
    operation: &str,
    reproduction_ids: &[String],
    repair_ids: &[String],
) -> Result<SourceReport, EngineError> {
    if reproduction_ids.len().saturating_add(repair_ids.len()) > 32 {
        return Err(EngineError::State(
            "source report permits at most 32 workflow links".into(),
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for id in reproduction_ids.iter().chain(repair_ids) {
        if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) || !seen.insert(id) {
            return Err(EngineError::State(
                "source report operation links must be bounded and unique".into(),
            ));
        }
    }
    let validated = source_provenance::load(store, session, operation)?;
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
    let reproductions = reproduction_ids
        .iter()
        .map(|id| workflow_provenance::reproduction(store, session, operation, id))
        .collect::<Result<Vec<_>, _>>()?;
    let mut repairs = Vec::new();
    for id in repair_ids {
        let repair = store.get_operation(id)?;
        let baseline_id = repair.payload["reproduction_operation_id"]
            .as_str()
            .ok_or_else(|| EngineError::State("repair baseline link is absent".into()))?;
        let baseline = reproductions
            .iter()
            .find(|r| r.operation_id == baseline_id)
            .ok_or_else(|| {
                EngineError::State(
                    "repair requires its baseline in the explicit reproduction selection".into(),
                )
            })?;
        repairs.push(workflow_provenance::repair(
            store, session, operation, id, baseline,
        )?);
    }
    Ok(SourceReport {
        schema_version: if reproductions.is_empty() && repairs.is_empty() {
            1
        } else {
            2
        },
        report_kind: zero_protocol::source::SourceReportKind::SourceHypotheses,
        verification_state: zero_protocol::source::VerificationState::Unverified,
        security_conclusion: zero_protocol::source::SecurityConclusion::NotEstablished,
        session_id: session.into(),
        operation_id: operation.into(),
        snapshot_sha256: validated.snapshot.digest,
        review: validated.review,
        artifacts,
        reproductions,
        repairs,
    })
}
