use super::*;
pub(super) fn run(conn: &Connection, campaign: &str, key: &str) -> Result<CampaignRun> {
    id(key)?;
    let c = original(conn, campaign)?;
    let (size,sequence,closed,close_sequence,close_reason):(usize,u64,Option<String>,Option<u64>,Option<String>)=conn.query_row("SELECT length(CAST(record AS BLOB)),sequence,CASE WHEN length(CAST(closed AS BLOB))<=16 THEN closed END,close_sequence,CASE WHEN length(CAST(close_reason AS BLOB))<=4096 THEN close_reason END FROM campaign_runs WHERE campaign_id=?1 AND id=?2",params![campaign,key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    lifecycle::closure(conn, &c.journal_session_id, key, close_sequence)?;
    if size > 600 * 1024 {
        return Err(bad("run record exceeds bound"));
    }
    let encoded: String =
        conn.query_row("SELECT record FROM campaign_runs WHERE id=?1", [key], |r| {
            r.get(0)
        })?;
    let mut r: CampaignRun = serde_json::from_str(&encoded)?;
    r.spec.validate().map_err(|e| bad(&e.to_string()))?;
    if r.id != key
        || r.campaign_id != campaign
        || r.sequence != sequence
        || r.status != CampaignRunStatus::Pending
        || r.operation_id.is_some()
        || r.run_command_id != format!("campaign-run:{key}")
        || r.request_sha256 != hash(&serde_json::to_value(&r.spec.request)?)?
    {
        return Err(bad("run identity differs"));
    }
    event(
        conn,
        &c.journal_session_id,
        sequence,
        "campaign_run_admitted",
        &serde_json::to_value(&r)?,
    )?;
    if let Some(key) = &r.spec.exposure_id {
        let e = exposure(conn, campaign, key)?;
        if e.suite_sha256 != r.spec.suite_sha256
            || e.evaluation_pair_sha256 != r.spec.evaluation_pair_sha256
            || e.finalist_sha256 != r.spec.candidate_sha256
        {
            return Err(bad("retained run exposure changed"));
        }
    }
    let s = crate::get_session(conn, &r.session_id)?;
    if s.generation != format!("campaign:{}", c.plan_sha256)
        || s.generation_epoch.is_some()
        || s.budget_limit != c.plan.limits.model_micro_usd
    {
        return Err(bad("bound session changed"));
    }
    let index:(String,String,String,u32)=conn.query_row("SELECT CASE WHEN length(CAST(campaign_id AS BLOB))<=256 THEN campaign_id END,CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id END,CASE WHEN length(CAST(command_id AS BLOB))<=256 THEN command_id END,schedule_index FROM campaign_runs WHERE id=?1",[key],|q|Ok((q.get(0)?,q.get(1)?,q.get(2)?,q.get(3)?)))?;
    if index
        != (
            r.campaign_id.clone(),
            r.session_id.clone(),
            r.command_id.clone(),
            r.spec.schedule_index,
        )
    {
        return Err(bad("run index differs"));
    }
    if let Some((operation, status)) = lifecycle::root(conn, &r)? {
        if closed.is_some() {
            return Err(bad("retired run has a root operation"));
        }
        r.operation_id = Some(operation);
        r.status = status;
    } else if let Some(closed) = closed {
        let sequence = close_sequence.ok_or_else(|| bad("retired run witness absent"))?;
        if closed != "unknown" && closed != "cancelled" && closed != "failed" {
            return Err(bad("invalid retired run"));
        }
        event(
            conn,
            &c.journal_session_id,
            sequence,
            "campaign_run_closed",
            &json!({"run_id":key,"status":closed,"reason":close_reason}),
        )?;
        r.status = if closed == "unknown" {
            CampaignRunStatus::Unknown
        } else if closed == "failed" {
            CampaignRunStatus::Failed
        } else {
            CampaignRunStatus::Cancelled
        };
    } else if close_sequence.is_some() {
        return Err(bad("unexpected run close witness"));
    }
    Ok(r)
}
pub(super) fn exposure(conn: &Connection, campaign: &str, key: &str) -> Result<CampaignExposure> {
    let c = original(conn, campaign)?;
    let(size,sequence):(usize,u64)=conn.query_row("SELECT length(CAST(record AS BLOB)),sequence FROM campaign_exposures WHERE id=?1 AND campaign_id=?2",params![key,campaign],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    if size > 4096 {
        return Err(bad("exposure exceeds bound"));
    }
    let bytes: String = conn.query_row(
        "SELECT record FROM campaign_exposures WHERE id=?1",
        [key],
        |r| r.get(0),
    )?;
    let e: CampaignExposure = serde_json::from_str(&bytes)?;
    let index:(String,String,String)=conn.query_row("SELECT CASE WHEN length(CAST(command_id AS BLOB))<=256 THEN command_id END,CASE WHEN length(CAST(suite_sha256 AS BLOB))<=71 THEN suite_sha256 END,CASE WHEN length(CAST(evaluation_pair_sha256 AS BLOB))<=71 THEN evaluation_pair_sha256 END FROM campaign_exposures WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if e.id != key
        || e.campaign_id != campaign
        || e.sequence != sequence
        || index
            != (
                e.command_id.clone(),
                e.suite_sha256.clone(),
                e.evaluation_pair_sha256.clone(),
            )
    {
        return Err(bad("exposure index differs"));
    }
    event(
        conn,
        &c.journal_session_id,
        sequence,
        "campaign_exposed",
        &serde_json::to_value(&e)?,
    )?;
    Ok(e)
}
pub(super) fn usage(conn: &Connection, c: &Campaign) -> Result<CampaignUsage> {
    let mut u = CampaignUsage::default();
    let bytes:u64=conn.query_row("SELECT COALESCE(SUM(length(CAST(record AS BLOB))),0) FROM campaign_runs WHERE campaign_id=?1",[&c.id],|r|r.get(0))?;
    if bytes > 64 * 1024 * 1024 {
        return Err(bad("campaign run read budget exceeded"));
    }
    lifecycle::budget(conn, &c.id)?;
    let mut q=conn.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END,CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id END,CASE WHEN length(CAST(owner AS BLOB))<=256 THEN owner END,CASE WHEN length(CAST(closed AS BLOB))<=16 THEN closed END,close_sequence,CASE WHEN length(CAST(close_reason AS BLOB))<=4096 THEN close_reason END,sequence FROM campaign_runs WHERE campaign_id=?1 ORDER BY sequence LIMIT 129")?;
    let rows = q
        .query_map([&c.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<u64>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, u64>(6)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > 128 {
        return Err(bad("run count exceeds bound"));
    }
    let event_count: u64 = conn.query_row(
        "SELECT COUNT(*) FROM events WHERE session_id=?1 AND kind='campaign_run_admitted'",
        [&c.journal_session_id],
        |r| r.get(0),
    )?;
    if event_count != rows.len() as u64 {
        return Err(bad("run index omitted immutable admission"));
    }
    for (key, session, owner, closed, close_sequence, reason, sequence) in rows {
        if key.len() > 256
            || session.len() > 256
            || owner.len() > 256
            || reason.as_ref().is_some_and(|v| v.len() > 4096)
        {
            return Err(bad("run metadata exceeds bound"));
        }
        let valid:bool=conn.query_row("SELECT json(r.record)=json(e.payload) AND json_extract(r.record,'$.id')=r.id AND json_extract(r.record,'$.session_id')=r.session_id AND json_extract(r.record,'$.owner')=r.owner AND json_extract(r.record,'$.campaign_id')=r.campaign_id AND json_extract(r.record,'$.command_id')=r.command_id AND json_extract(r.record,'$.sequence')=r.sequence AND json_extract(r.record,'$.spec.schedule_index')=r.schedule_index FROM campaign_runs r JOIN events e ON e.session_id=?2 AND e.sequence=r.sequence AND e.kind='campaign_run_admitted' WHERE r.id=?1",params![key,c.journal_session_id],|r|r.get(0)).optional()?.unwrap_or(false);
        if !valid {
            return Err(bad("run metadata differs from immutable admission"));
        }
        lifecycle::closure(conn, &c.journal_session_id, &key, close_sequence)?;
        if closed.is_none() && (close_sequence.is_some() || reason.is_some()) {
            return Err(bad("run closure metadata incomplete"));
        }
        let state = if let Some((_, status)) = lifecycle::metadata(conn, &key, &session, &owner)? {
            if closed.is_some() {
                return Err(bad("closed run has root"));
            }
            status
        } else if let Some(closed) = closed {
            let seq = close_sequence.ok_or_else(|| bad("closure witness missing"))?;
            event(
                conn,
                &c.journal_session_id,
                seq,
                "campaign_run_closed",
                &json!({"run_id":key,"status":closed,"reason":reason}),
            )?;
            match closed.as_str() {
                "unknown" => CampaignRunStatus::Unknown,
                "cancelled" => CampaignRunStatus::Cancelled,
                "failed" => CampaignRunStatus::Failed,
                _ => return Err(bad("invalid closure")),
            }
        } else {
            CampaignRunStatus::Pending
        };
        // The compact binding prevents deletion/repointing of the session projection.
        let count:u64=conn.query_row("SELECT COUNT(*) FROM events WHERE session_id=?1 AND kind='campaign_session_bound' AND json_extract(payload,'$.campaign_id')=?2 AND json_extract(payload,'$.run_id')=?3 AND json_extract(payload,'$.run_sequence')=?4",params![session,c.id,key,integer(sequence)?],|r|r.get(0))?;
        if count != 1 {
            return Err(bad("run session binding witness differs"));
        }
        u.runs += 1;
        match state {
            CampaignRunStatus::Pending | CampaignRunStatus::Running => u.active_runs += 1,
            CampaignRunStatus::Unknown => u.unknown_runs += 1,
            _ => {}
        }
    }
    hooks::sum(conn, c, &mut u)?;
    Ok(u)
}
pub(super) fn snapshot(conn: &Connection, key: &str) -> Result<CampaignSnapshot> {
    let c = current(conn, key)?;
    let usage = usage(conn, &c)?;
    let as_of_sequence: u64 = conn.query_row(
        "SELECT COALESCE(MAX(sequence),0) FROM events WHERE session_id=?1",
        [&c.journal_session_id],
        |r| r.get(0),
    )?;
    Ok(CampaignSnapshot {
        campaign: c,
        usage,
        as_of_sequence,
        as_of_ms: now()?,
    })
}
impl Store {
    pub fn campaign(&self, key: &str) -> Result<CampaignSnapshot> {
        let tx = self.conn.unchecked_transaction()?;
        snapshot(&tx, key)
    }
    pub fn campaign_run(&self, campaign: &str, key: &str) -> Result<CampaignRun> {
        let tx = self.conn.unchecked_transaction()?;
        run(&tx, campaign, key)
    }
    pub fn campaign_session(&self, session: &str) -> Result<Option<CampaignRun>> {
        let tx = self.conn.unchecked_transaction()?;
        binding(&tx, session)
    }
    pub fn campaign_runs(&self, campaign: &str, after: u64, limit: u32) -> Result<CampaignRunPage> {
        if !(1..=100).contains(&limit) {
            return Err(bad("page limit must be 1..100"));
        }
        let tx = self.conn.unchecked_transaction()?;
        original(&tx, campaign)?;
        let mut q=tx.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM campaign_runs WHERE campaign_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
        let ids = q
            .query_map(params![campaign, integer(after)?, limit + 1], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut page = CampaignRunPage {
            runs: vec![],
            next_after_sequence: None,
        };
        for key in ids {
            let r = run(&tx, campaign, &key)?;
            if page.runs.len() >= limit as usize {
                page.next_after_sequence = page.runs.last().map(|r| r.sequence);
                break;
            }
            page.runs.push(r.into());
            if serde_json::to_vec(&page)?.len() > 1024 * 1024 {
                page.runs.pop();
                page.next_after_sequence = page.runs.last().map(|r| r.sequence);
                if page.runs.is_empty() {
                    return Err(bad("first page entry exceeds bound"));
                }
                break;
            }
        }
        Ok(page)
    }
}
