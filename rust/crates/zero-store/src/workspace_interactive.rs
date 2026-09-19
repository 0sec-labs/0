//! Generation-bound interactive authority, checked again after private staging.
use crate::{Error, OperationStatus, Result, Store, WorkspaceState, append, workflow};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use zero_protocol::{
    agent::AgentRequest,
    interactive::InteractiveCall,
    model::{Completion, CompletionStatus, Content, Rates},
    sandbox::{SandboxRequest, SandboxResult},
};
fn bad(s: impl std::fmt::Display) -> Error {
    Error::Conflict(format!("workspace interactive: {s}"))
}
fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(bad)?
        .as_millis()
        .try_into()
        .map_err(bad)
}
struct Claim {
    seq: u64,
    value: Value,
    call: InteractiveCall,
}
fn generation_at(c: &Connection, state: &WorkspaceState, seq: u64) -> Result<String> {
    let value:Option<String>=c.query_row("SELECT json_extract(payload,'$.manifest') FROM events WHERE session_id=?1 AND sequence<?2 AND kind='workspace_effect' AND json_extract(payload,'$.actor')=?3 AND json_extract(payload,'$.manifest') IS NOT NULL ORDER BY sequence DESC LIMIT 1",params![state.actor.session_id,seq,state.actor.id],|r|r.get(0)).optional()?;
    value
        .map(Ok)
        .unwrap_or_else(|| zero_workspace::generation(&state.baseline).map_err(bad))
}
fn claims(
    c: &Connection,
    state: &WorkspaceState,
    reader: &mut workflow::Reader,
) -> Result<Vec<Claim>> {
    let request: AgentRequest = serde_json::from_value(state.actor.payload["request"].clone())?;
    let policy = request
        .interactive_policy
        .as_ref()
        .ok_or_else(|| bad("interactive capability absent"))?;
    policy.validate_actor(&request).map_err(bad)?;
    let capture: zero_protocol::interactive::InteractiveCapture =
        serde_json::from_value(state.actor.payload["interactive_capture"].clone())?;
    capture.validate(policy).map_err(bad)?;
    if capture.created_at_ms != state.capture.created_at_ms
        || capture.deadline_at_ms != state.capture.deadline_at_ms
    {
        return Err(bad("original deadline differs"));
    }
    let mut q=c.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='interactive_effect' AND json_extract(payload,'$.actor')=?2 ORDER BY sequence LIMIT 1025")?;
    let seqs = q
        .query_map(params![state.actor.session_id, state.actor.id], |r| {
            r.get::<_, u64>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if seqs.len() > 1024 {
        return Err(bad("claim history bound"));
    }
    let mut positions = std::collections::BTreeSet::new();
    let mut sessions = std::collections::BTreeMap::new();
    let mut closed = std::collections::BTreeSet::new();
    let mut writes = 0u32;
    let mut bytes = 0u64;
    let mut output = vec![];
    for seq in seqs {
        let (_, value) = reader.event(c, &state.actor.session_id, seq)?;
        let at = value["at_ms"]
            .as_u64()
            .ok_or_else(|| bad("claim timestamp absent"))?;
        let terminated: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence<?2 AND kind IN ('operation_settled','operation_unknown','operation_not_started') AND coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id'))=?3)", params![state.actor.session_id,seq,state.actor.id], |r|r.get(0))?;
        if value["owner"] != json!(state.actor.owner)
            || at < state.capture.created_at_ms
            || at >= state.capture.deadline_at_ms
            || terminated
        {
            return Err(bad("claim follows expired or terminated authority"));
        }
        let turn = value["turn"].as_u64().ok_or_else(|| bad("turn"))?;
        let index = value["index"].as_u64().ok_or_else(|| bad("index"))? as usize;
        if turn >= u64::from(request.max_turns) || !positions.insert((turn, index)) {
            return Err(bad("repeated or invalid invocation"));
        }
        let origin = workflow::operation(
            c,
            value["inference"]
                .as_str()
                .ok_or_else(|| bad("inference"))?,
            reader,
        )?;
        if origin.command_id != format!("{}:model:{turn}", state.actor.id)
            || origin.session_id != state.actor.session_id
            || origin.payload["parent_operation"] != state.actor.id
            || origin.payload["kind"] != "agent_inference"
            || origin.status != OperationStatus::Succeeded
        {
            return Err(bad("inference identity"));
        }
        let completion: Completion =
            serde_json::from_value(origin.outcome.ok_or_else(|| bad("completion absent"))?)?;
        if completion.status != CompletionStatus::Completed
            || !completion.usage_is_final
            || completion.error.is_some()
        {
            return Err(bad("inference not final"));
        }
        let rates: Rates = serde_json::from_value(origin.payload["rates"].clone())?;
        let charge = rates
            .charge(
                completion
                    .usage
                    .as_ref()
                    .ok_or_else(|| bad("usage absent"))?,
            )
            .ok_or_else(|| bad("charge"))?;
        let settled:u64=c.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND sequence<?2 AND kind='budget_settled' AND json_extract(payload,'$.reservation_id')=?3 AND json_extract(payload,'$.charged')=?4",params![state.actor.session_id,seq,origin.id,charge],|r|r.get(0))?;
        let completed:u64=c.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND sequence<?2 AND kind='operation_settled' AND json_extract(payload,'$.id')=?3",params![state.actor.session_id,seq,origin.id],|r|r.get(0))?;
        if settled != 1 || completed != 1 {
            return Err(bad("inference not settled before claim"));
        }
        let calls: Vec<_> = completion
            .content
            .iter()
            .filter_map(|v| match v {
                Content::ToolCall {
                    id,
                    name,
                    arguments,
                } => Some((id, name, arguments)),
                _ => None,
            })
            .collect();
        if calls.len() > 32
            || calls
                .iter()
                .map(|v| v.0)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != calls.len()
        {
            return Err(bad("model call inventory invalid"));
        }
        let (id, name, args) = calls.get(index).ok_or_else(|| bad("call missing"))?;
        let call: InteractiveCall = serde_json::from_value(value["call"].clone())?;
        if value["call_id"] != **id || *name != call.name() || **args != call.arguments() {
            return Err(bad("call differs"));
        }
        InteractiveCall::parse(name, args, policy).map_err(bad)?;
        let tools: Vec<zero_protocol::model::ToolDefinition> =
            serde_json::from_value(origin.payload["request"]["tools"].clone())?;
        if tools.iter().filter(|t| t.name == call.name()).count() != 1 {
            return Err(bad("tool not offered"));
        }
        let handle = value["handle"].as_str().ok_or_else(|| bad("handle"))?;
        match &call {
            InteractiveCall::Create {
                expected_generation: Some(generation),
                ..
            } => {
                if sessions.len() >= policy.max_sessions as usize
                    || sessions
                        .insert(handle.to_owned(), generation.clone())
                        .is_some()
                    || uuid::Uuid::parse_str(handle).is_err()
                    || generation_at(c, state, seq)? != *generation
                {
                    return Err(bad("create generation or handle differs"));
                }
                crate::workspace_edit::prefix_budget(c, &state.actor.session_id, seq, reader)?;
            }
            InteractiveCall::Create { .. } => return Err(bad("creation lacks generation")),
            _ => {
                if call.session_id() != Some(handle)
                    || !sessions.contains_key(handle)
                    || closed.contains(handle)
                {
                    return Err(bad("session ownership differs"));
                }
                if let InteractiveCall::Write { data_base64, .. } = &call {
                    if sessions[handle] != generation_at(c, state, seq)? {
                        return Err(bad("write uses revoked generation"));
                    }
                    writes += 1;
                    bytes += zero_protocol::interactive::decode_input(data_base64)
                        .map_err(bad)?
                        .len() as u64;
                    if writes > policy.max_writes || bytes > policy.max_input_bytes {
                        return Err(bad("write allowance"));
                    }
                    crate::workspace_edit::prefix_budget(c, &state.actor.session_id, seq, reader)?;
                }
                if matches!(call, InteractiveCall::Close { .. }) {
                    closed.insert(handle.to_owned());
                }
            }
        }
        output.push(Claim { seq, value, call });
    }
    Ok(output)
}
fn validate_execution(
    c: &Connection,
    state: &WorkspaceState,
    claim: &Claim,
    execution: &SandboxRequest,
) -> Result<String> {
    let InteractiveCall::Create {
        argv,
        expected_generation: Some(generation),
    } = &claim.call
    else {
        return Err(bad("not a generation-bound creation"));
    };
    let request: AgentRequest = serde_json::from_value(state.actor.payload["request"].clone())?;
    let profile = request.snapshot_request().map_err(bad)?;
    crate::workspace_edit::archive(c, generation)?
        .validate_pin(&execution.snapshot)
        .map_err(bad)?;
    execution.validate().map_err(bad)?;
    if execution.argv != *argv
        || execution.execution_id
            != format!(
                "interactive-{}",
                claim.value["handle"].as_str().unwrap_or("")
            )
        || execution.timeout_ms > profile.timeout_ms
        || execution.memory_mb != profile.memory_mb
        || execution.cpus != profile.cpus
        || execution.max_output_bytes != profile.max_output_bytes
        || execution.stdin.is_some()
        || execution.build_argv.is_some()
        || serde_json::to_value(&execution.backend)? != serde_json::to_value(&profile.backend)?
    {
        return Err(bad("execution exceeds original policy"));
    }
    Ok(generation.clone())
}
impl Store {
    pub fn begin_workspace_interactive_dispatch(
        &mut self,
        actor: &str,
        owner: &str,
        handle: &str,
        execution: &SandboxRequest,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = crate::workspace_edit::load(&tx, actor)?;
        crate::workspace_edit::owned(&tx, &state.actor, owner, &state.capture)?;
        let mut reader = workflow::Reader {
            remaining: 256 * 1024 * 1024,
        };
        let all = claims(&tx, &state, &mut reader)?;
        let claim = all
            .iter()
            .find(|v| {
                v.value["handle"] == handle && matches!(v.call, InteractiveCall::Create { .. })
            })
            .ok_or_else(|| bad("creation claim absent"))?;
        let generation = validate_execution(&tx, &state, claim, execution)?;
        if generation != zero_workspace::generation(&state.current).map_err(bad)? {
            return Err(bad("generation revoked during staging"));
        }
        let account = workflow::checked_budget(&tx, &state.actor.session_id, &mut reader)?;
        if account
            .charged
            .checked_add(account.reserved)
            .is_none_or(|n| n > account.limit)
        {
            return Err(bad("original budget exceeded"));
        }
        let prior:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='workspace_interactive_started' AND json_extract(payload,'$.actor')=?2 AND json_extract(payload,'$.handle')=?3)",params![state.actor.session_id,actor,handle],|r|r.get(0))?;
        if prior {
            return Err(bad("one-use launch already started"));
        }
        crate::workspace_edit::owned(&tx, &state.actor, owner, &state.capture)?;
        append(
            &tx,
            &state.actor.session_id,
            "workspace_interactive_started",
            &json!({"actor":actor,"handle":handle,"generation":generation,"claim_sequence":claim.seq,"owner":owner,"at_ms":now()?,"request":execution}),
        )?;
        tx.commit()?;
        Ok(())
    }
    /// Independently reconstruct session provenance. Physical output stays unverified.
    pub fn workspace_interactive_sessions(&self, actor: &str) -> Result<Vec<Value>> {
        let tx = self.conn.unchecked_transaction()?;
        let state = crate::workspace_edit::load(&tx, actor)?;
        if state.actor.payload["request"]["interactive_policy"].is_null() {
            return Ok(vec![]);
        }
        let mut reader = workflow::Reader {
            remaining: 256 * 1024 * 1024,
        };
        let all = claims(&tx, &state, &mut reader)?;
        let mut output = vec![];
        for claim in all
            .iter()
            .filter(|v| matches!(v.call, InteractiveCall::Create { .. }))
        {
            let handle = claim.value["handle"]
                .as_str()
                .ok_or_else(|| bad("handle absent"))?;
            let mut q=tx.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='workspace_interactive_started' AND json_extract(payload,'$.actor')=?2 AND json_extract(payload,'$.handle')=?3 ORDER BY sequence LIMIT 2")?;
            let starts = q
                .query_map(params![state.actor.session_id, actor, handle], |r| {
                    r.get::<_, u64>(0)
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            if starts.len() > 1 {
                return Err(bad("duplicate launch witness"));
            }
            let result_name = format!("interactive.{handle}.result");
            let digest: Option<String> = tx
                .query_row(
                    "SELECT digest FROM operation_artifacts WHERE operation_id=?1 AND name=?2",
                    params![actor, result_name],
                    |r| r.get(0),
                )
                .optional()?;
            if starts.is_empty() {
                if all.iter().any(|v| {
                    v.value["handle"] == handle && !matches!(v.call, InteractiveCall::Create { .. })
                }) {
                    return Err(bad("session effects lack launch witness"));
                }
                if digest.is_some() {
                    return Err(bad("result lacks launch witness"));
                }
                output.push(json!({"kind":"workspace_interactive","handle":handle,"generation":claim.value["call"]["expected_generation"],"assessment":"unverified","status":"unknown"}));
                continue;
            }
            let seq = starts[0];
            if all.iter().any(|v| {
                v.value["handle"] == handle
                    && !matches!(v.call, InteractiveCall::Create { .. })
                    && v.seq <= seq
            }) {
                return Err(bad("session effect predates launch"));
            }
            let (_, start) = reader.event(&tx, &state.actor.session_id, seq)?;
            let execution: SandboxRequest = serde_json::from_value(start["request"].clone())?;
            let generation = validate_execution(&tx, &state, claim, &execution)?;
            let at = start["at_ms"]
                .as_u64()
                .ok_or_else(|| bad("launch timestamp"))?;
            let terminated:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence<?2 AND kind IN ('operation_settled','operation_unknown','operation_not_started') AND coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id'))=?3)",params![state.actor.session_id,seq,actor],|r|r.get(0))?;
            if seq <= claim.seq
                || start["claim_sequence"] != claim.seq
                || start["owner"] != json!(state.actor.owner)
                || start["generation"] != generation
                || generation_at(&tx, &state, seq)? != generation
                || at < state.capture.created_at_ms
                || at >= state.capture.deadline_at_ms
                || terminated
            {
                return Err(bad("launch authority or chronology differs"));
            }
            crate::workspace_edit::prefix_budget(&tx, &state.actor.session_id, seq, &mut reader)?;
            let result = if let Some(digest) = digest {
                let witness:u64=tx.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND sequence>?2 AND kind='operation_artifact' AND json_extract(payload,'$.operation_id')=?3 AND json_extract(payload,'$.name')=?4 AND json_extract(payload,'$.digest')=?5",params![state.actor.session_id,seq,actor,result_name,digest],|r|r.get(0))?;
                if witness != 1 {
                    return Err(bad("result attachment witness differs"));
                }
                let result: SandboxResult =
                    serde_json::from_slice(&reader.artifact(&tx, &digest, 1024 * 1024)?)?;
                if result.execution_id != execution.execution_id {
                    return Err(bad("result execution identity"));
                }
                serde_json::to_value(result)?
            } else {
                Value::Null
            };
            output.push(json!({"kind":"workspace_interactive","handle":handle,"generation":generation,"assessment":"unverified","request":execution,"launch":start,"result":result,"claims":all.iter().filter(|v|v.value["handle"]==handle).map(|v|v.value.clone()).collect::<Vec<_>>()}));
        }
        tx.commit()?;
        Ok(output)
    }
}
