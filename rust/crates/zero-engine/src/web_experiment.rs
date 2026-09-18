//! Owned inline experiment matrix. Model predictions never become security truth.
use super::*;
use serde_json::{Value, json};
use zero_protocol::{Operation, web::*};
use zero_web_verification::FrozenExperiment;
mod execution;
mod provenance;
pub(crate) use execution::execute_admitted;
pub(crate) use provenance::{effect_origin, load};
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn status(assessment: &WebVerificationAssessment) -> OperationStatus {
    use zero_protocol::verification::Disposition;
    match assessment.disposition {
        Disposition::ObservedForPlan | Disposition::NotObserved => OperationStatus::Succeeded,
        Disposition::Inconclusive => OperationStatus::Failed,
        Disposition::Cancelled => OperationStatus::Cancelled,
        Disposition::Unknown => OperationStatus::Unknown,
    }
}
