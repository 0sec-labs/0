use super::*;
pub(super) struct Bound {
    pub record: ScanRecord,
    pub admission: ScanAdmission,
    pub controller: Operation,
    pub root: Operation,
    pub close: Option<ScanCloseReason>,
}
pub(super) fn operation(conn: &Connection, key: &str, r: &mut Reader) -> Result<Operation> {
    let n:usize=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 AND length(CAST(session_id AS BLOB))<=256 AND length(CAST(command_id AS BLOB))<=256 AND length(CAST(status AS BLOB))<=16 AND (owner IS NULL OR length(CAST(owner AS BLOB))<=4096) THEN length(CAST(payload AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0) END FROM operations WHERE id=?1",[key],|r|r.get(0))?;
    r.charge(n, 32 * 1024 * 1024)?;
    let op = crate::operations::operation(conn, key)?;
    for value in [&op.id, &op.session_id, &op.command_id] {
        id(value)?;
    }
    let mut q=conn.prepare("SELECT kind,sequence FROM events INDEXED BY campaign_root_lifecycle WHERE session_id=?1 AND kind IN ('command_admitted','operation_started','operation_settled','operation_unknown','operation_not_started') AND CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id')) END=?2 ORDER BY sequence LIMIT 5")?;
    let rows = q
        .query_map(params![op.session_id, op.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let expected_count = if op.status == OperationStatus::Running {
        2
    } else {
        3
    };
    if rows.len() != expected_count
        || rows[0].0 != "command_admitted"
        || rows[1].0 != "operation_started"
    {
        return Err(bad("operation lifecycle differs"));
    }
    let mut admitted = op.clone();
    admitted.status = OperationStatus::Admitted;
    admitted.owner = None;
    admitted.outcome = None;
    let mut started = op.clone();
    started.status = OperationStatus::Running;
    started.outcome = None;
    if op.owner.is_none()
        || r.event(conn, &op.session_id, rows[0].1)?.1 != serde_json::to_value(admitted)?
        || r.event(conn, &op.session_id, rows[1].1)?.1 != serde_json::to_value(started)?
    {
        return Err(bad("admission or ownership witness differs"));
    }
    if rows.len() == 3 {
        let (kind, value) = r.event(conn, &op.session_id, rows[2].1)?;
        if op.status == OperationStatus::Unknown {
            if kind != "operation_unknown"
                || (value != serde_json::to_value(&op)?
                    && !(op.outcome.is_none()
                        && (value == json!({"operation_id":op.id,"owner":op.owner})
                            || value
                                == json!({"operation_id":op.id,"owner":op.owner,"reason":"previous engine epoch ended"}))))
            {
                return Err(bad("Unknown witness differs"));
            }
        } else if !matches!(
            op.status,
            OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled
        ) || kind != "operation_settled"
            || value != serde_json::to_value(&op)?
        {
            return Err(bad("terminal witness differs"));
        }
    }
    Ok(op)
}
pub(super) fn record(conn: &Connection, key: &str, r: &mut Reader) -> Result<ScanRecord> {
    id(key)?;
    let (raw,seq):(String,u64)=conn.query_row("SELECT CASE WHEN length(CAST(record AS BLOB))<=65536 THEN record END,binding_sequence FROM scans WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    r.charge(raw.len(), 65536)?;
    let v: ScanRecord = serde_json::from_str(&raw)?;
    let valid:bool=conn.query_row("SELECT id=?2 AND sequence=?3 AND command_id=?4 AND session_id=?5 AND controller_operation_id=?6 AND root_operation_id=?7 AND intent_sha256=?8 FROM scans WHERE id=?1",params![key,v.id,integer(v.sequence)?,v.command_id,v.session_id,v.controller_operation_id,v.root_operation_id,v.intent_sha256],|r|r.get(0))?;
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='scan_created'",
        [&v.session_id],
        |r| r.get(0),
    )?;
    let global:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY scan_command_created WHERE kind='scan_created' AND json_extract(payload,'$.command_id')=?1",[&v.command_id],|r|r.get(0))?;
    let (kind, witness) = r.event(conn, &v.session_id, seq)?;
    if !valid
        || global != 1
        || v.schema_version != 1
        || count != 1
        || kind != "scan_created"
        || witness != serde_json::to_value(&v)?
    {
        return Err(bad("catalog binding witness differs"));
    }
    Ok(v)
}
pub(super) fn by_command(
    conn: &Connection,
    command: &str,
    r: &mut Reader,
) -> Result<Option<ScanRecord>> {
    id(command)?;
    let key:Option<String>=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM scans WHERE command_id=?1",[command],|r|r.get(0)).optional()?;
    let count:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY scan_command_created WHERE kind='scan_created' AND json_extract(payload,'$.command_id')=?1",[command],|r|r.get(0))?;
    match key {
        Some(key) if count == 1 => Ok(Some(bound(conn, &key, r)?.record)),
        None if count == 0 => Ok(None),
        _ => Err(bad("global command projection or witness missing")),
    }
}
pub(super) fn binding(conn: &Connection, session: &str, r: &mut Reader) -> Result<Option<Bound>> {
    let key:Option<String>=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM scans WHERE session_id=?1",[session],|r|r.get(0)).optional()?;
    if let Some(key) = key {
        return Ok(Some(bound(conn, &key, r)?));
    }
    let marked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND generation LIKE 'native-scan:%') OR EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='scan_created')",[session],|r|r.get(0))?;
    if marked {
        return Err(bad("scan binding projection missing"));
    }
    Ok(None)
}
pub(super) fn bound(conn: &Connection, key: &str, r: &mut Reader) -> Result<Bound> {
    let v = record(conn, key, r)?;
    let intent: Value =
        serde_json::from_slice(&r.artifact(conn, &v.intent_sha256, MAX_SCAN_INTENT_BYTES)?)?;
    let a: ScanAdmission = serde_json::from_value(intent["admission"].clone())?;
    admission::validate(&a)?;
    let bounded: bool = conn.query_row(
        "SELECT length(CAST(generation AS BLOB))<=256 FROM sessions WHERE id=?1",
        [&v.session_id],
        |r| r.get(0),
    )?;
    if !bounded {
        return Err(bad("session metadata bounds"));
    }
    let s = crate::get_session(conn, &v.session_id)?;
    if intent["kind"] != "native_scan_intent"
        || intent["schema_version"] != 1
        || intent["command_id"] != v.command_id
        || intent["created_at_ms"] != v.created_at_ms
        || intent["deadline_at_ms"] != v.deadline_at_ms
        || a.scan_id != v.id
        || a.session_id != v.session_id
        || a.controller_operation_id != v.controller_operation_id
        || a.root_operation_id != v.root_operation_id
        || a.input_target != v.input_target
        || a.target != v.target
        || a.profile_name != v.profile_name
        || hash(&a.profile)? != v.profile_sha256
        || s.generation != format!("native-scan:{}", v.id)
        || s.generation_epoch.is_some()
        || s.budget_limit != a.profile.budget_limit
        || s.created_at_ms != v.created_at_ms
        || v.created_at_ms.checked_add(a.profile.deadline_ms) != Some(v.deadline_at_ms)
        || a.root_payload["http_context"]["account_id"] != v.http_account_id
    {
        return Err(bad("immutable scan intent differs"));
    }
    let controller = operation(conn, &v.controller_operation_id, r)?;
    let root = operation(conn, &v.root_operation_id, r)?;
    let mut expected = a.root_payload.clone();
    expected["scan_operation_id"] = json!(controller.id);
    expected["scan_context"] = context(&v);
    if root.payload != expected
        || controller.payload
            != json!({"kind":"native_scan","scan_id":v.id,"intent_sha256":v.intent_sha256,"root_operation_id":root.id})
        || controller.session_id != v.session_id
        || root.session_id != v.session_id
        || controller.owner != root.owner
        || root.command_id != format!("scan:{}:root", v.id)
        || controller.command_id != format!("scan:{}", v.id)
    {
        return Err(bad("root/controller authority differs"));
    }
    let attached:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM operation_artifacts WHERE operation_id=?1 AND name='scan.intent' AND digest=?2)",params![controller.id,v.intent_sha256],|r|r.get(0))?;
    let account:(String,String,String)=conn.query_row("SELECT CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id END,CASE WHEN length(CAST(root_operation_id AS BLOB))<=256 THEN root_operation_id END,CASE WHEN length(CAST(context AS BLOB))<=1048576 THEN context END FROM http_accounts WHERE id=?1",[&v.http_account_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    r.charge(account.2.len(), 1024 * 1024)?;
    if !attached
        || account.0 != v.session_id
        || account.1 != root.id
        || serde_json::from_str::<Value>(&account.2)? != root.payload["http_context"]
    {
        return Err(bad("original account or intent attachment differs"));
    }
    let mut q=conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='http_account_created' ORDER BY sequence LIMIT 2")?;
    let events = q
        .query_map([&v.session_id], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let accounts: u64 = conn.query_row(
        "SELECT count(*) FROM http_accounts WHERE session_id=?1",
        [&v.session_id],
        |r| r.get(0),
    )?;
    if events.len() != 1
        || accounts != 1
        || r.event(conn, &v.session_id, events[0])?.1
            != json!({"account_id":v.http_account_id,"root_operation_id":root.id,"profile_sha256":root.payload["http_context"]["profile_sha256"]})
    {
        return Err(bad("original account witness differs"));
    }
    let (reason,seq):(Option<String>,Option<u64>)=conn.query_row("SELECT CASE WHEN length(CAST(close_reason AS BLOB))<=16 THEN close_reason END,close_sequence FROM scans WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='scan_admission_closed'",
        [&v.session_id],
        |r| r.get(0),
    )?;
    let close = match (reason, seq) {
        (None, None) if count == 0 => None,
        (Some(reason), Some(seq)) if count == 1 => {
            let reason: ScanCloseReason = serde_json::from_value(json!(reason))?;
            let (kind, event) = r.event(conn, &v.session_id, seq)?;
            if kind != "scan_admission_closed"
                || event["scan_id"] != v.id
                || event["controller_operation_id"] != controller.id
                || event["reason"] != serde_json::to_value(reason)?
                || event["owner"] != json!(controller.owner)
            {
                return Err(bad("stop witness differs"));
            }
            Some(reason)
        }
        _ => return Err(bad("stop projection differs")),
    };
    Ok(Bound {
        record: v,
        admission: a,
        controller,
        root,
        close,
    })
}
fn snapshot(conn: &Connection, b: Bound, r: &mut Reader) -> Result<ScanSnapshot> {
    let closure_bytes:usize=conn.query_row("SELECT (SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM operations WHERE session_id=?1)+(SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM events WHERE session_id=?1 AND kind='command_admitted')",[&b.record.session_id],|r|r.get(0))?;
    r.charge(closure_bytes, 64 * 1024 * 1024)?;
    crate::admission_closure::validate(conn, &b.record.session_id)?;

    let result = match (&b.controller.status, &b.controller.outcome) {
        (
            OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled,
            Some(outcome),
        ) => {
            let result: ScanResult = serde_json::from_value(outcome.clone())?;
            if result.outcome.scan_id != b.record.id
                || result.outcome.root_status != b.root.status
                || result.outcome.currency != b.admission.profile.currency
            {
                return Err(bad("result identity differs"));
            }
            Some(result)
        }
        _ => None,
    };
    let budget = checked_budget(conn, &b.record.session_id, r)?;
    let observed: u64 = conn.query_row(
        "SELECT coalesce(max(sequence),0) FROM events WHERE session_id=?1",
        [&b.record.session_id],
        |r| r.get(0),
    )?;
    let phase = if b.controller.status != OperationStatus::Running {
        ScanPhase::Terminal
    } else if b.close.is_some() {
        ScanPhase::Cancelling
    } else {
        ScanPhase::Investigating
    };
    let http_usage = crate::http::account_usage(
        conn,
        &b.record.session_id,
        &b.record.http_account_id,
        &mut r.remaining,
    )?;
    if let Some(result) = &result {
        let o = &result.outcome;
        let counts = &o.summary;
        let total = counts
            .claimed_critical
            .checked_add(counts.claimed_high)
            .and_then(|n| n.checked_add(counts.claimed_medium))
            .and_then(|n| n.checked_add(counts.claimed_low))
            .and_then(|n| n.checked_add(counts.claimed_info));
        if o.schema_version != 1
            || serde_json::to_value(&o.budget)? != serde_json::to_value(&budget)?
            || o.http_usage != http_usage
            || o.close_reason != b.close
            || o.vulnerability_reportable
            || counts.verified_vulnerabilities != 0
            || o.security_conclusion != zero_protocol::source::SecurityConclusion::NotEstablished
            || total != Some(counts.submitted_hypotheses)
            || counts.submitted_hypotheses > b.admission.profile.max_hypotheses
            || o.started_at_ms != b.record.created_at_ms
            || o.completed_at_ms < o.started_at_ms
        {
            return Err(bad(
                "terminal summary differs from immutable account or claim bounds",
            ));
        }
        if o.completeness == ScanCompleteness::CompletedWorkflow {
            let unresolved:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE session_id=?1 AND status IN ('admitted','running','unknown'))",[&b.record.session_id],|r|r.get(0))?;
            let agent: zero_protocol::agent::AgentResult = serde_json::from_value(
                b.root
                    .outcome
                    .clone()
                    .ok_or_else(|| bad("completed root outcome absent"))?,
            )?;
            let review = agent
                .web_review
                .as_ref()
                .ok_or_else(|| bad("complete workflow has no structured submission"))?;
            let digest = review
                .artifacts
                .get("web.review")
                .ok_or_else(|| bad("review digest absent"))?;
            let linked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM operation_artifacts WHERE operation_id=?1 AND name='web.review' AND digest=?2)",params![b.root.id,digest],|r|r.get(0))?;
            if unresolved
                || budget.reserved != 0
                || http_usage.response_reserved_bytes != 0
                || b.root.status != OperationStatus::Succeeded
                || agent.status != zero_protocol::agent::AgentStatus::Completed
                || o.agent_status != Some(agent.status)
                || o.review_sha256.as_deref() != Some(digest)
                || !linked
                || serde_json::from_slice::<Value>(&r.artifact(
                    conn,
                    digest,
                    crate::MAX_ARTIFACT_BYTES,
                )?)? != serde_json::to_value(&review.review)?
            {
                return Err(bad(
                    "completed workflow has unresolved work or lacks structured review",
                ));
            }
            let mut expected = ScanClaimSummary::default();
            for h in &review.review.hypotheses {
                expected.submitted_hypotheses += 1;
                match h.claim.claimed_severity {
                    zero_protocol::source::ClaimedSeverity::Critical => {
                        expected.claimed_critical += 1
                    }
                    zero_protocol::source::ClaimedSeverity::High => expected.claimed_high += 1,
                    zero_protocol::source::ClaimedSeverity::Medium => expected.claimed_medium += 1,
                    zero_protocol::source::ClaimedSeverity::Low => expected.claimed_low += 1,
                    zero_protocol::source::ClaimedSeverity::Info => expected.claimed_info += 1,
                }
            }
            if expected != *counts {
                return Err(bad("claimed severity summary differs"));
            }
        }
    }
    let snapshot = ScanSnapshot {
        scan: b.record,
        controller_status: b.controller.status,
        root_status: b.root.status,
        phase,
        close_reason: b.close,
        budget,
        http_usage,
        currency: b.admission.profile.currency,
        result,
        observed_sequence: observed,
        observed_at_ms: now()?,
    };
    r.charge(encode(&snapshot)?.len(), 256 * 1024)?;
    Ok(snapshot)
}
impl Store {
    pub fn scan_by_command(&self, command: &str) -> Result<Option<ScanRecord>> {
        let tx = self.conn.unchecked_transaction()?;
        by_command(&tx, command, &mut Reader::new())
    }
    pub fn scan_record(&self, key: &str) -> Result<ScanRecord> {
        let tx = self.conn.unchecked_transaction()?;
        Ok(bound(&tx, key, &mut Reader::new())?.record)
    }
    pub fn scan_snapshot(&self, key: &str) -> Result<ScanSnapshot> {
        let tx = self.conn.unchecked_transaction()?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        snapshot(&tx, b, &mut r)
    }
    pub fn scan_page(&self, before: Option<u64>, limit: u32) -> Result<ScanPage> {
        if !(1..=32).contains(&limit) {
            return Err(bad("page limit1..32"));
        }
        let tx = self.conn.unchecked_transaction()?;
        let mut r = Reader::new();
        let mut q=tx.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END,sequence FROM scans WHERE (?1 IS NULL OR sequence<?1) ORDER BY sequence DESC LIMIT 128")?;
        let rows = q
            .query_map([before.map(integer).transpose()?], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut page = ScanPage {
            scans: vec![],
            next_before_sequence: None,
        };
        let mut consumed = 0;
        for (key, seq) in &rows {
            if page.scans.len() >= limit as usize || r.remaining < 40 * 1024 * 1024 {
                break;
            }
            let b = bound(&tx, key, &mut r)?;
            let item = snapshot(&tx, b, &mut r)?;
            page.scans.push(item);
            if encode(&page)?.len() > 1024 * 1024 {
                page.scans.pop();
                break;
            }
            consumed += 1;
            page.next_before_sequence = Some(*seq);
        }
        if consumed == rows.len() && rows.len() < 128 {
            page.next_before_sequence = None;
        }
        if page.scans.is_empty() && !rows.is_empty() {
            return Err(bad("first scan exceeds page bounds"));
        }
        Ok(page)
    }
}

pub(super) fn checked_budget(
    conn: &Connection,
    session: &str,
    r: &mut Reader,
) -> Result<crate::BudgetSnapshot> {
    let mut q=conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind IN ('budget_reserved','budget_settled','budget_reconciled') ORDER BY sequence LIMIT 2049")?;
    let events = q
        .query_map([session], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if events.len() > 2048 {
        return Err(bad("model ledger event bound"));
    }
    let mut ledger: BTreeMap<String, (u64, Option<u64>)> = BTreeMap::new();
    for seq in events {
        let (kind, v) = r.event(conn, session, seq)?;
        let key = v["reservation_id"]
            .as_str()
            .ok_or_else(|| bad("reservation id absent"))?;
        id(key)?;
        if kind == "budget_reserved" {
            let amount = v["amount"]
                .as_u64()
                .ok_or_else(|| bad("reservation amount absent"))?;
            if ledger.insert(key.into(), (amount, None)).is_some() {
                return Err(bad("duplicate reservation witness"));
            }
        } else if kind == "budget_settled" {
            let charge = v["charged"].as_u64().ok_or_else(|| bad("charge absent"))?;
            let item = ledger
                .get_mut(key)
                .ok_or_else(|| bad("unreserved settlement"))?;
            if item.1.replace(charge).is_some() {
                return Err(bad("duplicate settlement"));
            }
        } else {
            return Err(bad("manual scan reconciliation forbidden"));
        }
    }
    let mut q=conn.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END,amount,charged FROM reservations WHERE session_id=?1 ORDER BY id LIMIT 1025")?;
    let rows = q
        .query_map([session], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, Option<u64>>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > 1024
        || rows.len() != ledger.len()
        || rows
            .iter()
            .any(|(key, a, c)| ledger.get(key) != Some(&(*a, *c)))
    {
        return Err(bad("model ledger projection differs"));
    }
    crate::budget::snapshot(conn, session)
}

impl Store {
    pub fn scan_by_session(&self, session: &str) -> Result<Option<ScanRecord>> {
        id(session)?;
        let tx = self.conn.unchecked_transaction()?;
        Ok(binding(&tx, session, &mut Reader::new())?.map(|b| b.record))
    }
}
