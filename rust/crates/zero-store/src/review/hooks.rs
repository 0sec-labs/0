//! Review authority is derived from the captured actor and original model calls.
//! Admission is not physical dispatch: source/sandbox work consumes a separate
//! one-use start witness while the same owner and deadline remain valid.
use super::*;
use zero_protocol::{
    agent::AgentRequest,
    model::{Completion, CompletionStatus, Content, ResponsesRequest},
};

fn open(conn: &Connection, b: &read::Bound) -> Result<()> {
    if b.close.is_some()
        || now()? >= b.record.deadline_at_ms
        || b.controller.status != OperationStatus::Running
        || b.root.status != OperationStatus::Running
    {
        return Err(bad("review admission is closed"));
    }
    epoch(
        conn,
        b.root
            .owner
            .as_deref()
            .ok_or_else(|| bad("root owner absent"))?,
    )
}

fn session_for(conn: &Connection, key: &str) -> Result<String> {
    id(key)?;
    Ok(conn.query_row(
        "SELECT CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id END FROM operations WHERE id=?1",
        [key], |r| r.get(0),
    )?)
}

fn by_command(
    conn: &Connection,
    session: &str,
    command: &str,
    r: &mut Reader,
) -> Result<Operation> {
    let key: String = conn.query_row(
        "SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM operations WHERE session_id=?1 AND command_id=?2",
        params![session, command], |r| r.get(0),
    )?;
    workflow::operation(conn, &key, r)
}

fn provider(payload: &Value, request: &AgentRequest, b: &read::Bound) -> Result<()> {
    let p = b
        .admission
        .provider_context
        .get(&request.provider)
        .ok_or_else(|| bad("provider absent from review capture"))?;
    if payload["endpoint"] != p.endpoint
        || payload["rates"] != serde_json::to_value(p.rates)?
        || payload
            .get("wire_api")
            .cloned()
            .unwrap_or(json!("responses"))
            != serde_json::to_value(p.wire_api)?
        || payload.get("hosted_catalog")
            != p.hosted_catalog
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?
                .as_ref()
    {
        return Err(bad("review provider capture differs"));
    }
    Ok(())
}

fn template(actor: &Operation) -> Result<ResponsesRequest> {
    let field = if actor.payload.get("parent_operation").is_some() {
        "delegation_template"
    } else {
        "review_template"
    };
    let template: ResponsesRequest = serde_json::from_value(actor.payload[field].clone())?;
    if !template.input.is_empty() {
        return Err(bad("captured actor template has input"));
    }
    Ok(template)
}

fn inference(
    conn: &Connection,
    b: &read::Bound,
    actor: &Operation,
    command: &str,
    payload: &Value,
    r: &mut Reader,
) -> Result<u32> {
    let request = zero_protocol::agent::validate_actor_payload(&actor.payload).map_err(bad)?;
    let turn = command
        .strip_prefix(&format!("{}:model:", actor.id))
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n < request.max_turns)
        .ok_or_else(|| bad("inference turn differs"))?;
    if command != format!("{}:model:{turn}", actor.id)
        || payload["kind"] != "agent_inference"
        || payload["parent_operation"] != actor.id
        || payload.as_object().is_none_or(|m| {
            m.keys().any(|k| {
                !matches!(
                    k.as_str(),
                    "kind"
                        | "parent_operation"
                        | "request"
                        | "endpoint"
                        | "wire_api"
                        | "rates"
                        | "hosted_catalog"
                        | "context"
                )
            })
        })
    {
        return Err(bad("inference identity or authority differs"));
    }
    let mut actual: ResponsesRequest = serde_json::from_value(payload["request"].clone())?;
    actual.input.clear();
    if serde_json::to_value(actual)? != serde_json::to_value(template(actor)?)?
        || (payload.get("context").is_some() && request.context_policy.is_none())
    {
        return Err(bad("inference template differs"));
    }
    provider(payload, &request, b)?;
    if turn > 0 {
        let prior = by_command(
            conn,
            &b.record.session_id,
            &format!("{}:model:{}", actor.id, turn - 1),
            r,
        )?;
        if prior.status != OperationStatus::Succeeded
            || prior.owner != b.root.owner
            || prior.payload["kind"] != "agent_inference"
            || prior.payload["parent_operation"] != actor.id
        {
            return Err(bad("prior inference is unresolved"));
        }
    }
    Ok(turn)
}

