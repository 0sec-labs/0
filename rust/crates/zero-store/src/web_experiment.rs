//! Native experiment source authority and atomic admission.
use crate::{Error, Operation, OperationStatus, Result, Store, questions::Reads};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zero_protocol::model::{Completion, CompletionStatus, Content, ToolDefinition};
use zero_web_verification::{FrozenExperiment, experiment_tool_definition};
// Source records have separate bounds from the much smaller frozen effect intent.
fn hash(value: &Value) -> Result<String> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(bad());
    }
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}
fn bad() -> Error {
    Error::Conflict("native experiment authority or witness differs".into())
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(bad)
}
fn witness(conn: &Connection, op: &Operation, kind: &str, reads: &mut Reads) -> Result<u64> {
    let mut stmt=conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind=?2 AND json_extract(payload,'$.id')=?3 LIMIT 2")?;
    let ids = stmt
        .query_map(params![op.session_id, kind, op.id], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if ids.len() != 1 {
        return Err(bad());
    }
    let (_, value) = reads
        .witnesses
        .event(conn, &op.session_id, ids[0], 32 * 1024 * 1024)?;
    let mut expected = op.clone();
    if kind == "command_admitted" {
        expected.status = OperationStatus::Admitted;
        expected.owner = None;
        expected.outcome = None;
    }
    if *value != serde_json::to_value(expected)? {
        return Err(bad());
    }
    Ok(ids[0])
}
/// Pure source derivation also used before an approval exists. No quota allocation.
pub(super) fn source(
    conn: &Connection,
    op: &Operation,
    reads: &mut Reads,
) -> Result<FrozenExperiment> {
    if op.payload["kind"] != "agent_web_experiment"
        || serde_json::to_vec(&op.payload)?.len() > 4 * 1024 * 1024
    {
        return Err(bad());
    }
    let frozen =
        FrozenExperiment::from_intent(&op.payload["execution_intent"]).map_err(|_| bad())?;
    let actor = reads.operation(conn, text(&op.payload, "parent_operation")?)?;
    witness(conn, &actor, "command_admitted", reads)?;
    let request =
        zero_protocol::agent::validate_actor_payload(&actor.payload).map_err(|_| bad())?;
    let policy = request.web_experiment_policy.ok_or_else(bad)?;
    let origin = reads.operation(conn, text(&op.payload, "origin_inference_id")?)?;
    witness(conn, &origin, "command_admitted", reads)?;
    witness(conn, &origin, "operation_settled", reads)?;
    if actor.session_id != op.session_id
        || origin.session_id != op.session_id
        || origin.status != OperationStatus::Succeeded
        || origin.payload["kind"] != "agent_inference"
        || origin.payload["parent_operation"] != actor.id
        || actor.payload["http_output_version"] != 2
    {
        return Err(bad());
    }
    let turn = origin
        .command_id
        .strip_prefix(&format!("{}:model:", actor.id))
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n < 32)
        .ok_or_else(bad)?;
    if origin.command_id != format!("{}:model:{turn}", actor.id) {
        return Err(bad());
    }
    let completion: Completion = serde_json::from_value(origin.outcome.clone().ok_or_else(bad)?)?;
    if completion.status != CompletionStatus::Completed || completion.error.is_some() {
        return Err(bad());
    }
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|c| match c {
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
            .map(|c| c.0)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != calls.len()
    {
        return Err(bad());
    }
    let index = calls
        .iter()
        .position(|c| Some(c.0.as_str()) == op.payload["call_id"].as_str())
        .ok_or_else(bad)?;
    let (id, name, args) = calls[index];
    if name != "run_web_experiment" {
        return Err(bad());
    }
    let definitions: Vec<ToolDefinition> =
        serde_json::from_value(origin.payload["request"]["tools"].clone())?;
    let offered: Vec<_> = definitions
        .iter()
        .filter(|d| d.name == name.as_str())
        .collect();
    if offered.len() != 1
        || serde_json::to_value(offered[0])?
            != serde_json::to_value(experiment_tool_definition(&policy))?
    {
        return Err(bad());
    }
    let expected = FrozenExperiment::new(
        &op.session_id,
        &actor.id,
        &origin.id,
        id,
        policy.clone(),
        serde_json::from_value(args.clone())?,
        actor.payload["http_context"].clone(),
        request.tool_approval_policy,
    )
    .map_err(|_| bad())?;
    if expected.intent() != frozen.intent() {
        return Err(bad());
    }
    let mut payload = frozen
        .parent_payload(
            &hash(&actor.payload).map_err(|_| bad())?,
            &hash(&origin.payload).map_err(|_| bad())?,
            &hash(origin.outcome.as_ref().unwrap_or(&Value::Null)).map_err(|_| bad())?,
        )
        .map_err(|_| bad())?;
    let approved = op.payload.get("approval_operation");
    if let Some(key) = approved {
        if !key.is_string() {
            return Err(bad());
        }
        payload["approval_operation"] = key.clone();
    }
    let command = format!("{}:tool:{turn}:{index}", actor.id);
    if payload != op.payload
        || op.command_id
            != if approved.is_some() {
                format!("{command}:effect")
            } else {
                command
            }
    {
        return Err(bad());
    }
    let context = &actor.payload["http_context"];
    let root_id: String = conn
        .query_row(
            "SELECT id FROM operations WHERE session_id=?1 AND command_id=?2",
            params![op.session_id, text(context, "original_root_command")?],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(bad)?;
    let root = reads.operation(conn, &root_id)?;
    witness(conn, &root, "command_admitted", reads)?;
    let root_request =
        zero_protocol::agent::validate_actor_payload(&root.payload).map_err(|_| bad())?;
    if root.payload.get("parent_operation").is_some()
        || root.payload["http_context"] != *context
        || root_request.web_experiment_policy.as_ref() != Some(&policy)
    {
        return Err(bad());
    }
    Ok(frozen)
}
fn actor_root(conn: &Connection, actor: &Operation, reads: &mut Reads) -> Result<String> {
    let Some(root_id) = actor.payload.get("parent_operation") else {
        return Ok(actor.id.clone());
    };
    let root_id = root_id.as_str().ok_or_else(bad)?;
    let root = reads.operation(conn, root_id)?;
    witness(conn, &root, "command_admitted", reads)?;
    zero_protocol::agent::validate_actor_payload(&root.payload).map_err(|_| bad())?;
    if root.session_id != actor.session_id
        || root.payload.get("parent_operation").is_some()
        || root.payload["http_context"] != actor.payload["http_context"]
    {
        return Err(bad());
    }
    let group_id: String = conn
        .query_row(
            "SELECT id FROM operations WHERE session_id=?1 AND command_id=?2",
            params![
                actor.session_id,
                text(&actor.payload, "delegation_group_command")?
            ],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(bad)?;
    let group = reads.operation(conn, &group_id)?;
    witness(conn, &group, "command_admitted", reads)?;
    if group.payload["kind"] != "agent_delegation"
        || group.payload["parent_operation"] != root.id
        || !group.payload["child_commands"]
            .as_array()
            .is_some_and(|v| v.iter().any(|c| c.as_str() == Some(&actor.command_id)))
    {
        return Err(bad());
    }
    Ok(root.id.clone())
}
fn prior(
    conn: &Connection,
    op: &Operation,
    frozen: &FrozenExperiment,
    reads: &mut Reads,
) -> Result<()> {
    let Some(mut link) = frozen.hypothesis().prior_revision.clone() else {
        return Ok(());
    };
    let actor = reads.operation(conn, text(&op.payload, "parent_operation")?)?;
    let mut root = actor_root(conn, &actor, reads)?;
    let mut roots = std::collections::BTreeSet::new();
    let mut complete_ancestry = false;
    for _ in 0..32 {
        if !roots.insert(root.clone()) {
            return Err(bad());
        }
        let current = reads.operation(conn, &root)?;
        witness(conn, &current, "command_admitted", reads)?;
        let request =
            zero_protocol::agent::validate_actor_payload(&current.payload).map_err(|_| bad())?;
        if current.session_id != op.session_id
            || current.payload["http_context"] != op.payload["http_context"]
            || request.web_experiment_policy.as_ref() != Some(frozen.policy())
        {
            return Err(bad());
        }
        match request.continuation_of {
            Some(previous) => root = previous,
            None => {
                complete_ancestry = true;
                break;
            }
        }
    }
    if !complete_ancestry {
        return Err(bad());
    }
    let origin = reads.operation(conn, text(&op.payload, "origin_inference_id")?)?;
    let before = witness(conn, &origin, "operation_settled", reads)?;
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..32 {
        if !seen.insert(link.operation_id.clone()) {
            return Err(bad());
        }
        let old = reads.operation(conn, &link.operation_id)?;
        if old.session_id != op.session_id
            || witness(conn, &old, "command_admitted", reads)? >= before
        {
            return Err(bad());
        }
        let old_frozen = source(conn, &old, reads)?;
        crate::web_experiment_quota::require(conn, &old, &old_frozen, reads)?;
        permission(conn, &old, &old_frozen, reads)?;
        let old_actor = reads.operation(conn, text(&old.payload, "parent_operation")?)?;
        if old_frozen.hypothesis_sha256() != link.hypothesis_sha256
            || old.payload["http_context"] != op.payload["http_context"]
            || !roots.contains(&actor_root(conn, &old_actor, reads)?)
        {
            return Err(bad());
        }
        let (digest,size):(String,usize)=conn.query_row("SELECT o.digest,length(a.bytes) FROM operation_artifacts o JOIN artifacts a ON a.digest=o.digest WHERE o.operation_id=?1 AND o.name='experiment.hypothesis'",[&old.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(bad)?;
        if size > 64 * 1024 {
            return Err(bad());
        }
        reads.witnesses.reserve(size)?;
        let mut stmt=conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='operation_artifact' AND json_extract(payload,'$.operation_id')=?2 AND json_extract(payload,'$.name')='experiment.hypothesis' LIMIT 2")?;
        let events = stmt
            .query_map(params![op.session_id, old.id], |r| r.get::<_, u64>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if events.len() != 1 || events[0] >= before {
            return Err(bad());
        }
        let (_, event) = reads
            .witnesses
            .event(conn, &op.session_id, events[0], 16384)?;
        if *event
            != serde_json::json!({"operation_id":old.id,"name":"experiment.hypothesis","digest":digest,"bytes":size})
        {
            return Err(bad());
        }
        let bytes = crate::artifacts::read(conn, &digest)?;
        if serde_json::from_slice::<Value>(&bytes)?
            != serde_json::to_value(old_frozen.hypothesis())?
        {
            return Err(bad());
        }
        match &old_frozen.hypothesis().prior_revision {
            Some(next) => link = next.clone(),
            None => return Ok(()),
        }
    }
    Err(bad())
}
fn permission(
    conn: &Connection,
    op: &Operation,
    frozen: &FrozenExperiment,
    reads: &mut Reads,
) -> Result<()> {
    if frozen.approval_required() != op.payload.get("approval_operation").is_some() {
        return Err(bad());
    }
    if let Some(key) = op.payload.get("approval_operation") {
        crate::approvals::validate_experiment_consumption(
            conn,
            op,
            key.as_str().ok_or_else(bad)?,
            reads,
        )?;
    }
    Ok(())
}
pub(super) fn admit(tx: &Transaction<'_>, op: &Operation) -> Result<()> {
    let mut reads = Reads::default();
    let frozen = source(tx, op, &mut reads)?;
    let actor = reads.operation(tx, text(&op.payload, "parent_operation")?)?;
    if actor.status != OperationStatus::Running || actor.owner.is_none() || actor.owner != op.owner
    {
        return Err(bad());
    }
    let epoch: Option<String> = tx
        .query_row(
            "SELECT owner FROM engine_epoch WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if epoch.as_ref() != op.owner.as_ref() {
        return Err(bad());
    }
    let root_id = actor_root(tx, &actor, &mut reads)?;
    let root = reads.operation(tx, &root_id)?;
    if root.status != OperationStatus::Running || root.owner != op.owner {
        return Err(bad());
    }
    prior(tx, op, &frozen, &mut reads)?;
    permission(tx, op, &frozen, &mut reads)?;
    crate::web_experiment_quota::admit(tx, op, &frozen, &mut reads)
}
pub(super) fn parent(
    conn: &Connection,
    op: &Operation,
    reads: &mut Reads,
) -> Result<FrozenExperiment> {
    witness(conn, op, "command_admitted", reads)?;
    let frozen = source(conn, op, reads)?;
    prior(conn, op, &frozen, reads)?;
    permission(conn, op, &frozen, reads)?;
    crate::web_experiment_quota::require(conn, op, &frozen, reads)?;
    Ok(frozen)
}
pub(super) fn effect(conn: &Connection, op: &Operation) -> Result<()> {
    let mut reads = Reads::default();
    let parent_op = reads.operation(conn, text(&op.payload, "parent_operation")?)?;
    let frozen = parent(conn, &parent_op, &mut reads)?;
    witness(conn, op, "command_admitted", &mut reads)?;
    let case = op.payload["origin"]["case_index"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(bad)?;
    let repeat = op.payload["origin"]["repeat_index"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(bad)?;
    if op.session_id != parent_op.session_id
        || op.command_id != format!("{}:web:case:{case}:{repeat}", parent_op.id)
        || op.payload
            != frozen
                .child_payload(&parent_op.id, case, repeat)
                .map_err(|_| bad())?
    {
        return Err(bad());
    }
    Ok(())
}
impl Store {
    pub fn admit_web_experiment(
        &mut self,
        session: &str,
        actor: &str,
        owner: &str,
        command: &str,
        payload: &Value,
    ) -> Result<Operation> {
        if payload["kind"] != "agent_web_experiment" || payload["parent_operation"] != actor {
            return Err(bad());
        }
        Ok(self
            .admit_owned_batch(session, owner, &[(command.into(), payload.clone())])?
            .remove(0))
    }
    pub fn validate_web_experiment_parent(&self, op: &Operation) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let mut reads = Reads::default();
        let current = reads.operation(&tx, &op.id)?;
        if serde_json::to_value(&*current)? != serde_json::to_value(op)? {
            return Err(bad());
        }
        Ok(parent(&tx, &current, &mut reads)?.intent().clone())
    }
}
