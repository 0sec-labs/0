//! Bounded source discovery. Valid submissions are unverified hypotheses only.
mod bundle;
mod submission;
pub use bundle::{PreparedReview, ReviewRequest, SourceBundle, SourceFile, prepare};
use serde::Serialize;
use sha2::{Digest, Sha256};
pub use submission::{
    Citation, Claim, ClaimedSeverity, Hypothesis, PreparedSubmission, ReviewResult,
    VerificationState,
};
pub const MAX_ARTIFACT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SOURCE_BYTES: usize = 512 * 1024;
pub const MAX_FILE_BYTES: usize = 128 * 1024;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid source review: {0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn encoded<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err(invalid("artifact exceeds 4 MiB"));
    }
    Ok(bytes)
}
fn identity<T: Serialize>(value: &T) -> Result<String> {
    Ok(hash(&encoded(value)?))
}
fn path_valid(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\\', '\0', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|c| !c.is_empty() && c != "." && c != "..")
}
