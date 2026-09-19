use super::*;
/// A provisional reply alone never proves backend settlement.
pub(crate) fn validate(
    store: &Store,
    call: &Operation,
    result: &PluginOutcome,
) -> Result<(), EngineError> {
    let Some(binding) = store.plugin_worker_call(&call.id)? else {
        return Ok(());
    };
    let worker = store.plugin_worker_record(
        binding["worker_operation_id"]
            .as_str()
            .ok_or_else(|| error("worker binding missing"))?,
    )?;
    if result.pin.as_ref().map(serde_json::to_value).transpose()? != Some(binding["pin"].clone()) {
        return Err(error("worker call pin differs"));
    }
    if worker.status == OperationStatus::Unknown {
        if call.status != OperationStatus::Unknown {
            return Err(error("unsettled worker cannot settle its call"));
        }
        return Ok(());
    }
    let outcome = worker
        .outcome
        .as_ref()
        .ok_or_else(|| error("worker has no terminal receipt"))?;
    if !result.external_effects_started
        || result.sandbox.is_some()
        || !result.lease_release_journaled_separately
        || serde_json::to_value(&result.staging_recovery)? != outcome["staging_recovery"]
        || serde_json::to_value(&result.error)? != outcome["error"]
    {
        return Err(error("worker call summary differs from joined receipt"));
    }
    let sandbox: zero_protocol::sandbox::SandboxResult =
        serde_json::from_value(outcome["sandbox"].clone())?;
    if worker.status == OperationStatus::Succeeded
        && (sandbox.status != zero_protocol::ExecutionStatus::Exited
            || sandbox.exit_code != Some(0)
            || !matches!(
                sandbox.cleanup,
                zero_protocol::sandbox::SandboxCleanup::Confirmed
            ))
    {
        return Err(error("worker success contradicts sandbox completion"));
    }
    if binding["started"] != true || binding["preparation"]["execution_id"] != sandbox.execution_id
    {
        return Err(error(
            "worker execution does not match physical-start permission",
        ));
    }
    let prepared = binding["preparation"]["request_sha256"]
        .as_str()
        .ok_or_else(|| error("worker preparation digest absent"))?;
    if outcome["request_sha256"] != prepared
        || store
            .operation_artifacts(&worker.id)?
            .get("plugin.worker_request")
            .map(String::as_str)
            != Some(prepared)
    {
        return Err(error("worker sandbox request changed"));
    }
    let request: zero_protocol::sandbox::SandboxRequest =
        serde_json::from_slice(&store.artifact(prepared)?)?;
    if request.execution_id != sandbox.execution_id {
        return Err(error("worker execution identity changed"));
    }
    match (&request.backend, &sandbox.artifact) {
        (
            zero_protocol::sandbox::SandboxBackend::Docker { image },
            zero_protocol::sandbox::SandboxArtifact::Docker {
                image_reference,
                resolved_image_id,
            },
        ) if image == image_reference
            && resolved_image_id.as_ref().is_none_or(|id| {
                image.rsplit_once('@').map_or(image.as_str(), |(_, id)| id) == id
            }) => {}
        _ => {
            return Err(error(
                "worker resolved image differs from captured immutable image",
            ));
        }
    }
    if let Some(digest) = binding["reply_artifact"].as_str() {
        let retained: UntrustedPluginReply = serde_json::from_slice(&store.artifact(digest)?)?;
        if serde_json::to_value(retained)? != serde_json::to_value(&result.untrusted_reply)? {
            return Err(error(
                "worker terminal reply differs from provisional evidence",
            ));
        }
    } else if result.untrusted_reply.is_some() {
        return Err(error("worker reply has no provisional evidence"));
    }
    if outcome["backend_settled"] != true
        || !matches!(
            sandbox.cleanup,
            zero_protocol::sandbox::SandboxCleanup::Confirmed
                | zero_protocol::sandbox::SandboxCleanup::NotCreated
        )
        || outcome["staging_recovery"] != Value::Null
    {
        return Err(error("worker backend settlement unconfirmed"));
    }
    if !matches!(
        worker.status,
        OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled
    ) || (call.status != worker.status
        && !(worker.status == OperationStatus::Succeeded && call.status == OperationStatus::Failed))
    {
        return Err(error("worker and call terminal statuses differ"));
    }
    Ok(())
}
/// Inspect a retained invocation without starting a worker or consulting current
/// plugin configuration. None preserves an unfinished/recovered opaque outcome.
pub fn read_plugin_worker_call(
    path: &Path,
    session: &str,
    id: &str,
) -> Result<Option<PluginOutcome>, EngineError> {
    let store = Store::open_read_only(path)?;
    let checked = store.plugin_worker_call(id)?;
    let operation = store.get_operation(id)?;
    if operation.session_id != session || checked.is_none() {
        return Err(error("not a persistent invocation in this session"));
    }
    let Some(value) = operation.outcome.clone() else {
        return Ok(None);
    };
    let result: PluginOutcome = match serde_json::from_value(value) {
        Ok(v) => v,
        Err(_) if operation.status == OperationStatus::Unknown => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    validate(&store, &operation, &result)?;
    Ok(Some(result))
}

pub(crate) fn output(store: &Store, call: &Operation) -> Result<String, EngineError> {
    let result: PluginOutcome = serde_json::from_value(
        call.outcome
            .clone()
            .ok_or_else(|| error("persistent call outcome absent"))?,
    )?;
    validate(store, call, &result)?;
    if !matches!(
        call.status,
        OperationStatus::Succeeded | OperationStatus::Failed
    ) || result.untrusted_reply.is_none()
    {
        return Err(error("persistent call lacks a settled provisional reply"));
    }
    Ok(serde_json::to_string(
        &json!({"untrusted_plugin_data":result.untrusted_reply,"provisional":true}),
    )?)
}
