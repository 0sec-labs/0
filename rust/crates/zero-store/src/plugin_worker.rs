//! Captured plugin workers and callbacks are one-use children of the original actor.
//! No callback creates an independent network account or inherits model authority.
use crate::workflow::{self, Reader};
use crate::{Error, Operation, OperationStatus, Result, Store, append};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use zero_protocol::plugin::{PluginHostOperation, PluginPin, PluginWorkerPolicy};

fn bad(s: &str) -> Error {
    Error::Conflict(format!("plugin worker: {s}"))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
        .ok_or_else(|| bad("missing or oversized identity"))
}
fn id(s: &str) -> Result<()> {
    if s.is_empty() || s.len() > 256 || s.chars().any(char::is_control) {
        Err(bad("invalid identifier"))
    } else {
        Ok(())
    }
}
fn hash(v: &Value) -> Result<String> {
    crate::questions::hash(v)
}
fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| bad("clock"))?
        .as_millis()
        .try_into()
        .map_err(|_| bad("clock overflow"))
}
fn epoch(c: &Connection, owner: &str) -> Result<()> {
    let actual: Option<String> = c
        .query_row(
            "SELECT owner FROM engine_epoch WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if actual.as_deref() != Some(owner) {
        return Err(bad("engine epoch changed"));
    }
    Ok(())
}
fn owned(op: &Operation, owner: &str) -> Result<()> {
    if op.status != OperationStatus::Running || op.owner.as_deref() != Some(owner) {
        return Err(bad("operation is not owned and running"));
    }
    Ok(())
}
pub(crate) fn forbid_generic(payload: &Value) -> Result<()> {
    if matches!(
        payload["kind"].as_str(),
        Some("agent_plugin_worker" | "agent_plugin_callback")
    ) || payload.get("plugin_worker_origin").is_some()
    {
        return Err(bad("dedicated worker admission required"));
    }
    Ok(())
}
fn guards(c: &Connection, session: &str, command: &str, payload: &Value) -> Result<()> {
    crate::scan::authorize(c, session, command, payload)?;
    crate::review::forbid_input(c, session)?;
    crate::campaign::authorize(c, session, command, payload)?;
    crate::strategy_session::authorize(c, session, command, payload)?;
    Ok(())
}
fn insert(
    tx: &Transaction<'_>,
    session: &str,
    key: &str,
    command: &str,
    payload: &Value,
    owner: &str,
) -> Result<Operation> {
    id(key)?;
    id(command)?;
    guards(tx, session, command, payload)?;
    let prior:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='command_admitted' AND json_extract(payload,'$.command_id')=?2)",params![session,command],|r|r.get(0))?;
    if prior {
        return Err(bad("immutable command admission already exists"));
    }
    let bytes = serde_json::to_vec(payload)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(bad("operation exceeds 2 MiB"));
    }
    use sha2::{Digest, Sha256};
    tx.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES(?1,?2,?3,?4,?5,'admitted')",params![key,session,command,std::str::from_utf8(&bytes).map_err(|_|bad("JSON encoding"))?,format!("{:x}",Sha256::digest(&bytes))])?;
    let mut op = Operation {
        id: key.into(),
        session_id: session.into(),
        command_id: command.into(),
        payload: payload.clone(),
        status: OperationStatus::Admitted,
        owner: None,
        outcome: None,
    };
    append(tx, session, "command_admitted", &serde_json::to_value(&op)?)?;
    tx.execute(
        "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
        params![key, owner],
    )?;
    op.status = OperationStatus::Running;
    op.owner = Some(owner.into());
    append(
        tx,
        session,
        "operation_started",
        &serde_json::to_value(&op)?,
    )?;
    Ok(op)
}
fn event(tx: &Transaction<'_>, worker: &Operation, kind: &str, mut value: Value) -> Result<()> {
    value["worker_id"] = json!(worker.id);
    append(tx, &worker.session_id, kind, &value)
}
struct State {
    worker: Operation,
    actor: Operation,
    root: Operation,
    policy: PluginWorkerPolicy,
    calls: Vec<(Operation, PluginPin)>,
    origins: BTreeMap<String, String>,
    callbacks: Vec<Operation>,
    started: bool,
    prepared: Option<Value>,
    effects: BTreeSet<String>,
}
// A provisional guest reply closes its wire invocation without asserting the
// worker process has drained. The artifact and detail are checked together.
fn reply_sequence(
    c: &Connection,
    worker: &str,
    call: &Operation,
    r: &mut Reader,
) -> Result<Option<u64>> {
    let mut q=c.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='operation_detail' AND json_extract(payload,'$.operation_id')=?2 AND json_extract(payload,'$.kind')='plugin.worker_reply' ORDER BY sequence LIMIT 2")?;
    let seq = q
        .query_map(params![call.session_id, call.id], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let attachment:Option<String>=c.query_row("SELECT CASE WHEN length(digest)<=71 THEN digest END FROM operation_artifacts WHERE operation_id=?1 AND name='plugin.worker_reply'",[&call.id],|r|r.get(0)).optional()?;
    if seq.is_empty() && attachment.is_none() {
        return Ok(None);
    }
    if seq.len() != 1 {
        return Err(bad("provisional reply witness missing or repeated"));
    }
    let digest = attachment.ok_or_else(|| bad("provisional reply artifact absent"))?;
    let bytes = r.artifact(c, &digest, 1024 * 1024)?;
    let (_, v) = r.event(c, &call.session_id, seq[0])?;
    if v != json!({"operation_id":call.id,"kind":"plugin.worker_reply","details":{"worker_operation_id":worker,"reply_artifact":digest}})
    {
        return Err(bad("provisional reply binding differs"));
    }
    let mut q=c.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='operation_artifact' AND json_extract(payload,'$.operation_id')=?2 AND json_extract(payload,'$.name')='plugin.worker_reply' LIMIT 2")?;
    let attached = q
        .query_map(params![call.session_id, call.id], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if attached.len() != 1
        || attached[0] >= seq[0]
        || r.event(c, &call.session_id, attached[0])?.1
            != json!({"operation_id":call.id,"name":"plugin.worker_reply","digest":digest,"bytes":bytes.len()})
    {
        return Err(bad("reply attachment witness differs"));
    }
    Ok(Some(seq[0]))
}
fn current_call(c: &Connection, s: &State, call: &Operation, owner: &str) -> Result<()> {
    owned(call, owner)?;
    if s.calls.last().map(|v| v.0.id.as_str()) != Some(call.id.as_str())
        || reply_sequence(c, &s.worker.id, call, &mut Reader::new())?.is_some()
    {
        return Err(bad("callback invocation already replied or superseded"));
    }
    Ok(())
}
fn actor_pair(c: &Connection, key: &str, r: &mut Reader) -> Result<(Operation, Operation)> {
    let actor = workflow::operation(c, key, r)?;
    zero_protocol::agent::validate_actor_payload(&actor.payload)
        .map_err(|_| bad("invalid captured actor"))?;
    let root = if let Some(key) = actor.payload["parent_operation"].as_str() {
        workflow::operation(c, key, r)?
    } else {
        actor.clone()
    };
    zero_protocol::agent::validate_actor_payload(&root.payload)
        .map_err(|_| bad("invalid captured root"))?;
    if root.payload.get("parent_operation").is_some()
        || root.session_id != actor.session_id
        || root.owner != actor.owner
    {
        return Err(bad("actor/root authority differs"));
    }
    Ok((actor, root))
}
fn policy(actor: &Operation, plugin: &str) -> Result<PluginWorkerPolicy> {
    let policy: PluginWorkerPolicy =
        serde_json::from_value(actor.payload["plugin_context"]["workers"][plugin].clone())?;
    policy
        .validate()
        .map_err(|_| bad("invalid captured worker policy"))?;
    Ok(policy)
}
fn selected<'a>(actor: &'a Operation, binding: &Value) -> Result<&'a Value> {
    let selected = actor.payload["plugin_context"]["selected"]
        .as_array()
        .filter(|a| a.len() <= 32)
        .ok_or_else(|| bad("captured plugin selection absent"))?;
    let mut found = selected.iter().filter(|v| v["binding"] == *binding);
    let value = found.next().ok_or_else(|| bad("plugin binding absent"))?;
    if found.next().is_some() {
        return Err(bad("duplicate plugin binding"));
    }
    Ok(value)
}
fn validate_call(
    c: &Connection,
    actor: &Operation,
    plugin: &str,
    call: &Operation,
    pin: &PluginPin,
    r: &mut Reader,
) -> Result<String> {
    if call.session_id != actor.session_id
        || call.owner != actor.owner
        || call.payload["kind"] != "agent_plugin"
        || call.payload["parent_operation"] != actor.id
        || call.payload["plugin_context"] != actor.payload["plugin_context"]
        || call.payload["binding"]["plugin"] != plugin
    {
        return Err(bad("call is outside captured actor/plugin"));
    }
    let binding = &call.payload["binding"];
    let selected = selected(actor, binding)?;
    let request = zero_protocol::agent::validate_actor_payload(&actor.payload)
        .map_err(|_| bad("actor request"))?;
    if !request
        .plugin_tools
        .iter()
        .any(|v| serde_json::to_value(v).ok().as_ref() == Some(binding))
    {
        return Err(bad("plugin binding not offered by actor"));
    }
    id(&pin.lease_id)?;
    id(&pin.lease_owner)?;
    if pin.lease_owner != call.id
        || pin.generation
            != actor.payload["plugin_context"]["generation"]
                .as_str()
                .unwrap_or("")
        || pin.epoch == 0
        || Some(pin.epoch) != actor.payload["plugin_context"]["epoch"].as_u64()
        || pin.plugin_manifest != text(selected, "manifest")?
        || pin.plugin_manifest.len() != 64
        || !pin
            .plugin_manifest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(bad("lease differs from captured plugin authority"));
    }
    let command = call
        .command_id
        .strip_suffix(":effect")
        .unwrap_or(&call.command_id);
    let (turn, index) = command
        .strip_prefix(&format!("{}:tool:", actor.id))
        .and_then(|s| s.split_once(':'))
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<usize>().ok()?)))
        .filter(|(a, b)| *a < 32 && *b < 32)
        .ok_or_else(|| bad("call has no canonical inference position"))?;
    if command != format!("{}:tool:{turn}:{index}", actor.id) {
        return Err(bad("noncanonical call position"));
    }
    let inference_id: String = c.query_row(
        "SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM operations WHERE session_id=?1 AND command_id=?2",
        params![actor.session_id, format!("{}:model:{turn}", actor.id)],
        |r| r.get(0),
    )?;
    let origin = workflow::operation(c, &inference_id, r)?;
    if origin.status != OperationStatus::Succeeded
        || origin.payload["kind"] != "agent_inference"
        || origin.payload["parent_operation"] != actor.id
    {
        return Err(bad("call origin not completed inference"));
    }
    let completion: zero_protocol::model::Completion = serde_json::from_value(
        origin
            .outcome
            .clone()
            .ok_or_else(|| bad("completion absent"))?,
    )?;
    if completion.status != zero_protocol::model::CompletionStatus::Completed
        || completion.error.is_some()
    {
        return Err(bad("inference incomplete"));
    }
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|v| {
            if let zero_protocol::model::Content::ToolCall {
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
    if calls.len() > 32 || calls.iter().map(|v| v.0).collect::<BTreeSet<_>>().len() != calls.len() {
        return Err(bad("invalid inference call inventory"));
    }
    let (call_id, name, args) = calls
        .get(index)
        .ok_or_else(|| bad("inference call absent"))?;
    if call.payload["call_id"] != **call_id
        || binding["alias"] != **name
        || call.payload["input"] != **args
    {
        return Err(bad("call differs from actual model arguments"));
    }
    let tools: Vec<zero_protocol::model::ToolDefinition> =
        serde_json::from_value(origin.payload["request"]["tools"].clone())?;
    if tools.iter().filter(|t| t.name == **name).count() != 1 {
        return Err(bad("alias not uniquely offered"));
    }
    let required = request
        .tool_approval_policy
        .as_ref()
        .is_some_and(|p| p.require_approval.contains(name));
    if let Some(key) = call.payload["approval_operation"].as_str() {
        crate::approvals::validate_experiment_consumption(
            c,
            call,
            key,
            &mut crate::questions::Reads::default(),
        )?;
    } else if required {
        return Err(bad("plugin alias requires independent approval"));
    }
    Ok(origin.id)
}
fn state(c: &Connection, key: &str, r: &mut Reader) -> Result<State> {
    let worker = workflow::operation(c, key, r)?;
    if worker.payload["kind"] != "agent_plugin_worker" {
        return Err(bad("not a worker"));
    }
    let (actor, root) = actor_pair(c, text(&worker.payload, "parent_operation")?, r)?;
    let plugin = text(&worker.payload, "plugin")?;
    let policy = policy(&actor, plugin)?;
    if worker.session_id != actor.session_id
        || worker.owner != actor.owner
        || worker.payload["root_operation"] != root.id
        || worker.payload["plugin_context_sha256"] != hash(&actor.payload["plugin_context"])?
        || worker.command_id != format!("{}:plugin-worker:{plugin}", actor.id)
    {
        return Err(bad("worker identity differs"));
    }
    let deadline = worker.payload["deadline_at_ms"]
        .as_u64()
        .ok_or_else(|| bad("worker deadline absent"))?;
    let created = worker.payload["created_at_ms"]
        .as_u64()
        .ok_or_else(|| bad("worker creation absent"))?;
    if created.checked_add(
        actor.payload["plugin_context"]["launch"]["timeout_ms"]
            .as_u64()
            .ok_or_else(|| bad("launch deadline absent"))?,
    ) != Some(deadline)
    {
        return Err(bad("worker deadline changed"));
    }
    let mut query=c.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind IN ('plugin_worker_registered','plugin_worker_call_bound','plugin_worker_prepared','plugin_worker_started','plugin_worker_callback_admitted','plugin_worker_callback_started') AND json_extract(payload,'$.worker_id')=?2 ORDER BY sequence LIMIT 513")?;
    let rows = query
        .query_map(params![worker.session_id, key], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.is_empty() || rows.len() > 512 {
        return Err(bad("worker witness inventory bound"));
    }
    let mut s = State {
        worker: worker.clone(),
        actor,
        root,
        policy,
        calls: vec![],
        origins: BTreeMap::new(),
        callbacks: vec![],
        started: false,
        prepared: None,
        effects: BTreeSet::new(),
    };
    let mut registered = false;
    for sequence in rows {
        let (kind, v) = r.event(c, &worker.session_id, sequence)?;
        match kind.as_str() {
            "plugin_worker_registered" => {
                if registered
                    || !s.calls.is_empty()
                    || v != json!({"worker_id":key,"payload_sha256":hash(&worker.payload)?,"owner":worker.owner})
                {
                    return Err(bad("worker registration witness differs"));
                }
                registered = true;
            }
            "plugin_worker_call_bound" => {
                if !registered
                    || s.calls.len() >= s.policy.max_calls as usize
                    || v["ordinal"] != s.calls.len() as u64
                {
                    return Err(bad("call ordinal differs"));
                }
                if let Some((prior, _)) = s.calls.last() {
                    if !reply_sequence(c, key, prior, r)?.is_some_and(|v| v < sequence) {
                        return Err(bad("next call precedes prior provisional reply"));
                    }
                }
                let call = workflow::operation(c, text(&v, "call_operation_id")?, r)?;
                let pin: PluginPin = serde_json::from_value(v["pin"].clone())?;
                let origin = validate_call(c, &s.actor, plugin, &call, &pin, r)?;
                s.origins.insert(call.id.clone(), origin);
                if s.calls
                    .iter()
                    .any(|(o, p)| o.id == call.id || p.lease_id == pin.lease_id)
                {
                    return Err(bad("replayed call or lease"));
                }
                s.calls.push((call, pin));
            }
            "plugin_worker_prepared" => {
                if s.prepared.is_some()
                    || s.calls.len() != 1
                    || s.started
                    || !zero_protocol::is_sha256(text(&v, "request_sha256")?)
                    || text(&v, "execution_id")?.len() > 256
                    || v["pin"] != serde_json::to_value(&s.calls[0].1)?
                {
                    return Err(bad("worker preparation differs"));
                }
                s.prepared = Some(v);
            }
            "plugin_worker_started" => {
                if s.started
                    || s.prepared.is_none()
                    || v != json!({"worker_id":key,"owner":worker.owner,"preparation_sha256":hash(s.prepared.as_ref().ok_or_else(||bad("worker preparation absent"))?)?})
                {
                    return Err(bad("worker physical start differs"));
                }
                s.started = true;
            }
            "plugin_worker_callback_admitted" => {
                if !s.started || s.callbacks.len() >= s.policy.max_callbacks as usize {
                    return Err(bad("callback exceeds captured worker"));
                }
                let cb = workflow::operation(c, text(&v, "callback_operation_id")?, r)?;
                let (call, pin) = s
                    .calls
                    .last()
                    .ok_or_else(|| bad("callback has no bound call"))?;
                validate_callback_payload(&s, call, pin, &cb)?;
                if reply_sequence(c, key, call, r)?.is_some_and(|v| v <= sequence) {
                    return Err(bad("callback was admitted after provisional reply"));
                }
                if cb.payload["callback_id"] != s.callbacks.len() as u64 + 1
                    || v["payload_sha256"] != hash(&cb.payload)?
                {
                    return Err(bad("callback sequence changed"));
                }
                s.callbacks.push(cb);
            }
            "plugin_worker_callback_started" => {
                let cb = s
                    .callbacks
                    .iter()
                    .find(|o| v["callback_operation_id"] == o.id)
                    .ok_or_else(|| bad("orphan callback effect"))?;
                let (call, _) = s
                    .calls
                    .last()
                    .ok_or_else(|| bad("effect has no active call"))?;
                if cb.payload["call_operation_id"] != call.id
                    || reply_sequence(c, key, call, r)?.is_some_and(|v| v <= sequence)
                {
                    return Err(bad("source effect occurred after invocation closed"));
                }
                if !s.effects.insert(cb.id.clone())
                    || v != json!({"worker_id":key,"callback_operation_id":cb.id,"owner":worker.owner,"payload_sha256":hash(&cb.payload)?})
                {
                    return Err(bad("callback start repeated or changed"));
                }
            }
            _ => return Err(bad("unsupported worker witness")),
        }
    }
    if !registered {
        return Err(bad("registration absent"));
    }
    // Detect deleted or forged projections in either direction, including a
    // tail callback whose operation row was removed but witness was retained.
    let mut q=c.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM operations WHERE session_id=?1 AND json_extract(payload,'$.worker_id')=?2 AND json_extract(payload,'$.kind')='agent_plugin_callback' LIMIT 129")?;
    let actual = q
        .query_map(params![worker.session_id, key], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    if actual != s.callbacks.iter().map(|v| v.id.clone()).collect() {
        return Err(bad("callback projection inventory differs"));
    }
    let mut q=c.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='command_admitted' AND json_extract(payload,'$.payload.kind')='agent_plugin_callback' AND json_extract(payload,'$.payload.worker_id')=?2 ORDER BY sequence LIMIT 129")?;
    let admissions = q
        .query_map(params![worker.session_id, key], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut ids = BTreeSet::new();
    for seq in admissions {
        let (_, v) = r.event(c, &worker.session_id, seq)?;
        if !ids.insert(text(&v, "id")?.to_owned()) {
            return Err(bad("duplicate callback admission"));
        }
    }
    if ids != actual {
        return Err(bad("orphan callback admission witness"));
    }
    let mut q=c.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='operation_detail' AND json_extract(payload,'$.kind')='plugin.worker_call' AND json_extract(payload,'$.details.worker_operation_id')=?2 ORDER BY sequence LIMIT 33")?;
    let links = q
        .query_map(params![worker.session_id, key], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if links.len() != s.calls.len() {
        return Err(bad("call link inventory differs"));
    }
    for (ordinal, seq) in links.into_iter().enumerate() {
        let (call, pin) = &s.calls[ordinal];
        if r.event(c, &worker.session_id, seq)?.1
            != json!({"operation_id":call.id,"kind":"plugin.worker_call","details":{"worker_operation_id":key,"call_operation_id":call.id,"pin":pin,"ordinal":ordinal}})
        {
            return Err(bad("call link witness differs"));
        }
    }
    for cb in &s.callbacks {
        if cb.status == OperationStatus::Succeeded
            && cb.payload["operation"] != "http_request"
            && !s.effects.contains(&cb.id)
        {
            return Err(bad("successful source callback lacks physical start"));
        }
    }
    Ok(s)
}
fn validate_callback_payload(
    s: &State,
    call: &Operation,
    pin: &PluginPin,
    cb: &Operation,
) -> Result<()> {
    let op: PluginHostOperation = serde_json::from_value(cb.payload["operation"].clone())?;
    let selected = selected(&s.actor, &call.payload["binding"])?;
    if !s.policy.operations.contains(&op)
        || !selected["capabilities"]
            .as_array()
            .is_some_and(|v| v.iter().any(|v| v == op.capability()))
    {
        return Err(bad("callback capability not captured for tool"));
    }
    let expected = json!({"kind":"agent_plugin_callback","parent_operation":s.actor.id,"root_operation":s.root.id,"worker_id":s.worker.id,"call_operation_id":call.id,"pin":pin,"callback_id":cb.payload["callback_id"],"operation":op,"input":cb.payload["input"]});
    if cb.payload != expected
        || cb.session_id != s.worker.session_id
        || cb.owner != s.worker.owner
        || cb.command_id
            != format!(
                "{}:callback:{}",
                s.worker.id,
                cb.payload["callback_id"]
                    .as_u64()
                    .ok_or_else(|| bad("callback id absent"))?
            )
    {
        return Err(bad("callback authority differs"));
    }
    let request = zero_protocol::agent::validate_actor_payload(&s.actor.payload)
        .map_err(|_| bad("actor invalid"))?;
    if op == PluginHostOperation::HttpRequest {
        if request.http_profile.is_none() || !s.actor.payload["http_context"].is_object() {
            return Err(bad("native HTTP not granted to actor"));
        }
        let _: zero_protocol::http::HttpRequestArguments =
            serde_json::from_value(cb.payload["input"].clone())?;
    } else {
        if (!request.source_snapshot_tools && request.source_review_operation_id.is_none())
            || request.snapshot_request().is_err()
        {
            return Err(bad("native source authority not granted to actor"));
        }
        if s.actor.payload.get("parent_operation").is_some()
            && !s.actor.payload["delegation_template"]["tools"]
                .as_array()
                .is_some_and(|tools| {
                    tools
                        .iter()
                        .filter(|tool| tool["name"] == op.name())
                        .count()
                        == 1
                })
        {
            return Err(bad("source callback was removed from delegated role"));
        }
    }
    Ok(())
}
fn live(c: &Connection, s: &State, owner: &str) -> Result<()> {
    epoch(c, owner)?;
    for op in [&s.worker, &s.actor, &s.root] {
        owned(op, owner)?;
    }
    if now()?
        >= s.worker.payload["deadline_at_ms"]
            .as_u64()
            .ok_or_else(|| bad("deadline absent"))?
    {
        return Err(bad("worker absolute deadline expired"));
    }
    guards(
        c,
        &s.worker.session_id,
        &s.worker.command_id,
        &s.worker.payload,
    )
}
fn callback(c: &Connection, key: &str, r: &mut Reader) -> Result<(State, Operation)> {
    let cb = workflow::operation(c, key, r)?;
    let s = state(c, text(&cb.payload, "worker_id")?, r)?;
    if !s.callbacks.iter().any(|v| v.id == cb.id) {
        return Err(bad("callback witness absent"));
    }
    Ok((s, cb))
}
fn http_payload(s: &State, cb: &Operation) -> Result<Value> {
    if cb.payload["operation"] != "http_request" {
        return Err(bad("callback is not HTTP"));
    }
    let context = &s.actor.payload["http_context"];
    let policy: zero_protocol::http::HttpProfilePolicy =
        serde_json::from_value(context["profile"].clone())?;
    if zero_http::normalize_policy(policy.clone()).map_err(|_| bad("HTTP policy"))? != policy
        || zero_http::profile_sha256(&policy).map_err(|_| bad("HTTP policy digest"))?
            != text(context, "profile_sha256")?
        || context["profile_name"] != s.actor.payload["request"]["http_profile"]
    {
        return Err(bad("HTTP capture differs"));
    }
    let args: zero_protocol::http::HttpRequestArguments =
        serde_json::from_value(cb.payload["input"].clone())?;
    let request = zero_http::normalize_intent(&policy, args)
        .map_err(|_| bad("callback HTTP request rejected"))?;
    let mut effect = json!({"kind":"agent_http","parent_operation":s.actor.id,"call_id":cb.id,"http_context":context,"request":request,"plugin_worker_origin":{"callback_operation_id":cb.id}});
    if let Some(version) = s.actor.payload.get("http_output_version") {
        if version != 2 {
            return Err(bad("unsupported HTTP output version"));
        }
        effect["http_output_version"] = json!(2);
    }
    Ok(effect)
}
fn needs_approval(s: &State) -> Result<bool> {
    let p: Option<zero_protocol::approvals::ToolApprovalPolicy> =
        serde_json::from_value(s.actor.payload["request"]["tool_approval_policy"].clone())?;
    Ok(p.is_some_and(|p| p.require_approval.iter().any(|n| n == "http_request")))
}
pub(crate) fn callback_approval_intent(
    c: &Connection,
    actor: &Operation,
    command: &str,
    origin: &str,
    call: &str,
    alias: &str,
    effect: &Value,
) -> Result<Value> {
    let (s, cb) = callback(c, origin, &mut Reader::new())?;
    if s.actor.id != actor.id
        || cb.id != call
        || alias != "http_request"
        || command != format!("{}:approval", cb.id)
        || !needs_approval(&s)?
        || http_payload(&s, &cb)? != *effect
    {
        return Err(bad("callback approval identity differs"));
    }
    Ok(
        json!({"schema_version":2,"session_id":actor.session_id,"root_operation_id":s.root.id,"actor_operation_id":actor.id,"actor_payload_sha256":hash(&actor.payload)?,"origin_callback_id":cb.id,"origin_callback_payload_sha256":hash(&cb.payload)?,"worker_operation_id":s.worker.id,"call_operation_id":cb.payload["call_operation_id"],"pin":cb.payload["pin"],"call_id":cb.id,"tool_name":"http_request","arguments":cb.payload["input"],"policy":actor.payload["request"]["tool_approval_policy"],"effect_command_id":format!("{}:http",cb.id),"effect_payload":effect}),
    )
}
pub(crate) fn guard_callback_approval(c: &Connection, intent: &Value, owner: &str) -> Result<()> {
    if intent["schema_version"] != 2 {
        return Ok(());
    }
    let (s, cb) = callback(c, text(intent, "origin_callback_id")?, &mut Reader::new())?;
    live(c, &s, owner)?;
    owned(&cb, owner)?;
    let call = s
        .calls
        .iter()
        .find(|(call, _)| cb.payload["call_operation_id"] == call.id)
        .ok_or_else(|| bad("callback call absent"))?;
    current_call(c, &s, &call.0, owner)?;
    Ok(())
}
pub(crate) fn guard_http_admission(
    c: &Connection,
    payload: &Value,
    command: &str,
    owner: &str,
) -> Result<()> {
    let Some(origin) = payload.get("plugin_worker_origin") else {
        return Ok(());
    };
    let (s, cb) = callback(
        c,
        text(origin, "callback_operation_id")?,
        &mut Reader::new(),
    )?;
    live(c, &s, owner)?;
    owned(&cb, owner)?;
    let (call, _) = s
        .calls
        .iter()
        .find(|(v, _)| cb.payload["call_operation_id"] == v.id)
        .ok_or_else(|| bad("callback call absent"))?;
    current_call(c, &s, call, owner)?;
    let mut expected = http_payload(&s, &cb)?;
    if let Some(approval) = payload.get("approval_operation") {
        expected["approval_operation"] = approval.clone();
    }
    if *payload != expected || command != format!("{}:http", cb.id) {
        return Err(bad("callback HTTP admission differs"));
    }
    let prior:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='command_admitted' AND json_extract(payload,'$.command_id')=?2)",params![cb.session_id,command],|r|r.get(0))?;
    if prior {
        return Err(bad("callback HTTP already durably admitted"));
    }
    Ok(())
}
pub(crate) fn guard_http(c: &Connection, op: &Operation, owner: &str, hop: &Value) -> Result<()> {
    let Some(origin) = op.payload.get("plugin_worker_origin") else {
        return Ok(());
    };
    let (s, cb) = callback(
        c,
        text(origin, "callback_operation_id")?,
        &mut Reader::new(),
    )?;
    live(c, &s, owner)?;
    owned(&cb, owner)?;
    let (call, _) = s
        .calls
        .iter()
        .find(|(call, _)| cb.payload["call_operation_id"] == call.id)
        .ok_or_else(|| bad("callback call absent"))?;
    current_call(c, &s, call, owner)?;
    let mut expected = http_payload(&s, &cb)?;
    if let Some(key) = op.payload["approval_operation"].as_str() {
        crate::approvals::validate_experiment_consumption(
            c,
            op,
            key,
            &mut crate::questions::Reads::default(),
        )?;
        expected["approval_operation"] = json!(key);
    } else if needs_approval(&s)? {
        return Err(bad("callback HTTP requires independent approval"));
    }
    if op.session_id != s.worker.session_id
        || op.command_id != format!("{}:http", cb.id)
        || op.payload != expected
    {
        return Err(bad("HTTP effect differs from callback"));
    }
    if hop["index"] == 0 {
        let request: zero_protocol::http::HttpRequestIntent =
            serde_json::from_value(expected["request"].clone())?;
        if hop["url"] != request.url
            || hop["method"] != request.method
            || hop["request_body_bytes"] != request.body.as_ref().map_or(0, |v| v.len())
        {
            return Err(bad("first callback HTTP hop changed"));
        }
    }
    Ok(())
}
impl Store {
    #[allow(clippy::too_many_arguments)]
    pub fn register_plugin_worker(
        &mut self,
        session: &str,
        actor_id: &str,
        owner: &str,
        worker_id: &str,
        plugin: &str,
        attempt_dir: &str,
    ) -> Result<Operation> {
        for v in [session, actor_id, worker_id, plugin] {
            id(v)?;
        }
        if !std::path::Path::new(attempt_dir).is_absolute()
            || attempt_dir.len() > 4096
            || attempt_dir.contains('\0')
        {
            return Err(bad("attempt directory must be absolute"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        epoch(&tx, owner)?;
        let (actor, root) = actor_pair(&tx, actor_id, &mut Reader::new())?;
        owned(&actor, owner)?;
        owned(&root, owner)?;
        if actor.session_id != session {
            return Err(bad("worker session differs"));
        }
        policy(&actor, plugin)?;
        let selected = actor.payload["plugin_context"]["selected"]
            .as_array()
            .ok_or_else(|| bad("selection absent"))?;
        if !selected.iter().any(|v| v["binding"]["plugin"] == plugin) {
            return Err(bad("plugin not selected"));
        }
        let timeout = actor.payload["plugin_context"]["launch"]["timeout_ms"]
            .as_u64()
            .filter(|v| (1..=3_600_000).contains(v))
            .ok_or_else(|| bad("launch timeout bound"))?;
        let created = now()?;
        let deadline = created
            .checked_add(timeout)
            .ok_or_else(|| bad("deadline overflow"))?;
        let payload = json!({"kind":"agent_plugin_worker","parent_operation":actor.id,"root_operation":root.id,"plugin":plugin,"plugin_context_sha256":hash(&actor.payload["plugin_context"])?,"attempt_dir":attempt_dir,"created_at_ms":created,"deadline_at_ms":deadline});
        let op = insert(
            &tx,
            session,
            worker_id,
            &format!("{actor_id}:plugin-worker:{plugin}"),
            &payload,
            owner,
        )?;
        event(
            &tx,
            &op,
            "plugin_worker_registered",
            json!({"owner":owner,"payload_sha256":hash(&payload)?}),
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn bind_plugin_worker_call(
        &mut self,
        worker: &str,
        call_id: &str,
        owner: &str,
        pin: &PluginPin,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let s = state(&tx, worker, &mut r)?;
        live(&tx, &s, owner)?;
        if s.calls.len() >= s.policy.max_calls as usize
            || s.calls
                .iter()
                .any(|(v, p)| v.id == call_id || p.lease_id == pin.lease_id)
            || s.callbacks
                .iter()
                .any(|v| v.status == OperationStatus::Running)
        {
            return Err(bad("call replay, overlap or lifetime cap"));
        }
        if let Some((prior, _)) = s.calls.last() {
            if reply_sequence(&tx, worker, prior, &mut r)?.is_none() {
                return Err(bad("previous invocation has not replied"));
            }
        }
        let call = workflow::operation(&tx, call_id, &mut r)?;
        owned(&call, owner)?;
        validate_call(
            &tx,
            &s.actor,
            text(&s.worker.payload, "plugin")?,
            &call,
            pin,
            &mut r,
        )?;
        event(
            &tx,
            &s.worker,
            "plugin_worker_call_bound",
            json!({"call_operation_id":call_id,"pin":pin,"ordinal":s.calls.len()}),
        )?;
        append(
            &tx,
            &s.worker.session_id,
            "operation_detail",
            &json!({"operation_id":call_id,"kind":"plugin.worker_call","details":{"worker_operation_id":worker,"call_operation_id":call_id,"pin":pin,"ordinal":s.calls.len()}}),
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn prepare_plugin_worker(
        &mut self,
        worker: &str,
        owner: &str,
        request_digest: &str,
        execution_id: &str,
    ) -> Result<()> {
        id(execution_id)?;
        if !zero_protocol::is_sha256(request_digest) {
            return Err(bad("invalid prepared request digest"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let s = state(&tx, worker, &mut Reader::new())?;
        live(&tx, &s, owner)?;
        if s.calls.len() != 1 || s.prepared.is_some() || s.started {
            return Err(bad("worker preparation is one-use"));
        }
        current_call(&tx, &s, &s.calls[0].0, owner)?;
        event(
            &tx,
            &s.worker,
            "plugin_worker_prepared",
            json!({"request_sha256":request_digest,"execution_id":execution_id,"pin":s.calls[0].1}),
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn begin_plugin_worker(&mut self, worker: &str, owner: &str) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let s = state(&tx, worker, &mut Reader::new())?;
        live(&tx, &s, owner)?;
        if s.started || s.prepared.is_none() {
            return Err(bad(
                "worker physical start is one-use and requires preparation",
            ));
        }
        current_call(&tx, &s, &s.calls[0].0, owner)?;
        event(
            &tx,
            &s.worker,
            "plugin_worker_started",
            json!({"owner":owner,"preparation_sha256":hash(s.prepared.as_ref().ok_or_else(||bad("worker preparation absent"))?)?}),
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn admit_plugin_callback(
        &mut self,
        worker: &str,
        owner: &str,
        lease_id: &str,
        callback_id: u64,
        operation: PluginHostOperation,
        input: &Value,
    ) -> Result<Operation> {
        if serde_json::to_vec(input)?.len() > 1024 * 1024 {
            return Err(bad("callback arguments exceed 1 MiB"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let s = state(&tx, worker, &mut Reader::new())?;
        live(&tx, &s, owner)?;
        if !s.started
            || s.callbacks.len() >= s.policy.max_callbacks as usize
            || callback_id != s.callbacks.len() as u64 + 1
            || s.callbacks
                .iter()
                .any(|v| v.status == OperationStatus::Running)
        {
            return Err(bad("callback start, ordering or lifetime cap"));
        }
        let (call, pin) = s.calls.last().ok_or_else(|| bad("no bound call"))?;
        current_call(&tx, &s, call, owner)?;
        if pin.lease_id != lease_id {
            return Err(bad("callback lease changed"));
        }
        let payload = json!({"kind":"agent_plugin_callback","parent_operation":s.actor.id,"root_operation":s.root.id,"worker_id":worker,"call_operation_id":call.id,"pin":pin,"callback_id":callback_id,"operation":operation,"input":input});
        let key = uuid::Uuid::new_v4().to_string();
        let op = insert(
            &tx,
            &s.worker.session_id,
            &key,
            &format!("{worker}:callback:{callback_id}"),
            &payload,
            owner,
        )?;
        validate_callback_payload(&s, call, pin, &op)?;
        // Scope and caller header restrictions are checked before even admitting
        // an HTTP callback, and rederived again at every physical dispatch.
        if operation == PluginHostOperation::HttpRequest {
            http_payload(&s, &op)?;
        }
        event(
            &tx,
            &s.worker,
            "plugin_worker_callback_admitted",
            json!({"callback_operation_id":key,"payload_sha256":hash(&payload)?}),
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn begin_plugin_callback_effect(&mut self, key: &str, owner: &str) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (s, cb) = callback(&tx, key, &mut Reader::new())?;
        live(&tx, &s, owner)?;
        owned(&cb, owner)?;
        let (call, _) = s
            .calls
            .iter()
            .find(|(v, _)| cb.payload["call_operation_id"] == v.id)
            .ok_or_else(|| bad("call absent"))?;
        current_call(&tx, &s, call, owner)?;
        if s.effects.contains(key) {
            return Err(bad("callback physical start is one-use"));
        }
        event(
            &tx,
            &s.worker,
            "plugin_worker_callback_started",
            json!({"callback_operation_id":key,"owner":owner,"payload_sha256":hash(&cb.payload)?}),
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn plugin_callback_http_payload(&self, key: &str) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let (s, cb) = callback(&tx, key, &mut Reader::new())?;
        let v = http_payload(&s, &cb)?;
        tx.commit()?;
        Ok(v)
    }
    pub fn admit_plugin_callback_http(&mut self, key: &str, owner: &str) -> Result<Operation> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (s, cb) = callback(&tx, key, &mut Reader::new())?;
        live(&tx, &s, owner)?;
        owned(&cb, owner)?;
        let (call, _) = s
            .calls
            .iter()
            .find(|(v, _)| cb.payload["call_operation_id"] == v.id)
            .ok_or_else(|| bad("call absent"))?;
        current_call(&tx, &s, call, owner)?;
        if needs_approval(&s)? {
            return Err(bad("HTTP callback requires separate approval"));
        }
        let op = insert(
            &tx,
            &s.worker.session_id,
            &uuid::Uuid::new_v4().to_string(),
            &format!("{key}:http"),
            &http_payload(&s, &cb)?,
            owner,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn create_plugin_callback_approval(
        &mut self,
        key: &str,
        owner: &str,
    ) -> Result<zero_protocol::approvals::ToolApprovalRecord> {
        let (session, actor, payload) = {
            let tx = self.conn.unchecked_transaction()?;
            let (s, cb) = callback(&tx, key, &mut Reader::new())?;
            live(&tx, &s, owner)?;
            owned(&cb, owner)?;
            let value = (
                s.worker.session_id.clone(),
                s.actor.id.clone(),
                http_payload(&s, &cb)?,
            );
            tx.commit()?;
            value
        };
        // create_tool_approval rederives the callback authority inside its own
        // immediate transaction; the preliminary read grants no permission.
        self.create_tool_approval(
            &session,
            &actor,
            owner,
            &format!("{key}:approval"),
            key,
            key,
            "http_request",
            &payload,
        )
    }
    pub fn plugin_worker_record(&self, key: &str) -> Result<Operation> {
        let tx = self.conn.unchecked_transaction()?;
        let s = state(&tx, key, &mut Reader::new())?;
        tx.commit()?;
        Ok(s.worker)
    }
    pub fn plugin_worker_call(&self, key: &str) -> Result<Option<Value>> {
        let tx = self.conn.unchecked_transaction()?;
        let mut r = Reader::new();
        let call = workflow::operation(&tx, key, &mut r)?;
        if call.payload["kind"] != "agent_plugin" {
            return Err(bad("not a plugin call"));
        }
        let (actor, _) = actor_pair(&tx, text(&call.payload, "parent_operation")?, &mut r)?;
        let plugin = text(&call.payload["binding"], "plugin")?;
        if actor.payload["plugin_context"]["workers"]
            .get(plugin)
            .is_none()
        {
            tx.commit()?;
            return Ok(None);
        }
        let worker: String = tx.query_row(
            "SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM operations WHERE session_id=?1 AND command_id=?2",
            params![
                call.session_id,
                format!("{}:plugin-worker:{plugin}", actor.id)
            ],
            |r| r.get(0),
        )?;
        let s = state(&tx, &worker, &mut r)?;
        let (ordinal, (_, pin)) = s
            .calls
            .iter()
            .enumerate()
            .find(|(_, (v, _))| v.id == key)
            .ok_or_else(|| bad("persistent call binding absent"))?;
        let origin = s
            .origins
            .get(key)
            .ok_or_else(|| bad("call inference absent"))?;
        let reply_artifact: Option<String> = if reply_sequence(&tx, &worker, &call, &mut r)?
            .is_some()
        {
            Some(tx.query_row("SELECT CASE WHEN length(digest)<=71 THEN digest END FROM operation_artifacts WHERE operation_id=?1 AND name='plugin.worker_reply'",[key],|row|row.get(0))?)
        } else {
            None
        };
        let v = json!({"worker_operation_id":worker,"call_operation_id":key,"inference_operation_id":origin,"pin":pin,"ordinal":ordinal,"preparation":s.prepared,"started":s.started,"reply_artifact":reply_artifact});
        tx.commit()?;
        Ok(Some(v))
    }
}

#[cfg(test)]
mod tests;
