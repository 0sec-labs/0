//! Session-owned native execution. Client disconnect is not a request replay.
mod agent;
mod agent_checkpoint;
mod agent_plugins;
mod agent_source;
mod agent_submission;
mod inference;
mod lifecycle;
mod plugin;
mod repair;
mod reproduction;
mod sandbox;
mod source;
mod source_provenance;
mod source_report;
mod workflow_provenance;

pub use source_report::{read_source_report, read_source_workflow_report};

use std::{
    collections::HashMap,
    fs::File,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use zero_executor::DockerExecutor;
use zero_protocol::{
    Command, ExecutionEvent, ExecutionRequest, ExecutionResult, ExecutionStatus, OperationStatus,
    PROTOCOL_VERSION, Reply,
};
use zero_store::Store;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("{0}")]
    Store(#[from] zero_store::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    State(String),
}

struct Active {
    command_id: String,
    execution_id: String,
    cancel: CancellationToken,
}

#[derive(Default)]
struct Control {
    closing: bool,
    active: HashMap<String, Active>,
}

struct Shared {
    store: Mutex<Store>,
    control: Mutex<Control>,
    workers: Arc<Workers>,
    executor: Arc<DockerExecutor>,
    sandbox: Arc<zero_sandbox::SandboxExecutor>,
    providers: Mutex<HashMap<String, inference::Profile>>,
    plugins: Mutex<Option<plugin::Profile>>,
    plugin_root: PathBuf,
    owner: String,
    // Retained by workers even when the client handle is dropped.
    _lock: OwnershipLock,
}

/// flock belongs to an open file description, which fork inherits until exec
/// applies CLOEXEC. Merely closing our descriptor can therefore leave a lock
/// temporarily held by an unrelated child. Explicitly unlock only when the last
/// Shared owner drops, after the preceding Store and runtime fields are gone.
struct OwnershipLock(File);
impl Drop for OwnershipLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

#[derive(Default)]
struct Workers {
    count: AtomicUsize,
    changed: Notify,
}
struct WorkerCompletion(Arc<Workers>);
impl Drop for WorkerCompletion {
    fn drop(&mut self) {
        self.0.count.fetch_sub(1, Ordering::AcqRel);
        self.0.changed.notify_waiters();
    }
}

/// Finalizes registration even if the worker panics or settlement fails.
struct WorkerGuard {
    // Fields drop in declaration order after Drop: release the worker's sole
    // engine ownership before the completion token can unblock shutdown.
    shared: Arc<Shared>,
    session_id: String,
    operation_id: String,
    cancel: CancellationToken,
    settled: bool,
    _completion: WorkerCompletion,
}
impl WorkerGuard {
    fn new(
        shared: Arc<Shared>,
        session_id: &str,
        operation_id: &str,
        cancel: CancellationToken,
    ) -> Self {
        let session_id = session_id.to_owned();
        let operation_id = operation_id.to_owned();
        let completion = WorkerCompletion(Arc::clone(&shared.workers));
        // Admission holds control until this registration and spawning finish.
        shared.workers.count.fetch_add(1, Ordering::AcqRel);
        Self {
            shared,
            session_id,
            operation_id,
            cancel,
            settled: false,
            _completion: completion,
        }
    }
}
impl Drop for WorkerGuard {
    fn drop(&mut self) {
        if !self.settled {
            self.cancel.cancel();
            // Keep the lock ordering used by admission: control, then store.
            if let Ok(mut control) = self.shared.control.lock() {
                control.closing = true;
                for active in control.active.values() {
                    active.cancel.cancel();
                }
                if let Ok(mut store) = self.shared.store.lock() {
                    let _ = store.mark_operation_unknown(
                        &self.operation_id,
                        &self.shared.owner,
                        "worker ended without durable settlement; engine admission closed",
                    );
                }
            }
        }
        if let Ok(mut control) = self.shared.control.lock() {
            control.active.remove(&self.session_id);
        }
    }
}

fn emit_admission(
    events: &mpsc::Sender<ExecutionEvent>,
    operation: &zero_protocol::Operation,
    execution_id: &str,
    cancel: &CancellationToken,
) {
    if events
        .try_send(ExecutionEvent::Admitted {
            session_id: operation.session_id.clone(),
            command_id: operation.command_id.clone(),
            operation_id: operation.id.clone(),
            execution_id: execution_id.into(),
        })
        .is_err()
    {
        cancel.cancel();
    }
}

