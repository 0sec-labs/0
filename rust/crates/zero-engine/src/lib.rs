//! Session-owned native execution. Client disconnect is not a request replay.
mod agent;
mod agent_approvals;
mod agent_checkpoint;
mod agent_context;
mod agent_context_history;
mod agent_delegation;
mod agent_http;
mod agent_plugins;
mod agent_questions;
mod agent_source;
mod agent_steering;
mod agent_submission;
mod agent_web;
mod agent_web_experiment;
mod budget_read;
mod campaign_read;
mod discovery;
mod history;
mod inference;
mod lifecycle;
mod model_progress;
mod plugin;
mod queue;
mod repair;
mod reproduction;
mod sandbox;
mod source;
mod source_provenance;
mod source_report;
mod strategy;
mod strategy_runtime;
pub use strategy::{
    RecomputedStrategyEvidence, StrategyEligibilityPreparation, VerifiedStrategyEvidence,
    export_strategy_evidence, import_strategy_eligibility, prepare_strategy_eligibility,
    read_strategy_eligibility, read_strategy_eligibility_receipt, reassess_strategy_evidence,
};
pub use strategy::{
    RecomputedStrategySearchEvidence, StrategySearchEligibilityPreparation,
    VerifiedStrategySearchEvidence, export_strategy_search_evidence,
    import_strategy_search_eligibility, prepare_strategy_search_eligibility,
    read_strategy_search_eligibility, read_strategy_search_eligibility_receipt,
    reassess_strategy_search_evidence,
};
pub use strategy_runtime::read_strategy_session;
mod triage;
mod web_experiment;
mod web_experiment_read;
mod web_read;
mod web_triage;
mod web_verification;
mod workflow_provenance;

pub use agent_approvals::{read_tool_approval, read_tool_approval_intent, read_tool_approvals};
pub use agent_http::{read_http_evidence, read_http_operation};
pub use agent_questions::{read_operator_question, read_operator_questions};
pub use agent_steering::read_agent_steering;
pub use budget_read::read_session_budget;
pub use campaign_read::{read_campaign_runs, read_campaign_status};
pub use discovery::{read_source_reviews, read_web_runs};
pub use source_report::{read_source_report, read_source_workflow_report};
pub use strategy::{read_strategy_development_feedback, read_strategy_report};
pub use strategy::{
    read_strategy_search_candidate, read_strategy_search_candidates, read_strategy_search_report,
    read_strategy_search_status,
};
pub use triage::{read_source_finding, read_source_findings};
pub use web_experiment_read::{
    read_web_experiment, read_web_experiments, read_web_workflow_report_with_experiments,
};
pub use web_read::{
    read_http_metadata, read_http_range, read_web_http_operations, read_web_run,
    read_web_workflow_report,
};
pub use web_triage::{read_web_finding, read_web_findings};
pub use web_verification::{prepare_web_verification, read_web_verification};

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
    strategy_campaigns: HashMap<String, CancellationToken>,
    actors: HashMap<String, agent_steering::Target>,
    questions: HashMap<String, agent_questions::Waiter>,
    approvals: HashMap<String, agent_approvals::Waiter>,
}

