//! Actor-owned persistent workers. Replies are provisional until joined drain.
use super::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use zero_plugin_runner::{Runner, RunningWorker, UntrustedReply, WorkerLimits, WorkerStatus};
use zero_protocol::{
    Operation,
    agent::{AgentRequest, PluginToolBinding},
    plugin::{PluginHostOperation, PluginOutcome, PluginWorkerPolicy, UntrustedPluginReply},
};
mod broker;
mod read;
pub use read::read_plugin_worker_call;
pub(super) use read::{output, validate};
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn reply(value: UntrustedReply) -> UntrustedPluginReply {
    match value {
        UntrustedReply::Result(value) => UntrustedPluginReply::Result { value },
        UntrustedReply::Error(e) => UntrustedPluginReply::Error {
            code: e.code,
            message: e.message,
        },
    }
}
struct Call {
    shared: Arc<Shared>,
    settled: bool,
    operation: Operation,
    approval: Option<Box<agent_approvals::ApprovedEffect>>,
}
impl Drop for Call {
    fn drop(&mut self) {
        if !self.settled {
            if let Ok(mut store) = self.shared.store.lock() {
                let _ = store.mark_operation_unknown(
                    &self.operation.id,
                    &self.shared.owner,
                    "plugin call owner failed before joined settlement",
                );
            }
        }
    }
}
struct Entry {
    shared: Arc<Shared>,
    operation: Operation,
    worker: Option<RunningWorker>,
    request_sha256: Option<String>,
    calls: Vec<Call>,
    cancel: CancellationToken,
    parent_cancel: CancellationToken,
    timer_stop: CancellationToken,
    timer: Option<tokio::task::JoinHandle<()>>,
    settled: bool,
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.timer_stop.cancel();
        if !self.settled {
            self.cancel.cancel();
            if let Ok(mut store) = self.shared.store.lock() {
                for id in std::iter::once(&self.operation.id)
                    .chain(self.calls.iter().map(|c| &c.operation.id))
                {
                    let _ = store.mark_operation_unknown(
                        id,
                        &self.shared.owner,
                        "persistent worker owner failed; reconcile backend and leases",
                    );
                }
            }
        }
    }
}
pub(super) struct WorkerPool {
    entries: BTreeMap<String, Entry>,
}
impl WorkerPool {
    pub fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn invoke(
        &mut self,
        shared: &Arc<Shared>,
        session: &str,
        actor: &str,
        command: &str,
        origin: &Operation,
        call_id: &str,
        request: &AgentRequest,
        context: &agent_plugins::Context,
        binding: &PluginToolBinding,
        input: Value,
        source: Option<Arc<agent_source::Context>>,
        http: Option<agent_http::Context>,
        cancel: &CancellationToken,
        events: &mpsc::Sender<ExecutionEvent>,
    ) -> Result<agent_approvals::ResultKind, EngineError> {
        agent_plugins::current(shared, context)?;
        let policy = context
            .workers
            .get(&binding.plugin)
            .ok_or_else(|| error("worker policy absent"))?;
        if self
            .entries
            .get(&binding.plugin)
            .is_some_and(|entry| entry.calls.len() >= policy.max_calls as usize)
        {
            return Ok(agent_approvals::ResultKind::Output(
                "Tool rejected: worker lifetime call limit reached".into(),
            ));
        }
        let mut approval = None;
        let operation = if agent_approvals::required(request, &binding.alias) {
            let effect = agent_approvals::Effect::Plugin {
                context: context.clone(),
                binding: binding.clone(),
                input: input.clone(),
            };
            match agent_approvals::admit(
                shared,
                session,
                actor,
                command,
                origin,
                call_id,
                &binding.alias,
                &effect,
                cancel,
                events,
            )
            .await?
            {
                agent_approvals::ApprovalAdmission::Ready(value) => {
                    let op = value.operation.clone();
                    approval = Some(value);
                    op
                }
                agent_approvals::ApprovalAdmission::Finished(value) => return Ok(value),
            }
        } else {
            let mut store = lock(&shared.store)?;
            let admitted=store.admit_command(session,command,&json!({"parent_operation":actor,"kind":"agent_plugin","call_id":call_id,"plugin_context":context.identity,"binding":binding,"input":input}))?;
            if admitted.duplicate {
                return Err(error(
                    "persistent invocation already admitted; reconcile instead of replay",
                ));
            }
            store.begin_operation(&admitted.operation.id, &shared.owner)?
        };
        let deferred = Call {
            shared: shared.clone(),
            settled: false,
            operation: operation.clone(),
            approval,
        };
        if !self.entries.contains_key(&binding.plugin) {
            let worker_id = uuid::Uuid::new_v4().to_string();
            let directory = shared.plugin_root.join(&worker_id);
            let worker = lock(&shared.store)?.register_plugin_worker(
                session,
                actor,
                &shared.owner,
                &worker_id,
                &binding.plugin,
                &directory.to_string_lossy(),
            )?;
            let stop = cancel.child_token();
            let timer_stop = CancellationToken::new();
            let deadline = worker.payload["deadline_at_ms"]
                .as_u64()
                .ok_or_else(|| error("worker deadline absent"))?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(error)?
                .as_millis() as u64;
            let timer_cancel = stop.clone();
            let timer_done = timer_stop.clone();
            let timer = tokio::spawn(async move {
                tokio::select! {_=timer_done.cancelled()=>{},_=tokio::time::sleep(std::time::Duration::from_millis(deadline.saturating_sub(now)))=>timer_cancel.cancel()}
            });
            self.entries.insert(
                binding.plugin.clone(),
                Entry {
                    shared: shared.clone(),
                    operation: worker,
                    worker: None,
                    request_sha256: None,
                    calls: vec![],
                    cancel: stop,
                    parent_cancel: cancel.clone(),
                    timer_stop,
                    timer: Some(timer),
                    settled: false,
                },
            );
        }
        let entry = self
            .entries
            .get_mut(&binding.plugin)
            .ok_or_else(|| error("worker pool entry absent"))?;
        entry.calls.push(deferred);
        let call = {
            let mut profiles = lock(&shared.plugins)?;
            let profile = profiles
                .as_mut()
                .ok_or_else(|| error("plugin profile absent"))?;
            let call = profile
                .harness
                .begin_call(
                    &context.pin,
                    &operation.id,
                    &binding.plugin,
                    &binding.tool,
                    input,
                )
                .map_err(error)?;
            lock(&shared.store)?.bind_plugin_worker_call(
                &entry.operation.id,
                &operation.id,
                &shared.owner,
                &plugin::pin(&call),
            )?;
            call
        };
        let response = if let Some(worker) = &mut entry.worker {
            let profiles = lock(&shared.plugins)?;
            let profile = profiles
                .as_ref()
                .ok_or_else(|| error("plugin profile absent"))?;
            worker
                .submit(&profile.harness, call)
                .map_err(|rejected| error(rejected.error))?
        } else {
            let directory = shared.plugin_root.join(&entry.operation.id);
            let broker = Arc::new(broker::Broker {
                shared: shared.clone(),
                worker: entry.operation.id.clone(),
                request: request.clone(),
                source,
                http,
                events: events.clone(),
            });
            let handlers = broker::handlers(broker, policy);
            let limits = WorkerLimits {
                max_calls: policy.max_calls as usize,
                max_callbacks: policy.max_callbacks as usize,
                broker_drain_ms: 1000,
            };
            let captured = {
                let profiles = lock(&shared.plugins)?;
                let profile = profiles
                    .as_ref()
                    .ok_or_else(|| error("plugin profile absent"))?;
                Runner::new((*shared.sandbox).clone())
                    .capture_worker_in(
                        &profile.harness,
                        call,
                        &binding.plugin,
                        context.launch.clone(),
                        limits,
                        handlers,
                        &directory,
                    )
                    .map_err(|e| error(e.error))?
            };
            let private_root = shared.plugin_root.clone();
            // Await staging without a Store, Control or Harness lock. Cancellation
            // never drops the owned copy job; physical begin is checked afterward.
            let prepared = tokio::task::spawn_blocking(move || {
                plugin::private_root(&private_root)?;
                captured.prepare().map_err(|e| error(e.error))
            })
            .await
            .map_err(error)??;
            let digest = format!("sha256:{}", prepared.request_digest().map_err(error)?);
            {
                let mut store = lock(&shared.store)?;
                let artifact = store.retain_operation_artifact(
                    &entry.operation.id,
                    &shared.owner,
                    "plugin.worker_request",
                    &serde_json::to_vec(prepared.request())?,
                )?;
                if artifact != digest {
                    return Err(error("worker request artifact digest differs"));
                }
                entry.request_sha256 = Some(digest.clone());
                store.prepare_plugin_worker(
                    &entry.operation.id,
                    &shared.owner,
                    &digest,
                    prepared.execution_id(),
                )?;
                if entry.cancel.is_cancelled() {
                    return Err(error("worker cancelled before physical start"));
                }
                store.begin_plugin_worker(&entry.operation.id, &shared.owner)?;
            }
            let events = events.clone();
            let stop = entry.cancel.clone();
            let sink = Arc::new(move |event| {
                if events.try_send(ExecutionEvent::Sandbox { event }).is_err() {
                    stop.cancel();
                }
            });
            let (worker, response) = prepared.start(entry.cancel.clone(), sink);
            entry.worker = Some(worker);
            response
        };
        let output = match response.wait().await {
            Ok(value) => reply(value),
            Err(e) => return Ok(agent_approvals::ResultKind::Failed(e)),
        };
        let bytes = serde_json::to_vec(&output)?;
        {
            let mut store = lock(&shared.store)?;
            let digest = store.retain_operation_artifact(
                &operation.id,
                &shared.owner,
                "plugin.worker_reply",
                &bytes,
            )?;
            store.append_operation_event(
                &operation.id,
                &shared.owner,
                "plugin.worker_reply",
                &json!({"worker_operation_id":entry.operation.id,"reply_artifact":digest}),
            )?;
        }
        Ok(agent_approvals::ResultKind::Output(serde_json::to_string(
            &json!({"untrusted_plugin_data":output,"provisional":true}),
        )?))
    }
    /// Drain every owned supervisor and callback even after one journal fails.
    pub async fn drain(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Option<(zero_protocol::agent::AgentStatus, String)>, EngineError> {
        let mut failure = None;
        let mut disposition = None;
        for (_, mut entry) in std::mem::take(&mut self.entries) {
            if cancel.is_cancelled() {
                entry.cancel.cancel();
            }
            let result = drain_entry(&mut entry).await;
            entry.timer_stop.cancel();
            if let Some(timer) = entry.timer.take() {
                let _ = timer.await;
            }
            match result {
                Ok(value) => {
                    if value
                        .as_ref()
                        .is_some_and(|(s, _)| *s == zero_protocol::agent::AgentStatus::Unknown)
                        || disposition.is_none()
                    {
                        disposition = value;
                    }
                }
                Err(e) => {
                    failure.get_or_insert(e);
                }
            }
        }
        if let Some(e) = failure {
            Err(e)
        } else {
            Ok(disposition)
        }
    }
}
async fn drain_entry(
    entry: &mut Entry,
) -> Result<Option<(zero_protocol::agent::AgentStatus, String)>, EngineError> {
    let shared = &entry.shared;
    let worker = entry.worker.take().ok_or_else(|| {
        error("worker did not reach physical start; lease requires reconciliation")
    })?;
    let mut outcome = worker.finish().await.map_err(error)?;
    let settled = outcome.backend_settled();
    if let Some(pending) = outcome.pending_capability.take() {
        pending.cancel();
        let _ = pending.wait().await;
    }
    let status = if !settled {
        OperationStatus::Unknown
    } else {
        match outcome.status {
            WorkerStatus::Completed => OperationStatus::Succeeded,
            WorkerStatus::Cancelled => {
                if entry.parent_cancel.is_cancelled() {
                    OperationStatus::Cancelled
                } else {
                    OperationStatus::Failed
                }
            }
            WorkerStatus::TimedOut | WorkerStatus::Failed => OperationStatus::Failed,
            WorkerStatus::Unknown => OperationStatus::Unknown,
        }
    };
    let value = json!({"schema_version":1,"request_sha256":entry.request_sha256,"sandbox":outcome.sandbox,"error":outcome.error,"staging_recovery":outcome.staging_recovery,"backend_settled":settled});
    {
        let mut store = lock(&shared.store)?;
        if status == OperationStatus::Unknown {
            store.mark_operation_unknown_with_outcome(
                &entry.operation.id,
                &shared.owner,
                &value,
            )?;
        } else {
            store.settle_operation(&entry.operation.id, &shared.owner, status, &value)?;
        }
    }
    for mut call in outcome.calls {
        let deferred = entry
            .calls
            .iter_mut()
            .find(|c| c.operation.id == call.call.lease().owner)
            .ok_or_else(|| error("worker returned foreign call"))?;
        let output = call.reply.take().map(reply);
        let call_status = if status == OperationStatus::Succeeded
            && !matches!(output, Some(UntrustedPluginReply::Result { .. }))
        {
            OperationStatus::Failed
        } else {
            status
        };
        let result = PluginOutcome {
            external_effects_started: true,
            pin: Some(plugin::pin(&call.call)),
            sandbox: None,
            untrusted_reply: output,
            error: outcome.error.clone(),
            staging_recovery: outcome
                .staging_recovery
                .as_ref()
                .map(|p| p.display().to_string()),
            lease_release_journaled_separately: true,
        };
        let Reply::Plugin { operation, .. } =
            plugin::settle(shared, &deferred.operation.id, result, call_status)?
        else {
            unreachable!()
        };
        validate(
            &*lock(&shared.store)?,
            &operation,
            &serde_json::from_value(
                operation
                    .outcome
                    .clone()
                    .ok_or_else(|| error("worker call outcome absent"))?,
            )?,
        )?;
        deferred.settled = true;
        if let Some(approval) = deferred.approval.take() {
            approval.finish(shared, operation, &entry.cancel)?;
        }
        if settled {
            let released = lock(&shared.plugins)?
                .as_mut()
                .ok_or_else(|| error("plugin profile disappeared"))?
                .harness
                .complete_settled(&mut call.call)
                .map_err(error);
            plugin::journal_release(shared, &deferred.operation.id, released)?;
        }
    }
    // Every binding must be represented by the joined supervisor's result.
    for call in &entry.calls {
        if lock(&shared.store)?
            .get_operation(&call.operation.id)?
            .status
            == OperationStatus::Running
        {
            return Err(error("joined worker omitted a call outcome"));
        }
    }
    entry.settled = true;
    use zero_protocol::agent::AgentStatus;
    Ok(match status {
        OperationStatus::Succeeded => None,
        OperationStatus::Cancelled => {
            Some((AgentStatus::Cancelled, "plugin worker cancelled".into()))
        }
        OperationStatus::Unknown => Some((
            AgentStatus::Unknown,
            "plugin worker teardown uncertain; leases retained".into(),
        )),
        _ => Some((AgentStatus::Failed, "plugin worker failed".into())),
    })
}
