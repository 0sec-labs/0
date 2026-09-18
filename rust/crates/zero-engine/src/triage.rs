//! Explicit operator disposition, independent of security verification or execution.
use super::*;
use zero_protocol::triage::{SourceFindingRecord, SourceFindingStatus, TriageDecision};

/// Inspect only one explicitly selected validated source review. This never opens
/// an engine owner, migrates a database, reads original sources or calls providers.
pub fn read_source_findings(
    state: &Path,
    session: &str,
    source_operation: &str,
    offset: u32,
    limit: u32,
) -> Result<Vec<SourceFindingRecord>, EngineError> {
    findings(
        &Store::open_read_only(state)?,
        session,
        source_operation,
        offset,
        limit,
    )
}

/// Read the current disposition and a bounded revision page from one SQLite
/// snapshot. The immutable source submission is independently revalidated first.
pub fn read_source_finding(
    state: &Path,
    session: &str,
    source_operation: &str,
    hypothesis: &str,
    after_revision: u64,
    limit: u32,
) -> Result<(SourceFindingRecord, Vec<TriageDecision>), EngineError> {
    finding(
        &Store::open_read_only(state)?,
        session,
        source_operation,
        hypothesis,
        after_revision,
        limit,
    )
}

fn check_record(
    source: &source_provenance::Validated,
    record: &SourceFindingRecord,
) -> Result<(), EngineError> {
    let expected = source
        .review
        .hypotheses
        .iter()
        .find(|hypothesis| hypothesis.id == record.hypothesis.id)
        .ok_or_else(|| {
            EngineError::State("hypothesis is absent from validated source review".into())
        })?;
    if serde_json::to_value(expected)? != serde_json::to_value(&record.hypothesis)? {
        return Err(EngineError::State(
            "triage hypothesis differs from validated source review".into(),
        ));
    }
    Ok(())
}

pub(super) fn findings(
    store: &Store,
    session: &str,
    source_operation: &str,
    offset: u32,
    limit: u32,
) -> Result<Vec<SourceFindingRecord>, EngineError> {
    let source = source_provenance::load(store, session, source_operation)?;
    let findings = store.source_findings(session, source_operation, offset, limit)?;
    let expected: Vec<_> = source
        .review
        .hypotheses
        .iter()
        .skip(offset as usize)
        .take(findings.len())
        .collect();
    if expected.len() != findings.len() {
        return Err(EngineError::State(
            "triage source hypothesis page mismatch".into(),
        ));
    }
    for (finding, expected) in findings.iter().zip(expected) {
        if finding.hypothesis.id != expected.id {
            return Err(EngineError::State(
                "triage source hypothesis page order mismatch".into(),
            ));
        }
        check_record(&source, finding)?;
    }
    Ok(findings)
}

pub(super) fn finding(
    store: &Store,
    session: &str,
    source_operation: &str,
    hypothesis: &str,
    after_revision: u64,
    limit: u32,
) -> Result<(SourceFindingRecord, Vec<TriageDecision>), EngineError> {
    let source = source_provenance::load(store, session, source_operation)?;
    let (finding, history) = store.source_finding_with_history(
        session,
        source_operation,
        hypothesis,
        after_revision,
        limit,
    )?;
    check_record(&source, &finding)?;
    Ok((finding, history))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn decide(
    store: &mut Store,
    session: &str,
    command: &str,
    source_operation: &str,
    hypothesis: &str,
    status: SourceFindingStatus,
    expected_revision: u64,
    note: &str,
) -> Result<Reply, EngineError> {
    let source = source_provenance::load(store, session, source_operation)?;
    if !source.review.hypotheses.iter().any(|h| h.id == hypothesis) {
        return Err(EngineError::State(
            "hypothesis is absent from validated source review".into(),
        ));
    }
    // The store rechecks the exact review digest and target inside its atomic
    // decision/event transaction, applies CAS, and resolves exact retries first.
    let (finding, decision, duplicate) = store.triage_source_finding(
        session,
        command,
        source_operation,
        hypothesis,
        status,
        expected_revision,
        note,
    )?;
    Ok(Reply::SourceFindingTriaged {
        finding,
        decision,
        duplicate,
    })
}
