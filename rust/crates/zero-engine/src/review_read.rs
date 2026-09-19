//! Read-only review composition over one bounded, pinned retained session.
use super::*;
use zero_protocol::{
    agent::AgentStatus,
    review::{ReviewReport, ReviewSnapshot},
    source::SecurityConclusion,
};

pub fn read_review_status(state: &Path, id: &str) -> Result<ReviewSnapshot, EngineError> {
    Ok(Store::open_read_only(state)?.review_snapshot(id)?)
}

pub fn read_review_report(state: &Path, id: &str) -> Result<ReviewReport, EngineError> {
    let frozen = Store::open_read_only(state)?.review_read_snapshot(id)?;
    compose(&frozen, id)
}

/// The caller supplies a private query-only review snapshot.
pub(super) fn compose(store: &Store, id: &str) -> Result<ReviewReport, EngineError> {
    let review = store.review_snapshot(id)?;
    let submitted = review.root_status == OperationStatus::Succeeded
        && review.agent_result.as_ref().is_some_and(|result| {
            result.status == AgentStatus::Completed && result.source_review.is_some()
        });
    let source = if submitted {
        Some(source_report::compose_from_store(
            store,
            &review.review.session_id,
            &review.review.root_operation_id,
            &[],
            &[],
        )?)
    } else {
        None
    };
    Ok(ReviewReport {
        schema_version: 1,
        review,
        source,
        security_conclusion: SecurityConclusion::NotEstablished,
    })
}
