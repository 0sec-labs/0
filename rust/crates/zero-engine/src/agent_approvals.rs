//! Explicit permission for one frozen offline invocation; never a broader grant.
use super::*;
use serde_json::{Value, json};
use zero_protocol::{
    Operation,
    agent::{AgentRequest, PluginToolBinding},
    approvals::*,
    sandbox::SandboxRequest,
};
mod receipt;
pub(super) use receipt::validate_receipt;
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn hash(value: &impl serde::Serialize) -> Result<String, EngineError> {
    Ok(format!(
        "sha256:{}",
        zero_plugin::sha256(&serde_json::to_vec(value)?)
    ))
}
const DENIED: &str = "Tool rejected: operator denied this exact invocation.";

pub fn read_tool_approvals(
    path: &Path,
    session: &str,
    root: Option<&str>,
    after: u64,
    limit: u32,
) -> Result<Vec<ToolApprovalRecord>, EngineError> {
    Ok(Store::open_read_only(path)?.tool_approvals(session, root, after, limit)?)
}
pub fn read_tool_approval(
    path: &Path,
    session: &str,
    id: &str,
) -> Result<ToolApprovalRecord, EngineError> {
    Ok(Store::open_read_only(path)?.get_tool_approval(session, id)?)
}
pub fn read_tool_approval_intent(
    path: &Path,
    session: &str,
    id: &str,
) -> Result<Value, EngineError> {
    Ok(Store::open_read_only(path)?.tool_approval_intent(session, id)?)
}

pub(super) fn required(request: &AgentRequest, name: &str) -> bool {
    request
        .tool_approval_policy
        .as_ref()
        .is_some_and(|p| p.require_approval.iter().any(|n| n == name))
}
pub(super) fn inherited(parent: &AgentRequest, tools: &[String]) -> Option<ToolApprovalPolicy> {
    let require_approval = parent
        .tool_approval_policy
        .as_ref()?
        .require_approval
        .iter()
        .filter(|name| tools.contains(name))
        .cloned()
        .collect::<Vec<_>>();
    (!require_approval.is_empty()).then_some(ToolApprovalPolicy { require_approval })
}
pub(super) fn validate_policy(request: &AgentRequest) -> Result<(), EngineError> {
    let Some(policy) = &request.tool_approval_policy else {
        return Ok(());
    };
    policy.validate().map_err(error)?;
    if required(request, "execute_snapshot") {
        immutable_backend(&request.execution.sandbox_request().backend)?;
    }
    for name in &policy.require_approval {
        let native_non_effect = (name == "ask_operator" && request.operator_questions)
            || (name == "delegate_tasks" && request.delegation_policy.is_some())
            || (name == "submit_source_hypotheses"
                && request.source_submission_max_hypotheses.is_some())
            || (agent_source::is_tool(name)
                && (request.source_snapshot_tools || request.source_review_operation_id.is_some()));
        if native_non_effect
            || (name != "execute_snapshot"
                && !request.plugin_tools.iter().any(|b| &b.alias == name))
        {
            return Err(error(
                "approval policy supports only execute_snapshot and explicitly offered offline plugin aliases",
            ));
        }
    }
    Ok(())
}

pub(super) fn immutable_backend(
    backend: &zero_protocol::sandbox::SandboxBackend,
) -> Result<(), EngineError> {
    if let zero_protocol::sandbox::SandboxBackend::Docker { image } = backend {
        let digest = image
            .rsplit_once('@')
            .map_or(image.as_str(), |(_, digest)| digest);
        if !zero_protocol::is_sha256(digest) {
            return Err(error(
                "tool approvals require an immutable Docker image: use a sha256 image ID or name@sha256 digest; mutable tags cannot be approved",
            ));
        }
    }
    Ok(())
}
pub(super) fn validate_plugins(
    request: &AgentRequest,
    context: Option<&agent_plugins::Context>,
) -> Result<(), EngineError> {
    if request
        .plugin_tools
        .iter()
        .any(|binding| required(request, &binding.alias))
    {
        immutable_backend(
            &context
                .ok_or_else(|| error("approval plugin context missing"))?
                .launch
                .backend,
        )?;
    }
    Ok(())
}