struct Shared {
    store: Mutex<Store>,
    control: Mutex<Control>,
    workers: Arc<Workers>,
    executor: Arc<DockerExecutor>,
    sandbox: Arc<zero_sandbox::SandboxExecutor>,
    providers: Mutex<HashMap<String, inference::Profile>>,
    plugins: Mutex<Option<plugin::Profile>>,
    strategy_runtime: Mutex<Option<zero_harness::Harness>>,
    http: Mutex<HashMap<String, Arc<zero_http::Client>>>,
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
                for campaign in control.strategy_campaigns.values() {
                    campaign.cancel();
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
                strategy_runtime: Mutex::new(None),
                http: Mutex::new(HashMap::new()),
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
            "provisional_model_progress",
            "chat_completions_inference",
            "anthropic_messages_inference",
            "bounded_offline_snapshot_agent",
            "bounded_joined_subagents",
            "durable_boundary_steering",
            "durable_operator_questions",
            "exact_invocation_tool_approvals",
            "scoped_http_requests",
            "durable_agent_input_queue",
            "explicit_context_projection",
            "generation_pinned_offline_plugins",
            "unverified_source_review",
            "source_hypothesis_triage",
            "bounded_source_review_discovery",
            "host_frozen_source_observation",
            "durable_strategy_campaign_accounting",
            "qualification_only_strategy_evaluation",
            "captured_advisory_strategy_sessions",
            "registry_bound_strategy_campaigns",
            "source_verified_strategy_eligibility",
            "autonomous_development_strategy_search",
            "shared_proposal_evaluation_accounting",
        ]
        .map(String::from)
        .to_vec()
    }

    /// Application requests share one semantics across CLI and stdio clients.
    pub async fn handle(&self, command: Command, event_tx: mpsc::Sender<ExecutionEvent>) -> Reply {
        self.handle_inner(command, event_tx, None).await
    }

    /// Opt into provisional model telemetry on a separate bounded channel.
    /// Keeping this channel separate preserves operational event backpressure.
    pub async fn handle_with_progress(
        &self,
        command: Command,
        event_tx: mpsc::Sender<ExecutionEvent>,
        progress_tx: mpsc::Sender<ExecutionEvent>,
    ) -> Reply {
        if event_tx.same_channel(&progress_tx) {
            return Reply::Error {
                code: "invalid_request".into(),
                message: "model progress requires a separate channel from operational events"
                    .into(),
            };
        }
        self.handle_inner(command, event_tx, Some(progress_tx))
            .await
    }

    async fn handle_inner(
        &self,
        command: Command,
        event_tx: mpsc::Sender<ExecutionEvent>,
        progress_tx: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Reply {
        match self.dispatch(command, event_tx, progress_tx).await {
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
        progress_tx: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<Reply, EngineError> {
        match command {
            Command::CreateStrategySearch { command_id, plan } => {
                return self.create_strategy_search(command_id, *plan);
            }
            Command::RunStrategySearch { campaign_id } => {
                return self
                    .run_strategy_search(campaign_id, event_tx, progress_tx)
                    .await;
            }
            Command::CancelStrategySearch { campaign_id } => {
                return self.cancel_strategy_search(campaign_id);
            }
            Command::StrategySearchStatus { campaign_id } => {
                return self.strategy_search_status(campaign_id);
            }
            Command::StrategySearchReport { campaign_id } => {
                return self.strategy_search_report(campaign_id);
            }
            Command::StrategySearchCandidates {
                campaign_id,
                after_sequence,
                limit,
            } => return self.strategy_search_candidates(campaign_id, after_sequence, limit),
            Command::StrategySearchCandidate {
                campaign_id,
                candidate_id,
            } => return self.strategy_search_candidate(campaign_id, candidate_id),
            Command::CreateStrategySession { budget_limit } => {
                return Ok(Reply::Session {
                    session: self.create_strategy_session(budget_limit)?,
                });
            }
            Command::RunStrategyAgent {
                session_id,
                command_id,
                prompt,
                continuation_of,
            } => {
                return self
                    .run_strategy_agent(
                        session_id,
                        command_id,
                        prompt,
                        continuation_of,
                        event_tx,
                        progress_tx,
                    )
                    .await;
            }
            Command::CreateBoundStrategyCampaign {
                command_id,
                plan,
                candidate_generation,
            } => {
                return self.create_bound_strategy_campaign(
                    command_id,
                    *plan,
                    candidate_generation,
                );
            }
            Command::CreateStrategyCampaign { command_id, plan } => {
                return self.create_strategy_campaign(command_id, *plan);
            }
            Command::RunStrategyCampaign { campaign_id, lane } => {
                return self
                    .run_strategy_campaign(campaign_id, lane, event_tx, progress_tx)
                    .await;
            }
            Command::StrategyCampaignReport { campaign_id } => {
                return self.strategy_campaign_report(campaign_id);
            }
            Command::StrategyDevelopmentFeedback { campaign_id } => {
                return self.strategy_development_feedback(campaign_id);
            }
            Command::CancelStrategyCampaign { campaign_id } => {
                return self.cancel_strategy_campaign(campaign_id);
            }
            _ => {}
        }
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
                .review_source(session_id, command_id, request, event_tx, progress_tx)
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
        if let Command::RunQueuedAgent {
            session_id,
            input_id,
        } = command
        {
            return self
                .run_queued_agent(session_id, input_id, event_tx, progress_tx)
                .await;
        }
        if let Command::PrepareWebVerification { session_id, plan } = command {
            return self.prepare_web_verification(session_id, plan);
        }
        if let Command::VerifyWebHypothesis {
            session_id,
            command_id,
            request,
        } = command
        {
            return self
                .verify_web_hypothesis(session_id, command_id, request, event_tx)
                .await;
        }
        if let Command::RunAgent {
            session_id,
            command_id,
            request,
        } = command
        {
            return self
                .run_agent(session_id, command_id, request, event_tx, progress_tx)
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
                    progress_tx,
                )
                .await;
        }
        if let Command::DecideToolApproval {
            session_id,
            command_id,
            approval_operation_id,
            expected_intent_sha256,
            decision,
        } = command
        {
            return self.decide_tool_approval(
                &session_id,
                &command_id,
                &approval_operation_id,
                &expected_intent_sha256,
                &decision,
            );
        }
        if let Command::DecideOperatorQuestion {
            session_id,
            command_id,
            question_operation_id,
            expected_request_sha256,
            decision,
        } = command
        {
            return self.decide_operator_question(
                &session_id,
                &command_id,
                &question_operation_id,
                &expected_request_sha256,
                &decision,
            );
        }
        if let Command::SteerAgent {
            session_id,
            operation_id,
            command_id,
            prompt,
        } = command
        {
            return self.steer_agent(&session_id, &operation_id, &command_id, &prompt);
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
            Command::QueueAgent {
                session_id,
                command_id,
                request,
                after_input,
            } => {
                agent::validate_initial(&request)?;
                let (input, duplicate) = lock(&self.shared.store)?.enqueue_agent(
                    &session_id,
                    &command_id,
                    &request,
                    &after_input,
                )?;
                Ok(Reply::AgentQueued { input, duplicate })
            }
            Command::AgentQueue {
                session_id,
                after_sequence,
                limit,
            } => Ok(Reply::AgentQueue {
                inputs: lock(&self.shared.store)?.queued_agents(
                    &session_id,
                    after_sequence,
                    limit,
                )?,
            }),
            Command::CancelQueuedAgent {
                session_id,
                input_id,
            } => Ok(Reply::AgentInput {
                input: lock(&self.shared.store)?.cancel_queued_agent(&session_id, &input_id)?,
            }),
            Command::ToolApprovals {
                session_id,
                root_operation_id,
                after_sequence,
                limit,
            } => Ok(Reply::ToolApprovals {
                approvals: lock(&self.shared.store)?.tool_approvals(
                    &session_id,
                    root_operation_id.as_deref(),
                    after_sequence,
                    limit,
                )?,
            }),
            Command::ToolApproval {
                session_id,
                approval_operation_id,
            } => Ok(Reply::ToolApproval {
                approval: lock(&self.shared.store)?
                    .get_tool_approval(&session_id, &approval_operation_id)?,
            }),
            Command::OperatorQuestions {
                session_id,
                root_operation_id,
                after_sequence,
                limit,
            } => Ok(Reply::OperatorQuestions {
                questions: lock(&self.shared.store)?.operator_questions(
                    &session_id,
                    root_operation_id.as_deref(),
                    after_sequence,
                    limit,
                )?,
            }),
            Command::OperatorQuestion {
                session_id,
                question_operation_id,
            } => Ok(Reply::OperatorQuestion {
                question: lock(&self.shared.store)?
                    .get_operator_question(&session_id, &question_operation_id)?,
            }),
            Command::AgentSteering {
                session_id,
                operation_id,
                after_sequence,
                limit,
            } => Ok(Reply::AgentSteering {
                messages: lock(&self.shared.store)?.agent_steering(
                    &session_id,
                    &operation_id,
                    after_sequence,
                    limit,
                )?,
            }),
            Command::WebExperiments {
                session_id,
                web_operation_id,
                after_sequence,
                limit,
            } => {
                let store = lock(&self.shared.store)?;
                Ok(Reply::WebExperiments {
                    page: web_experiment_read::experiments(
                        &store,
                        &session_id,
                        &web_operation_id,
                        after_sequence,
                        limit,
                    )?,
                })
            }
            Command::WebExperiment {
                session_id,
                web_operation_id,
                experiment_operation_id,
            } => {
                let store = lock(&self.shared.store)?;
                Ok(Reply::WebExperiment {
                    experiment: web_experiment_read::experiment(
                        &store,
                        &session_id,
                        &web_operation_id,
                        &experiment_operation_id,
                    )?,
                })
            }
            Command::WebRuns {
                session_id,
                before_sequence,
                limit,
            } => Ok(Reply::WebRuns {
                page: lock(&self.shared.store)?.web_runs(&session_id, before_sequence, limit)?,
            }),
            Command::WebRun {
                session_id,
                operation_id,
            } => {
                let store = lock(&self.shared.store)?;
                Ok(Reply::WebRun {
                    run: agent_web::load_run(&store, &session_id, &operation_id)?,
                })
            }
            Command::WebHttpOperations {
                session_id,
                web_operation_id,
                after_sequence,
                limit,
            } => {
                let store = lock(&self.shared.store)?;
                Ok(Reply::WebHttpOperations {
                    page: web_read::http_operations(
                        &store,
                        &session_id,
                        &web_operation_id,
                        after_sequence,
                        limit,
                    )?,
                })
            }
            Command::HttpEvidence {
                session_id,
                operation_id,
            } => {
                let store = lock(&self.shared.store)?;
                Ok(Reply::HttpEvidence {
                    evidence: web_read::http_evidence(&store, &session_id, &operation_id)?.0,
                })
            }
            Command::HttpEvidenceRange {
                session_id,
                operation_id,
                expected_manifest_sha256,
                offset,
                limit,
            } => {
                let store = lock(&self.shared.store)?;
                Ok(Reply::HttpEvidenceRange {
                    range: web_read::http_range(
                        &store,
                        &session_id,
                        &operation_id,
                        &expected_manifest_sha256,
                        offset,
                        limit,
                    )?,
                })
            }
            Command::WebWorkflowReport {
                session_id,
                operation_id,
                verification_ids,
                experiment_ids,
            } => {
                let store = lock(&self.shared.store)?;
                Ok(Reply::WebWorkflowReport {
                    report: web_experiment_read::workflow_report(
                        &store,
                        &session_id,
                        &operation_id,
                        &verification_ids,
                        &experiment_ids,
                    )?,
                })
            }
            Command::SourceReviews {
                session_id,
                before_sequence,
                limit,
            } => Ok(Reply::SourceReviews {
                page: lock(&self.shared.store)?.source_reviews(
                    &session_id,
                    before_sequence,
                    limit,
                )?,
            }),
            Command::WebFindings {
                session_id,
                web_operation_id,
                offset,
                limit,
            } => {
                let store = lock(&self.shared.store)?;
                Ok(Reply::WebFindings {
                    findings: web_triage::findings(
                        &store,
                        &session_id,
                        &web_operation_id,
                        offset,
                        limit,
                    )?,
                })
            }
            Command::WebFinding {
                session_id,
                web_operation_id,
                hypothesis_id,
                after_revision,
                limit,
            } => {
                let store = lock(&self.shared.store)?;
                let (finding, history) = web_triage::finding(
                    &store,
                    &session_id,
                    &web_operation_id,
                    &hypothesis_id,
                    after_revision,
                    limit,
                )?;
                Ok(Reply::WebFinding { finding, history })
            }
            Command::TriageWebFinding {
                session_id,
                command_id,
                web_operation_id,
                hypothesis_id,
                status,
                expected_revision,
                note,
            } => {
                let mut store = lock(&self.shared.store)?;
                web_triage::decide(
                    &mut store,
                    &session_id,
                    &command_id,
                    &web_operation_id,
                    &hypothesis_id,
                    status,
                    expected_revision,
                    &note,
                )
            }
            Command::SourceFindings {
                session_id,
                source_operation_id,
                offset,
                limit,
            } => {
                let store = lock(&self.shared.store)?;
                Ok(Reply::SourceFindings {
                    findings: triage::findings(
                        &store,
                        &session_id,
                        &source_operation_id,
                        offset,
                        limit,
                    )?,
                })
            }
            Command::SourceFinding {
                session_id,
                source_operation_id,
                hypothesis_id,
                after_revision,
                limit,
            } => {
                let store = lock(&self.shared.store)?;
                let (finding, history) = triage::finding(
                    &store,
                    &session_id,
                    &source_operation_id,
                    &hypothesis_id,
                    after_revision,
                    limit,
                )?;
                Ok(Reply::SourceFinding { finding, history })
            }
            Command::TriageSourceFinding {
                session_id,
                command_id,
                source_operation_id,
                hypothesis_id,
                status,
                expected_revision,
                note,
            } => {
                let mut store = lock(&self.shared.store)?;
                triage::decide(
                    &mut store,
                    &session_id,
                    &command_id,
                    &source_operation_id,
                    &hypothesis_id,
                    status,
                    expected_revision,
                    &note,
                )
            }
            Command::SessionListPage { after, limit } => self.session_list_page(after, limit),
            Command::SessionHistory {
                session_id,
                before_sequence,
                limit,
            } => self.session_history(&session_id, before_sequence, limit),
            Command::SessionList => Ok(Reply::Sessions {
                sessions: lock(&self.shared.store)?.list_sessions()?,
            }),
            Command::SessionGet { session_id } => Ok(Reply::Session {
                session: lock(&self.shared.store)?.get_session(&session_id)?,
            }),
            Command::CampaignStatus { campaign_id } => Ok(Reply::CampaignStatus {
                snapshot: lock(&self.shared.store)?.campaign(&campaign_id)?,
            }),
            Command::CampaignRuns {
                campaign_id,
                after_sequence,
                limit,
            } => Ok(Reply::CampaignRuns {
                page: lock(&self.shared.store)?.campaign_runs(
                    &campaign_id,
                    after_sequence,
                    limit,
                )?,
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
            Command::CreateStrategySearch { .. }
            | Command::RunStrategySearch { .. }
            | Command::CancelStrategySearch { .. }
            | Command::StrategySearchStatus { .. }
            | Command::StrategySearchReport { .. }
            | Command::StrategySearchCandidates { .. }
            | Command::StrategySearchCandidate { .. }
            | Command::CreateStrategySession { .. }
            | Command::RunStrategyAgent { .. }
            | Command::CreateBoundStrategyCampaign { .. }
            | Command::CreateStrategyCampaign { .. }
            | Command::RunStrategyCampaign { .. }
            | Command::StrategyCampaignReport { .. }
            | Command::StrategyDevelopmentFeedback { .. }
            | Command::CancelStrategyCampaign { .. }
            | Command::Execute { .. }
            | Command::SteerAgent { .. }
            | Command::DecideOperatorQuestion { .. }
            | Command::DecideToolApproval { .. }
            | Command::Infer { .. }
            | Command::ReproduceSource { .. }
            | Command::ValidateSourceRepair { .. }
            | Command::ReviewSource { .. }
            | Command::PrepareWebVerification { .. }
            | Command::VerifyWebHypothesis { .. }
            | Command::RunAgent { .. }
            | Command::RunQueuedAgent { .. }
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
            for campaign in control.strategy_campaigns.values() {
                campaign.cancel();
            }
        }
        loop {
            let notified = self.shared.workers.changed.notified();
            let drained = {
                let control = lock(&self.shared.control)?;
                control.active.is_empty() && control.strategy_campaigns.is_empty()
            };
            if drained && self.shared.workers.count.load(Ordering::Acquire) == 0 {
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
            for campaign in control.strategy_campaigns.values() {
                campaign.cancel();
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
