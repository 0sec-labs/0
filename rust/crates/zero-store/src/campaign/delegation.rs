//! Exact child authority derives from the frozen parent and one original model task.
use super::*;
use zero_protocol::model::{Completion, CompletionStatus, Content};
fn by_command(conn: &Connection, session: &str, command: &str) -> Result<Operation> {
    let key:String=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM operations WHERE session_id=?1 AND command_id=?2",params![session,command],|r|r.get(0))?;
    hooks::operation(conn, &key)
}
pub(super) fn group(
    conn: &Connection,
    r: &CampaignRun,
    parent: &Operation,
    command: &str,
    payload: &Value,
) -> Result<()> {
    let policy = r
        .spec
        .request
        .delegation_policy
        .as_ref()
        .ok_or_else(|| bad("delegation absent"))?;
    let tasks = payload["tasks"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= policy.max_children as usize)
        .ok_or_else(|| bad("delegation task count"))?;
    if serde_json::to_vec(tasks)?.len() > 512 * 1024
        || payload["kind"] != "agent_delegation"
        || payload["parent_operation"] != parent.id
        || payload["delegation_context_sha256"] != hash(&parent.payload["delegation_context"])?
    {
        return Err(bad("delegation group identity differs"));
    }
    let commands = payload["child_commands"]
        .as_array()
        .filter(|v| v.len() == tasks.len())
        .ok_or_else(|| bad("delegation command count"))?;
    for (i, task) in tasks.iter().enumerate() {
        let prompt = task["prompt"]
            .as_str()
            .ok_or_else(|| bad("delegation prompt absent"))?;
        if task.as_object().is_none_or(|v| v.len() != 2)
            || prompt.trim().is_empty()
            || prompt.len() > 16384
            || prompt.contains('\0')
            || !policy.roles.iter().any(|r| task["role"] == r.name)
            || commands[i] != format!("{command}:agent:{i}")
        {
            return Err(bad("delegation task identity differs"));
        }
    }
    let (turn, index) = command
        .strip_prefix(&format!("{}:tool:", parent.id))
        .and_then(|s| s.split_once(':'))
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<usize>().ok()?)))
        .filter(|(a, b)| *a < 32 && *b < 32)
        .ok_or_else(|| bad("delegation command differs"))?;
    let origin = by_command(conn, &r.session_id, &format!("{}:model:{turn}", parent.id))?;
    if origin.status != OperationStatus::Succeeded
        || origin.payload["kind"] != "agent_inference"
        || origin.payload["parent_operation"] != parent.id
    {
        return Err(bad("delegation origin is not completed inference"));
    }
    let witness:(u64,u64)=conn.query_row("SELECT count(*),COALESCE(sum(length(CAST(payload AS BLOB))),0) FROM events WHERE session_id=?1 AND kind='operation_settled' AND CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id')) END=?2",params![r.session_id,origin.id],|q|Ok((q.get(0)?,q.get(1)?)))?;
    if witness.0 != 1 || witness.1 > 32 * 1024 * 1024 {
        return Err(bad("delegation origin settlement bound"));
    }
    let valid:bool=conn.query_row("SELECT json(payload)=json(?3) FROM events WHERE session_id=?1 AND kind='operation_settled' AND CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id')) END=?2",params![r.session_id,origin.id,serde_json::to_string(&serde_json::to_value(&origin)?)?],|q|q.get(0))?;
    if !valid {
        return Err(bad("delegation origin settlement differs"));
    }
    let completion: Completion = serde_json::from_value(
        origin
            .outcome
            .ok_or_else(|| bad("delegation origin outcome absent"))?,
    )?;
    let calls = completion
        .content
        .iter()
        .filter_map(|c| {
            if let Content::ToolCall {
                id,
                name,
                arguments,
            } = c
            {
                Some((id, name, arguments))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    if completion.status != CompletionStatus::Completed
        || completion.error.is_some()
        || calls.len() > 32
    {
        return Err(bad("delegation origin incomplete"));
    }
    let (id, name, args) = calls
        .get(index)
        .ok_or_else(|| bad("delegation origin call absent"))?;
    if name.as_str() != "delegate_tasks"
        || payload["call_id"] != **id
        || args.as_object().is_none_or(|v| v.len() != 1)
        || args["tasks"] != payload["tasks"]
    {
        return Err(bad("delegation tasks differ from original model call"));
    }
    Ok(())
}
pub(super) fn child(
    conn: &Connection,
    r: &CampaignRun,
    parent: &Operation,
    command: &str,
    payload: &Value,
    role: &zero_protocol::delegation::DelegationRole,
) -> Result<()> {
    let group_command = payload["delegation_group_command"]
        .as_str()
        .filter(|s| s.len() <= 4096)
        .ok_or_else(|| bad("delegated group absent"))?;
    let joined = by_command(conn, &r.session_id, group_command)?;
    if joined.status != OperationStatus::Running || joined.owner.as_deref() != Some(&r.owner) {
        return Err(bad("delegation group not owned running"));
    }
    group(conn, r, parent, group_command, &joined.payload)?;
    let index = payload["delegation_index"]
        .as_u64()
        .filter(|n| *n < 16)
        .ok_or_else(|| bad("delegation child index"))? as usize;
    let task = joined.payload["tasks"]
        .get(index)
        .ok_or_else(|| bad("delegation child task absent"))?;
    if task["role"] != role.name || joined.payload["child_commands"][index] != command {
        return Err(bad("delegation child membership differs"));
    }
    let mut expected = r.spec.request.clone();
    expected.provider = role.provider.clone();
    expected.model = role.model.clone();
    expected.instructions = format!(
        "{}\n\nHost-defined delegated role {}:\n{}",
        r.spec.request.instructions, role.name, role.instructions
    );
    expected.prompt = task["prompt"]
        .as_str()
        .ok_or_else(|| bad("delegation prompt absent"))?
        .into();
    expected.max_turns = role.max_turns;
    expected.reservation_per_turn = role.reservation_per_turn;
    expected.delegation_policy = None;
    expected.continuation_of = None;
    expected.source_submission_max_hypotheses = None;
    expected.web_submission_max_hypotheses = None;
    expected.web_experiment_policy = expected
        .web_experiment_policy
        .filter(|_| role.tools.iter().any(|t| t == "run_web_experiment"));
    expected.context_policy = None;
    expected.tool_approval_policy = None;
    expected.operator_questions = false;
    expected.http_profile = expected
        .http_profile
        .filter(|_| role.tools.iter().any(|t| t == "http_request"));
    expected
        .plugin_tools
        .retain(|b| role.tools.contains(&b.alias));
    let identity = parent.payload["delegation_context"]["roles"]
        .as_array()
        .and_then(|v| v.iter().find(|v| v["name"] == role.name))
        .ok_or_else(|| bad("delegation role capture absent"))?;
    if payload["request"] != serde_json::to_value(expected)?
        || payload["delegation_template"] != identity["template"]
        || [
            "endpoint",
            "rates",
            "wire_api",
            "hosted_catalog",
            "plugin_context",
            "http_context",
            "http_output_version",
        ]
        .iter()
        .any(|key| payload.get(key) != identity.get(key))
    {
        return Err(bad("delegated authority differs"));
    }
    Ok(())
}