pub(super) enum Effect {
    Snapshot(SandboxRequest),
    Plugin {
        context: agent_plugins::Context,
        binding: PluginToolBinding,
        input: Value,
    },
}
impl Effect {
    fn payload(&self, actor: &str, call: &str) -> Value {
        match self {
            Self::Snapshot(request) => {
                json!({"parent_operation":actor,"kind":"agent_tool","call_id":call,"request":request})
            }
            Self::Plugin {
                context,
                binding,
                input,
            } => {
                json!({"parent_operation":actor,"kind":"agent_plugin","call_id":call,"plugin_context":context.identity,"binding":binding,"input":input})
            }
        }
    }
    fn revalidate(&self, shared: &Shared) -> Result<(), EngineError> {
        match self {
            Self::Snapshot(request) => request.validate().map_err(error),
            Self::Plugin {
                context,
                binding,
                input,
            } => {
                agent_plugins::current(shared, context)?;
                agent_plugins::validate(shared, context, binding, input.clone())
            }
        }
    }
}
pub(super) enum ResultKind {
    Output(String),
    Cancelled,
    Unknown(String),
    Failed(String),
}
pub(super) struct Waiter {
    session: String,
    actor: String,
    root: String,
    cancel: CancellationToken,
    changed: Arc<Notify>,
}
struct Guard {
    shared: Arc<Shared>,
    session: String,
    approval: String,
    effect: Option<String>,
    settled: bool,
}
impl Drop for Guard {
    fn drop(&mut self) {
        if let Ok(mut control) = self.shared.control.lock() {
            control.approvals.remove(&self.approval);
            if !self.settled {
                if let Ok(mut store) = self.shared.store.lock() {
                    if let Some(effect) = &self.effect {
                        let _ = store.mark_operation_unknown(
                            effect,
                            &self.shared.owner,
                            "approved effect owner failed; reconcile before further work",
                        );
                        let _ = store.mark_operation_unknown(
                            &self.approval,
                            &self.shared.owner,
                            "approved effect outcome uncertain",
                        );
                    } else if store
                        .cancel_tool_approval(&self.session, &self.approval, &self.shared.owner)
                        .is_err()
                    {
                        control.closing = true;
                    }
                } else {
                    control.closing = true;
                }
            }
        }
    }
}
impl Engine {
    pub(super) fn decide_tool_approval(
        &self,
        session: &str,
        command: &str,
        approval: &str,
        digest: &str,
        decision: &ToolApprovalDecision,
    ) -> Result<Reply, EngineError> {
        let control = lock(&self.shared.control)?;
        let mut store = lock(&self.shared.store)?;
        if let Some(prior) = store.tool_approval_decision_by_command(session, command)? {
            if prior.approval_operation_id != approval
                || prior.intent_sha256 != digest
                || &prior.decision != decision
            {
                return Err(error("approval command retry changed exact intent"));
            }
            return Ok(Reply::ToolApprovalDecided {
                approval: store.get_tool_approval(session, approval)?,
                decision: prior,
                duplicate: true,
            });
        }
        let waiter = control
            .approvals
            .get(approval)
            .ok_or_else(|| error("approval is not owned by a waiting live actor"))?;
        let actor = store.get_operation(&waiter.actor)?;
        let root = store.get_operation(&waiter.root)?;
        if control.closing
            || waiter.session != session
            || waiter.cancel.is_cancelled()
            || actor.status != OperationStatus::Running
            || actor.owner.as_deref() != Some(&self.shared.owner)
            || root.status != OperationStatus::Running
            || !control
                .active
                .get(session)
                .is_some_and(|a| a.command_id == root.command_id && !a.cancel.is_cancelled())
        {
            return Err(error("approval actor is no longer live"));
        }
        let (approval, decision, duplicate) = store.decide_tool_approval(
            session,
            command,
            approval,
            digest,
            decision,
            &self.shared.owner,
        )?;
        waiter.changed.notify_one();
        Ok(Reply::ToolApprovalDecided {
            approval,
            decision,
            duplicate,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    shared: &Arc<Shared>,
    session: &str,
    actor: &str,
    command: &str,
    origin: &Operation,
    call: &str,
    name: &str,
    effect: Effect,
    cancel: &CancellationToken,
    events: &mpsc::Sender<ExecutionEvent>,
) -> Result<ResultKind, EngineError> {
    let payload = effect.payload(actor, call);
    let changed = Arc::new(Notify::new());
    let (record, mut guard) = {
        let mut control = lock(&shared.control)?;
        if control.closing || cancel.is_cancelled() {
            return Ok(ResultKind::Cancelled);
        }
        let record = lock(&shared.store)?.create_tool_approval(
            session,
            actor,
            &shared.owner,
            command,
            &origin.id,
            call,
            name,
            &payload,
        )?;
        control.approvals.insert(
            record.operation_id.clone(),
            Waiter {
                session: session.into(),
                actor: actor.into(),
                root: record.root_operation_id.clone(),
                cancel: cancel.clone(),
                changed: Arc::clone(&changed),
            },
        );
        let guard = Guard {
            shared: Arc::clone(shared),
            session: session.into(),
            approval: record.operation_id.clone(),
            effect: None,
            settled: false,
        };
        (record, guard)
    };
    if events
        .try_send(ExecutionEvent::ToolApprovalRequested {
            session_id: session.into(),
            root_operation_id: record.root_operation_id.clone(),
            actor_operation_id: actor.into(),
            approval_operation_id: record.operation_id.clone(),
        })
        .is_err()
    {
        cancel.cancel();
    }
    loop {
        let notified = changed.notified();
        let status = {
            let mut store = lock(&shared.store)?;
            if cancel.is_cancelled() {
                store.cancel_tool_approval(session, &record.operation_id, &shared.owner)?;
                guard.settled = true;
                return Ok(ResultKind::Cancelled);
            }
            store
                .get_tool_approval(session, &record.operation_id)?
                .status
        };
        match status {
            ToolApprovalStatus::Denied => {
                let store = lock(&shared.store)?;
                let wrapper = store.get_operation(&record.operation_id)?;
                let output = validate_receipt(&store, &wrapper)?;
                guard.settled = true;
                return Ok(ResultKind::Output(output));
            }
            ToolApprovalStatus::Approved => break,
            ToolApprovalStatus::Pending => {}
            _ => return Err(error("approval ended without a consumable decision")),
        }
        tokio::select! {biased;_=cancel.cancelled()=>{},_=notified=>{}}
    }
    if let Err(reason) = effect.revalidate(shared) {
        lock(&shared.store)?.cancel_tool_approval(session, &record.operation_id, &shared.owner)?;
        guard.settled = true;
        return Ok(ResultKind::Failed(format!(
            "approved invocation is no longer valid: {reason}"
        )));
    }
    let operation = {
        let control = lock(&shared.control)?;
        let mut store = lock(&shared.store)?;
        if control.closing || cancel.is_cancelled() {
            store.cancel_tool_approval(session, &record.operation_id, &shared.owner)?;
            guard.settled = true;
            return Ok(ResultKind::Cancelled);
        }
        store.consume_tool_approval(
            session,
            &record.operation_id,
            &shared.owner,
            &record.intent_sha256,
            &format!("{command}:effect"),
            &payload,
        )?
    };
    guard.effect = Some(operation.id.clone());
    let reply = match effect {
        Effect::Snapshot(request) => {
            sandbox::run_sandbox_owned(
                shared,
                &operation.id,
                request,
                cancel.clone(),
                events.clone(),
            )
            .await?
        }
        Effect::Plugin {
            context,
            binding,
            input,
        } => {
            agent_plugins::execute_admitted(
                shared,
                operation,
                &context,
                &binding,
                input,
                cancel.clone(),
                events.clone(),
            )
            .await?
        }
    };
    let operation = match reply {
        Reply::Sandbox { operation, .. } | Reply::Plugin { operation, .. } => operation,
        _ => return Err(error("approved effect returned an unexpected reply")),
    };
    let (status, output) = receipt::effect_output(&operation)?;
    let value = receipt::settlement(&record, &operation, output.as_deref())?;
    {
        let mut store = lock(&shared.store)?;
        if status == OperationStatus::Unknown {
            store.mark_operation_unknown_with_outcome(
                &record.operation_id,
                &shared.owner,
                &value,
            )?;
        } else {
            store.settle_operation(&record.operation_id, &shared.owner, status, &value)?;
        }
    }
    guard.settled = true;
    if status == OperationStatus::Unknown {
        return Ok(ResultKind::Unknown(
            "approved effect cleanup or completion is uncertain".into(),
        ));
    }
    if cancel.is_cancelled() || status == OperationStatus::Cancelled {
        return Ok(ResultKind::Cancelled);
    }
    Ok(ResultKind::Output(output.ok_or_else(|| {
        error("settled approved effect lacks tool output")
    })?))
}
