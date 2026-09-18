//! Language-neutral, inert plugin admission. No process, network or loader APIs.
mod manifest;
mod registry;
mod rpc;
mod schema;
pub use manifest::*;
pub use registry::*;
pub use rpc::*;
pub use schema::Schema;
use sha2::{Digest, Sha256};
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid or unsupported plugin data: {0}")]
    Invalid(&'static str),
    #[error("plugin data exceeds configured bounds")]
    Limit,
    #[error("artifact or dependency identity mismatch")]
    Identity,
    #[error("missing plugin dependency")]
    MissingDependency,
    #[error("plugin dependency cycle")]
    Cycle,
    #[error("plugin identity is already registered")]
    Conflict,
    #[error("host grants do not authorize this plugin invocation")]
    Denied,
    #[error("newline RPC decoder is poisoned or truncated")]
    Framing,
}
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn identifier(value: &str, max: usize, separators: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || separators.contains(&c))
        && !["constructor", "prototype", "__proto__"].contains(&value)
}
