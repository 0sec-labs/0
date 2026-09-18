//! Pure host-frozen HTTP observation plans. No network, credentials or model verdicts.
mod plan;
mod score;
pub use plan::{FrozenPlan, ORACLE_VERSION, hash};
pub use score::assess;
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Error(pub String);
pub type Result<T> = std::result::Result<T, Error>;
fn invalid(s: impl std::fmt::Display) -> Error {
    Error(s.to_string())
}
