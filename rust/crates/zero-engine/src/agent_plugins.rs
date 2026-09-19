//! Curated model-facing plugin definitions; this module never grants authority.
use super::*;
use serde_json::{Value, json};
use zero_harness::GenerationPin;
use zero_plugin_runner::Launch;
use zero_protocol::{agent::PluginToolBinding, model::ToolDefinition};

#[derive(Clone)]
pub(super) struct Context {
    pub pin: GenerationPin,
    pub launch: Launch,
    pub tools: Vec<ToolDefinition>,
    pub identity: Value,
    pub workers: std::collections::BTreeMap<String, zero_protocol::plugin::PluginWorkerPolicy>,
}
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}

pub(super) fn capture(
    shared: &Shared,
    session: &zero_protocol::Session,
    request: &zero_protocol::agent::AgentRequest,
) -> Result<Option<Context>, EngineError> {
    let bindings = &request.plugin_tools;
    if bindings.is_empty() {
        return Ok(None);
    }
    if bindings.len() > 32 {
        return Err(error("at most 32 explicit plugin tools may be offered"));
    }
    let mut aliases = std::collections::BTreeSet::new();
    for binding in bindings {
        if binding.alias.is_empty()
            || binding.alias.len() > 64
            || !binding
                .alias
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || binding.alias == "execute_snapshot"
            || !aliases.insert(&binding.alias)
        {
            return Err(error(
                "plugin aliases must be unique provider names and cannot shadow execute_snapshot",
            ));
        }
    }
    let pin = GenerationPin {
        generation: session.generation.clone(),
        epoch: session
            .generation_epoch
            .ok_or_else(|| error("plugin tools require a generation-pinned session"))?,
    };
    let profiles = lock(&shared.plugins)?;
    let profile = profiles
        .as_ref()
        .ok_or_else(|| error("plugins are not configured"))?;
    let mut tools = vec![];
    let mut selected = vec![];
    for binding in bindings {
        if !profile.workers.contains_key(&binding.plugin) {
            offline_graph(
                profile.harness.prepared_graph(&pin).map_err(error)?,
                &binding.plugin,
            )?;
        }
        let (digest, tool) = profile
            .harness
            .tool_definition(&pin, &binding.plugin, &binding.tool)
            .map_err(error)?;
        tools.push(ToolDefinition {
            name: binding.alias.clone(),
            description: tool.description.clone(),
            parameters: serde_json::to_value(&tool.parameters)?,
        });
        let mut capture = json!({"binding":binding,"manifest":digest});
        if profile.workers.contains_key(&binding.plugin) {
            capture["capabilities"] = serde_json::to_value(&tool.capabilities)?;
        }
        selected.push(capture);
    }
    let workers = profile
        .workers
        .iter()
        .filter(|(name, _)| bindings.iter().any(|b| b.plugin == **name))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect::<std::collections::BTreeMap<_, _>>();
    for policy in workers.values() {
        for operation in &policy.operations {
            match operation {
                zero_protocol::plugin::PluginHostOperation::HttpRequest
                    if request.http_profile.is_none() =>
                {
                    return Err(error(
                        "plugin HTTP capability requires original actor HTTP profile",
                    ));
                }
                zero_protocol::plugin::PluginHostOperation::HttpRequest => {}
                _ if !request.source_snapshot_tools
                    && request.source_review_operation_id.is_none() =>
                {
                    return Err(error(
                        "plugin source capability requires original actor source authority",
                    ));
                }
                _ => {}
            }
        }
    }
    let mut identity = json!({"generation":pin.generation,"epoch":pin.epoch,"selected":selected,"launch":profile.launch});
    if !workers.is_empty() {
        identity["workers"] = serde_json::to_value(&workers)?;
    }
    Ok(Some(Context {
        identity,
        workers,
        pin,
        launch: profile.launch.clone(),
        tools,
    }))
}

