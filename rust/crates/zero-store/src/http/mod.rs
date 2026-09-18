mod rate;
use crate::{Error, OperationStatus, Result, Store, append, integer};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zero_protocol::http::{HttpBudget, HttpProfilePolicy, HttpRatePolicy};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpAdmission {
    Admitted { receipt: String },
    WaitUntil { unix_ms: u64 },
}
fn invalid() -> Error {
    Error::Invalid("invalid HTTP accounting authority or evidence".into())
}
fn conflict() -> Error {
    Error::Conflict("HTTP accounting authority or retry mismatch".into())
}
fn hash(value: &Value) -> Result<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value)?)
    ))
}
// An oversized server deadline must not suppress the mandatory 429 park.
fn cooldown(now_ms: u64, retry_after: Option<u64>) -> Result<u64> {
    integer(now_ms)?;
    Ok(now_ms
        .saturating_add(60_000)
        .max(retry_after.unwrap_or(0))
        .min(i64::MAX as u64))
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value.get(key).and_then(Value::as_str).ok_or_else(invalid)
}
fn number(value: &Value, key: &str) -> Result<u64> {
    value.get(key).and_then(Value::as_u64).ok_or_else(invalid)
}
fn bounded(value: &Value, max: usize) -> Result<String> {
    let text = serde_json::to_string(value)?;
    if text.len() > max {
        return Err(invalid());
    }
    Ok(text)
}
fn owned(conn: &Connection, session: &str, effect: &str, owner: &str) -> Result<crate::Operation> {
    let op = crate::operations::operation(conn, effect)?;
    let epoch: Option<String> = conn
        .query_row(
            "SELECT owner FROM engine_epoch WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if op.session_id != session
        || op.owner.as_deref() != Some(owner)
        || op.status != OperationStatus::Running
        || epoch.as_deref() != Some(owner)
    {
        return Err(conflict());
    }
    Ok(op)
}

pub(crate) fn ensure_account(
    tx: &rusqlite::Transaction<'_>,
    session: &str,
    context: &Value,
) -> Result<()> {
    let encoded = bounded(context, 1024 * 1024)?;
    if number(context, "schema_version")? != 1 {
        return Err(invalid());
    }
    let account = string(context, "account_id")?;
    let command = string(context, "original_root_command")?;
    let profile = context.get("profile").ok_or_else(invalid)?;
    let policy: HttpProfilePolicy = serde_json::from_value(profile.clone())?;
    policy.validate().map_err(|_| invalid())?;
    let digest = hash(profile)?;
    if string(context, "profile_sha256")? != digest
        || hash(
            &json!({"session_id":session,"original_root_command":command,"profile_sha256":digest}),
        )? != account
    {
        return Err(invalid());
    }
    let budget: HttpBudget =
        serde_json::from_value(profile.get("budget").cloned().ok_or_else(invalid)?)?;
    integer(budget.max_requests)?;
    integer(budget.max_request_body_bytes)?;
    integer(budget.max_response_decoded_bytes)?;
    let root_id: String = tx.query_row(
        "SELECT id FROM operations WHERE session_id=?1 AND command_id=?2",
        params![session, command],
        |r| r.get(0),
    )?;
    let root = crate::operations::operation(tx, &root_id)?;
    if root.payload.get("http_context") != Some(context)
        || zero_protocol::agent::validate_actor_payload(&root.payload).is_err()
        || root.payload.pointer("/request/http_profile") != context.get("profile_name")
    {
        return Err(conflict());
    }
    let existing: Option<(String, String, String)> = tx
        .query_row(
            "SELECT session_id,root_operation_id,context FROM http_accounts WHERE id=?1",
            [account],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some(old) = existing {
        if old != (session.into(), root_id, encoded) {
            return Err(conflict());
        }
        return Ok(());
    }
    tx.execute(
        "INSERT INTO http_accounts(id,session_id,root_operation_id,context) VALUES (?1,?2,?3,?4)",
        params![account, session, root_id, encoded],
    )?;
    append(
        tx,
        session,
        "http_account_created",
        &json!({"account_id":account,"root_operation_id":root_id,"profile_sha256":digest}),
    )?;
    Ok(())
}

impl Store {
    /// Lazy creation binds one immutable account to the original root admission.
    /// Continuations and child actors reuse this identity, never reset it.
    pub fn ensure_http_account(&mut self, session: &str, context: &Value) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::scan::hooks_account(&tx, session, context)?;
        ensure_account(&tx, session, context)?;
        tx.commit()?;
        Ok(())
    }

    /// Not retryable after admission: a committed receipt means possible external
    /// dispatch. A caller must never turn a duplicate into a second socket.
    pub fn admit_http_hop(
        &mut self,
        session: &str,
        effect: &str,
        owner: &str,
        account: &str,
        intent: &Value,
        now_ms: u64,
    ) -> Result<HttpAdmission> {
        integer(now_ms)?;
        let encoded = bounded(intent, 65536)?;
        let index = number(intent, "index")?;
        let host = string(intent, "host")?;
        if index > 5
            || host.is_empty()
            || host.len() > 253
            || !host.is_ascii()
            || host
                .bytes()
                .any(|b| b.is_ascii_uppercase() || b.is_ascii_whitespace())
        {
            return Err(invalid());
        }
        let request = number(intent, "request_body_bytes")?;
        let reserved = number(intent, "response_decoded_limit")?;
        if request > 1024 * 1024 || reserved > 16 * 1024 * 1024 {
            return Err(invalid());
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let op = owned(&tx, session, effect, owner)?;
        crate::scan::guard_effect(&tx, session, effect, intent)?;
        crate::web_verification::effect(&tx, &op)?;
        let (account_session, context): (String, String) = tx.query_row(
            "SELECT session_id,context FROM http_accounts WHERE id=?1",
            [account],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let context: Value = serde_json::from_str(&context)?;
        if account_session != session
            || op.payload.get("http_context") != Some(&context)
            || op.payload.get("kind").and_then(Value::as_str) != Some("agent_http")
            || intent.get("profile_sha256") != context.get("profile_sha256")
        {
            return Err(conflict());
        }
        if index == 0 && op.payload.get("origin").is_some() {
            let planned: zero_protocol::http::HttpRequestIntent =
                serde_json::from_value(op.payload["request"].clone())?;
            if intent["url"] != planned.url
                || intent["method"] != planned.method
                || request != planned.body.as_ref().map_or(0, |b| b.len() as u64)
            {
                return Err(conflict());
            }
        }
        let profile = context.get("profile").ok_or_else(invalid)?;
        let policy: HttpProfilePolicy = serde_json::from_value(profile.clone())?;
        policy.validate().map_err(|_| invalid())?;
        let max_hops = match policy.redirect {
            zero_protocol::http::HttpRedirectPolicy::Follow { max_hops } => u64::from(max_hops),
            _ => 0,
        };
        if index > max_hops
            || request > policy.limits.max_request_body_bytes
            || reserved != policy.limits.max_response_decoded_bytes
        {
            return Err(invalid());
        }
        let budget: HttpBudget =
            serde_json::from_value(profile.get("budget").cloned().ok_or_else(invalid)?)?;
        let rates: HttpRatePolicy =
            serde_json::from_value(profile.get("rate").cloned().ok_or_else(invalid)?)?;
        if rates.jitter_ms > 1000 || rates.per_host.len() > 128 {
            return Err(invalid());
        }
        let rate = rates.per_host.get(host).unwrap_or(&rates.default);
        check_account(&tx, session, account)?;
        let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM http_dispatches WHERE effect_operation_id=?1 AND hop_index=?2)",params![effect,index],|r|r.get(0))?;
        if duplicate {
            return Err(conflict());
        }
        // Redirects are consecutive and cannot race a previous unsettled hop.
        let (prior,unfinished):(u64,u64) = tx.query_row("SELECT COUNT(*),COALESCE(SUM(observation IS NULL),0) FROM http_dispatches WHERE effect_operation_id=?1",[effect],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if prior != index || unfinished != 0 {
            return Err(conflict());
        }
        if index > 0 {
            let previous:String=tx.query_row("SELECT observation FROM http_dispatches WHERE effect_operation_id=?1 AND hop_index=?2",params![effect,index-1],|r|r.get(0))?;
            let previous: Value = serde_json::from_str(&previous)?;
            if previous.get("complete").and_then(Value::as_bool) != Some(true)
                || !matches!(
                    previous.get("status").and_then(Value::as_u64),
                    Some(301 | 302 | 303 | 307 | 308)
                )
            {
                return Err(conflict());
            }
            if previous.get("redirect_url") != intent.get("url") {
                return Err(conflict());
            }
            let prior_intent: String = tx.query_row(
                "SELECT intent FROM http_dispatches WHERE effect_operation_id=?1 AND hop_index=?2",
                params![effect, index - 1],
                |r| r.get(0),
            )?;
            let prior_intent: Value = serde_json::from_str(&prior_intent)?;
            let prior_method = string(&prior_intent, "method")?;
            let status = number(&previous, "status")?;
            let becomes_get = (matches!(status, 301 | 302) && prior_method == "POST")
                || (status == 303 && prior_method != "GET" && prior_method != "HEAD");
            if string(intent, "method")? != if becomes_get { "GET" } else { prior_method }
                || request
                    != if becomes_get {
                        0
                    } else {
                        number(&prior_intent, "request_body_bytes")?
                    }
            {
                return Err(conflict());
            }
        }
        let (count,request_used,response_used):(u64,u64,u64) = tx.query_row("SELECT COUNT(*),COALESCE(SUM(request_bytes),0),COALESCE(SUM(COALESCE(charged_bytes,reserved_bytes)),0) FROM http_dispatches WHERE account_id=?1",[account],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        if request_used > budget.max_request_body_bytes
            || response_used > budget.max_response_decoded_bytes
            || count >= budget.max_requests
            || request > budget.max_request_body_bytes.saturating_sub(request_used)
            || reserved
                > budget
                    .max_response_decoded_bytes
                    .saturating_sub(response_used)
        {
            return Err(Error::BudgetExceeded);
        }
        let state = rate_state(&tx, session, account, host)?;
        let (tokens, last, cooldown) = state.unwrap_or((
            rate.interval_ms.saturating_mul(u64::from(rate.burst)),
            now_ms,
            0,
        ));
        let (tokens, time, eligible) = rate::available(rate, tokens, last, now_ms, cooldown)?;
        if eligible > now_ms {
            return Ok(HttpAdmission::WaitUntil { unix_ms: eligible });
        }
        // Bounded host jitter is shared by siblings and persisted on dispatch.
        let id = uuid::Uuid::new_v4().to_string();
        crate::campaign::admit_http(&tx, session, effect, &id, intent)?;
        let jitter = u64::from(Sha256::digest(id.as_bytes())[0]) * rates.jitter_ms / 255;
        let next = now_ms.checked_add(jitter).ok_or_else(invalid)?;
        integer(next)?;
        tx.execute("INSERT INTO http_rates(account_id,host,tokens,last_ms,cooldown_ms) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(account_id,host) DO UPDATE SET tokens=excluded.tokens,last_ms=excluded.last_ms,cooldown_ms=MAX(http_rates.cooldown_ms,excluded.cooldown_ms)",params![account,host,integer(tokens-rate.interval_ms)?,integer(time)?,integer(next)?])?;
        record_rate(&tx, session, account, host)?;
        tx.execute("INSERT INTO http_dispatches(id,account_id,effect_operation_id,hop_index,host,intent,request_bytes,reserved_bytes) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",params![id,account,effect,index,host,encoded,integer(request)?,integer(reserved)?])?;
        append(
            &tx,
            session,
            "http_dispatch_admitted",
            &json!({"receipt":id,"effect_operation_id":effect,"account_id":account,"intent":intent}),
        )?;
        tx.commit()?;
        Ok(HttpAdmission::Admitted { receipt: id })
    }
}

impl Store {
    #[allow(clippy::too_many_arguments)]
    pub fn observe_http_headers(
        &mut self,
        session: &str,
        effect: &str,
        owner: &str,
        receipt: &str,
        status: u16,
        retry_after_until_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<()> {
        if !(100..=599).contains(&status) {
            return Err(invalid());
        }
        integer(now_ms)?;
        let until = if status == 429 {
            cooldown(now_ms, retry_after_until_ms)?
        } else {
            0
        };
        integer(until)?;
        let headers = json!({"status":status,"retry_after_until_ms":retry_after_until_ms,"observed_at_ms":now_ms});
        let text = bounded(&headers, 1024)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (account,host,actual_effect,old):(String,String,String,Option<String>) = tx.query_row("SELECT account_id,host,effect_operation_id,headers FROM http_dispatches WHERE id=?1",[receipt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        if actual_effect != effect {
            return Err(conflict());
        }
        check_account(&tx, session, &account)?;
        if let Some(old) = old {
            if old != text {
                return Err(conflict());
            }
            let op = crate::operations::operation(&tx, effect)?;
            if op.session_id != session || op.owner.as_deref() != Some(owner) {
                return Err(conflict());
            }
            return Ok(());
        }
        owned(&tx, session, effect, owner)?;
        tx.execute(
            "UPDATE http_dispatches SET headers=?2 WHERE id=?1",
            params![receipt, text],
        )?;
        if status == 429 {
            rate_state(&tx, session, &account, &host)?.ok_or_else(invalid)?;
            tx.execute("UPDATE http_rates SET cooldown_ms=MAX(cooldown_ms,?3) WHERE account_id=?1 AND host=?2",params![account,host,integer(until)?])?;
        }
        if status == 429 {
            record_rate(&tx, session, &account, &host)?;
        }
        append(
            &tx,
            session,
            "http_headers_observed",
            &json!({"receipt":receipt,"effect_operation_id":effect,"headers":headers,"cooldown_until_ms":until}),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Incomplete effects retain their full byte hold. Exact retries are reads.
    pub fn settle_http_hop(
        &mut self,
        session: &str,
        effect: &str,
        owner: &str,
        receipt: &str,
        observation: &Value,
    ) -> Result<()> {
        let text = bounded(observation, 65536)?;
        let complete = observation
            .get("complete")
            .and_then(Value::as_bool)
            .ok_or_else(invalid)?;
        let decoded = number(observation, "response_decoded_bytes")?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (actual_effect,index,request,reserved,old,headers):(String,u64,u64,u64,Option<String>,Option<String>) = tx.query_row("SELECT effect_operation_id,hop_index,request_bytes,reserved_bytes,observation,headers FROM http_dispatches WHERE id=?1",[receipt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
        if actual_effect != effect
            || observation.pointer("/permit/id").and_then(Value::as_str) != Some(receipt)
            || number(observation, "index")? != index
            || number(observation, "request_body_bytes")? != request
            || decoded > reserved
        {
            return Err(conflict());
        }
        crate::campaign::settle_http(&tx, session, receipt, complete, decoded)?;
        if let Some(old) = old {
            if old != text {
                return Err(conflict());
            }
            let op = crate::operations::operation(&tx, effect)?;
            if op.session_id != session || op.owner.as_deref() != Some(owner) {
                return Err(conflict());
            }
            return Ok(());
        }
        owned(&tx, session, effect, owner)?;
        if complete {
            let headers: Value = serde_json::from_str(&headers.ok_or_else(invalid)?)?;
            if headers.get("status") != observation.get("status")
                || !observation.get("error").is_some_and(Value::is_null)
            {
                return Err(invalid());
            }
        }
        let charged = if complete { decoded } else { reserved };
        tx.execute(
            "UPDATE http_dispatches SET charged_bytes=?2,observation=?3 WHERE id=?1",
            params![receipt, integer(charged)?, text],
        )?;
        append(
            &tx,
            session,
            "http_hop_settled",
            &json!({"receipt":receipt,"effect_operation_id":effect,"charged_response_decoded_bytes":charged,"observation":observation}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn read_http_dispatches(&self, session: &str, effect: &str) -> Result<Vec<Value>> {
        let tx = self.conn.unchecked_transaction()?;
        let result = read_dispatches(&tx, session, effect)?;
        tx.commit()?;
        Ok(result)
    }
}
fn read_dispatches(conn: &Connection, session: &str, effect: &str) -> Result<Vec<Value>> {
    read_dispatches_inner(conn, session, effect, true)
}
fn read_dispatches_inner(
    conn: &Connection,
    session: &str,
    effect: &str,
    validate_account: bool,
) -> Result<Vec<Value>> {
    let op = crate::operations::operation(conn, effect)?;
    if op.session_id != session {
        return Err(conflict());
    }
    let account = op.payload["http_context"]["account_id"]
        .as_str()
        .ok_or_else(invalid)?;
    if validate_account {
        check_account(conn, session, account)?;
    }
    let mut stmt = conn.prepare("SELECT id,account_id,hop_index,intent,request_bytes,reserved_bytes,charged_bytes,headers,observation FROM http_dispatches WHERE effect_operation_id=?1 ORDER BY hop_index LIMIT 7")?;
    let rows = stmt.query_map([effect], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, u64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, u64>(4)?,
            r.get::<_, u64>(5)?,
            r.get::<_, Option<u64>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, Option<String>>(8)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, account, index, intent, request, reserved, charged, headers, observation) = row?;
        if index != out.len() as u64
            || out.len() >= 6
            || intent.len() > 65536
            || headers.as_ref().is_some_and(|v| v.len() > 1024)
            || observation.as_ref().is_some_and(|v| v.len() > 65536)
        {
            return Err(invalid());
        }
        let intent: Value = serde_json::from_str(&intent)?;
        let headers: Option<Value> = headers.map(|v| serde_json::from_str(&v)).transpose()?;
        let observation: Option<Value> =
            observation.map(|v| serde_json::from_str(&v)).transpose()?;
        if number(&intent, "index")? != index
            || number(&intent, "request_body_bytes")? != request
            || number(&intent, "response_decoded_limit")? != reserved
            || op.payload["http_context"]["account_id"] != account
        {
            return Err(invalid());
        }
        witness(
            conn,
            session,
            &id,
            "http_dispatch_admitted",
            Some(
                json!({"receipt":id,"effect_operation_id":effect,"account_id":account,"intent":intent}),
            ),
        )?;
        let header_event = if let Some(headers) = &headers {
            let status = number(headers, "status")?;
            let at = number(headers, "observed_at_ms")?;
            if !(100..=599).contains(&status) {
                return Err(invalid());
            }
            let until = if status == 429 {
                cooldown(at, headers["retry_after_until_ms"].as_u64())?
            } else {
                0
            };
            Some(
                json!({"receipt":id,"effect_operation_id":effect,"headers":headers,"cooldown_until_ms":until}),
            )
        } else {
            None
        };
        witness(conn, session, &id, "http_headers_observed", header_event)?;
        let settlement = if let Some(observation) = &observation {
            let complete = observation["complete"].as_bool().ok_or_else(invalid)?;
            let decoded = number(observation, "response_decoded_bytes")?;
            if number(observation, "index")? != index
                || observation["permit"]["id"] != id
                || number(observation, "request_body_bytes")? != request
                || decoded > reserved
                || charged != Some(if complete { decoded } else { reserved })
                || (complete
                    && (headers.as_ref().and_then(|h| h.get("status"))
                        != observation.get("status")
                        || !observation.get("error").is_some_and(Value::is_null)))
            {
                return Err(invalid());
            }
            Some(
                json!({"receipt":id,"effect_operation_id":effect,"charged_response_decoded_bytes":charged,"observation":observation}),
            )
        } else {
            if charged.is_some() {
                return Err(invalid());
            }
            None
        };
        witness(conn, session, &id, "http_hop_settled", settlement)?;
        out.push(json!({"id":id,"account_id":account,"effect_operation_id":effect,"hop_index":index,"intent":intent,"request_body_bytes":request,"reserved_response_decoded_bytes":reserved,"charged_response_decoded_bytes":charged,"headers":headers,"observation":observation}));
    }
    Ok(out)
}

/// Check a bounded unique immutable event before treating mutable projection
/// rows as evidence. A missing or duplicate journal witness is not a receipt.
fn witness(
    conn: &Connection,
    session: &str,
    receipt: &str,
    kind: &str,
    expected: Option<Value>,
) -> Result<()> {
    let mut stmt=conn.prepare("SELECT CASE WHEN length(CAST(payload AS BLOB))<=131072 THEN payload ELSE NULL END FROM events WHERE session_id=?1 AND kind IN ('http_dispatch_admitted','http_headers_observed','http_hop_settled') AND kind=?2 AND json_extract(payload,'$.receipt')=?3 LIMIT 2")?;
    let values = stmt
        .query_map(params![session, kind, receipt], |r| {
            r.get::<_, Option<String>>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    match expected {
        None if values.is_empty() => Ok(()),
        Some(expected) if values.len() == 1 => {
            let observed: Value = serde_json::from_str(values[0].as_deref().ok_or_else(invalid)?)?;
            if observed == expected {
                Ok(())
            } else {
                Err(invalid())
            }
        }
        _ => Err(invalid()),
    }
}

/// Admission uses projections only after they agree with the journal. This
/// checks the entire shared account, so damage to a sibling cannot free quota.
fn check_account(conn: &Connection, session: &str, account: &str) -> Result<()> {
    let invalid_rows:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM http_dispatches d WHERE d.account_id=?2 AND (
        d.host IS NOT json_extract(d.intent,'$.host') OR
        d.request_bytes IS NOT json_extract(d.intent,'$.request_body_bytes') OR
        d.reserved_bytes IS NOT json_extract(d.intent,'$.response_decoded_limit') OR
        d.hop_index IS NOT json_extract(d.intent,'$.index') OR
        (SELECT COUNT(*) FROM events e WHERE e.session_id=?1 AND e.kind IN ('http_dispatch_admitted','http_headers_observed','http_hop_settled') AND e.kind='http_dispatch_admitted' AND json_extract(e.payload,'$.receipt')=d.id AND json_extract(e.payload,'$.account_id')=d.account_id AND json_extract(e.payload,'$.effect_operation_id')=d.effect_operation_id AND json_extract(e.payload,'$.intent')=d.intent)!=1 OR
        (d.observation IS NULL AND (d.charged_bytes IS NOT NULL OR EXISTS(SELECT 1 FROM events e WHERE e.session_id=?1 AND e.kind IN ('http_dispatch_admitted','http_headers_observed','http_hop_settled') AND e.kind='http_hop_settled' AND json_extract(e.payload,'$.receipt')=d.id))) OR
        (d.observation IS NOT NULL AND (d.charged_bytes IS NOT CASE WHEN json_extract(d.observation,'$.complete')=1 THEN json_extract(d.observation,'$.response_decoded_bytes') ELSE d.reserved_bytes END OR
            (SELECT COUNT(*) FROM events e WHERE e.session_id=?1 AND e.kind IN ('http_dispatch_admitted','http_headers_observed','http_hop_settled') AND e.kind='http_hop_settled' AND json_extract(e.payload,'$.receipt')=d.id AND json_extract(e.payload,'$.effect_operation_id')=d.effect_operation_id AND json_extract(e.payload,'$.charged_response_decoded_bytes')=d.charged_bytes AND json_extract(e.payload,'$.observation')=d.observation)!=1))
        )) OR EXISTS(SELECT 1 FROM events e WHERE e.session_id=?1 AND e.kind IN ('http_dispatch_admitted','http_headers_observed','http_hop_settled') AND e.kind='http_dispatch_admitted' AND json_extract(e.payload,'$.account_id')=?2 AND NOT EXISTS(SELECT 1 FROM http_dispatches d WHERE d.account_id=?2 AND d.id=json_extract(e.payload,'$.receipt') AND d.effect_operation_id=json_extract(e.payload,'$.effect_operation_id') AND d.hop_index=json_extract(e.payload,'$.intent.index')))",params![session,account],|r|r.get(0))?;
    if invalid_rows { Err(invalid()) } else { Ok(()) }
}
fn rate_state(
    conn: &Connection,
    session: &str,
    account: &str,
    host: &str,
) -> Result<Option<(u64, u64, u64)>> {
    let row: Option<(u64, u64, u64)> = conn
        .query_row(
            "SELECT tokens,last_ms,cooldown_ms FROM http_rates WHERE account_id=?1 AND host=?2",
            params![account, host],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let witness:Option<Option<String>>=conn.query_row("SELECT CASE WHEN length(CAST(payload AS BLOB))<=4096 THEN payload ELSE NULL END FROM events WHERE session_id=?1 AND kind='http_rate_updated' AND json_extract(payload,'$.account_id')=?2 AND json_extract(payload,'$.host')=?3 ORDER BY sequence DESC LIMIT 1",params![session,account,host],|r|r.get(0)).optional()?;
    match (row, witness) {
        (None, None) => Ok(None),
        (Some((tokens, last_ms, cooldown_ms)), Some(Some(text))) => {
            let observed: Value = serde_json::from_str(&text)?;
            if observed
                != json!({"account_id":account,"host":host,"tokens":tokens,"last_ms":last_ms,"cooldown_ms":cooldown_ms})
            {
                return Err(invalid());
            }
            Ok(row)
        }
        _ => Err(invalid()),
    }
}
fn record_rate(
    tx: &rusqlite::Transaction<'_>,
    session: &str,
    account: &str,
    host: &str,
) -> Result<()> {
    let (tokens, last_ms, cooldown_ms): (u64, u64, u64) = tx.query_row(
        "SELECT tokens,last_ms,cooldown_ms FROM http_rates WHERE account_id=?1 AND host=?2",
        params![account, host],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    append(
        tx,
        session,
        "http_rate_updated",
        &json!({"account_id":account,"host":host,"tokens":tokens,"last_ms":last_ms,"cooldown_ms":cooldown_ms}),
    )
}

#[cfg(test)]
mod tests;

/// Complete immutable account ledger, including uncertain response holds.
pub(crate) fn account_usage(
    conn: &Connection,
    session: &str,
    account: &str,
    budget: &mut usize,
) -> Result<zero_protocol::scan::ScanHttpUsage> {
    let (count,bytes,max_intent,max_headers,max_observation):(u64,u64,u64,u64,u64)=conn.query_row("SELECT count(*),coalesce(sum(length(CAST(intent AS BLOB))+coalesce(length(CAST(headers AS BLOB)),0)+coalesce(length(CAST(observation AS BLOB)),0)),0),coalesce(max(length(CAST(intent AS BLOB))),0),coalesce(max(length(CAST(headers AS BLOB))),0),coalesce(max(length(CAST(observation AS BLOB))),0) FROM http_dispatches WHERE account_id=?1",[account],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    let (event_bytes,max_event):(u64,u64)=conn.query_row("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0),coalesce(max(length(CAST(payload AS BLOB))),0) FROM events WHERE session_id=?1 AND kind IN ('http_dispatch_admitted','http_headers_observed','http_hop_settled')",[session],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let (operation_bytes,max_operation):(u64,u64)=conn.query_row("SELECT coalesce(sum(length(CAST(payload AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0)),0),coalesce(max(length(CAST(payload AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0)),0) FROM operations WHERE id IN (SELECT effect_operation_id FROM http_dispatches WHERE account_id=?1)",[account],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let bad_scalars:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM http_dispatches WHERE account_id=?1 AND (length(CAST(id AS BLOB))>256 OR length(CAST(effect_operation_id AS BLOB))>256 OR length(CAST(host AS BLOB))>253)) OR EXISTS(SELECT 1 FROM operations WHERE id IN(SELECT effect_operation_id FROM http_dispatches WHERE account_id=?1) AND (length(CAST(session_id AS BLOB))>256 OR length(CAST(command_id AS BLOB))>4096 OR length(CAST(status AS BLOB))>16 OR length(CAST(owner AS BLOB))>4096))",[account],|r|r.get(0))?;
    if bad_scalars {
        return Err(invalid());
    }
    let expected: (u64, u64) = conn.query_row(
        "SELECT count(headers),count(observation) FROM http_dispatches WHERE account_id=?1",
        [account],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let actual:(u64,u64,u64)=conn.query_row("SELECT coalesce(sum(kind='http_dispatch_admitted'),0),coalesce(sum(kind='http_headers_observed'),0),coalesce(sum(kind='http_hop_settled'),0) FROM events WHERE session_id=?1 AND kind IN ('http_dispatch_admitted','http_headers_observed','http_hop_settled')",[session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if actual != (count, expected.0, expected.1) {
        return Err(invalid());
    }
    let charge = bytes
        .checked_add(event_bytes)
        .and_then(|n| n.checked_add(operation_bytes))
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(invalid)?;
    if count > 100000
        || max_intent > 65536
        || max_headers > 1024
        || max_observation > 65536
        || max_event > 131072
        || max_operation > 32 * 1024 * 1024
        || charge > *budget
    {
        return Err(invalid());
    }
    *budget -= charge;
    check_account(conn, session, account)?;
    let mut stmt=conn.prepare("SELECT DISTINCT CASE WHEN length(CAST(effect_operation_id AS BLOB))<=256 THEN effect_operation_id END FROM http_dispatches WHERE account_id=?1 ORDER BY effect_operation_id")?;
    let effects = stmt
        .query_map([account], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut usage = zero_protocol::scan::ScanHttpUsage {
        requests: 0,
        request_body_bytes: 0,
        response_charged_bytes: 0,
        response_reserved_bytes: 0,
    };
    for effect in effects {
        for row in read_dispatches_inner(conn, session, &effect, false)? {
            if row["account_id"] != account {
                return Err(invalid());
            }
            usage.requests = usage.requests.checked_add(1).ok_or_else(invalid)?;
            usage.request_body_bytes = usage
                .request_body_bytes
                .checked_add(number(&row, "request_body_bytes")?)
                .ok_or_else(invalid)?;
            if row["observation"]["complete"] == true {
                usage.response_charged_bytes = usage
                    .response_charged_bytes
                    .checked_add(number(&row, "charged_response_decoded_bytes")?)
                    .ok_or_else(invalid)?;
            } else {
                usage.response_reserved_bytes = usage
                    .response_reserved_bytes
                    .checked_add(number(&row, "reserved_response_decoded_bytes")?)
                    .ok_or_else(invalid)?;
            }
        }
    }
    if usage.requests != count {
        return Err(invalid());
    }
    Ok(usage)
}
