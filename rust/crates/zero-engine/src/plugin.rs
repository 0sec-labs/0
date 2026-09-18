use super::*;
use serde_json::{Value, json};
use zero_harness::{GenerationPin, Harness, PinnedCall};
use zero_plugin_runner::{Launch, Runner, UntrustedReply};
use zero_protocol::plugin::{PluginOutcome, PluginPin, UntrustedPluginReply};
pub(super) struct Profile {
    pub(super) harness: Harness,
    pub(super) launch: Launch,
}
fn state(error: impl std::fmt::Display) -> EngineError {
    EngineError::State(error.to_string())
}
fn pin(call: &PinnedCall) -> PluginPin {
    let p = call.pin();
    PluginPin {
        generation: p.generation.generation,
        epoch: p.generation.epoch,
        lease_id: p.lease_id,
        lease_owner: call.lease().owner.clone(),
        plugin_manifest: p.plugin_manifest,
    }
}
impl Engine {
    pub fn configure_plugins(&self, harness: Harness, launch: Launch) -> Result<(), EngineError> {
        launch.validate().map_err(state)?;
        let control = lock(&self.shared.control)?;
        if control.closing || !control.active.is_empty() {
            return Err(state("plugin configuration requires idle engine"));
        }
        GenerationPin::from_state(&harness.current().map_err(state)?).map_err(state)?;
        let mut profile = lock(&self.shared.plugins)?;
        if profile.is_some() {
            return Err(state("plugins already configured"));
        }
        *profile = Some(Profile { harness, launch });
        Ok(())
    }
    pub(super) fn create_pinned_session(&self, budget: u64) -> Result<Reply, EngineError> {
        let profiles = lock(&self.shared.plugins)?;
        let profile = profiles
            .as_ref()
            .ok_or_else(|| state("plugins are not configured"))?;
        let pin =
            GenerationPin::from_state(&profile.harness.current().map_err(state)?).map_err(state)?;
        Ok(Reply::Session {
            session: lock(&self.shared.store)?.create_pinned_session(
                &pin.generation,
                pin.epoch,
                budget,
            )?,
        })
    }
    pub(super) async fn run_plugin(
        &self,
        session_id: String,
        command_id: String,
        plugin: String,
        tool: String,
        input: Value,
        event_tx: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            if control.closing {
                return Err(state("engine is shutting down"));
            }
            if control
                .active
                .get(&session_id)
                .is_some_and(|a| a.command_id != command_id)
            {
                return Err(state("session already has an active operation"));
            }
            if control.active.len() >= 64 && !control.active.contains_key(&session_id) {
                return Err(state("engine active operation limit reached"));
            }
            let profiles = lock(&self.shared.plugins)?;
            let profile = profiles
                .as_ref()
                .ok_or_else(|| state("plugins are not configured"))?;
            let mut store = lock(&self.shared.store)?;
            let session = store.get_session(&session_id)?;
            let epoch = session
                .generation_epoch
                .ok_or_else(|| state("plugin calls require a pinned session"))?;
            let expected = GenerationPin {
                generation: session.generation,
                epoch,
            };
            let payload = json!({"kind":"offline_pinned_plugin","generation":expected.generation,"epoch":expected.epoch,"plugin":plugin,"tool":tool,"input":input,"launch":profile.launch});
            // Exact retry remains replayable after a later activation. Only NEW
            // admissions require the current generation/epoch to still match.
            match store.get_operation_by_command(&session_id, &command_id) {
                Ok(_) => {
                    let admission = store.admit_command(&session_id, &command_id, &payload)?;
                    let result = admission
                        .operation
                        .outcome
                        .clone()
                        .and_then(|v| serde_json::from_value(v).ok());
                    return Ok(Reply::Plugin {
                        operation: admission.operation,
                        result,
                        duplicate: true,
                    });
                }
                Err(zero_store::Error::NotFound(_)) => {}
                Err(error) => return Err(error.into()),
            }
            if GenerationPin::from_state(&profile.harness.current().map_err(state)?)
                .map_err(state)?
                != expected
            {
                return Err(state("stale plugin session generation/epoch"));
            }
            let admission = store.admit_command(&session_id, &command_id, &payload)?;
            let operation = store.begin_operation(&admission.operation.id, &self.shared.owner)?;
            let directory = self.shared.plugin_root.join(&operation.id);
            if let Err(error)=store.append_operation_event(&operation.id,&self.shared.owner,"plugin.preparing",&json!({"lease_owner":operation.id,"generation":expected.generation,"epoch":expected.epoch,"attempt_dir":directory})) {
                let result=PluginOutcome{external_effects_started:false,pin:None,sandbox:None,untrusted_reply:None,error:Some(format!("pre-dispatch intent could not be journaled: {error}")),staging_recovery:None,lease_release_journaled_separately:true};
                match store.settle_operation(&operation.id,&self.shared.owner,OperationStatus::Failed,&serde_json::to_value(&result)?) {
                    Ok(operation)=>return Ok(Reply::Plugin{operation,result:Some(result),duplicate:false}),
                    Err(error)=>{
                        control.closing=true;
                        for active in control.active.values(){active.cancel.cancel();}
                        let _=store.mark_operation_unknown(&operation.id,&self.shared.owner,"pre-dispatch journal/settlement failure; no plugin effects started; admission closed");
                        return Err(error.into());
                    }
                }
            }
            let launch = profile.launch.clone();
            drop(store);
            drop(profiles);
            let cancel = CancellationToken::new();
            control.active.insert(
                session_id.clone(),
                Active {
                    command_id: command_id.clone(),
                    execution_id: command_id.clone(),
                    cancel: cancel.clone(),
                },
            );
            emit_admission(&event_tx, &operation, &command_id, &cancel);
            let (sender, receiver) = oneshot::channel();
            let shared = Arc::clone(&self.shared);
            tokio::spawn(async move {
                let mut guard =
                    WorkerGuard::new(&shared, &session_id, &operation.id, cancel.clone());
                let result = run(
                    &shared,
                    &operation.id,
                    expected,
                    plugin,
                    tool,
                    input,
                    launch,
                    directory,
                    cancel,
                    event_tx,
                )
                .await;
                guard.settled = result.is_ok();
                drop(guard);
                let _ = sender.send(result);
            });
            receiver
        };
        receiver
            .await
            .map_err(|_| state("plugin owner stopped before settlement"))?
    }
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    shared: &Arc<Shared>,
    operation: &str,
    expected: GenerationPin,
    plugin: String,
    tool: String,
    input: Value,
    launch: Launch,
    directory: PathBuf,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
) -> Result<Reply, EngineError> {
    // Intent naming this private root/operation path is durable before creation.
    if let Err(error) = private_root(&shared.plugin_root) {
        return settle(
            shared,
            operation,
            PluginOutcome {
                external_effects_started: false,
                pin: None,
                sandbox: None,
                untrusted_reply: None,
                error: Some(error.to_string()),
                staging_recovery: None,
                lease_release_journaled_separately: true,
            },
            OperationStatus::Failed,
        );
    }
    let prepared = {
        let mut profiles = lock(&shared.plugins)?;
        let profile = profiles
            .as_mut()
            .ok_or_else(|| state("plugin profile disappeared"))?;
        let call = match profile
            .harness
            .begin_call(&expected, operation, &plugin, &tool, input)
        {
            Ok(call) => call,
            Err(error) => {
                return settle(
                    shared,
                    operation,
                    PluginOutcome {
                        external_effects_started: false,
                        pin: None,
                        sandbox: None,
                        untrusted_reply: None,
                        error: Some(error.to_string()),
                        staging_recovery: None,
                        lease_release_journaled_separately: true,
                    },
                    OperationStatus::Failed,
                );
            }
        };
        let runner = Runner::new((*shared.sandbox).clone());
        match runner.prepare_in(&profile.harness, call, &plugin, launch.clone(), &directory) {
            Ok(prepared) => prepared,
            Err(mut rejected) => {
                let cleanup = rejected
                    .owned_staging
                    .as_ref()
                    .is_none_or(|path| std::fs::remove_dir_all(path).is_ok());
                let preserved = if rejected.owned_staging.is_none() {
                    directory.exists()
                } else {
                    !cleanup
                };
                let result = PluginOutcome {
                    external_effects_started: false,
                    pin: Some(pin(&rejected.call)),
                    sandbox: None,
                    untrusted_reply: None,
                    error: Some(rejected.error.to_string()),
                    staging_recovery: preserved.then(|| directory.display().to_string()),
                    lease_release_journaled_separately: true,
                };
                let reply = settle(shared, operation, result, OperationStatus::Failed)?;
                if cleanup {
                    let released = profile
                        .harness
                        .complete_settled(&mut rejected.call)
                        .map_err(state);
                    journal_release(shared, operation, released)?;
                }
                return Ok(reply);
            }
        }
    };
    let pinned = pin(prepared.call());
    let request_digest = prepared.request_digest().map_err(state)?;
    lock(&shared.store)?.append_operation_event(operation,&shared.owner,"plugin.prepared",&json!({"pin":pinned,"execution_id":prepared.execution_id(),"staging_path":prepared.staging_path(),"request_digest":request_digest,"launch":launch}))?;
    let unavailable = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = unavailable.clone();
    let stop = cancel.clone();
    let sink = Arc::new(move |event| {
        if events.try_send(ExecutionEvent::Sandbox { event }).is_err() {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            stop.cancel();
        }
    });
    let mut outcome = match prepared.start(cancel.clone(), sink).wait().await {
        Ok(outcome) => outcome,
        Err(error) => {
            return settle(
                shared,
                operation,
                PluginOutcome {
                    external_effects_started: true,
                    pin: Some(pinned),
                    sandbox: None,
                    untrusted_reply: None,
                    error: Some(format!("plugin supervisor failed: {error}")),
                    staging_recovery: Some(directory.display().to_string()),
                    lease_release_journaled_separately: true,
                },
                OperationStatus::Unknown,
            );
        }
    };
    let settled = outcome.backend_settled();
    let (untrusted_reply, error) = match outcome.reply {
        Ok(UntrustedReply::Result(value)) => (Some(UntrustedPluginReply::Result { value }), None),
        Ok(UntrustedReply::Error(error)) => (
            Some(UntrustedPluginReply::Error {
                code: error.code,
                message: error.message,
            }),
            None,
        ),
        Err(error) => (None, Some(error.to_string())),
    };
    let unavailable = unavailable.load(std::sync::atomic::Ordering::Relaxed);
    let status = if !settled {
        OperationStatus::Unknown
    } else if cancel.is_cancelled() || unavailable {
        OperationStatus::Cancelled
    } else if matches!(untrusted_reply, Some(UntrustedPluginReply::Result { .. })) {
        OperationStatus::Succeeded
    } else {
        OperationStatus::Failed
    };
    let result = PluginOutcome {
        external_effects_started: true,
        pin: Some(pinned),
        sandbox: outcome.sandbox,
        untrusted_reply,
        error: if unavailable {
            Some("event consumer unavailable; plugin cancelled".into())
        } else {
            error
        },
        staging_recovery: outcome.staging_recovery.map(|p| p.display().to_string()),
        lease_release_journaled_separately: true,
    };
    // This is NOT a cross-database transaction: durable execution settlement
    // precedes release in evolution. The post-release detail is independently durable.
    let reply = settle(shared, operation, result, status)?;
    if settled {
        let released = {
            let mut profiles = lock(&shared.plugins)?;
            profiles
                .as_mut()
                .ok_or_else(|| state("plugins disappeared"))?
                .harness
                .complete_settled(&mut outcome.call)
                .map_err(state)
        };
        journal_release(shared, operation, released)?;
    }
    Ok(reply)
}
fn settle(
    shared: &Shared,
    id: &str,
    result: PluginOutcome,
    status: OperationStatus,
) -> Result<Reply, EngineError> {
    let value = serde_json::to_value(&result)?;
    let mut store = lock(&shared.store)?;
    let operation = if status == OperationStatus::Unknown {
        store.mark_operation_unknown_with_outcome(id, &shared.owner, &value)?
    } else {
        store.settle_operation(id, &shared.owner, status, &value)?
    };
    Ok(Reply::Plugin {
        operation,
        result: Some(result),
        duplicate: false,
    })
}
fn journal_release(
    shared: &Shared,
    id: &str,
    result: Result<(), EngineError>,
) -> Result<(), EngineError> {
    let (kind, details) = match result {
        Ok(()) => ("plugin.lease_released", json!({})),
        Err(error) => (
            "plugin.lease_release_failed",
            json!({"error":error.to_string(),"lease_outstanding":true}),
        ),
    };
    lock(&shared.store)?.append_operation_event(id, &shared.owner, kind, &details)?;
    Ok(())
}
fn private_root(path: &Path) -> Result<(), EngineError> {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let m = std::fs::symlink_metadata(path)?;
            if !m.is_dir() || m.file_type().is_symlink() {
                return Err(state("plugin staging root is not a private directory"));
            }
            #[cfg(unix)]
            if m.permissions().mode() & 0o077 != 0 {
                return Err(state("plugin staging root is not private"));
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
