//! Durable user input is separate from paid-effect admission. Only an explicit
//! dispatch starts work; recovery never turns pending input into a provider call.
use super::*;
use zero_protocol::queue::QueuedAgentStatus;

impl Engine {
    pub(super) async fn run_queued_agent(
        &self,
        session_id: String,
        input_id: String,
        events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        let input = {
            let control = lock(&self.shared.control)?;
            if control.closing {
                return Err(EngineError::State("engine is shutting down".into()));
            }
            let mut store = lock(&self.shared.store)?;
            let input = store.queued_agent(&session_id, &input_id)?;
            // The store checks the exact session, reserved command ID and resolved
            // request against this operation. A receipt is not new admission.
            if let Some(id) = input.operation_id {
                let operation = store.get_operation(&id)?;
                let result = operation
                    .outcome
                    .clone()
                    .and_then(|value| serde_json::from_value(value).ok());
                return Ok(Reply::Agent {
                    operation,
                    result,
                    duplicate: true,
                });
            }
            if input.status == QueuedAgentStatus::Cancelled {
                return Err(EngineError::State("queued input was cancelled".into()));
            }
            if control.active.contains_key(&session_id) {
                return Err(EngineError::State(
                    "session already has an active operation".into(),
                ));
            }
            store.resolve_queued_agent(&session_id, &input_id)?
        };
        let request = input.resolved_request.ok_or_else(|| {
            EngineError::State("queued input lacks resolved dispatch authority".into())
        })?;
        // Admission rechecks this input while holding control through the actual
        // operation admission. Cancellation in this gap therefore wins safely.
        self.run_agent_input(
            session_id,
            input.run_command_id,
            request,
            events,
            Some(input_id),
        )
        .await
    }
}
