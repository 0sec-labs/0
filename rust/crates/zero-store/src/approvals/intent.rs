use super::*;
use zero_protocol::model::{Completion, CompletionStatus, Content, ToolDefinition};
#[allow(clippy::too_many_arguments)]
pub(super) fn derive(
    conn: &Connection,
    actor: &Operation,
    command: &str,
    origin_id: &str,
    call: &str,
    alias: &str,
    effect: &Value,
    cache: &mut Cache,
) -> Result<Value> {
    let (turn, index) = command
        .strip_prefix(&format!("{}:tool:", actor.id))
        .and_then(|s| s.split_once(':'))
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<usize>().ok()?)))
        .filter(|(a, b)| *a < 32 && *b < 32)
        .ok_or_else(|| bad("approval is not a bounded actor call"))?;
    if command != format!("{}:tool:{turn}:{index}", actor.id) {
        return Err(bad("approval call command is not canonical"));
    }
    let origin = cache.reads.operation(conn, origin_id)?;
    if origin.session_id != actor.session_id
        || origin.command_id != format!("{}:model:{turn}", actor.id)
        || origin.status != OperationStatus::Succeeded
        || origin.payload["kind"] != "agent_inference"
        || origin.payload["parent_operation"] != actor.id
    {
        return Err(bad(
            "approval origin is not this actor's successful inference",
        ));
    }
    let completion: Completion = serde_json::from_value(
        origin
            .outcome
            .clone()
            .ok_or_else(|| bad("approval origin completion absent"))?,
    )?;
    if completion.status != CompletionStatus::Completed || completion.error.is_some() {
        return Err(bad("approval origin completion not successful"));
    }
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|v| {
            if let Content::ToolCall {
                id,
                name,
                arguments,
            } = v
            {
                Some((id, name, arguments))
            } else {
                None
            }
        })
        .collect();
    if calls.len() > 32
        || calls
            .iter()
            .map(|c| c.0)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != calls.len()
    {
        return Err(bad("approval origin call identities invalid"));
    }
    let (original_call, name, args) = calls
        .get(index)
        .ok_or_else(|| bad("approval call absent"))?;
    if *original_call != call || *name != alias {
        return Err(bad("approval differs from original tool call"));
    }
    let policy: Policy =
        serde_json::from_value(actor.payload["request"]["tool_approval_policy"].clone())?;
    policy
        .validate()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    if !policy.require_approval.iter().any(|n| n == alias) {
        return Err(bad("tool was not selected for approval by host"));
    }
    let definitions: Vec<ToolDefinition> =
        serde_json::from_value(origin.payload["request"]["tools"].clone())?;
    let offered: Vec<_> = definitions.iter().filter(|t| t.name == alias).collect();
    if offered.len() != 1 {
        return Err(bad("approved tool was not uniquely offered"));
    }
    let expected = if alias == "execute_snapshot" {
        let object = args
            .as_object()
            .filter(|v| v.len() == 1 && v.contains_key("argv"))
            .ok_or_else(|| bad("approval snapshot arguments invalid"))?;
        let execution: zero_protocol::agent::AgentExecution =
            serde_json::from_value(actor.payload["request"]["execution"].clone())?;
        let mut request = execution.sandbox_request();
        immutable_backend(&request.backend)?;
        request.execution_id = format!("agent-{}-{turn}-{index}", actor.id);
        request.argv = serde_json::from_value(object["argv"].clone())?;
        request
            .validate()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        json!({"parent_operation":actor.id,"kind":"agent_tool","call_id":call,"request":request})
    } else {
        let bindings: Vec<zero_protocol::agent::PluginToolBinding> = serde_json::from_value(
            actor.payload["request"]
                .get("plugin_tools")
                .cloned()
                .unwrap_or(json!([])),
        )?;
        let bindings: Vec<_> = bindings.iter().filter(|b| b.alias == alias).collect();
        if bindings.len() != 1 || !actor.payload["plugin_context"].is_object() {
            return Err(bad("approval tool is not a captured offline plugin alias"));
        }
        let backend: zero_protocol::sandbox::SandboxBackend =
            serde_json::from_value(actor.payload["plugin_context"]["launch"]["backend"].clone())?;
        immutable_backend(&backend)?;
        json!({"parent_operation":actor.id,"kind":"agent_plugin","call_id":call,"plugin_context":actor.payload["plugin_context"],"binding":bindings[0],"input":args})
    };
    if *effect != expected {
        return Err(bad(
            "approval effect differs from captured actor authority or arguments",
        ));
    }
    Ok(
        json!({"schema_version":1,"session_id":actor.session_id,"root_operation_id":actor.payload["parent_operation"].as_str().unwrap_or(&actor.id),"actor_operation_id":actor.id,"actor_payload_sha256":hash(&actor.payload)?,"origin_inference_id":origin.id,"origin_payload_sha256":hash(&origin.payload)?,"origin_outcome_sha256":hash(&serde_json::to_value(&origin.outcome)?)?,"call_id":call,"tool_name":alias,"tool_definition":offered[0],"arguments":args,"policy":policy,"effect_command_id":format!("{command}:effect"),"effect_payload":effect}),
    )
}

fn immutable_backend(backend: &zero_protocol::sandbox::SandboxBackend) -> Result<()> {
    match backend {
        zero_protocol::sandbox::SandboxBackend::Docker { image }
            if zero_protocol::is_sha256(image)
                || image.split_once('@').is_some_and(|(name, digest)| {
                    !name.is_empty() && zero_protocol::is_sha256(digest)
                }) =>
        {
            Ok(())
        }
        zero_protocol::sandbox::SandboxBackend::Smolvm { archive_digest, .. }
            if zero_protocol::is_sha256(archive_digest) =>
        {
            Ok(())
        }
        _ => Err(bad("approval requires immutable backend artifact identity")),
    }
}