pub(super) fn current(shared: &Shared, context: &Context) -> Result<(), EngineError> {
    let profiles = lock(&shared.plugins)?;
    let profile = profiles
        .as_ref()
        .ok_or_else(|| error("plugins are not configured"))?;
    if GenerationPin::from_state(&profile.harness.current().map_err(error)?).map_err(error)?
        != context.pin
        || serde_json::to_value(&profile.launch)? != serde_json::to_value(&context.launch)?
        || context.workers.iter().any(|(key, value)| {
            profile.workers.get(key).is_none_or(|host| {
                host.schema_version != value.schema_version
                    || host.max_calls != value.max_calls
                    || host.max_callbacks != value.max_callbacks
                    || value
                        .operations
                        .iter()
                        .any(|op| !host.operations.contains(op))
            })
        })
    {
        return Err(error(
            "agent plugin generation, epoch or host launch changed",
        ));
    }
    Ok(())
}
pub(super) fn validate(
    shared: &Shared,
    context: &Context,
    binding: &PluginToolBinding,
    input: Value,
) -> Result<(), EngineError> {
    let profiles = lock(&shared.plugins)?;
    let profile = profiles
        .as_ref()
        .ok_or_else(|| error("plugins are not configured"))?;
    profile
        .harness
        .validate_call(&context.pin, &binding.plugin, &binding.tool, input)
        .map_err(error)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute(
    shared: &Arc<Shared>,
    session: &str,
    parent: &str,
    command: &str,
    call_id: &str,
    context: &Context,
    binding: &PluginToolBinding,
    input: Value,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    let operation = {
        let mut store = lock(&shared.store)?;
        let admission=store.admit_command(session,command,&json!({"parent_operation":parent,"kind":"agent_plugin","call_id":call_id,"plugin_context":context.identity,"binding":binding,"input":input}))?;
        if admission.duplicate {
            return Err(error(
                "plugin child already admitted; explicit recovery required",
            ));
        }
        store.begin_operation(&admission.operation.id, &shared.owner)?
    };
    execute_admitted(shared, operation, context, binding, input, cancel, events).await
}

/// Execute an already admitted effect, including one atomically linked to an approval.
pub(super) async fn execute_admitted(
    shared: &Arc<Shared>,
    operation: zero_protocol::Operation,
    context: &Context,
    binding: &PluginToolBinding,
    input: Value,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    if operation.status != OperationStatus::Running
        || operation.owner.as_deref() != Some(&shared.owner)
        || operation.payload["kind"] != "agent_plugin"
        || operation.payload["plugin_context"] != context.identity
        || operation.payload["binding"] != serde_json::to_value(binding)?
        || operation.payload["input"] != input
    {
        return Err(error(
            "admitted plugin effect differs from captured invocation",
        ));
    }
    let mut guard = ChildGuard {
        shared,
        operation: operation.id.clone(),
        settled: false,
    };
    let directory = shared.plugin_root.join(&operation.id);
    // This child shares the parent session owner and cancellation token. Its own
    // guard still records uncertainty if preparation or journaling fails.
    let result=async {
        let journal = lock(&shared.store)?.append_operation_event(&operation.id,&shared.owner,"plugin.preparing",&json!({"lease_owner":operation.id,"generation":context.pin.generation,"epoch":context.pin.epoch,"attempt_dir":directory}));
        if let Err(error) = journal {
            let result=zero_protocol::plugin::PluginOutcome {external_effects_started:false,pin:None,sandbox:None,untrusted_reply:None,error:Some(format!("pre-dispatch intent could not be journaled: {error}")),staging_recovery:None,lease_release_journaled_separately:true};
            let operation=lock(&shared.store)?.settle_operation(&operation.id,&shared.owner,OperationStatus::Failed,&serde_json::to_value(&result)?)?;
            return Ok(Reply::Plugin{operation,result:Some(result),duplicate:false});
        }
        plugin::run(shared,&operation.id,context.pin.clone(),binding.plugin.clone(),binding.tool.clone(),input,context.launch.clone(),directory,cancel,events).await
    }.await;
    guard.settled = result.is_ok();
    result
}

struct ChildGuard<'a> {
    shared: &'a Shared,
    operation: String,
    settled: bool,
}
impl Drop for ChildGuard<'_> {
    fn drop(&mut self) {
        if !self.settled {
            if let Ok(mut store) = self.shared.store.lock() {
                let _ = store.mark_operation_unknown(
                    &self.operation,
                    &self.shared.owner,
                    "agent plugin owner failed; effects require reconciliation",
                );
            }
        }
    }
}

/// Mirror the runner's offline closure before offering a tool to the provider.
/// The runner repeats this check against the issued call immediately before staging.
fn offline_graph(graph: &zero_harness::PreparedGraph, plugin: &str) -> Result<(), EngineError> {
    let mut pending = vec![plugin.to_owned()];
    let mut seen = std::collections::BTreeSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let manifest = graph
            .plugin_manifest(&id)
            .ok_or_else(|| error("missing pinned plugin dependency"))?;
        if manifest.capabilities().iter().any(|c| {
            !matches!(
                c,
                zero_plugin::Capability::Compute
                    | zero_plugin::Capability::ProcessExec
                    | zero_plugin::Capability::FilesystemRead
                    | zero_plugin::Capability::FilesystemWrite
            )
        }) {
            return Err(error(
                "only offline disposable-snapshot plugin tools can be offered",
            ));
        }
        if id == plugin
            && manifest.entrypoint.argv.first().map(String::as_str) != Some("{artifact}")
        {
            return Err(error(
                "plugin entrypoint must begin with literal {artifact}",
            ));
        }
        pending.extend(manifest.dependencies.iter().map(|d| d.id.clone()));
    }
    Ok(())
}
