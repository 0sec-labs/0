//! Bounded retained review references, not validation or execution authority.
use super::*;
use zero_protocol::discovery::SourceReviewPage;

/// Discover retained `source.review` attachments without acquiring engine
/// ownership or reading source/evidence bytes. Selecting a candidate still
/// requires the existing full source-provenance checks.
pub fn read_source_reviews(
    state: &Path,
    session: &str,
    before_sequence: Option<u64>,
    limit: u32,
) -> Result<SourceReviewPage, EngineError> {
    Ok(Store::open_read_only(state)?.source_reviews(session, before_sequence, limit)?)
}

/// Discover partial web roots without acquiring ownership or reading evidence.
pub fn read_web_runs(
    state: &Path,
    session: &str,
    before: Option<u64>,
    limit: u32,
) -> Result<zero_protocol::web::WebRunsPage, EngineError> {
    Ok(Store::open_read_only(state)?.web_runs(session, before, limit)?)
}