struct OriginalCall {
    turn: u32,
    index: usize,
    id: String,
    name: String,
    args: Value,
}
fn original_call(
    conn: &Connection,
    b: &read::Bound,
    actor: &Operation,
    command: &str,
    r: &mut Reader,
) -> Result<OriginalCall> {
    let suffix = command
        .strip_prefix(&format!("{}:tool:", actor.id))
        .ok_or_else(|| bad("tool command differs"))?;
    let (turn, index) = suffix
        .split_once(':')
        .ok_or_else(|| bad("tool position absent"))?;
    let turn: u32 = turn.parse().map_err(bad)?;
    let index: usize = index.parse().map_err(bad)?;
    if turn >= 32 || index >= 32 || suffix != format!("{turn}:{index}") {
        return Err(bad("tool position differs"));
    }
    let origin = by_command(
        conn,
        &b.record.session_id,
        &format!("{}:model:{turn}", actor.id),
        r,
    )?;
    if origin.status != OperationStatus::Succeeded || origin.owner != b.root.owner {
        return Err(bad("tool origin is not settled by the review owner"));
    }
    inference(conn, b, actor, &origin.command_id, &origin.payload, r)?;
    let completion: Completion = serde_json::from_value(
        origin
            .outcome
            .ok_or_else(|| bad("tool completion absent"))?,
    )?;
    let calls: Vec<_> = completion
        .content
        .into_iter()
        .filter_map(|c| match c {
            Content::ToolCall {
                id,
                name,
                arguments,
            } => Some((id, name, arguments)),
            _ => None,
        })
        .collect();
    let mut ids = BTreeSet::new();
    if completion.status != CompletionStatus::Completed
        || completion.error.is_some()
        || calls.len() > 32
        || calls
            .iter()
            .any(|(key, _, _)| key.is_empty() || key.len() > 512 || !ids.insert(key))
    {
        return Err(bad("tool completion is incomplete or has duplicate calls"));
    }
    let (id, name, args) = calls
        .get(index)
        .ok_or_else(|| bad("original tool call absent"))?;
    let offered = template(actor)?;
    let definitions: Vec<_> = offered.tools.iter().filter(|t| &t.name == name).collect();
    if definitions.len() != 1 {
        return Err(bad("tool was not uniquely offered"));
    }
    let parameters = &definitions[0].parameters;
    let properties = parameters["properties"]
        .as_object()
        .ok_or_else(|| bad("offered tool properties absent"))?;
    let arguments = args
        .as_object()
        .ok_or_else(|| bad("tool arguments are not an object"))?;
    if arguments.keys().any(|key| !properties.contains_key(key))
        || parameters.get("required").is_some_and(|v| {
            v.as_array().is_none_or(|keys| {
                keys.iter()
                    .any(|key| key.as_str().is_none_or(|key| !arguments.contains_key(key)))
            })
        })
    {
        return Err(bad("arguments differ from offered schema"));
    }
    Ok(OriginalCall {
        turn,
        index,
        id: id.clone(),
        name: name.clone(),
        args: args.clone(),
    })
}

fn group(
    conn: &Connection,
    b: &read::Bound,
    command: &str,
    payload: &Value,
    r: &mut Reader,
) -> Result<()> {
    let request = zero_protocol::agent::validate_actor_payload(&b.root.payload).map_err(bad)?;
    let call = original_call(conn, b, &b.root, command, r)?;
    if call.name != "delegate_tasks" || payload["call_id"] != call.id {
        return Err(bad("delegation source call differs"));
    }
    if payload.as_object().is_none_or(|m| {
        m.keys().any(|k| {
            !matches!(
                k.as_str(),
                "kind"
                    | "parent_operation"
                    | "call_id"
                    | "tasks"
                    | "child_commands"
                    | "delegation_context_sha256"
            )
        })
    }) {
        return Err(bad("unexpected delegation group authority"));
    }
    crate::campaign::delegation::group_request(
        conn,
        &b.record.session_id,
        &request,
        &b.root,
        command,
        payload,
    )?;
    let maximum = request
        .delegation_policy
        .as_ref()
        .ok_or_else(|| bad("delegation absent"))?
        .max_children;
    let used: u64 = conn.query_row(
        "SELECT COALESCE(sum(json_array_length(payload,'$.tasks')),0) FROM operations WHERE session_id=?1 AND command_id<>?2 AND json_extract(payload,'$.kind')='agent_delegation' AND json_extract(payload,'$.parent_operation')=?3",
        params![b.record.session_id,command,b.root.id], |row| row.get(0),
    )?;
    let added = payload["tasks"]
        .as_array()
        .ok_or_else(|| bad("delegation tasks absent"))?
        .len() as u64;
    if used
        .checked_add(added)
        .is_none_or(|n| n > u64::from(maximum))
    {
        return Err(bad("review delegation quota exceeded"));
    }
    Ok(())
}

