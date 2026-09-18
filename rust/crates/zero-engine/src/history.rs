//! Display-only reads: no provider lookup, epoch recovery or replay.
use super::*;
use zero_protocol::history::SessionCursor;
impl Engine {
    pub(super) fn session_list_page(
        &self,
        after: Option<SessionCursor>,
        limit: u32,
    ) -> Result<Reply, EngineError> {
        Ok(Reply::SessionListPage {
            page: lock(&self.shared.store)?.session_list_page(after.as_ref(), limit)?,
        })
    }
    pub(super) fn session_history(
        &self,
        session: &str,
        before: Option<u64>,
        limit: u32,
    ) -> Result<Reply, EngineError> {
        Ok(Reply::SessionHistory {
            page: lock(&self.shared.store)?.session_history(session, before, limit)?,
        })
    }
}