pub struct Engine {
    shared: Arc<Shared>,
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, EngineError> {
    mutex
        .lock()
        .map_err(|_| EngineError::State("native state lock poisoned".into()))
}

impl Engine {
    pub fn open(
        path: impl AsRef<Path>,
        docker_binary: Option<PathBuf>,
    ) -> Result<Self, EngineError> {
        Self::open_with_backends(path, docker_binary, None)
    }
    pub fn open_with_backends(
        path: impl AsRef<Path>,
        docker_binary: Option<PathBuf>,
        smolvm_binary: Option<PathBuf>,
    ) -> Result<Self, EngineError> {
        let (store, owner, file) = lifecycle::open_owned_store(path.as_ref())?;
        let mut plugin_root = path.as_ref().as_os_str().to_os_string();
        plugin_root.push(".plugin-runs");
        let plugin_root = std::path::absolute(PathBuf::from(plugin_root))?;
        let executor = docker_binary
            .map(DockerExecutor::with_binary)
            .unwrap_or_default();
        let mut smolvm = zero_smolvm::SmolvmConfig::default();
        if let Some(binary) = smolvm_binary {
            smolvm.binary = binary;
        }
        let sandbox = zero_sandbox::SandboxExecutor::with_backends(executor.clone(), smolvm);
        Ok(Self {
            shared: Arc::new(Shared {
                store: Mutex::new(store),
                control: Mutex::new(Control::default()),
                workers: Arc::new(Workers::default()),
                executor: Arc::new(executor),
                sandbox: Arc::new(sandbox),
                providers: Mutex::new(HashMap::new()),
                plugins: Mutex::new(None),
                plugin_root,
                owner,
                _lock: OwnershipLock(file),
            }),
        })
    }

    pub fn capabilities() -> Vec<String> {
        [
            "native_session_journal",
            "idempotent_execution_admission",
            "offline_docker_snapshot",
            "offline_sandbox_snapshot",
            "operation_admission_events",
            "execution_cancellation",
            "finding_reconciliation",
            "responses_inference",
            "chat_completions_inference",
            "anthropic_messages_inference",
            "bounded_offline_snapshot_agent",
            "generation_pinned_offline_plugins",
            "unverified_source_review",
            "host_frozen_source_observation",
        ]
        .map(String::from)
        .to_vec()
    }

    /// Application requests share one semantics across CLI and stdio clients.
    pub async fn handle(&self, command: Command, event_tx: mpsc::Sender<ExecutionEvent>) -> Reply {
        match self.dispatch(command, event_tx).await {
            Ok(reply) => reply,
            Err(error) => Reply::Error {
                code: error_code(&error).into(),
                message: error.to_string(),
            },
        }
    }