fn child(
    conn: &Connection,
    b: &read::Bound,
    command: &str,
    payload: &Value,
    r: &mut Reader,
) -> Result<()> {
    if payload["kind"] != "offline_snapshot_agent" || payload["parent_operation"] != b.root.id {
        return Err(bad("recursive or foreign delegated actor"));
    }
    if payload.as_object().is_none_or(|m| {
        m.keys().any(|k| {
            !matches!(
                k.as_str(),
                "kind"
                    | "request"
                    | "endpoint"
                    | "rates"
                    | "wire_api"
                    | "hosted_catalog"
                    | "delegation_role"
                    | "delegation_template"
                    | "parent_operation"
                    | "delegation_group_command"
                    | "delegation_index"
            )
        })
    }) {
        return Err(bad("unexpected delegated actor authority"));
    }
    let request = zero_protocol::agent::validate_actor_payload(&b.root.payload).map_err(bad)?;
    let role = request
        .delegation_policy
        .as_ref()
        .and_then(|p| {
            p.roles
                .iter()
                .find(|role| payload["delegation_role"] == role.name)
        })
        .ok_or_else(|| bad("delegated role absent"))?;
    let root_template = template(&b.root)?;
    let mut tools = Vec::new();
    for name in &role.tools {
        tools.push(
            root_template
                .tools
                .iter()
                .find(|tool| &tool.name == name)
                .ok_or_else(|| bad("delegated tool absent from root capture"))?
                .clone(),
        );
    }
    let expected_template = ResponsesRequest {
        model: role.model.clone(),
        instructions: format!(
            "{}\n\nHost-defined delegated role {}:\n{}",
            request.instructions, role.name, role.instructions
        ),
        input: vec![],
        max_output_tokens: 8192,
        tools,
    };
    if payload["delegation_template"] != serde_json::to_value(expected_template)? {
        return Err(bad("delegated template exceeds captured role tools"));
    }
    let command_group = payload["delegation_group_command"]
        .as_str()
        .ok_or_else(|| bad("delegation group absent"))?;
    let joined = by_command(conn, &b.record.session_id, command_group, r)?;
    if joined.status != OperationStatus::Running || joined.owner != b.root.owner {
        return Err(bad("delegation group is not owned running"));
    }
    group(conn, b, command_group, &joined.payload, r)?;
    crate::campaign::delegation::child_request(
        conn,
        &b.record.session_id,
        b.root.owner.as_deref().ok_or_else(|| bad("owner absent"))?,
        &request,
        &b.root,
        command,
        payload,
        role,
    )?;
    let request = zero_protocol::agent::validate_actor_payload(payload).map_err(bad)?;
    provider(payload, &request, b)
}

fn actor(conn: &Connection, b: &read::Bound, key: &str, r: &mut Reader) -> Result<Operation> {
    if key == b.root.id {
        return Ok(b.root.clone());
    }
    let a = workflow::operation(conn, key, r)?;
    if a.session_id != b.record.session_id
        || a.status != OperationStatus::Running
        || a.owner != b.root.owner
    {
        return Err(bad("actor membership or owner differs"));
    }
    child(conn, b, &a.command_id, &a.payload, r)?;
    Ok(a)
}

