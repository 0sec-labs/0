use std::path::PathBuf;
pub use zero_protocol::microvm::*;

/// Trusted host configuration, never inferred from guest output.
#[derive(Debug, Clone)]
pub struct SmolvmConfig {
    pub binary: PathBuf,
    pub setpriv: PathBuf,
}
impl Default for SmolvmConfig {
    fn default() -> Self {
        Self {
            binary: "smolvm".into(),
            setpriv: "setpriv".into(),
        }
    }
}
