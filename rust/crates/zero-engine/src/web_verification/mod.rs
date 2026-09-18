//! Explicit host-frozen web observation plans. Never an automatic model tool.
use super::*;
use serde_json::{Value, json};
use zero_protocol::{Operation, agent::validate_actor_payload, web::*};
use zero_web_verification::FrozenPlan;
mod execution;
mod provenance;
pub use provenance::read_web_verification;
pub(crate) use provenance::{effect_origin, report};
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn prepare(
    store: &Store,
    session: &str,
    plan: WebVerificationPlan,
) -> Result<FrozenPlan, EngineError> {
    let source = agent_web::load(store, session, &plan.web_operation_id)?;
    if source.artifacts.get("web.review") != Some(&plan.web_review_sha256)
        || !source
            .review
            .hypotheses
            .iter()
            .any(|h| h.id == plan.hypothesis_id)
    {
        return Err(error("web plan review/hypothesis identity differs"));
    }
    let request = validate_actor_payload(&source.operation.payload).map_err(error)?;
    FrozenPlan::new(
        session,
        plan,
        source.http_context,
        request.tool_approval_policy,
    )
    .map_err(error)
}
pub fn prepare_web_verification(
    path: &Path,
    session: &str,
    plan: WebVerificationPlan,
) -> Result<WebVerificationPreparation, EngineError> {
    let store = Store::open_read_only(path)?;
    preparation(prepare(&store, session, plan)?)
}
fn preparation(frozen: FrozenPlan) -> Result<WebVerificationPreparation, EngineError> {
    Ok(WebVerificationPreparation {
        intent_sha256: frozen.intent_sha256().into(),
        approval_required: frozen.approval_required(),
        intent: frozen.intent().clone(),
    })
}
impl Engine {
    pub(super) fn prepare_web_verification(
        &self,
        session: String,
        plan: WebVerificationPlan,
    ) -> Result<Reply, EngineError> {
        let store = lock(&self.shared.store)?;
        Ok(Reply::WebVerificationPrepared {
            preparation: preparation(prepare(&store, &session, plan)?)?,
        })
    }
}