fn checked(
    conn: &Connection,
    b: &read::Bound,
    command: &str,
    payload: &Value,
    r: &mut Reader,
) -> Result<()> {
    open(conn, b)?;
    let parent = payload["parent_operation"]
        .as_str()
        .ok_or_else(|| bad("generic root admission forbidden"))?;
    let a = actor(conn, b, parent, r)?;
    match payload["kind"].as_str().unwrap_or("") {
        "offline_snapshot_agent" => child(conn, b, command, payload, r),
        "agent_delegation" if a.id == b.root.id => group(conn, b, command, payload, r),
        "agent_inference" => inference(conn, b, &a, command, payload, r).map(|_| ()),
        "agent_source_tool" | "agent_tool" => {
            let call = original_call(conn, b, &a, command, r)?;
            let expected = if payload["kind"] == "agent_source_tool" {
                if !matches!(
                    call.name.as_str(),
                    "list_source_files" | "read_source_lines" | "search_source_text"
                ) {
                    return Err(bad("source tool differs"));
                }
                json!({"parent_operation":a.id,"kind":"agent_source_tool","call_id":call.id,"name":call.name,"arguments":call.args,
                    "source_operation":null,"bundle_sha256":null,"source_identity":{"kind":"snapshot_catalog","sha256":b.record.snapshot_sha256}})
            } else {
                if call.name != "execute_snapshot"
                    || call.args.as_object().is_none_or(|args| args.len() != 1)
                {
                    return Err(bad("sandbox tool differs"));
                }
                let request =
                    zero_protocol::agent::validate_actor_payload(&a.payload).map_err(bad)?;
                let mut execution = request.snapshot_request().map_err(bad)?;
                execution.argv = serde_json::from_value(call.args["argv"].clone())?;
                execution.execution_id = format!("agent-{}-{}-{}", a.id, call.turn, call.index);
                execution.validate().map_err(bad)?;
                json!({"parent_operation":a.id,"kind":"agent_tool","call_id":call.id,"request":execution})
            };
            if *payload != expected {
                return Err(bad("effect differs from original call or source authority"));
            }
            Ok(())
        }
        _ => Err(bad("unsupported review effect")),
    }
}

pub(crate) fn authorize(
    conn: &Connection,
    session: &str,
    command: &str,
    payload: &Value,
) -> Result<()> {
    let mut r = Reader::new();
    let Some(b) = read::binding(conn, session, &mut r)? else {
        return Ok(());
    };
    checked(conn, &b, command, payload, &mut r)
}

pub(crate) fn guard_owner(conn: &Connection, session: &str, owner: &str) -> Result<()> {
    let Some(b) = read::binding(conn, session, &mut Reader::new())? else {
        return Ok(());
    };
    open(conn, &b)?;
    if b.root.owner.as_deref() != Some(owner) {
        return Err(bad("review owner differs"));
    }
    Ok(())
}

pub(crate) fn guard_reservation(
    conn: &Connection,
    session: &str,
    key: &str,
    amount: u64,
) -> Result<()> {
    let mut r = Reader::new();
    let Some(b) = read::binding(conn, session, &mut r)? else {
        return Ok(());
    };
    let op = workflow::operation(conn, key, &mut r)?;
    if op.session_id != session
        || op.status != OperationStatus::Running
        || op.owner != b.root.owner
        || op.payload["kind"] != "agent_inference"
    {
        return Err(bad("reservation is not owned review inference"));
    }
    checked(conn, &b, &op.command_id, &op.payload, &mut r)?;
    let a = actor(
        conn,
        &b,
        op.payload["parent_operation"]
            .as_str()
            .ok_or_else(|| bad("inference actor absent"))?,
        &mut r,
    )?;
    let request = zero_protocol::agent::validate_actor_payload(&a.payload).map_err(bad)?;
    if amount != request.reservation_per_turn {
        return Err(bad("review reservation amount differs"));
    }
    Ok(())
}