    async fn dispatch(
        &self,
        command: Command,
        event_tx: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        if let Command::ValidateSourceRepair {
            session_id,
            command_id,
            request,
        } = command
        {
            return self
                .validate_repair(session_id, command_id, request, event_tx)
                .await;
        }
        if let Command::ReproduceSource {
            session_id,
            command_id,
            request,
        } = command
        {
            return self
                .reproduce_source(session_id, command_id, request, event_tx)
                .await;
        }
        if let Command::ReviewSource {
            session_id,
            command_id,
            request,
        } = command
        {
            return self
                .review_source(session_id, command_id, request, event_tx)
                .await;
        }
        if let Command::RunPlugin {
            session_id,
            command_id,
            plugin,
            tool,
            input,
        } = command
        {
            return self
                .run_plugin(session_id, command_id, plugin, tool, input, event_tx)
                .await;
        }
        if let Command::Execute {
            session_id,
            command_id,
            request,
        } = command
        {
            return self
                .execute(session_id, command_id, request, event_tx)
                .await;
        }
        if let Command::RunSandbox {
            session_id,
            command_id,
            request,
        } = command
        {
            return self
                .run_sandbox(session_id, command_id, request, event_tx)
                .await;
        }
        if let Command::RunAgent {
            session_id,
            command_id,
            request,
        } = command
        {
            return self
                .run_agent(session_id, command_id, request, event_tx)
                .await;
        }
        if let Command::Infer {
            session_id,
            command_id,
            provider,
            request,
            reservation,
        } = command
        {
            return self
                .infer(
                    session_id,
                    command_id,
                    provider,
                    request,
                    reservation,
                    event_tx,
                )
                .await;
        }
        let mut control = lock(&self.shared.control)?;
        if control.closing {
            return Err(EngineError::State("engine is shutting down".into()));
        }
        match command {
            Command::Initialize => Ok(Reply::Initialized {
                protocol_version: PROTOCOL_VERSION,
                capabilities: Self::capabilities(),
            }),
            Command::SessionCreate {
                generation,
                budget_limit,
            } => Ok(Reply::Session {
                session: lock(&self.shared.store)?.create_session(&generation, budget_limit)?,
            }),
            Command::SessionCreatePinned { budget_limit } => {
                self.create_pinned_session(budget_limit)
            }
            Command::SessionList => Ok(Reply::Sessions {
                sessions: lock(&self.shared.store)?.list_sessions()?,
            }),
            Command::SessionGet { session_id } => Ok(Reply::Session {
                session: lock(&self.shared.store)?.get_session(&session_id)?,
            }),
            Command::SessionBudget { session_id } => Ok(Reply::SessionBudget {
                budget: lock(&self.shared.store)?.budget(&session_id)?,
            }),
            Command::ReconcileUsage {
                session_id,
                operation_id,
                charged,
                evidence,
            } => {
                if control.active.contains_key(&session_id) {
                    return Err(EngineError::State(
                        "usage reconciliation requires an idle session".into(),
                    ));
                }
                let mut store = lock(&self.shared.store)?;
                let operation = store.get_operation(&operation_id)?;
                if operation.session_id != session_id
                    || matches!(
                        operation.status,
                        OperationStatus::Admitted | OperationStatus::Running
                    )
                {
                    return Err(EngineError::State(
                        "usage reconciliation requires a settled operation in this session".into(),
                    ));
                }
                Ok(Reply::SessionBudget {
                    budget: store.reconcile_budget(
                        &session_id,
                        &operation_id,
                        charged,
                        &evidence,
                    )?,
                })
            }
            Command::SessionEvents {
                session_id,
                after_sequence,
                limit,
            } => Ok(Reply::SessionEvents {
                events: lock(&self.shared.store)?.events(&session_id, after_sequence, limit)?,
            }),
            Command::Cancel {
                session_id,
                execution_id,
            } => {
                let accepted = control.active.get_mut(&session_id).is_some_and(|active| {
                    if active.execution_id == execution_id {
                        active.cancel.cancel();
                        true
                    } else {
                        false
                    }
                });
                Ok(Reply::Cancelled {
                    execution_id,
                    accepted,
                })
            }
            Command::Reconcile(request) => zero_evidence::reconcile(request)
                .map(Reply::Reconciled)
                .map_err(|e| EngineError::State(e.to_string())),
            Command::Execute { .. }
            | Command::Infer { .. }
            | Command::ReproduceSource { .. }
            | Command::ValidateSourceRepair { .. }
            | Command::ReviewSource { .. }
            | Command::RunAgent { .. }
            | Command::RunSandbox { .. }
            | Command::RunPlugin { .. } => {
                unreachable!("execution dispatched before acquiring synchronous locks")
            }
        }
    }

    async fn execute(
        &self,
        session_id: String,
        command_id: String,
        request: ExecutionRequest,
        event_tx: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        request
            .validate()
            .map_err(|e| EngineError::State(e.to_string()))?;
        let receiver = {
            // Admission, ownership and registration are serialized against shutdown.
            let mut control = lock(&self.shared.control)?;
            if control.closing {
                return Err(EngineError::State("engine is shutting down".into()));
            }
            if control
                .active
                .get(&session_id)
                .is_some_and(|active| active.command_id != command_id)
            {
                return Err(EngineError::State(
                    "session already has an active operation".into(),
                ));
            }
            if control.active.len() >= 64 && !control.active.contains_key(&session_id) {
                return Err(EngineError::State(
                    "engine active operation limit reached".into(),
                ));
            }
            let payload =
                serde_json::json!({"kind":"offline_docker_snapshot", "request": &request});
            let mut store = lock(&self.shared.store)?;
            let admission = store.admit_command(&session_id, &command_id, &payload)?;
            if admission.duplicate {
                let result = admission
                    .operation
                    .outcome
                    .clone()
                    .and_then(|value| serde_json::from_value::<ExecutionResult>(value).ok());
                return Ok(Reply::Execution {
                    operation: admission.operation,
                    result,
                    duplicate: true,
                });
            }
            let operation = store.begin_operation(&admission.operation.id, &self.shared.owner)?;
            let cancel = CancellationToken::new();
            control.active.insert(
                session_id.clone(),
                Active {
                    command_id,
                    execution_id: request.execution_id.clone(),
                    cancel: cancel.clone(),
                },
            );
            emit_admission(&event_tx, &operation, &request.execution_id, &cancel);
            let (sender, receiver) = oneshot::channel();
            let shared = Arc::clone(&self.shared);
            let mut guard = WorkerGuard::new(shared, &session_id, &operation.id, cancel.clone());
            tokio::spawn(async move {
                let result =
                    run_owned(&guard.shared, &operation.id, request, cancel, event_tx).await;
                guard.settled = result.is_ok();
                drop(guard);
                let _ = sender.send(result);
            });
            receiver
        };
        receiver
            .await
            .map_err(|_| EngineError::State("execution owner stopped before settlement".into()))?
    }

