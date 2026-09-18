//! Controller-owned offline fixture evaluation. No production activation authority.
mod driver;
mod ledger;
mod score;
mod types;
pub use driver::Evaluation;
pub use types::*;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("evaluation: {0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Evolution(#[from] zero_evolution::Error),
    #[error(transparent)]
    Harness(#[from] zero_harness::Error),
    #[error(transparent)]
    Plugin(#[from] zero_plugin::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("sha256:{:x}", Sha256::digest(bytes))
}
