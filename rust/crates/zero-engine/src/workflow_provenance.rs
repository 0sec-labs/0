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

/// Native provenance retains distinct logical and reconstructed execution plans.
/// The caller supplies a pinned Store view containing both complete sessions.
pub(super) fn native_reproduction(store: &Store, key: &str) -> Result<Reply, EngineError> {
    let admitted = store.native_reproduction(key)?;
    let op = admitted.operation;
    let outcome: Option<ReproductionOutcome> =
        op.outcome.clone().map(serde_json::from_value).transpose()?;
    if let Some(outcome) = &outcome {
        if outcome.assessment.is_some() || op.status == OperationStatus::Succeeded {
            terminal(
                &op,
                &admitted.record.session_id,
                "native_source_reproduction",
            )?;
            let authorization = store.native_reproduction_authorization(key)?;
            let (plan, binding) = store
                .native_reproduction_bound_source(key)?
                .ok_or_else(|| error("native reproduction source binding unavailable"))?;
            let frozen = FrozenPlan::new(plan).map_err(error)?;
            review_reproduction::validate_binding(store, &authorization, &frozen, &binding)?;
            let validated = matrix::validate_native(store, &op.session_id, &op.id, outcome)?;
            if !same(validated.frozen.plan(), frozen.plan())? || validated.status != op.status {
                return Err(error("native reproduction plan or terminal status differs"));
            }
        }
    } else if op.status == OperationStatus::Succeeded {
        return Err(error(
            "successful native reproduction has no retained outcome",
        ));
    }
    Ok(Reply::SourceReproduction {
        operation: op,
        result: outcome,
        duplicate: true,
    })
}
