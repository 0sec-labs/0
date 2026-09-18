//! Read-only journal validation; exact observations never establish reportability.
mod matrix;
mod repair;
use super::*;
pub(super) use repair::repair;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use zero_protocol::{
    source::ReproductionReport,
    verification::{Disposition, ReproductionOutcome, SourceReproductionRequest},
};
use zero_verification::FrozenPlan;
fn error(value: impl std::fmt::Display) -> EngineError {
    EngineError::State(value.to_string())
}
fn same(a: &impl serde::Serialize, b: &impl serde::Serialize) -> Result<bool, EngineError> {
    Ok(serde_json::to_value(a)? == serde_json::to_value(b)?)
}
fn artifact<T: DeserializeOwned + serde::Serialize>(
    store: &Store,
    digest: &str,
) -> Result<T, EngineError> {
    let bytes = store.artifact(digest)?;
    let value: T = serde_json::from_slice(&bytes)?;
    if serde_json::to_vec(&value)? != bytes {
        return Err(error("workflow artifact encoding identity mismatch"));
    }
    Ok(value)
}
fn terminal(op: &zero_protocol::Operation, session: &str, kind: &str) -> Result<(), EngineError> {
    if op.session_id != session
        || op.payload["kind"] != kind
        || matches!(
            op.status,
            OperationStatus::Admitted | OperationStatus::Running
        )
    {
        return Err(error(
            "workflow requires a terminal operation in this session",
        ));
    }
    Ok(())
}
pub(super) fn reproduction(
    store: &Store,
    session: &str,
    source_id: &str,
    id: &str,
) -> Result<ReproductionReport, EngineError> {
    let (report, _) = reproduction_plan(store, session, source_id, id)?;
    Ok(report)
}
pub(super) fn reproduction_plan(
    store: &Store,
    session: &str,
    source_id: &str,
    id: &str,
) -> Result<(ReproductionReport, FrozenPlan), EngineError> {
    let op = store.get_operation(id)?;
    terminal(&op, session, "host_source_reproduction")?;
    let request: SourceReproductionRequest = serde_json::from_value(op.payload["request"].clone())?;
    if request.source_operation_id != source_id {
        return Err(error("reproduction source operation mismatch"));
    }
    let outcome: ReproductionOutcome = serde_json::from_value(
        op.outcome
            .clone()
            .ok_or_else(|| error("reproduction outcome absent"))?,
    )?;
    let source = source_provenance::load(store, session, source_id)?;
    let frozen = FrozenPlan::new(request.plan).map_err(error)?;
    if op.payload["plan_digest"] != frozen.digest()
        || source.bundle.digest() != frozen.plan().source_bundle_digest
        || !same(&source.snapshot, &frozen.plan().snapshot)?
        || !source
            .review
            .hypotheses
            .iter()
            .any(|h| h.id == frozen.plan().hypothesis_id)
    {
        return Err(error("reproduction source/plan provenance mismatch"));
    }
    let validated = matrix::validate(store, session, id, "reproduction", &outcome)?;
    if !same(validated.frozen.plan(), frozen.plan())? || validated.status != op.status {
        return Err(error("reproduction plan or terminal status mismatch"));
    }
    Ok((
        ReproductionReport {
            operation_id: id.into(),
            operation_status: op.status,
            assessment: validated.assessment,
            stop_reason: outcome.stop_reason,
            children: outcome.children,
            artifacts: outcome.artifacts,
        },
        frozen,
    ))
}
