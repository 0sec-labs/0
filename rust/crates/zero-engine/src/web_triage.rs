//! Explicit operator disposition, independent of security verification or execution.
use super::*;
use zero_protocol::web::{WebFindingRecord, WebTriageDecision, WebTriageStatus};

/// Inspect only one explicitly selected validated web review. This never opens
/// an engine owner, migrates a database, reads original sources or calls providers.
pub fn read_web_findings(
    state: &Path,
    session: &str,
    web_operation: &str,
    offset: u32,
    limit: u32,
) -> Result<Vec<WebFindingRecord>, EngineError> {
    findings(
        &Store::open_read_only(state)?,
        session,
        web_operation,
        offset,
        limit,
    )
}

/// Read the current disposition and a bounded revision page from one SQLite
/// snapshot. The immutable web submission is independently revalidated first.
pub fn read_web_finding(
    state: &Path,
    session: &str,
    web_operation: &str,
    hypothesis: &str,
    after_revision: u64,
    limit: u32,
) -> Result<(WebFindingRecord, Vec<WebTriageDecision>), EngineError> {
    finding(
        &Store::open_read_only(state)?,
        session,
        web_operation,
        hypothesis,
        after_revision,
        limit,
    )
}

fn check_record(
    web: &agent_web::ValidatedWebReview,
    record: &WebFindingRecord,
) -> Result<(), EngineError> {
    let expected = web
        .review
        .hypotheses
        .iter()
        .find(|hypothesis| hypothesis.id == record.hypothesis.id)
        .ok_or_else(|| {
            EngineError::State("hypothesis is absent from validated web review".into())
        })?;
    if serde_json::to_value(expected)? != serde_json::to_value(&record.hypothesis)? {
        return Err(EngineError::State(
            "triage hypothesis differs from validated web review".into(),
        ));
    }
    Ok(())
}

pub(super) fn findings(
    store: &Store,
    session: &str,
    web_operation: &str,
    offset: u32,
    limit: u32,
) -> Result<Vec<WebFindingRecord>, EngineError> {
    let web = agent_web::load(store, session, web_operation)?;
    let findings = store.web_findings(session, web_operation, offset, limit)?;
    let expected: Vec<_> = web
        .review
        .hypotheses
        .iter()
        .skip(offset as usize)
        .take(findings.len())
        .collect();
    if expected.len() != findings.len() {
        return Err(EngineError::State(
            "triage web hypothesis page mismatch".into(),
        ));
    }
    for (finding, expected) in findings.iter().zip(expected) {
        if finding.hypothesis.id != expected.id {
            return Err(EngineError::State(
                "triage web hypothesis page order mismatch".into(),
            ));
        }
        check_record(&web, finding)?;
    }
    Ok(findings)
}

pub(super) fn finding(
    store: &Store,
    session: &str,
    web_operation: &str,
    hypothesis: &str,
    after_revision: u64,
    limit: u32,
) -> Result<(WebFindingRecord, Vec<WebTriageDecision>), EngineError> {
    let web = agent_web::load(store, session, web_operation)?;
    let (finding, history) = store.web_finding_with_history(
        session,
        web_operation,
        hypothesis,
        after_revision,
        limit,
    )?;
    check_record(&web, &finding)?;
    Ok((finding, history))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn decide(
    store: &mut Store,
    session: &str,
    command: &str,
    web_operation: &str,
    hypothesis: &str,
    status: WebTriageStatus,
    expected_revision: u64,
    note: &str,
) -> Result<Reply, EngineError> {
    let web = agent_web::load(store, session, web_operation)?;
    if !web.review.hypotheses.iter().any(|h| h.id == hypothesis) {
        return Err(EngineError::State(
            "hypothesis is absent from validated web review".into(),
        ));
    }
    // The store rechecks the exact review digest and target inside its atomic
    // decision/event transaction, applies CAS, and resolves exact retries first.
    let (finding, decision, duplicate) = store.triage_web_finding(
        session,
        command,
        web_operation,
        hypothesis,
        status,
        expected_revision,
        note,
    )?;
    Ok(Reply::WebFindingTriaged {
        finding,
        decision,
        duplicate,
    })
}
