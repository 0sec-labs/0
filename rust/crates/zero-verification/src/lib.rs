//! Frozen host-owned exact-output observations. No execution or vulnerability verdict.
mod binary;
mod plan;
mod score;
mod types;
pub use plan::FrozenPlan;
pub use score::assess;
use sha2::{Digest, Sha256};
pub use types::*;
pub const ORACLE_VERSION: &str = "zero-verification-exact-output-v1";
pub const MAX_PLAN_BYTES: usize = 1024 * 1024;
pub const MAX_EVIDENCE_BYTES: usize = 32 * 1024 * 1024;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid verification contract: {0}")]
    Invalid(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn hash<T: serde::Serialize + ?Sized>(value: &T, cap: usize) -> Result<String> {
    struct Sink {
        hash: Sha256,
        remaining: usize,
    }
    impl std::io::Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.remaining {
                return Err(std::io::Error::other("serialized evidence byte bound"));
            }
            self.hash.update(bytes);
            self.remaining -= bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut sink = Sink {
        hash: Sha256::new(),
        remaining: cap,
    };
    serde_json::to_writer(&mut sink, value)?;
    Ok(format!("sha256:{:x}", sink.hash.finalize()))
}
