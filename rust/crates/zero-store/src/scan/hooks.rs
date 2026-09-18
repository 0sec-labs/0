use super::*;
pub(super) fn provider(
    payload: &Value,
    name: &str,
    pins: &BTreeMap<String, CampaignProviderContext>,
) -> Result<()> {
    let pin = pins
        .get(name)
        .ok_or_else(|| bad("provider absent from captured profile"))?;
    if pin.endpoint.is_empty()
        || pin.endpoint.len() > 8192
        || payload["endpoint"] != pin.endpoint
        || payload["rates"] != serde_json::to_value(pin.rates)?
        || payload
            .get("wire_api")
            .cloned()
            .unwrap_or(json!("responses"))
            != serde_json::to_value(pin.wire_api)?
        || payload.get("hosted_catalog")
            != pin
                .hosted_catalog
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?
                .as_ref()
    {
        return Err(bad("provider capture differs"));
    }
    Ok(())
}
fn open(b: &read::Bound) -> Result<()> {
    if b.close.is_some()
        || now()? >= b.record.deadline_at_ms
        || b.controller.status != OperationStatus::Running
        || b.root.status != OperationStatus::Running
    {
        return Err(bad("admission is closed or deadline expired"));
    }
    Ok(())
}
pub(crate) fn forbid_input(conn: &Connection, session: &str) -> Result<()> {
    if read::binding(conn, session, &mut Reader::new())?.is_some() {
        return Err(bad(
            "external input/reconciliation is not supported for a frozen scan",
        ));
    }
    Ok(())
}
fn parent(conn: &Connection, key: &str, b: &read::Bound, r: &mut Reader) -> Result<Operation> {
    let op = read::operation(conn, key, r)?;
    if op.session_id != b.record.session_id
        || op.status != OperationStatus::Running
        || op.owner != b.root.owner
    {
        return Err(bad("effect parent ownership differs"));
    }
    Ok(op)
}
fn actor(conn: &Connection, p: &Operation, b: &read::Bound, r: &mut Reader) -> Result<Operation> {
    let actor = if p.payload["kind"] == "agent_web_experiment" {
        parent(
            conn,
            p.payload["parent_operation"]
                .as_str()
                .ok_or_else(|| bad("experiment parent absent"))?,
            b,
            r,
        )?
    } else {
        p.clone()
    };
    if actor.id == b.root.id {
        return Ok(actor);
    }
    if actor.payload["kind"] != "scoped_web_agent" || actor.payload["parent_operation"] != b.root.id
    {
        return Err(bad("effect is outside original scan root"));
    }
    let request = zero_protocol::agent::validate_actor_payload(&b.root.payload).map_err(bad)?;
    let role = request
        .delegation_policy
        .as_ref()
        .and_then(|p| {
            p.roles
                .iter()
                .find(|role| actor.payload["delegation_role"] == role.name)
        })
        .ok_or_else(|| bad("delegated role absent"))?;
    crate::campaign::delegation::child_request(
        conn,
        &b.record.session_id,
        b.root.owner.as_deref().ok_or_else(|| bad("owner absent"))?,
        &request,
        &b.root,
        &actor.command_id,
        &actor.payload,
        role,
    )?;
    Ok(actor)
}
fn template(actor: &Operation) -> Result<Value> {
    let mut v = if actor.payload.get("parent_operation").is_some() {
        actor.payload["delegation_template"].clone()
    } else {
        actor.payload["scan_template"].clone()
    };
    if !v.is_object() {
        return Err(bad("actor template absent"));
    }
    v["input"] = json!([]);
    Ok(v)
}
fn inference(
    conn: &Connection,
    a: &Operation,
    command: &str,
    payload: &Value,
    b: &read::Bound,
    r: &mut Reader,
) -> Result<u32> {
    let request = zero_protocol::agent::validate_actor_payload(&a.payload).map_err(bad)?;
    let turn = command
        .strip_prefix(&format!("{}:model:", a.id))
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n < request.max_turns)
        .ok_or_else(|| bad("inference turn differs"))?;
    if command != format!("{}:model:{turn}", a.id) {
        return Err(bad("inference command differs"));
    }
    let mut actual = payload["request"].clone();
    actual["input"] = json!([]);
    if actual != template(a)? {
        return Err(bad("offered tools or model template differs"));
    }
    provider(payload, &request.provider, &b.admission.provider_context)?;
    if turn > 0 {
        let key:String=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM operations WHERE session_id=?1 AND command_id=?2",params![b.record.session_id,format!("{}:model:{}",a.id,turn-1)],|r|r.get(0))?;
        let previous = read::operation(conn, &key, r)?;
        if previous.status != OperationStatus::Succeeded
            || previous.payload["parent_operation"] != a.id
            || previous.payload["kind"] != "agent_inference"
        {
            return Err(bad("prior inference is unresolved"));
        }
    }
    Ok(turn)
}
fn http_origin(
    conn: &Connection,
    a: &Operation,
    command: &str,
    payload: &Value,
    b: &read::Bound,
    r: &mut Reader,
) -> Result<()> {
    let suffix = command
        .strip_prefix(&format!("{}:tool:", a.id))
        .ok_or_else(|| bad("HTTP call command differs"))?;
    let (turn, index) = suffix
        .split_once(':')
        .ok_or_else(|| bad("HTTP call position absent"))?;
    let turn: u32 = turn.parse().map_err(bad)?;
    let index: usize = index.parse().map_err(bad)?;
    if turn >= 32 || index >= 32 || suffix != format!("{turn}:{index}") {
        return Err(bad("HTTP call position differs"));
    }
    let key:String=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM operations WHERE session_id=?1 AND command_id=?2",params![b.record.session_id,format!("{}:model:{turn}",a.id)],|r|r.get(0))?;
    let origin = read::operation(conn, &key, r)?;
    if origin.status != OperationStatus::Succeeded
        || origin.payload["parent_operation"] != a.id
        || origin.payload["kind"] != "agent_inference"
    {
        return Err(bad("HTTP origin not completed"));
    }
    inference(conn, a, &origin.command_id, &origin.payload, b, r)?;
    let completed: zero_protocol::model::Completion =
        serde_json::from_value(origin.outcome.ok_or_else(|| bad("completion absent"))?)?;
    if completed.status != zero_protocol::model::CompletionStatus::Completed
        || completed.error.is_some()
    {
        return Err(bad("HTTP origin incomplete"));
    }
    let calls: Vec<_> = completed
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
    if calls.len() > 32
        || calls
            .iter()
            .map(|c| c.0)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != calls.len()
    {
        return Err(bad("HTTP origin duplicate calls"));
    }
    let (call, name, args) = calls.get(index).ok_or_else(|| bad("HTTP call absent"))?;
    if name.as_str() != "http_request" || payload["call_id"] != **call {
        return Err(bad("HTTP call identity differs"));
    }
    let policy = serde_json::from_value(b.root.payload["http_context"]["profile"].clone())?;
    if payload["request"]
        != serde_json::to_value(
            zero_http::normalize_intent(&policy, serde_json::from_value((*args).clone())?)
                .map_err(bad)?,
        )?
        || payload.get("origin").is_some()
        || payload.get("approval_operation").is_some()
    {
        return Err(bad("HTTP source arguments differ"));
    }
    Ok(())
}
fn checked(
    conn: &Connection,
    b: &read::Bound,
    command: &str,
    payload: &Value,
    r: &mut Reader,
) -> Result<()> {
    open(b)?;
    epoch(
        conn,
        b.root.owner.as_deref().ok_or_else(|| bad("owner absent"))?,
    )?;
    let parentid = payload["parent_operation"]
        .as_str()
        .ok_or_else(|| bad("generic root admission is forbidden"))?;
    let p = parent(conn, parentid, b, r)?;
    let a = actor(conn, &p, b, r)?;
    let root_request =
        zero_protocol::agent::validate_actor_payload(&b.root.payload).map_err(bad)?;
    let request = zero_protocol::agent::validate_actor_payload(&a.payload).map_err(bad)?;
    match payload["kind"].as_str().unwrap_or("") {
        "scoped_web_agent" => {
            if p.id != b.root.id {
                return Err(bad("recursive delegation"));
            }
            let role = root_request
                .delegation_policy
                .as_ref()
                .and_then(|d| {
                    d.roles
                        .iter()
                        .find(|role| payload["delegation_role"] == role.name)
                })
                .ok_or_else(|| bad("role absent"))?;
            crate::campaign::delegation::child_request(
                conn,
                &b.record.session_id,
                b.root.owner.as_deref().ok_or_else(|| bad("owner absent"))?,
                &root_request,
                &b.root,
                command,
                payload,
                role,
            )?;
            let child = zero_protocol::agent::validate_actor_payload(payload).map_err(bad)?;
            provider(payload, &child.provider, &b.admission.provider_context)?;
            if payload["http_context"] != b.root.payload["http_context"] {
                return Err(bad("child resets account"));
            }
        }
        "agent_delegation" => {
            if p.id != b.root.id {
                return Err(bad("recursive delegate group"));
            }
            crate::campaign::delegation::group_request(
                conn,
                &b.record.session_id,
                &root_request,
                &b.root,
                command,
                payload,
            )?;
        }
        "agent_inference" => {
            if p.id != a.id {
                return Err(bad("inference parent is not actor"));
            }
            inference(conn, &a, command, payload, b, r)?;
        }
        "agent_http" | "agent_web_experiment" => {
            if payload["http_context"] != b.root.payload["http_context"]
                || a.payload["http_context"] != b.root.payload["http_context"]
            {
                return Err(bad("effect resets HTTP account"));
            }
            if payload["kind"] == "agent_web_experiment"
                && (p.id != a.id || request.web_experiment_policy.is_none())
            {
                return Err(bad("experiment authority absent"));
            }
            if payload["kind"] == "agent_http" {
                if p.id == a.id {
                    http_origin(conn, &a, command, payload, b, r)?;
                } else {
                    let frozen = zero_web_verification::FrozenExperiment::from_intent(
                        &p.payload["execution_intent"],
                    )
                    .map_err(bad)?;
                    let case = payload["origin"]["case_index"]
                        .as_u64()
                        .and_then(|n| usize::try_from(n).ok())
                        .ok_or_else(|| bad("case absent"))?;
                    let repeat = payload["origin"]["repeat_index"]
                        .as_u64()
                        .and_then(|n| u32::try_from(n).ok())
                        .ok_or_else(|| bad("repeat absent"))?;
                    if command != format!("{}:web:case:{case}:{repeat}", p.id)
                        || *payload != frozen.child_payload(&p.id, case, repeat).map_err(bad)?
                    {
                        return Err(bad("experiment HTTP request differs"));
                    }
                }
            }
        }
        _ => return Err(bad("unsupported effect in scan session")),
    }
    Ok(())
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
pub(crate) fn guard_effect(
    conn: &Connection,
    session: &str,
    effect: &str,
    intent: &Value,
) -> Result<()> {
    let mut r = Reader::new();
    let Some(b) = read::binding(conn, session, &mut r)? else {
        return Ok(());
    };
    let op = parent(conn, effect, &b, &mut r)?;
    checked(conn, &b, &op.command_id, &op.payload, &mut r)?;
    if intent["index"] == 0 {
        let request: zero_protocol::http::HttpRequestIntent =
            serde_json::from_value(op.payload["request"].clone())?;
        if intent["url"] != request.url
            || intent["method"] != request.method
            || intent["request_body_bytes"] != request.body.as_ref().map_or(0, |s| s.len())
        {
            return Err(bad("initial physical hop differs from source request"));
        }
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
    let op = parent(conn, key, &b, &mut r)?;
    checked(conn, &b, &op.command_id, &op.payload, &mut r)?;
    let p = parent(
        conn,
        op.payload["parent_operation"]
            .as_str()
            .ok_or_else(|| bad("inference actor absent"))?,
        &b,
        &mut r,
    )?;
    let request = zero_protocol::agent::validate_actor_payload(&p.payload).map_err(bad)?;
    if op.payload["kind"] != "agent_inference" || amount != request.reservation_per_turn {
        return Err(bad("model reservation authority differs"));
    }
    Ok(())
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
    let op = parent(tx, key, &b, &mut r)?;
    append(
        tx,
        session,
        "scan_budget_denied",
        &json!({"scan_id":b.record.id,"operation_id":key,"actor_operation_id":op.payload["parent_operation"],"requested":amount,"charged":current.charged,"reserved":current.reserved,"limit":current.limit,"owner":b.root.owner}),
    )?;
    Ok(true)
}
impl Store {
    pub fn request_scan_stop(
        &mut self,
        key: &str,
        owner: &str,
        reason: ScanCloseReason,
    ) -> Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let b = read::bound(&tx, key, &mut Reader::new())?;
        if b.controller.status != OperationStatus::Running || b.close.is_some() {
            return Ok(false);
        }
        epoch(&tx, owner)?;
        if b.controller.owner.as_deref() != Some(owner) {
            return Err(bad("stop owner differs"));
        }
        if reason == ScanCloseReason::Deadline && now()? < b.record.deadline_at_ms {
            return Err(bad("deadline not reached"));
        }
        let seq: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM events WHERE session_id=?1",
            [&b.record.session_id],
            |r| r.get(0),
        )?;
        let text = match reason {
            ScanCloseReason::Cancelled => "cancelled",
            ScanCloseReason::Deadline => "deadline",
        };
        tx.execute(
            "UPDATE scans SET close_reason=?2,close_sequence=?3 WHERE id=?1",
            params![key, text, integer(seq)?],
        )?;
        append(
            &tx,
            &b.record.session_id,
            "scan_admission_closed",
            &json!({"scan_id":key,"controller_operation_id":b.controller.id,"reason":reason,"owner":owner}),
        )?;
        tx.commit()?;
        Ok(true)
    }
    pub fn scan_terminal_budget_denied(&self, key: &str) -> Result<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let mut r = Reader::new();
        let b = read::bound(&tx, key, &mut r)?;
        let mut q=tx.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind IN ('scan_budget_denied','operation_detail') ORDER BY sequence LIMIT 2049")?;
        let rows = q
            .query_map([&b.record.session_id], |r| r.get::<_, u64>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if rows.len() > 2048 {
            return Err(bad("denial witness count bound"));
        }
        let mut denied = BTreeMap::new();
        let mut terminal = vec![];
        for seq in rows {
            let (kind, v) = r.event(&tx, &b.record.session_id, seq)?;
            if kind == "scan_budget_denied" {
                denied.insert(
                    v["operation_id"]
                        .as_str()
                        .ok_or_else(|| bad("denial ID absent"))?
                        .to_owned(),
                    (seq, v),
                );
            } else if v["kind"] == "scan_terminal_budget_denied" && v["operation_id"] == b.root.id {
                terminal.push((
                    v["details"]["operation_id"]
                        .as_str()
                        .ok_or_else(|| bad("terminal denial ID absent"))?
                        .to_owned(),
                    seq,
                ));
            }
        }
        if terminal.len() > 1 {
            return Err(bad("duplicate terminal budget causes"));
        }
        let Some((key, terminal_sequence)) = terminal.first() else {
            return Ok(false);
        };
        let (denial_sequence, v) = denied
            .get(key)
            .ok_or_else(|| bad("terminal denial has no reservation witness"))?;
        let op = read::operation(&tx, key, &mut r)?;
        if denial_sequence >= terminal_sequence
            || op.payload["parent_operation"] != b.root.id
            || op.payload["kind"] != "agent_inference"
            || v["actor_operation_id"] != b.root.id
            || v["scan_id"] != b.record.id
            || v["owner"] != json!(b.root.owner)
            || v["limit"] != b.admission.profile.budget_limit
            || v["requested"] != b.admission.profile.reservation_per_turn
        {
            return Err(bad("terminal budget cause differs"));
        }
        let charged = v["charged"]
            .as_u64()
            .ok_or_else(|| bad("denial charge is not an integer"))?;
        let reserved = v["reserved"]
            .as_u64()
            .ok_or_else(|| bad("denial hold is not an integer"))?;
        let requested = v["requested"]
            .as_u64()
            .ok_or_else(|| bad("denial amount is not an integer"))?;
        let total = charged
            .checked_add(reserved)
            .and_then(|n| n.checked_add(requested));
        if total.is_some_and(|n| n <= b.admission.profile.budget_limit) {
            return Err(bad("denial did not exceed budget"));
        }
        Ok(true)
    }
}
