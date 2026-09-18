//! Explicit native advisory sessions. Registry capture never expands host tool authority.
use super::*;
use serde_json::Value;
use zero_protocol::{
    agent::AgentRequest,
    session::{Operation, Session},
    strategy_registry::{StrategySessionCapture, render_strategy_request},
};
fn error(v: impl std::fmt::Display) -> EngineError {
    EngineError::State(v.to_string())
}
fn request(
    c: &StrategySessionCapture,
    prompt: &str,
    continuation: Option<String>,
) -> Result<AgentRequest, EngineError> {
    render_strategy_request(
        &c.authority.host,
        &c.advisory,
        prompt,
        &c.authority.http_profile_name,
        continuation,
    )
    .map_err(error)
}
impl Engine {
    pub fn configure_strategy(&self, harness: zero_harness::Harness) -> Result<(), EngineError> {
        harness.strategy_capture().map_err(error)?;
        let control = lock(&self.shared.control)?;
        if control.closing || !control.active.is_empty() || !control.strategy_campaigns.is_empty() {
            return Err(error("strategy configuration requires idle engine"));
        }
        let mut slot = lock(&self.shared.strategy_runtime)?;
        if slot.is_some() {
            return Err(error("strategy runtime already configured"));
        }
        *slot = Some(harness);
        Ok(())
    }
    pub fn create_strategy_session(&self, budget_limit: u64) -> Result<Session, EngineError> {
        let control = lock(&self.shared.control)?;
        if control.closing {
            return Err(error("engine shutting down"));
        }
        let profiles = lock(&self.shared.strategy_runtime)?;
        let capture = profiles
            .as_ref()
            .ok_or_else(|| error("strategy runtime not configured"))?
            .strategy_capture()
            .map_err(error)?;
        Ok(lock(&self.shared.store)?.create_strategy_session(&capture, budget_limit)?)
    }
    pub(crate) async fn run_strategy_agent(
        &self,
        session_id: String,
        command_id: String,
        prompt: String,
        continuation_of: Option<String>,
        events: mpsc::Sender<ExecutionEvent>,
        progress: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<Reply, EngineError> {
        let capture = lock(&self.shared.store)?
            .strategy_session(&session_id)?
            .ok_or_else(|| error("session has no strategy capture"))?;
        let request = request(&capture, &prompt, continuation_of)?;
        agent::run_agent_shared(
            &self.shared,
            session_id,
            command_id,
            request,
            events,
            progress,
            None,
        )
        .await
    }
}
/// Runs under the caller's admission mutex; no registry refresh occurs for historical retries.
pub(super) fn admission(
    shared: &Shared,
    session: &str,
    command: &str,
    actual: &AgentRequest,
) -> Result<Option<(Value, Option<Operation>)>, EngineError> {
    let (capture, context, prior) = {
        let store = lock(&shared.store)?;
        let Some(capture) = store.strategy_session(session)? else {
            return Ok(None);
        };
        let prior = match store.get_operation_by_command(session, command) {
            Ok(op) => Some(op),
            Err(zero_store::Error::NotFound(_)) => None,
            Err(e) => return Err(e.into()),
        };
        (
            capture,
            store
                .strategy_session_context(session)?
                .ok_or_else(|| error("capture absent"))?,
            prior,
        )
    };
    let expected = request(&capture, &actual.prompt, actual.continuation_of.clone())?;
    if serde_json::to_value(actual)? != serde_json::to_value(expected)? {
        return Err(error("request differs from captured strategy authority"));
    }
    if let Some(prior) = &prior {
        if prior.payload["request"] != serde_json::to_value(actual)?
            || prior.payload.get("strategy_context") != Some(&context)
            || prior.payload.get("parent_operation").is_some()
        {
            return Err(error("strategy command retry differs"));
        }
    } else {
        let configured = lock(&shared.strategy_runtime)?;
        let current = configured
            .as_ref()
            .ok_or_else(|| error("strategy runtime not configured"))?
            .strategy_capture()
            .map_err(error)?;
        if serde_json::to_value(&current)? != serde_json::to_value(&capture)? {
            return Err(error(
                "strategy session capture is stale; create a new strategy session",
            ));
        }
    }
    Ok(Some((context, prior)))
}
pub fn read_strategy_session(
    path: &Path,
    session: &str,
) -> Result<StrategySessionCapture, EngineError> {
    Store::open_read_only(path)?
        .strategy_session(session)?
        .ok_or_else(|| error("session has no strategy capture"))
}
