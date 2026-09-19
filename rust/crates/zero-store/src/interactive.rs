//! One-use interactive effect markers authenticated against retained actor/model history.
use crate::{Error, OperationStatus, Result, Store, append, workflow};
use rusqlite::{TransactionBehavior, params};
use serde_json::json;
use zero_protocol::{
    agent::AgentRequest,
    interactive::{InteractiveCall, InteractiveCapture},
    model::{Completion, CompletionStatus, Content},
};
fn bad(s: &str) -> Error {
    Error::Conflict(format!("interactive: {s}"))
}
impl Store {
    /// Commit before creating a process or forwarding stdin. A lost acknowledgment
    /// is deliberately non-replayable, including after an engine epoch change.
    pub fn claim_interactive(
        &mut self,
        actor_id: &str,
        owner: &str,
        turn: u32,
        index: usize,
        call_id: &str,
        call: &InteractiveCall,
        handle: &str,
    ) -> Result<()> {
        let now: u64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| bad("clock"))?
            .as_millis()
            .try_into()
            .map_err(|_| bad("clock overflow"))?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let epoch: String = tx.query_row(
            "SELECT owner FROM engine_epoch WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        if epoch != owner {
            return Err(bad("engine epoch changed"));
        }
        let mut reader = workflow::Reader::new();
        let actor = workflow::operation(&tx, actor_id, &mut reader)?;
        if actor.status != OperationStatus::Running || actor.owner.as_deref() != Some(owner) {
            return Err(bad("actor is not owned and running"));
        }
        let request: AgentRequest = serde_json::from_value(actor.payload["request"].clone())?;
        let policy = request
            .interactive_policy
            .as_ref()
            .ok_or_else(|| bad("capability absent"))?;
        policy
            .validate_actor(&request)
            .map_err(|_| bad("invalid policy"))?;
        let capture: InteractiveCapture =
            serde_json::from_value(actor.payload["interactive_capture"].clone())?;
        capture
            .validate(policy)
            .map_err(|_| bad("capture differs"))?;
        if now >= capture.deadline_at_ms {
            return Err(bad("original deadline elapsed"));
        }
        crate::review::forbid_input(&tx, &actor.session_id)?;
        crate::scan::forbid_input(&tx, &actor.session_id)?;
        crate::campaign::forbid_input(&tx, &actor.session_id)?;
        let origin_id: String = tx.query_row(
            "SELECT id FROM operations WHERE session_id=?1 AND command_id=?2",
            params![actor.session_id, format!("{actor_id}:model:{turn}")],
            |r| r.get(0),
        )?;
        let origin = workflow::operation(&tx, &origin_id, &mut reader)?;
        if origin.status != OperationStatus::Succeeded
            || origin.payload["parent_operation"] != actor.id
            || origin.payload["kind"] != "agent_inference"
        {
            return Err(bad("origin not completed actor inference"));
        }
        let completion: Completion =
            serde_json::from_value(origin.outcome.ok_or_else(|| bad("completion missing"))?)?;
        if completion.status != CompletionStatus::Completed
            || !completion.usage_is_final
            || completion.usage.is_none()
            || completion.error.is_some()
        {
            return Err(bad("inference accounting incomplete"));
        }
        let rates: zero_protocol::model::Rates =
            serde_json::from_value(origin.payload["rates"].clone())?;
        let charge = rates
            .charge(
                completion
                    .usage
                    .as_ref()
                    .ok_or_else(|| bad("usage missing"))?,
            )
            .ok_or_else(|| bad("unrepresentable charge"))?;
        let settled: Option<u64> = tx.query_row(
            "SELECT charged FROM reservations WHERE session_id=?1 AND id=?2",
            params![actor.session_id, origin_id],
            |r| r.get(0),
        )?;
        let witnesses:u64=tx.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND kind='budget_settled' AND json_extract(payload,'$.reservation_id')=?2 AND json_extract(payload,'$.charged')=?3",params![actor.session_id,origin_id,charge],|r|r.get(0))?;
        if settled != Some(charge) || witnesses != 1 {
            return Err(bad("original inference budget settlement differs"));
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
        if turn >= request.max_turns
            || calls.len() > 32
            || calls
                .iter()
                .map(|v| v.0)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != calls.len()
        {
            return Err(bad("invalid call inventory"));
        }
        let (id, name, args) = calls
            .get(index)
            .ok_or_else(|| bad("call position missing"))?;
        if *id != call_id || *name != call.name() || **args != call.arguments() {
            return Err(bad("call differs from model inference"));
        }
        InteractiveCall::parse(name, args, policy).map_err(|_| bad("invalid call"))?;
        let tools: Vec<zero_protocol::model::ToolDefinition> =
            serde_json::from_value(origin.payload["request"]["tools"].clone())?;
        if tools.iter().filter(|tool| tool.name == call.name()).count() != 1 {
            return Err(bad("tool was not offered"));
        }
        if matches!(
            call,
            InteractiveCall::Create { .. } | InteractiveCall::Write { .. }
        ) {
            let budget = crate::budget::snapshot(&tx, &actor.session_id)?;
            if budget
                .charged
                .checked_add(budget.reserved)
                .is_none_or(|used| used > budget.limit)
            {
                return Err(bad("original session budget exceeded"));
            }
        }
        let mut q=tx.prepare("SELECT payload FROM events WHERE session_id=?1 AND kind='interactive_effect' AND json_extract(payload,'$.actor')=?2 ORDER BY sequence LIMIT 1025")?;
        let prior = q
            .query_map(params![actor.session_id, actor.id], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(q);
        if prior.len() >= 1024 {
            return Err(bad("effect limit"));
        }
        let mut generations = std::collections::BTreeMap::new();
        let mut sessions = std::collections::BTreeSet::new();
        let mut closed = std::collections::BTreeSet::new();
        let mut writes = 0u32;
        let mut bytes = 0u64;
        for raw in prior {
            let v: serde_json::Value = serde_json::from_str(&raw)?;
            if v["turn"] == turn && v["index"] == index {
                return Err(bad("effect marker already exists; do not retry"));
            }
            let old: InteractiveCall = serde_json::from_value(v["call"].clone())?;
            match old {
                InteractiveCall::Create {
                    expected_generation,
                    ..
                } => {
                    generations.insert(
                        v["handle"].as_str().unwrap_or("").to_owned(),
                        expected_generation,
                    );
                    sessions.insert(
                        v["handle"]
                            .as_str()
                            .ok_or_else(|| bad("missing handle"))?
                            .to_owned(),
                    );
                }
                InteractiveCall::Close { session_id } => {
                    closed.insert(session_id);
                }
                InteractiveCall::Write { data_base64, .. } => {
                    writes += 1;
                    bytes += zero_protocol::interactive::decode_input(&data_base64)
                        .map_err(|_| bad("invalid retained frame"))?
                        .len() as u64;
                }
                _ => {}
            }
        }
        match call {
            InteractiveCall::Create { .. } => {
                if sessions.len() >= policy.max_sessions as usize
                    || sessions.contains(handle)
                    || uuid::Uuid::parse_str(handle).is_err()
                {
                    return Err(bad("session limit or repeated handle"));
                }
            }
            _ => {
                if call.session_id() != Some(handle)
                    || !sessions.contains(handle)
                    || closed.contains(handle)
                {
                    return Err(bad("handle not open in this actor"));
                }
            }
        }
        if matches!(
            call,
            InteractiveCall::Create { .. } | InteractiveCall::Write { .. }
        ) {
            let generation = match call {
                InteractiveCall::Create {
                    expected_generation,
                    ..
                } => expected_generation.as_deref(),
                _ => generations.get(handle).and_then(|v| v.as_deref()),
            };
            if request.workspace_policy.is_some() {
                let workspace = crate::workspace_edit::load(&tx, actor_id)?;
                if generation
                    != Some(
                        zero_workspace::generation(&workspace.current)
                            .map_err(|_| bad("workspace generation"))?
                            .as_str(),
                    )
                {
                    return Err(bad(
                        "workspace generation stale or absent; close and recreate session",
                    ));
                }
                if capture.deadline_at_ms != workspace.capture.deadline_at_ms {
                    return Err(bad("workspace deadline differs"));
                }
            } else if generation.is_some() {
                return Err(bad("generation requires workspace policy"));
            }
        }
        if let InteractiveCall::Write { data_base64, .. } = call {
            let n = zero_protocol::interactive::decode_input(data_base64)
                .map_err(|_| bad("frame"))?
                .len() as u64;
            if writes >= policy.max_writes || bytes + n > policy.max_input_bytes {
                return Err(bad("write allowance exhausted"));
            }
        }
        let effect_at_ms: u64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| bad("clock"))?
            .as_millis()
            .try_into()
            .map_err(|_| bad("clock overflow"))?;
        if effect_at_ms >= capture.deadline_at_ms {
            return Err(bad("original deadline elapsed before claim"));
        }
        append(
            &tx,
            &actor.session_id,
            "interactive_effect",
            &json!({"actor":actor.id,"inference":origin_id,"turn":turn,"index":index,"call_id":call_id,"handle":handle,"call":call,"at_ms":effect_at_ms,"owner":owner}),
        )?;
        tx.commit()?;
        Ok(())
    }
}
