use super::*;
use zero_protocol::{
    plugin::{PluginOutcome, UntrustedPluginReply},
    sandbox::{SandboxCleanup, SandboxResult},
};
fn uncertain(cleanup: &SandboxCleanup) -> bool {
    matches!(
        cleanup,
        SandboxCleanup::Unknown { .. } | SandboxCleanup::Unconfirmed { .. }
    )
}

pub(super) fn effect_output(
    store: &Store,
    effect: &Operation,
) -> Result<(OperationStatus, Option<String>), EngineError> {
    if effect.status == OperationStatus::Unknown {
        return Ok((OperationStatus::Unknown, None));
    }
    if effect.status == OperationStatus::Cancelled {
        return Ok((OperationStatus::Cancelled, None));
    }
    if !matches!(
        effect.status,
        OperationStatus::Succeeded | OperationStatus::Failed
    ) {
        return Err(error("approved effect has no durable terminal result"));
    }
    let outcome = effect
        .outcome
        .clone()
        .ok_or_else(|| error("approved effect outcome missing"))?;
    let output = match effect.payload["kind"].as_str() {
        Some("agent_web_experiment") => {
            return Ok((
                effect.status,
                Some(agent_web_experiment::validate_receipt(store, effect)?),
            ));
        }
        Some("agent_http") => {
            return Ok((
                effect.status,
                Some(agent_http::validate_receipt(store, effect)?),
            ));
        }
        Some("agent_tool") => {
            let result: SandboxResult = serde_json::from_value(outcome)?;
            if uncertain(&result.cleanup) {
                return Ok((OperationStatus::Unknown, None));
            }
            if result.execution_id != effect.payload["request"]["execution_id"] {
                return Err(error("approved sandbox result execution identity changed"));
            }
            let status = if result.status == ExecutionStatus::Cancelled {
                OperationStatus::Cancelled
            } else if result.status == ExecutionStatus::Exited
                && result.exit_code == Some(0)
                && matches!(result.cleanup, SandboxCleanup::Confirmed)
            {
                OperationStatus::Succeeded
            } else {
                OperationStatus::Failed
            };
            if status != effect.status {
                return Err(error("approved sandbox status contradicts outcome"));
            }
            json!({"status":result.status,"exit_code":result.exit_code,"stdout_text":String::from_utf8_lossy(&result.stdout),"stderr_text":String::from_utf8_lossy(&result.stderr),"error":result.error})
        }
        Some("agent_plugin") => {
            let result: PluginOutcome = serde_json::from_value(outcome)?;
            plugin_workers::validate(store, effect, &result)?;
            if store.plugin_worker_call(&effect.id)?.is_some() {
                return Ok((effect.status, Some(plugin_workers::output(store, effect)?)));
            }
            if result
                .sandbox
                .as_ref()
                .is_some_and(|r| uncertain(&r.cleanup))
            {
                return Ok((OperationStatus::Unknown, None));
            }
            if effect.status == OperationStatus::Succeeded
                && !matches!(
                    result.untrusted_reply,
                    Some(UntrustedPluginReply::Result { .. })
                )
            {
                return Err(error("approved plugin success lacks an actual result"));
            }
            json!({"untrusted_plugin_data":result.untrusted_reply,"error":result.error,"status":effect.status})
        }
        _ => return Err(error("approval references unsupported effect kind")),
    };
    Ok((effect.status, Some(serde_json::to_string(&output)?)))
}
pub(super) fn settlement(
    record: &ToolApprovalRecord,
    effect: &Operation,
    output: Option<&str>,
) -> Result<Value, EngineError> {
    Ok(
        json!({"schema_version":1,"intent_sha256":record.intent_sha256,"effect_operation_id":effect.id,"effect_payload_sha256":hash(&effect.payload)?,"effect_outcome_sha256":hash(&effect.outcome)?,"output":output}),
    )
}

/// Permission is not evidence of execution: rederive from frozen intent and the
/// exact consumed child outcome before accepting any historical tool output.
pub(crate) fn validate_receipt(store: &Store, wrapper: &Operation) -> Result<String, EngineError> {
    if wrapper.payload["kind"] != "agent_approved_tool" {
        return Err(error("not an approval wrapper"));
    }
    let record = store.get_tool_approval(&wrapper.session_id, &wrapper.id)?;
    let intent = store.tool_approval_intent(&wrapper.session_id, &wrapper.id)?;
    if record.operation_status != wrapper.status
        || intent["actor_operation_id"] != wrapper.payload["parent_operation"]
    {
        return Err(error("approval wrapper identity changed"));
    }
    if record.status == ToolApprovalStatus::Denied {
        let expected = json!({"status":"denied","approval_operation_id":wrapper.id,"intent_sha256":record.intent_sha256,"external_effects_started":false});
        if record.consumption.is_some() || wrapper.outcome.as_ref() != Some(&expected) {
            return Err(error("denied approval has contradictory effects"));
        }
        return Ok(DENIED.into());
    }
    if record.status != ToolApprovalStatus::Consumed
        || !matches!(
            wrapper.status,
            OperationStatus::Succeeded | OperationStatus::Failed
        )
    {
        return Err(error(
            "approval lacks a completely settled consumed invocation",
        ));
    }
    let consumption = record
        .consumption
        .as_ref()
        .ok_or_else(|| error("approval consumption missing"))?;
    let effect = store.get_operation(&consumption.effect_operation_id)?;
    let mut expected = intent["effect_payload"].clone();
    expected["approval_operation"] = json!(wrapper.id);
    if effect.session_id != wrapper.session_id
        || effect.command_id != intent["effect_command_id"]
        || effect.payload != expected
        || consumption.effect_payload_sha256 != hash(&effect.payload)?
    {
        return Err(error("consumed effect differs from frozen approval"));
    }
    let (status, output) = effect_output(store, &effect)?;
    if status != wrapper.status
        || !matches!(status, OperationStatus::Succeeded | OperationStatus::Failed)
    {
        return Err(error("approval wrapper contradicts effect completion"));
    }
    let output = output.ok_or_else(|| error("approval has no canonical effect output"))?;
    if wrapper.outcome.as_ref() != Some(&settlement(&record, &effect, Some(&output))?) {
        return Err(error("approval output differs from exact effect receipt"));
    }
    Ok(output)
}
