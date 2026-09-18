//! Durable supplementary operator input. Captured means request admission, not provider receipt.
use super::*;
use serde_json::{Value, json};

/// Read retained intent/status without engine ownership, migration or dispatch.
pub fn read_agent_steering(
    path: &Path,
    session: &str,
    operation: &str,
    after_sequence: u64,
    limit: u32,
) -> Result<Vec<zero_protocol::steering::AgentSteeringMessage>, EngineError> {
    Ok(Store::open_read_only(path)?.agent_steering(session, operation, after_sequence, limit)?)
}

pub(super) struct Target {
    session: String,
    root: String,
    cancel: CancellationToken,
}
pub(super) struct TargetGuard {
    shared: Arc<Shared>,
    operation: String,
}
impl TargetGuard {
    pub fn enter(
        shared: &Arc<Shared>,
        session: &str,
        operation: &str,
        cancel: &CancellationToken,
    ) -> Result<Self, EngineError> {
        let mut control = lock(&shared.control)?;
        let store = lock(&shared.store)?;
        let actor = store.get_operation(operation)?;
        let root = actor.payload["parent_operation"]
            .as_str()
            .unwrap_or(operation);
        let root_operation = store.get_operation(root)?;
        if actor.session_id != session
            || actor.status != OperationStatus::Running
            || actor.owner.as_deref() != Some(&shared.owner)
            || actor.payload["kind"] != "offline_snapshot_agent"
            || root_operation.session_id != session
            || root_operation.payload.get("parent_operation").is_some()
            || !control
                .active
                .get(session)
                .is_some_and(|active| active.command_id == root_operation.command_id)
        {
            return Err(EngineError::State(
                "steering target lacks an active root owner".into(),
            ));
        }
        if control.actors.contains_key(operation) {
            return Err(EngineError::State(
                "agent steering target already registered".into(),
            ));
        }
        control.actors.insert(
            operation.into(),
            Target {
                session: session.into(),
                root: root.into(),
                cancel: cancel.clone(),
            },
        );
        Ok(Self {
            shared: Arc::clone(shared),
            operation: operation.into(),
        })
    }
}
impl Drop for TargetGuard {
    fn drop(&mut self) {
        if let Ok(mut control) = self.shared.control.lock() {
            control.actors.remove(&self.operation);
        }
    }
}

impl Engine {
    pub(super) fn steer_agent(
        &self,
        session: &str,
        operation: &str,
        command: &str,
        prompt: &str,
    ) -> Result<Reply, EngineError> {
        let control = lock(&self.shared.control)?;
        let mut store = lock(&self.shared.store)?;
        if let Some(message) = store.agent_steering_by_command(session, command)? {
            if message.operation_id != operation || message.prompt != prompt {
                return Err(zero_store::Error::Conflict(command.into()).into());
            }
            return Ok(Reply::AgentSteered {
                message,
                duplicate: true,
            });
        }
        let actor = store.get_operation(operation)?;
        let root = actor.payload["parent_operation"]
            .as_str()
            .unwrap_or(operation);
        let root_operation = store.get_operation(root)?;
        let active = control.active.get(session);
        if control.closing
            || actor.session_id != session
            || actor.status != OperationStatus::Running
            || actor.owner.as_deref() != Some(&self.shared.owner)
            || actor.payload["kind"] != "offline_snapshot_agent"
            || root_operation.session_id != session
            || root_operation.status != OperationStatus::Running
            || root_operation.payload.get("parent_operation").is_some()
            || !active.is_some_and(|a| {
                a.command_id == root_operation.command_id && !a.cancel.is_cancelled()
            })
        {
            return Err(EngineError::State(
                "steering requires this engine's live agent owner".into(),
            ));
        }
        if root != operation
            && !control
                .actors
                .get(operation)
                .is_some_and(|a| a.session == session && a.root == root && !a.cancel.is_cancelled())
        {
            return Err(EngineError::State(
                "delegated agent is not currently running".into(),
            ));
        }
        let (message, duplicate) =
            store.enqueue_agent_steering(session, operation, command, prompt)?;
        Ok(Reply::AgentSteered { message, duplicate })
    }
}

pub(super) fn captured_input(
    store: &Store,
    inference: &zero_protocol::Operation,
) -> Result<Vec<Value>, EngineError> {
    Ok(store
        .inference_steering(inference)?
        .into_iter()
        .map(|message| json!({"role":"user","content":message.prompt}))
        .collect())
}
pub(super) fn strip_captured_input(
    store: &Store,
    inference: &zero_protocol::Operation,
    mut input: Vec<Value>,
) -> Result<Vec<Value>, EngineError> {
    let captured = captured_input(store, inference)?;
    let length = input
        .len()
        .checked_sub(captured.len())
        .ok_or_else(|| EngineError::State("captured steering input missing".into()))?;
    if input[length..] != captured {
        return Err(EngineError::State(
            "captured steering input differs from request suffix".into(),
        ));
    }
    input.truncate(length);
    Ok(input)
}
