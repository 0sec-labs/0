//! Actor-owned pipe sessions. Nothing here grants guest output verification authority.
use super::*;
use std::collections::BTreeMap;
use zero_protocol::interactive::{InteractiveCall, InteractiveCapture, InteractivePage};
use zero_protocol::sandbox::{SandboxCleanup, SandboxEvent, SandboxResult};
struct Session {
    sender: Option<zero_executor::InteractiveSender>,
    cancel: CancellationToken,
    output: Arc<Mutex<Vec<u8>>>,
    task: Option<tokio::task::JoinHandle<SandboxResult>>,
    result: Option<SandboxResult>,
}
#[derive(Default)]
pub(super) struct Sessions {
    sessions: BTreeMap<String, Session>,
}
pub(super) fn now() -> Result<u64, EngineError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| EngineError::State("clock before epoch".into()))?
        .as_millis()
        .try_into()
        .map_err(|_| EngineError::State("clock overflow".into()))
}
impl Sessions {
    #[allow(clippy::too_many_arguments)]
    pub async fn call(
        &mut self,
        shared: &Arc<Shared>,
        parent: &str,
        request: &zero_protocol::agent::AgentRequest,
        turn: u32,
        index: usize,
        id: &str,
        name: &str,
        args: &serde_json::Value,
        cancel: &CancellationToken,
    ) -> Result<serde_json::Value, EngineError> {
        let policy = request
            .interactive_policy
            .as_ref()
            .ok_or_else(|| EngineError::State("interactive policy absent".into()))?;
        let call = InteractiveCall::parse(name, args, policy).map_err(EngineError::State)?;
        let handle = call
            .session_id()
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if cancel.is_cancelled() {
            return Err(EngineError::State("interactive actor cancelled".into()));
        }
        let capture: InteractiveCapture = {
            let mut store = lock(&shared.store)?;
            let actor = store.get_operation(parent)?;
            let capture = serde_json::from_value(actor.payload["interactive_capture"].clone())?;
            store.claim_interactive(parent, &shared.owner, turn, index, id, &call, &handle)?;
            capture
        };
        let remaining = capture
            .deadline_at_ms
            .checked_sub(now()?)
            .filter(|n| *n > 0)
            .ok_or_else(|| EngineError::State("interactive deadline elapsed after claim".into()))?;
        match call {
            InteractiveCall::Create { argv } => {
                let mut execution = request
                    .snapshot_request()
                    .map_err(|e| EngineError::State(e.to_string()))?;
                execution.argv = argv;
                execution.execution_id = format!("interactive-{handle}");
                execution.timeout_ms = execution.timeout_ms.min(remaining);
                execution
                    .validate()
                    .map_err(|e| EngineError::State(e.to_string()))?;
                // Preserve both independently capped streams without dropping their interleaved bytes.
                let cap = execution.max_output_bytes * 2;
                let output = Arc::new(Mutex::new(Vec::new()));
                let retained = Arc::clone(&output);
                let token = cancel.child_token();
                let sink_token = token.clone();
                let sink = Arc::new(move |event| {
                    if let SandboxEvent::Output { bytes, .. } = event {
                        match retained.lock() {
                            Ok(mut output) => {
                                let room = cap.saturating_sub(output.len());
                                output.extend_from_slice(&bytes[..bytes.len().min(room)]);
                                if bytes.len() > room {
                                    sink_token.cancel();
                                }
                            }
                            Err(_) => sink_token.cancel(),
                        }
                    }
                });
                let (sender, input) = zero_executor::interactive_input();
                let executor = Arc::clone(&shared.sandbox);
                let worker_token = token.clone();
                let task = tokio::spawn(async move {
                    executor
                        .execute_interactive(execution, worker_token, sink, input)
                        .await
                });
                self.sessions.insert(
                    handle.clone(),
                    Session {
                        sender: Some(sender),
                        cancel: token,
                        output,
                        task: Some(task),
                        result: None,
                    },
                );
                Ok(
                    serde_json::json!({"session_id":handle,"deadline_at_ms":capture.deadline_at_ms,"status":"starting"}),
                )
            }
            InteractiveCall::Write { data_base64, .. } => {
                let state = self.sessions.get_mut(&handle).ok_or_else(|| {
                    EngineError::State("interactive handle unavailable; cannot resume".into())
                })?;
                let bytes = zero_protocol::interactive::decode_input(&data_base64)
                    .map_err(EngineError::State)?;
                let sender = state
                    .sender
                    .as_ref()
                    .ok_or_else(|| EngineError::State("interactive stdin closed".into()))?;
                let sent = tokio::select! {biased;_ = cancel.cancelled()=>Err("interactive write cancelled; consumption unknown".into()),v=tokio::time::timeout(std::time::Duration::from_millis(remaining),sender.send_confirmed(bytes))=>v.unwrap_or_else(|_|Err("interactive write deadline; consumption unknown".into()))};
                if let Err(error) = sent {
                    state.cancel.cancel();
                    return Err(EngineError::State(error));
                }
                Ok(
                    serde_json::json!({"session_id":handle,"forwarded_to_launcher":true,"guest_consumption":"unknown"}),
                )
            }
            InteractiveCall::Read {
                after,
                max_bytes,
                wait_ms,
                ..
            } => {
                let state = self
                    .sessions
                    .get_mut(&handle)
                    .ok_or_else(|| EngineError::State("interactive handle unavailable".into()))?;
                if wait_ms > 0 {
                    tokio::select! {_ = cancel.cancelled()=>{},_ = tokio::time::sleep(std::time::Duration::from_millis(u64::from(wait_ms).min(remaining)))=>{}}
                }
                let output = lock(&state.output)?;
                let start = usize::try_from(after)
                    .ok()
                    .filter(|n| *n <= output.len())
                    .ok_or_else(|| {
                        EngineError::State("interactive cursor beyond captured bytes".into())
                    })?;
                let end = output.len().min(start + max_bytes as usize);
                Ok(serde_json::to_value(InteractivePage {
                    session_id: handle,
                    after,
                    next_after: end as u64,
                    bytes_base64: zero_protocol::interactive::encode_bytes(&output[start..end]),
                    available_bytes: output.len() as u64,
                    finished: state.result.is_some()
                        || state.task.as_ref().is_some_and(|t| t.is_finished()),
                })?)
            }
            InteractiveCall::Close { .. } => {
                let state = self
                    .sessions
                    .get_mut(&handle)
                    .ok_or_else(|| EngineError::State("interactive handle unavailable".into()))?;
                finish(shared, parent, &handle, state).await?;
                let result = state
                    .result
                    .as_ref()
                    .ok_or_else(|| EngineError::State("interactive close result missing".into()))?;
                Ok(
                    serde_json::json!({"session_id":handle,"status":result.status,"exit_code":result.exit_code,"cleanup":result.cleanup,"error":result.error}),
                )
            }
        }
    }
    pub async fn drain(&mut self, shared: &Arc<Shared>, parent: &str) -> Result<(), EngineError> {
        for state in self.sessions.values_mut() {
            state.cancel.cancel();
            state.sender.take();
        }
        let mut error = None;
        for (handle, state) in &mut self.sessions {
            if let Err(e) = finish(shared, parent, handle, state).await {
                error.get_or_insert(e);
            }
        }
        match error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}
async fn finish(
    shared: &Arc<Shared>,
    parent: &str,
    handle: &str,
    state: &mut Session,
) -> Result<(), EngineError> {
    state.cancel.cancel();
    state.sender.take();
    if let Some(task) = state.task.take() {
        let result = task
            .await
            .map_err(|e| EngineError::State(format!("interactive supervisor uncertain: {e}")))?;
        state.result = Some(result);
    }
    let result = state
        .result
        .as_ref()
        .ok_or_else(|| EngineError::State("interactive result absent".into()))?;
    let mut store = lock(&shared.store)?;
    store.retain_operation_artifact(
        parent,
        &shared.owner,
        &format!("interactive.{handle}.transcript"),
        &lock(&state.output)?,
    )?;
    store.retain_operation_artifact(
        parent,
        &shared.owner,
        &format!("interactive.{handle}.result"),
        &serde_json::to_vec(result)?,
    )?;
    if matches!(
        result.cleanup,
        SandboxCleanup::Unconfirmed { .. } | SandboxCleanup::Unknown { .. }
    ) {
        return Err(EngineError::State(
            "interactive cleanup uncertain; retained result requires reconciliation".into(),
        ));
    }
    Ok(())
}