pub(crate) fn guard_begin(conn: &Connection, key: &str, owner: &str) -> Result<()> {
    let session = session_for(conn, key)?;
    let mut r = Reader::new();
    let Some(b) = read::binding(conn, &session, &mut r)? else {
        return Ok(());
    };
    open(conn, &b)?;
    if b.root.owner.as_deref() != Some(owner) {
        return Err(bad("review begin owner differs"));
    }
    let bytes: usize = conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 AND length(CAST(session_id AS BLOB))<=256 AND length(CAST(command_id AS BLOB))<=256 AND length(CAST(status AS BLOB))<=16 AND (owner IS NULL OR length(CAST(owner AS BLOB))<=4096) THEN length(CAST(payload AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0) END FROM operations WHERE id=?1",[key],|r|r.get(0))?;
    r.charge(bytes, 4 * 1024 * 1024)?;
    let op = crate::operations::operation(conn, key)?;
    if op.status != OperationStatus::Admitted || op.owner.is_some() || op.outcome.is_some() {
        return Err(bad("review operation cannot begin again"));
    }
    let rows = {
        let mut q = conn.prepare("SELECT sequence FROM events INDEXED BY campaign_root_lifecycle WHERE session_id=?1 AND kind IN ('command_admitted','operation_started','operation_settled','operation_unknown','operation_not_started') AND CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id')) END=?2 ORDER BY sequence LIMIT 2")?;
        q.query_map(params![session, key], |r| r.get::<_, u64>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    if rows.len() != 1 {
        return Err(bad("review admission witness count differs"));
    }
    let (kind, value) = r.event(conn, &session, rows[0])?;
    if kind != "command_admitted" || value != serde_json::to_value(&op)? {
        return Err(bad("review admission witness differs"));
    }
    checked(conn, &b, &op.command_id, &op.payload, &mut r)
}

pub(crate) fn budget_denied(
    tx: &rusqlite::Transaction<'_>,
    session: &str,
    key: &str,
    amount: u64,
    current: &crate::BudgetSnapshot,
) -> Result<bool> {
    let mut r = Reader::new();
    let Some(b) = read::binding(tx, session, &mut r)? else {
        return Ok(false);
    };
    guard_reservation(tx, session, key, amount)?;
    let op = workflow::operation(tx, key, &mut r)?;
    append(
        tx,
        session,
        "review_budget_denied",
        &json!({"review_id":b.record.id,"operation_id":key,"actor_operation_id":op.payload["parent_operation"],
        "requested":amount,"charged":current.charged,"reserved":current.reserved,"limit":current.limit,"owner":b.root.owner}),
    )?;
    Ok(true)
}

impl Store {
    /// Capture one permission to prepare the actor's private source copy. This
    /// grants neither provider work nor sandbox execution.
    pub fn begin_review_source_preparation(
        &mut self,
        actor_operation_id: &str,
        owner: &str,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session = session_for(&tx, actor_operation_id)?;
        let mut r = Reader::new();
        let Some(b) = read::binding(&tx, &session, &mut r)? else {
            return Ok(());
        };
        open(&tx, &b)?;
        let op = actor(&tx, &b, actor_operation_id, &mut r)?;
        if op.owner.as_deref() != Some(owner) || op.status != OperationStatus::Running {
            return Err(bad("source preparation is not owned running"));
        }
        let request = zero_protocol::agent::validate_actor_payload(&op.payload).map_err(bad)?;
        if !request.source_snapshot_tools
            || request.source_review_operation_id.is_some()
            || serde_json::to_value(request.snapshot_request().map_err(bad)?.snapshot)?
                != serde_json::to_value(&b.admission.snapshot)?
        {
            return Err(bad("source preparation authority differs"));
        }
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='operation_detail' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.operation_id')=?2 AND json_extract(payload,'$.kind')='review_source_preparation_started' ELSE 0 END)",params![session,actor_operation_id],|r|r.get(0))?;
        if exists {
            return Err(bad("review source preparation already started"));
        }
        open(&tx, &b)?;
        append(
            &tx,
            &session,
            "operation_detail",
            &json!({"operation_id":actor_operation_id,"kind":"review_source_preparation_started","details":{
            "review_id":b.record.id,"owner":owner,"snapshot_sha256":b.record.snapshot_sha256,"payload_sha256":hash(&op.payload)?}}),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// One-use permission to start an already admitted review source/sandbox action.
    /// Exact retries are observations; they never receive a second dispatch grant.
    pub fn begin_review_effect(
        &mut self,
        operation_id: &str,
        owner: &str,
        request: &Value,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session = session_for(&tx, operation_id)?;
        let mut r = Reader::new();
        let Some(b) = read::binding(&tx, &session, &mut r)? else {
            return Ok(());
        };
        let op = workflow::operation(&tx, operation_id, &mut r)?;
        if op.status != OperationStatus::Running
            || op.owner.as_deref() != Some(owner)
            || op.owner != b.root.owner
        {
            return Err(bad("physical effect is not owned running"));
        }
        checked(&tx, &b, &op.command_id, &op.payload, &mut r)?;
        match op.payload["kind"].as_str() {
            Some("agent_source_tool") if *request == op.payload => (),
            Some("agent_tool") if *request == op.payload["request"] => (),
            _ => return Err(bad("physical effect request differs")),
        }
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='operation_detail' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.operation_id')=?2 AND json_extract(payload,'$.kind')='review_effect_started' ELSE 0 END)",params![session,operation_id],|r|r.get(0))?;
        if exists {
            return Err(bad("review effect already started"));
        }
        open(&tx, &b)?;
        append(
            &tx,
            &session,
            "operation_detail",
            &json!({"operation_id":operation_id,"kind":"review_effect_started","details":{
            "review_id":b.record.id,"owner":owner,"payload_sha256":hash(&op.payload)?,"request_sha256":hash(request)?}}),
        )?;
        tx.commit()?;
        Ok(())
    }
}