    /// Close admission before cancelling, and await settlement, owned cleanup,
    /// and release of every worker's engine ownership. Other Engine handles or
    /// callers borrowing this Engine must still be dropped before reopening.
    pub async fn shutdown(&self) -> Result<(), EngineError> {
        {
            let mut control = lock(&self.shared.control)?;
            control.closing = true;
            for active in control.active.values() {
                active.cancel.cancel();
            }
        }
        loop {
            let notified = self.shared.workers.changed.notified();
            if lock(&self.shared.control)?.active.is_empty()
                && self.shared.workers.count.load(Ordering::Acquire) == 0
            {
                break;
            }
            notified.await;
        }
        Ok(())
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // Explicit shutdown is needed to await cleanup; Drop still requests it.
        if let Ok(mut control) = self.shared.control.lock() {
            control.closing = true;
            for active in control.active.values() {
                active.cancel.cancel();
            }
        }
    }
}

async fn run_owned(
    shared: &Arc<Shared>,
    operation_id: &str,
    request: ExecutionRequest,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    let executor = Arc::clone(&shared.executor);
    let overflow = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let overflow_sink = Arc::clone(&overflow);
    let sink_cancel = cancel.clone();
    let sink = Arc::new(move |event| {
        if events.try_send(event).is_err() {
            overflow_sink.store(true, std::sync::atomic::Ordering::Relaxed);
            sink_cancel.cancel();
        }
    });
    // A worker panic is an uncertain external outcome, never a retry instruction.
    let result = tokio::spawn(async move { executor.execute(request, cancel, sink).await }).await;
    match result {
        Ok(mut result) => {
            if overflow.load(std::sync::atomic::Ordering::Relaxed) {
                result.error = Some(format!(
                    "event consumer unavailable; execution cancelled{}",
                    result
                        .error
                        .as_ref()
                        .map(|e| format!(": {e}"))
                        .unwrap_or_default()
                ));
                if result.status == ExecutionStatus::Exited {
                    result.status = ExecutionStatus::Cancelled;
                }
            }
            let status = match result.status {
                ExecutionStatus::Cancelled => OperationStatus::Cancelled,
                ExecutionStatus::Exited
                    if result.exit_code == Some(0)
                        && matches!(result.cleanup, zero_protocol::CleanupStatus::Confirmed) =>
                {
                    OperationStatus::Succeeded
                }
                _ => OperationStatus::Failed,
            };
            let operation = lock(&shared.store)?.settle_operation(
                operation_id,
                &shared.owner,
                status,
                &serde_json::to_value(&result)?,
            )?;
            Ok(Reply::Execution {
                operation,
                result: Some(result),
                duplicate: false,
            })
        }
        Err(error) => {
            let operation = lock(&shared.store)?.mark_operation_unknown(
                operation_id,
                &shared.owner,
                &format!("execution worker failed: {error}"),
            )?;
            Ok(Reply::Execution {
                operation,
                result: None,
                duplicate: false,
            })
        }
    }
}

fn error_code(error: &EngineError) -> &'static str {
    match error {
        EngineError::Store(zero_store::Error::Conflict(_)) => "conflict",
        EngineError::Store(zero_store::Error::NotFound(_)) => "not_found",
        EngineError::Store(zero_store::Error::BudgetExceeded) => "budget_exceeded",
        EngineError::Io(_) | EngineError::Store(_) => "storage_error",
        EngineError::State(_) | EngineError::Json(_) => "invalid_request",
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod worker_completion_tests;
