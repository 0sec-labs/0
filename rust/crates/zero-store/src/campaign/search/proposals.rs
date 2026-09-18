use super::*;
fn bound(conn: &Connection, c: &Campaign) -> Result<()> {
    let bytes:u64=conn.query_row("SELECT COALESCE(SUM(length(CAST(o.payload AS BLOB))+COALESCE(length(CAST(o.outcome AS BLOB)),0)+length(CAST(p.record AS BLOB))),0) FROM strategy_search_proposals p JOIN operations o ON o.id=p.operation_id WHERE p.campaign_id=?1",[&c.id],|r|r.get(0))?;
    let events:u64=conn.query_row("SELECT COALESCE(SUM(length(CAST(e.payload AS BLOB))),0) FROM events e JOIN strategy_search_proposals p ON p.session_id=e.session_id WHERE p.campaign_id=?1",[&c.id],|r|r.get(0))?;
    let (count,config_bytes):(u64,u64)=conn.query_row("SELECT (SELECT count(*) FROM strategy_search_proposals WHERE campaign_id=?1),length(bytes) FROM artifacts WHERE digest=?2",params![c.id,c.plan.controller_plan_sha256],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if bytes
        .checked_add(events)
        .and_then(|n| n.checked_add((count + 1).saturating_mul(config_bytes + 512 * 1024)))
        .is_none_or(|n| n > 64 * 1024 * 1024)
    {
        return Err(bad("search proposal read budget exceeds64MiB"));
    }
    Ok(())
}
fn feedback(
    conn: &Connection,
    c: &Campaign,
    index: u32,
    digest: Option<&str>,
) -> Result<Option<Value>> {
    if index == 0 {
        if digest.is_some() {
            return Err(bad("first proposal cannot accept feedback"));
        }
        return Ok(None);
    }
    let digest = digest.ok_or_else(|| bad("later proposal requires retained feedback"))?;
    let linked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM operation_artifacts a JOIN operations o ON o.id=a.operation_id WHERE o.session_id=?1 AND o.command_id=?2 AND a.name=?3 AND a.digest=?4)",params![c.journal_session_id,format!("strategy-search:{}",c.id),format!("search.feedback.{index}"),digest],|r|r.get(0))?;
    if !linked {
        return Err(bad("proposal feedback is not retained by controller"));
    }
    let v: Value = serde_json::from_slice(&artifact(conn, digest, 512 * 1024)?)?;
    if v["schema_version"] != 1
        || v["kind"] != "strategy_search_development_feedback"
        || v["campaign_id"] != c.id
        || v["config_sha256"] != c.plan.controller_plan_sha256
        || v["prior_attempts"] != index
        || v["proposals"]
            .as_array()
            .is_none_or(|a| a.len() != index as usize)
    {
        return Err(bad("feedback prefix identity differs"));
    }
    let mut q=conn.prepare("SELECT CASE WHEN length(CAST(operation_id AS BLOB))<=256 THEN operation_id END FROM strategy_search_proposals WHERE campaign_id=?1 AND attempt_index<?2 ORDER BY attempt_index LIMIT 17")?;
    let ids = q
        .query_map(params![c.id, index], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if ids.len() != index as usize
        || ids.iter().enumerate().any(|(i, id)| {
            v["proposals"][i]["operation_id"] != *id || v["proposals"][i]["attempt_index"] != i
        })
    {
        return Err(bad("feedback omitted prior proposal"));
    }
    Ok(Some(v))
}
fn payload(
    conn: &Connection,
    c: &Campaign,
    config: &StrategySearchConfiguration,
    index: u32,
    digest: Option<&str>,
) -> Result<Value> {
    let request = render_search_proposal(config, index, feedback(conn, c, index, digest)?)
        .map_err(|e| bad(&e.to_string()))?;
    let mut v = json!({"kind":"strategy_proposal_inference","campaign_id":c.id,"attempt_index":index,"search_config_sha256":c.plan.controller_plan_sha256,"feedback_sha256":digest,"request":request,"provider":config.plan.proposer.provider,"endpoint":config.proposer_context.endpoint,"wire_api":config.proposer_context.wire_api,"rates":config.proposer_context.rates});
    if let Some(pin) = &config.proposer_context.hosted_catalog {
        v["hosted_catalog"] = serde_json::to_value(pin)?;
    }
    Ok(v)
}
fn lifecycle(conn: &Connection, p: &SearchProposal, op: &Operation) -> Result<()> {
    let mut q=conn.prepare("SELECT kind,sequence FROM events WHERE session_id=?1 AND kind IN ('command_admitted','operation_started','operation_settled','operation_unknown','operation_not_started') ORDER BY sequence LIMIT 9")?;
    let rows = q
        .query_map([&p.session_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let seq = |kind: &str| -> Result<Option<u64>> {
        let found: Vec<_> = rows
            .iter()
            .filter(|(k, _)| k == kind)
            .map(|(_, s)| *s)
            .collect();
        if found.len() > 1 {
            return Err(bad("duplicate proposal lifecycle witness"));
        }
        Ok(found.first().copied())
    };
    if rows.len() > 4 || seq("operation_not_started")?.is_some() {
        return Err(bad("unexpected proposal lifecycle"));
    }
    let a = seq("command_admitted")?.ok_or_else(|| bad("proposal admission absent"))?;
    let s = seq("operation_started")?.ok_or_else(|| bad("proposal start absent"))?;
    let mut admitted = op.clone();
    admitted.status = OperationStatus::Admitted;
    admitted.owner = None;
    admitted.outcome = None;
    event(
        conn,
        &p.session_id,
        a,
        "command_admitted",
        &serde_json::to_value(admitted)?,
    )?;
    let mut started = op.clone();
    started.status = OperationStatus::Running;
    started.owner = Some(p.owner.clone());
    started.outcome = None;
    event(
        conn,
        &p.session_id,
        s,
        "operation_started",
        &serde_json::to_value(started)?,
    )?;
    if s <= a || op.owner.as_deref() != Some(&p.owner) {
        return Err(bad("proposal owner changed"));
    }
    let settled = seq("operation_settled")?;
    let unknown = seq("operation_unknown")?;
    match op.status {
        OperationStatus::Running
            if settled.is_none() && unknown.is_none() && op.outcome.is_none() => {}
        OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled
            if unknown.is_none() =>
        {
            let t = settled
                .filter(|v| *v > s)
                .ok_or_else(|| bad("proposal terminal witness absent"))?;
            event(
                conn,
                &p.session_id,
                t,
                "operation_settled",
                &serde_json::to_value(op)?,
            )?;
        }
        OperationStatus::Unknown if settled.is_none() => {
            let t = unknown
                .filter(|v| *v > s)
                .ok_or_else(|| bad("proposal recovery witness absent"))?;
            if event(
                conn,
                &p.session_id,
                t,
                "operation_unknown",
                &serde_json::to_value(op)?,
            )
            .is_err()
            {
                let raw:String=conn.query_row("SELECT CASE WHEN length(CAST(payload AS BLOB))<=4096 THEN payload END FROM events WHERE session_id=?1 AND sequence=?2",params![p.session_id,integer(t)?],|r|r.get(0))?;
                let v: Value = serde_json::from_str(&raw)?;
                if op.outcome.is_some()
                    || (v != json!({"operation_id":op.id,"owner":p.owner})
                        && v != json!({"operation_id":op.id,"owner":p.owner,"reason":"previous engine epoch ended"}))
                {
                    return Err(bad("proposal recovery differs"));
                }
            }
        }
        _ => return Err(bad("proposal state lacks witness")),
    }
    Ok(())
}
fn read(conn: &Connection, c: &Campaign, key: &str) -> Result<(SearchProposal, Operation)> {
    bound(conn, c)?;
    let (raw,seq):(String,u64)=conn.query_row("SELECT CASE WHEN length(CAST(record AS BLOB))<=1048576 THEN record END,sequence FROM strategy_search_proposals WHERE campaign_id=?1 AND id=?2",params![c.id,key],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let p: SearchProposal = serde_json::from_str(&raw)?;
    if p.id != key || p.campaign_id != c.id || p.sequence != seq {
        return Err(bad("proposal record identity differs"));
    }
    event(
        conn,
        &c.journal_session_id,
        seq,
        "strategy_search_proposal_admitted",
        &serde_json::to_value(&p)?,
    )?;
    let projection:bool=conn.query_row("SELECT session_id=?2 AND operation_id=?3 AND attempt_index=?4 AND command_id=?5 FROM strategy_search_proposals WHERE id=?1",params![p.id,p.session_id,p.operation_id,p.attempt_index,p.command_id],|r|r.get(0))?;
    if !projection {
        return Err(bad("proposal projection differs"));
    }
    let op = hooks::operation(conn, &p.operation_id)?;
    let cfg = required(conn, c)?;
    if op.session_id != p.session_id
        || op.command_id != p.command_id
        || op.payload != payload(conn, c, &cfg, p.attempt_index, p.feedback_sha256.as_deref())?
        || hash(&op.payload["request"])? != p.request_sha256
    {
        return Err(bad("proposal immutable request differs"));
    }
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM operations WHERE session_id=?1",
        [&p.session_id],
        |r| r.get(0),
    )?;
    if count != 1 {
        return Err(bad("proposal session contains extra operations"));
    }
    let bind: Vec<u64> = {
        let mut q=conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='strategy_search_proposal_bound' LIMIT 2")?;
        q.query_map([&p.session_id], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?
    };
    if bind.len() != 1 {
        return Err(bad("proposal session witness absent"));
    }
    event(
        conn,
        &p.session_id,
        bind[0],
        "strategy_search_proposal_bound",
        &json!({"campaign_id":c.id,"proposal_id":p.id,"operation_id":p.operation_id,"sequence":seq}),
    )?;
    lifecycle(conn, &p, &op)?;
    Ok((p, op))
}
pub(super) fn list(conn: &Connection, c: &Campaign) -> Result<Vec<(SearchProposal, Operation)>> {
    bound(conn, c)?;
    let mut q=conn.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM strategy_search_proposals WHERE campaign_id=?1 ORDER BY attempt_index LIMIT 17")?;
    let ids = q
        .query_map([&c.id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let count:u64=conn.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND kind='strategy_search_proposal_admitted'",[&c.journal_session_id],|r|r.get(0))?;
    if ids.len() > 16 || count != ids.len() as u64 {
        return Err(bad("proposal index omitted witness"));
    }
    ids.iter()
        .enumerate()
        .map(|(i, k)| {
            let p = read(conn, c, k)?;
            if p.0.attempt_index != i as u32 {
                return Err(bad("proposal order differs"));
            }
            Ok(p)
        })
        .collect()
}
pub(in super::super) fn proposal_binding(
    conn: &Connection,
    session: &str,
) -> Result<Option<(SearchProposal, Operation)>> {
    let row:Option<(String,String)>=conn.query_row("SELECT CASE WHEN length(CAST(campaign_id AS BLOB))<=256 THEN campaign_id END,CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM strategy_search_proposals WHERE session_id=?1",[session],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    match row {
        Some((c, k)) => Ok(Some(read(conn, &original(conn, &c)?, &k)?)),
        None => {
            let bound:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='strategy_search_proposal_bound') OR EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND generation LIKE 'strategy-proposal:%')",[session],|r|r.get(0))?;
            if bound {
                return Err(bad("proposal session projection absent"));
            }
            Ok(None)
        }
    }
}
pub(in super::super) fn authorize_proposal_session(
    conn: &Connection,
    session: &str,
    _command: &str,
    _payload: &Value,
) -> Result<bool> {
    if proposal_binding(conn, session)?.is_some() {
        return Err(bad("proposal session forbids additional admissions"));
    }
    Ok(false)
}
fn worker(p: &SearchProposal, op: &Operation) -> hooks::DebitWorker {
    hooks::DebitWorker {
        campaign_id: p.campaign_id.clone(),
        session_id: p.session_id.clone(),
        owner: p.owner.clone(),
        status: if op.status == OperationStatus::Running {
            CampaignRunStatus::Running
        } else {
            CampaignRunStatus::Unknown
        },
    }
}
pub(in super::super) fn reserve_model(
    conn: &Transaction<'_>,
    session: &str,
    op: &str,
    amount: u64,
) -> Result<bool> {
    let Some((p, o)) = proposal_binding(conn, session)? else {
        return Ok(false);
    };
    let c = original(conn, &p.campaign_id)?;
    let cfg = required(conn, &c)?;
    if p.operation_id != op || amount != cfg.plan.proposer.reservation_micro_usd {
        return Err(bad("proposal reservation mismatch"));
    }
    hooks::reserve(
        conn,
        &worker(&p, &o),
        &format!("model:{op}"),
        op,
        "model",
        &json!({"micro_usd":amount}),
    )?;
    Ok(true)
}
pub(in super::super) fn settle_model(
    conn: &Transaction<'_>,
    session: &str,
    op: &str,
    amount: u64,
) -> Result<bool> {
    let Some((p, o)) = proposal_binding(conn, session)? else {
        return Ok(false);
    };
    if p.operation_id != op {
        return Err(bad("proposal settlement identity"));
    }
    hooks::settle(
        conn,
        &worker(&p, &o),
        &format!("model:{op}"),
        &json!({"micro_usd":amount}),
    )?;
    Ok(true)
}
impl Store {
    pub fn search_proposals(&self, campaign: &str) -> Result<Vec<(SearchProposal, Operation)>> {
        let tx = self.conn.unchecked_transaction()?;
        let c = original(&tx, campaign)?;
        required(&tx, &c)?;
        list(&tx, &c)
    }
    pub fn search_proposal(
        &self,
        campaign: &str,
        key: &str,
    ) -> Result<(SearchProposal, Operation)> {
        let tx = self.conn.unchecked_transaction()?;
        read(&tx, &original(&tx, campaign)?, key)
    }
    pub fn admit_search_proposal(
        &mut self,
        campaign: &str,
        owner: &str,
        index: u32,
        request: &ResponsesRequest,
        feedback_sha256: Option<&str>,
    ) -> Result<(SearchProposal, Operation, bool)> {
        id(owner)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let c = original(&tx, campaign)?;
        let cfg = required(&tx, &c)?;
        let expected = payload(&tx, &c, &cfg, index, feedback_sha256)?;
        if expected["request"] != serde_json::to_value(request)?
            || encode(&expected)?.len() > 512 * 1024
        {
            return Err(bad("proposal request differs from exact renderer"));
        }
        let prior = list(&tx, &c)?;
        if let Some((p, o)) = prior.get(index as usize) {
            if o.payload != expected {
                return Err(bad("proposal exact retry differs"));
            }
            return Ok((p.clone(), o.clone(), true));
        }
        require_epoch(&tx, owner)?;
        open(&tx, campaign)?;
        if index as usize != prior.len()
            || prior.iter().any(|(_, o)| {
                matches!(
                    o.status,
                    OperationStatus::Running | OperationStatus::Unknown | OperationStatus::Admitted
                )
            })
        {
            return Err(bad("proposal prefix unresolved"));
        }
        for (_, old) in &prior {
            if old.status == OperationStatus::Succeeded {
                if let Some(completion) = old
                    .outcome
                    .clone()
                    .and_then(|v| serde_json::from_value::<Completion>(v).ok())
                {
                    let calls: Vec<_> = completion
                        .content
                        .iter()
                        .filter_map(|c| {
                            if let Content::ToolCall {
                                name, arguments, ..
                            } = c
                            {
                                Some((name, arguments))
                            } else {
                                None
                            }
                        })
                        .collect();
                    if completion.status == CompletionStatus::Completed
                        && completion.error.is_none()
                        && calls.len() == 1
                        && calls[0].0 == "submit_strategy_proposal"
                        && matches!(
                            serde_json::from_value::<SearchProposalOutput>(calls[0].1.clone()),
                            Ok(SearchProposalOutput::Stop { .. })
                        )
                    {
                        return Err(bad("search already stopped by a durable proposal"));
                    }
                }
            }
        }
        for evaluation in evaluations::list(&tx, &c)? {
            let count:u32=tx.query_row("SELECT count(*) FROM campaign_runs WHERE campaign_id=?1 AND schedule_index>=?2 AND schedule_index<?3",params![c.id,evaluation.schedule_start,evaluation.schedule_start+evaluation.run_count],|r|r.get(0))?;
            if count != evaluation.run_count {
                return Err(bad("prior evaluation schedule is incomplete"));
            }
        }
        let usage = read::usage(&tx, &c)?;
        if usage.active_runs > 0
            || usage.unknown_runs > 0
            || usage.model_reserved_micro_usd > 0
            || usage.http_response_reserved_bytes > 0
        {
            return Err(bad("search has unresolved work"));
        }
        let s = session(
            &tx,
            &format!("strategy-proposal:{}", c.plan_sha256),
            c.plan.limits.model_micro_usd,
            now()?,
        )?;
        let key = uuid::Uuid::new_v4().to_string();
        let op_id = uuid::Uuid::new_v4().to_string();
        let command = format!("strategy-proposal:{campaign}:{index}");
        let raw = encode(&expected)?;
        tx.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES(?1,?2,?3,?4,?5,'admitted')",params![op_id,s.id,command,raw,format!("{:x}",Sha256::digest(raw.as_bytes()))])?;
        let mut op = hooks::operation(&tx, &op_id)?;
        append(&tx, &s.id, "command_admitted", &serde_json::to_value(&op)?)?;
        tx.execute(
            "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
            params![op_id, owner],
        )?;
        op.status = OperationStatus::Running;
        op.owner = Some(owner.into());
        append(&tx, &s.id, "operation_started", &serde_json::to_value(&op)?)?;
        let seq = next(&tx, &c.journal_session_id)?;
        let p = SearchProposal {
            id: key,
            campaign_id: campaign.into(),
            command_id: command,
            session_id: s.id,
            operation_id: op_id,
            attempt_index: index,
            owner: owner.into(),
            request_sha256: hash(&expected["request"])?,
            feedback_sha256: feedback_sha256.map(Into::into),
            sequence: seq,
        };
        tx.execute(
            "INSERT INTO strategy_search_proposals VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                p.id,
                campaign,
                p.command_id,
                p.session_id,
                p.operation_id,
                index,
                encode(&p)?,
                integer(seq)?
            ],
        )?;
        append(
            &tx,
            &c.journal_session_id,
            "strategy_search_proposal_admitted",
            &serde_json::to_value(&p)?,
        )?;
        append(
            &tx,
            &p.session_id,
            "strategy_search_proposal_bound",
            &json!({"campaign_id":campaign,"proposal_id":p.id,"operation_id":p.operation_id,"sequence":seq}),
        )?;
        reserve_model(
            &tx,
            &p.session_id,
            &p.operation_id,
            cfg.plan.proposer.reservation_micro_usd,
        )?;
        tx.execute(
            "INSERT INTO reservations(session_id,id,amount) VALUES(?1,?2,?3)",
            params![
                p.session_id,
                p.operation_id,
                integer(cfg.plan.proposer.reservation_micro_usd)?
            ],
        )?;
        append(
            &tx,
            &p.session_id,
            "budget_reserved",
            &json!({"reservation_id":p.operation_id,"amount":cfg.plan.proposer.reservation_micro_usd}),
        )?;
        tx.commit()?;
        Ok((p, op, false))
    }
}
