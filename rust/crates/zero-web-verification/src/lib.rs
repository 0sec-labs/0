//! Pure host-frozen HTTP observation plans. No network, credentials or model verdicts.
mod experiment;
mod experiment_tool;
pub use experiment_tool::experiment_tool_definition;
mod matrix;
pub use experiment::FrozenExperiment;
mod plan;
pub use matrix::ObservationMatrix;
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
