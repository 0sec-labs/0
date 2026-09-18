//! Read retained model conjectures separately from independently measured feedback.
use crate::{EngineError, agent_web, agent_web_experiment, web_experiment};
use std::{collections::BTreeSet, path::Path};
use zero_protocol::{OperationStatus, web::WebWorkflowReport, web_experiment::*};
use zero_store::Store;
fn invalid(message: &str) -> EngineError {
    EngineError::State(message.into())
}
pub(crate) fn experiments(
    store: &Store,
    session: &str,
    root: &str,
    after: u64,
    limit: u32,
) -> Result<WebExperimentsPage, EngineError> {
    if !(1..=32).contains(&limit) {
        return Err(invalid("Experiment page limit must be 1..32"));
    }
    agent_web::load_run(store, session, root)?;
    let candidates = store.experiment_operation_candidates(session, Some(after), limit)?;
    let mut page = WebExperimentsPage {
        experiments: vec![],
        next_after_sequence: candidates.next_after_sequence,
    };
    for candidate in candidates.experiments {
        if agent_web::owns_actor(store, root, &candidate.actor_operation_id)? {
            page.experiments.push(candidate);
        }
    }
    Ok(page)
}
pub(crate) fn experiment(
    store: &Store,
    session: &str,
    root: &str,
    id: &str,
) -> Result<WebExperimentReport, EngineError> {
    agent_web::load_run(store, session, root)?;
    let operation = store.get_operation(id)?;
    if operation.session_id != session {
        return Err(invalid(
            "Experiment is outside the selected web operation lineage",
        ));
    }
    let (frozen, actor, inference) = agent_web_experiment::origin(store, &operation)?;
    if !agent_web::owns_actor(store, root, &actor.id)? {
        return Err(invalid("Experiment actor is outside selected web lineage"));
    }
    let outcome = if matches!(
        operation.status,
        OperationStatus::Running | OperationStatus::Admitted
    ) {
        None
    } else {
        Some(web_experiment::load(store, &operation)?)
    };
    let report = WebExperimentReport {
        schema_version: 1,
        session_id: session.into(),
        web_operation_id: root.into(),
        operation_id: id.into(),
        operation_status: operation.status,
        actor_operation_id: actor.id,
        inference_operation_id: inference.id,
        call_id: operation.payload["call_id"]
            .as_str()
            .ok_or_else(|| invalid("Experiment call identity missing"))?
            .into(),
        policy: frozen.policy().clone(),
        proposal: frozen.proposal().clone(),
        hypothesis: frozen.hypothesis().clone(),
        intent_sha256: frozen.intent_sha256().into(),
        matrix_sha256: frozen.matrix_sha256().into(),
        outcome,
        artifacts: store.operation_artifacts(id)?,
    };
    if serde_json::to_vec(&report)?.len() > 8 * 1024 * 1024 {
        return Err(invalid("Experiment report exceeds 8 MiB"));
    }
    Ok(report)
}
pub(crate) fn workflow_report(
    store: &Store,
    session: &str,
    root: &str,
    verification_ids: &[String],
    experiment_ids: &[String],
) -> Result<WebWorkflowReport, EngineError> {
    if verification_ids.len().saturating_add(experiment_ids.len()) > 32 {
        return Err(invalid(
            "Web report permits at most 32 explicit experiment and verification links",
        ));
    }
    let mut seen = BTreeSet::new();
    for id in verification_ids.iter().chain(experiment_ids) {
        if id.is_empty() || id.len() > 4096 || !seen.insert(id) {
            return Err(invalid("Web report links must be bounded and unique"));
        }
    }
    let mut report = crate::web_read::workflow_report(store, session, root, verification_ids)?;
    // Enforce the export budget incrementally rather than accumulate 32 maximum
    // detail records before checking the final serialized output.
    let mut bytes = serde_json::to_vec(&report)?.len();
    for id in experiment_ids {
        let detail = experiment(store, session, root, id)?;
        bytes = bytes
            .saturating_add(serde_json::to_vec(&detail)?.len())
            .saturating_add(32);
        if bytes > 16 * 1024 * 1024 {
            return Err(invalid("Web workflow report exceeds 16 MiB"));
        }
        report.experiments.push(detail);
    }
    if serde_json::to_vec(&report)?.len() > 16 * 1024 * 1024 {
        return Err(invalid("Web workflow report exceeds 16 MiB"));
    }
    Ok(report)
}
pub fn read_web_experiments(
    path: &Path,
    session: &str,
    root: &str,
    after: u64,
    limit: u32,
) -> Result<WebExperimentsPage, EngineError> {
    experiments(&Store::open_read_only(path)?, session, root, after, limit)
}
pub fn read_web_experiment(
    path: &Path,
    session: &str,
    root: &str,
    id: &str,
) -> Result<WebExperimentReport, EngineError> {
    experiment(&Store::open_read_only(path)?, session, root, id)
}
pub fn read_web_workflow_report_with_experiments(
    path: &Path,
    session: &str,
    root: &str,
    verification_ids: &[String],
    experiment_ids: &[String],
) -> Result<WebWorkflowReport, EngineError> {
    workflow_report(
        &Store::open_read_only(path)?,
        session,
        root,
        verification_ids,
        experiment_ids,
    )
}
