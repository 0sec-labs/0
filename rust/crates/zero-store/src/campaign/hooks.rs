use super::*;
pub(super) fn operation(conn: &Connection, id: &str) -> Result<Operation> {
    let size:usize=conn.query_row("SELECT length(CAST(payload AS BLOB))+COALESCE(length(CAST(outcome AS BLOB)),0) FROM operations WHERE id=?1",[id],|r|r.get(0))?;
    if size > 32 * 1024 * 1024 {
        return Err(bad("operation exceeds campaign read bound"));
    }
    crate::operations::operation(conn, id)
}
fn provider(
    payload: &Value,
    request: &zero_protocol::agent::AgentRequest,
    r: &CampaignRun,
) -> Result<()> {
    let p = r
        .spec
        .provider_context
        .get(&request.provider)
        .ok_or_else(|| bad("provider outside frozen map"))?;
    let wire = payload
        .get("wire_api")
        .cloned()
        .unwrap_or(json!("responses"));
    if payload["endpoint"] != p.endpoint
        || payload["rates"] != serde_json::to_value(p.rates)?
        || wire != serde_json::to_value(p.wire_api)?
        || payload.get("hosted_catalog")
            != p.hosted_catalog
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?
                .as_ref()
    {
        return Err(bad("provider route, price or catalog drift"));
    }
    Ok(())
}
fn http_context(payload: &Value, r: &CampaignRun) -> Result<()> {
    let c = &payload["http_context"];
    if c["profile"] != serde_json::to_value(&r.spec.http_policy)?
        || c["original_root_command"] != r.run_command_id
    {
        return Err(bad("HTTP captured campaign authority differs"));
    }
    Ok(())
}
pub(crate) fn authorize(
    conn: &Connection,
    session: &str,
    command: &str,
    payload: &Value,
) -> Result<()> {
    if search::authorize_proposal_session(conn, session, command, payload)? {
        return Ok(());
    }
    let Some(r) = binding(conn, session)? else {
        let controller:Option<String>=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM campaigns WHERE journal_session_id=?1",[session],|q|q.get(0)).optional()?;
        if controller.is_none() && conn.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='campaign_created')",[session],|q|q.get::<_,bool>(0))? {return Err(bad("campaign controller projection missing"))}
        if let Some(key) = controller {
            let c = open(conn, &key)?;
            if search::authorize_controller(conn, &c, command, payload)? {
                return Ok(());
            }
            let lane = payload["lane"]
                .as_str()
                .filter(|s| matches!(*s, "development" | "final"))
                .ok_or_else(|| bad("controller lane absent"))?;
            if command != format!("strategy-evaluation:{key}:{lane}")
                || *payload
                    != json!({"kind":"strategy_evaluation","campaign_id":key,"controller_plan_sha256":c.plan.controller_plan_sha256,"lane":lane})
            {
                return Err(bad(
                    "campaign journal permits exact controller operations only",
                ));
            }
        }
        return Ok(());
    };
    let _c = open(conn, &r.campaign_id)?;
    require_epoch(conn, &r.owner)?;
    if matches!(
        r.status,
        CampaignRunStatus::Unknown
            | CampaignRunStatus::Cancelled
            | CampaignRunStatus::Failed
            | CampaignRunStatus::Succeeded
    ) {
        return Err(bad("run already terminal"));
    }
    let kind = payload["kind"]
        .as_str()
        .ok_or_else(|| bad("operation kind absent"))?;
    if payload.get("parent_operation").is_none() {
        if command != r.run_command_id
            || r.operation_id.is_some()
            || payload["request"] != serde_json::to_value(&r.spec.request)?
        {
            return Err(bad("arbitrary root in bound session"));
        }
        zero_protocol::agent::validate_actor_payload(payload).map_err(|e| bad(&e.to_string()))?;
        provider(payload, &r.spec.request, &r)?;
        http_context(payload, &r)?;
        return Ok(());
    }
    let parent = operation(
        conn,
        payload["parent_operation"]
            .as_str()
            .ok_or_else(|| bad("parent missing"))?,
    )?;
    if parent.session_id != session
        || parent.status != OperationStatus::Running
        || parent.owner.as_deref() != Some(&r.owner)
    {
        return Err(bad("child parent is not owned running run"));
    }
    let rootid = r
        .operation_id
        .as_deref()
        .ok_or_else(|| bad("child before root admission"))?;
    let parentkind = parent.payload["kind"].as_str().unwrap_or("");
    let actor = if parentkind == "agent_web_experiment" {
        operation(
            conn,
            parent.payload["parent_operation"]
                .as_str()
                .ok_or_else(|| bad("experiment actor absent"))?,
        )?
    } else {
        parent.clone()
    };
    if actor.id != rootid && actor.payload["parent_operation"] != rootid {
        return Err(bad("child outside campaign root lineage"));
    }
    match kind {
        "scoped_web_agent" | "offline_snapshot_agent" => {
            if parent.id != rootid {
                return Err(bad("recursive delegated actor"));
            }
            let child = zero_protocol::agent::validate_actor_payload(payload)
                .map_err(|e| bad(&e.to_string()))?;
            let mut spec = r.spec.clone();
            spec.request = child.clone();
            spec.validate().map_err(|e| bad(&e.to_string()))?;
            let role = r
                .spec
                .request
                .delegation_policy
                .as_ref()
                .and_then(|p| {
                    p.roles.iter().find(|role| {
                        Some(role.name.as_str()) == payload["delegation_role"].as_str()
                    })
                })
                .ok_or_else(|| bad("unknown delegated role"))?;
            super::delegation::child(conn, &r, &parent, command, payload, role)?;
            provider(payload, &child, &r)?;
            http_context(payload, &r)?;
        }
        "agent_inference" => {
            let ar = zero_protocol::agent::validate_actor_payload(&parent.payload)
                .map_err(|e| bad(&e.to_string()))?;
            provider(payload, &ar, &r)?;
            if payload["request"]["model"] != ar.model
                || payload["request"]["instructions"] != ar.instructions
            {
                return Err(bad("inference authority differs"));
            }
        }
        "agent_delegation" => {
            if parent.id != rootid || r.spec.request.delegation_policy.is_none() {
                return Err(bad("delegation absent from run"));
            }
            super::delegation::group(conn, &r, &parent, command, payload)?;
        }
        "agent_http" => http_context(payload, &r)?,
        "agent_web_experiment" => {
            http_context(payload, &r)?;
            if r.spec.request.web_experiment_policy.is_none() {
                return Err(bad("experiments absent from run"));
            }
        }
        _ => return Err(bad("effect kind unsupported in campaign session")),
    }
    Ok(())
}
pub(crate) fn forbid_input(conn: &Connection, session: &str) -> Result<()> {
    if search::proposal_binding(conn,session)?.is_some() || binding(conn, session)?.is_some()
        || conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM campaigns WHERE journal_session_id=?1) OR EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='campaign_created')",
            [session],
            |r| r.get::<_, bool>(0),
        )?
    {
        return Err(bad(
            "external input or reconciliation changes frozen evaluation",
        ));
    }
    Ok(())
}
fn add(a: &mut u64, b: u64) -> Result<()> {
    *a = a
        .checked_add(b)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or_else(|| bad("aggregate overflow"))?;
    Ok(())
}
pub(super) fn sum(conn: &Connection, c: &Campaign, u: &mut CampaignUsage) -> Result<()> {
    let mut q=conn.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=512 THEN id END,CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id END,CASE WHEN length(CAST(operation_id AS BLOB))<=256 THEN operation_id END,CASE WHEN length(CAST(kind AS BLOB))<=16 THEN kind END,CASE WHEN length(CAST(reserved AS BLOB))<=4096 THEN reserved END,CASE WHEN length(CAST(settled AS BLOB))<=4096 THEN settled END,sequence,settlement_sequence FROM campaign_debits WHERE campaign_id=?1 ORDER BY sequence LIMIT 12801")?;
    let rows = q
        .query_map([&c.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, u64>(6)?,
                r.get::<_, Option<u64>>(7)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > 12800 {
        return Err(bad("debit count exceeds bound"));
    }
    let count: u64 = conn.query_row(
        "SELECT COUNT(*) FROM events WHERE session_id=?1 AND kind='campaign_debit_reserved'",
        [&c.journal_session_id],
        |r| r.get(0),
    )?;
    if count != rows.len() as u64 {
        return Err(bad("debit index omitted immutable witness"));
    }
    for (id, session, op, kind, reserved, settled, sequence, settlement_sequence) in rows {
        if id.len() > 512
            || session.len() > 256
            || op.len() > 256
            || kind.len() > 16
            || reserved.len() > 4096
            || settled.as_ref().is_some_and(|s| s.len() > 4096)
        {
            return Err(bad("debit row exceeds bound"));
        }
        let v: Value = serde_json::from_str(&reserved)?;
        event(
            conn,
            &c.journal_session_id,
            sequence,
            "campaign_debit_reserved",
            &json!({"campaign_id":c.id,"id":id,"session_id":session,"operation_id":op,"kind":kind,"reserved":v}),
        )?;
        let s = settled
            .map(|s| serde_json::from_str::<Value>(&s))
            .transpose()?;
        if let Some(s) = &s {
            event(
                conn,
                &c.journal_session_id,
                settlement_sequence.ok_or_else(|| bad("settlement witness absent"))?,
                "campaign_debit_settled",
                &json!({"campaign_id":c.id,"id":id,"settled":s}),
            )?;
        } else if settlement_sequence.is_some() {
            return Err(bad("unexpected settlement witness"));
        }
        let n = |v: &Value, key: &str| v[key].as_u64().ok_or_else(|| bad("debit units absent"));
        match kind.as_str() {
            "model" => {
                add(&mut u.model_calls, 1)?;
                if let Some(s) = s {
                    add(&mut u.model_charged_micro_usd, n(&s, "micro_usd")?)?
                } else {
                    add(&mut u.model_reserved_micro_usd, n(&v, "micro_usd")?)?
                }
            }
            "http" => {
                add(&mut u.http_requests, 1)?;
                add(&mut u.http_request_body_bytes, n(&v, "request_bytes")?)?;
                if let Some(s) = s.filter(|s| s["complete"] == true) {
                    add(&mut u.http_response_charged_bytes, n(&s, "decoded_bytes")?)?
                } else {
                    add(
                        &mut u.http_response_reserved_bytes,
                        n(&v, "response_bytes")?,
                    )?
                }
            }
            "experiment" => add(&mut u.experiments, 1)?,
            _ => return Err(bad("unknown debit kind")),
        }
    }
    Ok(())
}
pub(super) struct DebitWorker {
    pub campaign_id: String,
    pub session_id: String,
    pub owner: String,
    pub status: CampaignRunStatus,
}
impl From<&CampaignRun> for DebitWorker {
    fn from(r: &CampaignRun) -> Self {
        Self {
            campaign_id: r.campaign_id.clone(),
            session_id: r.session_id.clone(),
            owner: r.owner.clone(),
            status: r.status,
        }
    }
}
pub(super) fn reserve(
    conn: &Transaction<'_>,
    r: &DebitWorker,
    key: &str,
    op: &str,
    kind: &str,
    value: &Value,
) -> Result<()> {
    let prior: Option<(String, String)> = conn
        .query_row(
            "SELECT kind,reserved FROM campaign_debits WHERE id=?1",
            [key],
            |q| Ok((q.get(0)?, q.get(1)?)),
        )
        .optional()?;
    if let Some((old, bytes)) = prior {
        if old != kind || serde_json::from_str::<Value>(&bytes)? != *value {
            return Err(bad("debit retry differs"));
        }
        let c = original(conn, &r.campaign_id)?;
        sum(conn, &c, &mut CampaignUsage::default())?;
        return Ok(());
    }
    if r.status != CampaignRunStatus::Running {
        return Err(bad("new effect after run stopped"));
    }
    require_epoch(conn, &r.owner)?;
    let c = open(conn, &r.campaign_id)?;
    let u = read::usage(conn, &c)?;
    let l = &c.plan.limits;
    let n = |key: &str| {
        value[key]
            .as_u64()
            .ok_or_else(|| bad("reservation dimension absent"))
    };
    let fits = |used: u64, held: u64, amount: u64, limit: u64| {
        used.checked_add(held)
            .and_then(|s| s.checked_add(amount))
            .is_some_and(|s| s <= limit)
    };
    let okay = match kind {
        "model" => {
            u.model_calls < u64::from(l.model_calls)
                && fits(
                    u.model_charged_micro_usd,
                    u.model_reserved_micro_usd,
                    n("micro_usd")?,
                    l.model_micro_usd,
                )
        }
        "http" => {
            u.http_requests < l.http_requests
                && fits(
                    u.http_request_body_bytes,
                    0,
                    n("request_bytes")?,
                    l.http_request_body_bytes,
                )
                && fits(
                    u.http_response_charged_bytes,
                    u.http_response_reserved_bytes,
                    n("response_bytes")?,
                    l.http_response_decoded_bytes,
                )
        }
        "experiment" => u.experiments < u64::from(l.experiments),
        _ => false,
    };
    if !okay {
        return Err(Error::BudgetExceeded);
    }
    let sequence = next(conn, &c.journal_session_id)?;
    conn.execute("INSERT INTO campaign_debits(id,campaign_id,session_id,operation_id,kind,reserved,settled,sequence,settlement_sequence) VALUES(?1,?2,?3,?4,?5,?6,NULL,?7,NULL)",params![key,c.id,r.session_id,op,kind,serde_json::to_string(value)?,integer(sequence)?])?;
    append(
        conn,
        &c.journal_session_id,
        "campaign_debit_reserved",
        &json!({"campaign_id":c.id,"id":key,"session_id":r.session_id,"operation_id":op,"kind":kind,"reserved":value}),
    )?;
    Ok(())
}
pub(super) fn settle(
    conn: &Transaction<'_>,
    r: &DebitWorker,
    key: &str,
    value: &Value,
) -> Result<()> {
    let c = original(conn, &r.campaign_id)?;
    sum(conn, &c, &mut CampaignUsage::default())?;
    let prior: Option<String> = conn.query_row(
        "SELECT settled FROM campaign_debits WHERE id=?1 AND campaign_id=?2",
        params![key, c.id],
        |q| q.get(0),
    )?;
    if let Some(prior) = prior {
        if serde_json::from_str::<Value>(&prior)? != *value {
            return Err(bad("settlement differs"));
        }
        return Ok(());
    }
    let sequence = next(conn, &c.journal_session_id)?;
    conn.execute(
        "UPDATE campaign_debits SET settled=?2,settlement_sequence=?3 WHERE id=?1",
        params![key, serde_json::to_string(value)?, integer(sequence)?],
    )?;
    append(
        conn,
        &c.journal_session_id,
        "campaign_debit_settled",
        &json!({"campaign_id":c.id,"id":key,"settled":value}),
    )?;
    sum(conn, &c, &mut CampaignUsage::default())?;
    Ok(())
}
pub(crate) fn reserve_model(
    conn: &Transaction<'_>,
    session: &str,
    op: &str,
    amount: u64,
) -> Result<()> {
    if search::reserve_model(conn, session, op, amount)? {
        return Ok(());
    }
    let Some(r) = binding(conn, session)? else {
        return Ok(());
    };
    let inference = operation(conn, op)?;
    if inference.session_id != session || inference.payload["kind"] != "agent_inference" {
        return Err(bad("campaign reservation lacks inference"));
    }
    let actor = operation(
        conn,
        inference.payload["parent_operation"]
            .as_str()
            .ok_or_else(|| bad("inference actor absent"))?,
    )?;
    let request = zero_protocol::agent::validate_actor_payload(&actor.payload)
        .map_err(|e| bad(&e.to_string()))?;
    if amount != request.reservation_per_turn {
        return Err(bad("model reservation differs from frozen actor"));
    }
    provider(&inference.payload, &request, &r)?;
    reserve(
        conn,
        &DebitWorker::from(&r),
        &format!("model:{op}"),
        op,
        "model",
        &json!({"micro_usd":amount}),
    )
}
pub(crate) fn settle_model(
    conn: &Transaction<'_>,
    session: &str,
    op: &str,
    amount: u64,
) -> Result<()> {
    if search::settle_model(conn, session, op, amount)? {
        return Ok(());
    }
    if let Some(r) = binding(conn, session)? {
        settle(
            conn,
            &DebitWorker::from(&r),
            &format!("model:{op}"),
            &json!({"micro_usd":amount}),
        )?
    }
    Ok(())
}
pub(crate) fn admit_http(
    conn: &Transaction<'_>,
    session: &str,
    op: &str,
    receipt: &str,
    intent: &Value,
) -> Result<()> {
    let Some(r) = binding(conn, session)? else {
        return Ok(());
    };
    let url = intent["url"]
        .as_str()
        .ok_or_else(|| bad("HTTP hop URL absent"))?;
    if zero_http::canonical_origin(url).map_err(|e| bad(&e.to_string()))? != r.spec.fixture_origin {
        return Err(bad("HTTP hop outside exact fixture origin"));
    }
    reserve(
        conn,
        &DebitWorker::from(&r),
        &format!("http:{receipt}"),
        op,
        "http",
        &json!({"request_bytes":intent["request_body_bytes"],"response_bytes":intent["response_decoded_limit"]}),
    )
}
pub(crate) fn settle_http(
    conn: &Transaction<'_>,
    session: &str,
    receipt: &str,
    complete: bool,
    decoded: u64,
) -> Result<()> {
    if let Some(r) = binding(conn, session)? {
        settle(
            conn,
            &DebitWorker::from(&r),
            &format!("http:{receipt}"),
            &json!({"complete":complete,"decoded_bytes":decoded}),
        )?
    }
    Ok(())
}
pub(crate) fn experiment(conn: &Transaction<'_>, op: &Operation) -> Result<()> {
    if let Some(r) = binding(conn, &op.session_id)? {
        reserve(
            conn,
            &DebitWorker::from(&r),
            &format!("experiment:{}", op.id),
            &op.id,
            "experiment",
            &json!({"count":1}),
        )?
    }
    Ok(())
}
pub(super) fn close_pending(
    conn: &Transaction<'_>,
    campaign: Option<&str>,
    owner: Option<&str>,
    status: &str,
) -> Result<()> {
    let mut cursor = String::new();
    loop {
        let mut q=conn.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END,CASE WHEN length(CAST(campaign_id AS BLOB))<=256 THEN campaign_id END FROM campaign_runs WHERE closed IS NULL AND (?1 IS NULL OR campaign_id=?1) AND (?2 IS NULL OR owner=?2) AND id>?3 ORDER BY id LIMIT 64")?;
        let rows = q
            .query_map(params![campaign, owner, cursor], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if rows.is_empty() {
            break;
        }
        for (key, campaign) in rows {
            cursor = key.clone();
            let r = read::run(conn, &campaign, &key)?;
            if r.operation_id.is_some() {
                continue;
            }
            let c = original(conn, &campaign)?;
            let sequence = next(conn, &c.journal_session_id)?;
            let reason = if status == "cancelled" {
                "campaign cancelled before root admission"
            } else {
                "owner ended before root admission"
            };
            conn.execute(
                "UPDATE campaign_runs SET closed=?2,close_sequence=?3,close_reason=?4 WHERE id=?1",
                params![key, status, integer(sequence)?, reason],
            )?;
            append(
                conn,
                &c.journal_session_id,
                "campaign_run_closed",
                &json!({"run_id":key,"status":status,"reason":reason}),
            )?;
        }
    }
    Ok(())
}
pub(crate) fn recover(conn: &Transaction<'_>, previous: Option<&str>) -> Result<()> {
    close_pending(conn, None, previous, "unknown")
}
