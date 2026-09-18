//! Read existing balances without acquiring execution ownership or recovering work.
use crate::EngineError;
use std::path::Path;
use zero_protocol::BudgetSnapshot;
use zero_store::Store;
pub fn read_session_budget(path: &Path, session: &str) -> Result<BudgetSnapshot, EngineError> {
    Ok(Store::open_read_only(path)?.budget(session)?)
}
