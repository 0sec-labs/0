//! Immutable advisory session capture and effect admission fences.
use crate::{Error, Operation, OperationStatus, Result, Store, append, integer};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zero_protocol::{
    agent::AgentRequest,
    session::Session,
    strategy_registry::{StrategySessionCapture, render_strategy_request},
};
fn bad(s: impl std::fmt::Display) -> Error {
    Error::Conflict(format!("strategy session: {s}"))
}
fn hash(v: &Value) -> Result<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(v)?)
    ))
}
fn validate(c: &StrategySessionCapture) -> Result<()> {
    c.authority.validate().map_err(bad)?;
    c.advisory.validate().map_err(bad)?;
    if c.registry.schema_version != 1
        || c.registry.registry_id.is_empty()
        || c.registry.registry_id.len() > 256
        || c.epoch == 0
        || [
            &c.registry.genesis_sha256,
            &c.generation,
            &c.state_sha256,
            &c.advisory_sha256,
            &c.host_policy_sha256,
        ]
        .iter()
        .any(|v| !zero_protocol::is_sha256(v))
        || hash(&serde_json::to_value(&c.advisory)?)? != c.advisory_sha256
        || serde_json::to_vec(c)?.len() > 524288
    {
        return Err(bad("invalid immutable capture"));
    }
    Ok(())
}
fn context(c: &StrategySessionCapture) -> Result<Value> {
    Ok(
        json!({"capture_sha256":hash(&serde_json::to_value(c)?)?,"registry":c.registry,"generation":c.generation,"epoch":c.epoch,"advisory_sha256":c.advisory_sha256,"host_policy_sha256":c.host_policy_sha256}),
    )
}
fn load(conn: &Connection, session: &str) -> Result<Option<StrategySessionCapture>> {
    let row:Option<(String,u64)>=conn.query_row("SELECT CASE WHEN length(CAST(capture AS BLOB))<=524288 THEN capture END,sequence FROM strategy_sessions WHERE session_id=?1",[session],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='strategy_session_bound'",
        [session],
        |r| r.get(0),
    )?;
    let Some((raw, sequence)) = row else {
        if count != 0 {
            return Err(bad("capture projection missing"));
        }
        return Ok(None);
    };
    let c: StrategySessionCapture = serde_json::from_str(&raw)?;
    validate(&c)?;
    let s = crate::get_session(conn, session)?;
    let event:Value=serde_json::from_str(&conn.query_row("SELECT CASE WHEN length(CAST(payload AS BLOB))<=525312 THEN payload END FROM events WHERE session_id=?1 AND sequence=?2 AND kind='strategy_session_bound'",params![session,integer(sequence)?],|r|r.get::<_,String>(0))?)?;
    if count != 1
        || s.generation != c.generation
        || s.generation_epoch != Some(c.epoch)
        || s.budget_limit > c.authority.campaign_limits.model_micro_usd
        || event
            != json!({"session_id":session,"capture":c,"capture_sha256":hash(&serde_json::to_value(&c)?)?})
    {
        return Err(bad("capture witness differs"));
    }
    Ok(Some(c))
}
impl Store {
    pub fn create_strategy_session(
        &mut self,
        capture: &StrategySessionCapture,
        budget_limit: u64,
    ) -> Result<Session> {
        validate(capture)?;
        if budget_limit > capture.authority.campaign_limits.model_micro_usd {
            return Err(bad("session budget exceeds host authority"));
        }
        let s = Session {
            id: uuid::Uuid::new_v4().to_string(),
            generation: capture.generation.clone(),
            generation_epoch: Some(capture.epoch),
            created_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(bad)?
                .as_millis()
                .try_into()
                .map_err(bad)?,
            budget_limit,
        };
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO sessions(id,generation,created_at_ms,budget_limit,generation_epoch) VALUES(?1,?2,?3,?4,?5)",params![s.id,s.generation,integer(s.created_at_ms)?,integer(budget_limit)?,integer(capture.epoch)?])?;
        append(&tx, &s.id, "session_created", &serde_json::to_value(&s)?)?;
        let sequence = 2u64;
        tx.execute(
            "INSERT INTO strategy_sessions(session_id,capture,sequence) VALUES(?1,?2,?3)",
            params![
                s.id,
                serde_json::to_string(&serde_json::to_value(capture)?)?,
                sequence
            ],
        )?;
        append(
            &tx,
            &s.id,
            "strategy_session_bound",
            &json!({"session_id":s.id,"capture":capture,"capture_sha256":hash(&serde_json::to_value(capture)?)?}),
        )?;
        tx.commit()?;
        Ok(s)
    }
    pub fn strategy_session(&self, session: &str) -> Result<Option<StrategySessionCapture>> {
        self.get_session(session)?;
        load(&self.conn, session)
    }
    pub fn strategy_session_context(&self, session: &str) -> Result<Option<Value>> {
        self.strategy_session(session)?
            .as_ref()
            .map(context)
            .transpose()
    }
}
fn op(conn: &Connection, id: &str) -> Result<Operation> {
    let n:usize=conn.query_row("SELECT length(CAST(payload AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0) FROM operations WHERE id=?1",[id],|r|r.get(0))?;
    if n > 32 * 1024 * 1024 {
        return Err(bad("parent read exceeds bound"));
    }
    crate::operations::operation(conn, id)
}
fn provider(payload: &Value, r: &AgentRequest, c: &StrategySessionCapture) -> Result<()> {
    let p = c
        .authority
        .provider_context
        .get(&r.provider)
        .ok_or_else(|| bad("provider outside capture"))?;
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
        return Err(bad("provider identity drift"));
    }
    Ok(())
}
fn http(payload: &Value, c: &StrategySessionCapture) -> Result<()> {
    if payload["http_context"]["profile"] != serde_json::to_value(&c.authority.http_policy)? {
        return Err(bad("HTTP authority differs"));
    }
    Ok(())
}
fn root_request(c: &StrategySessionCapture, payload: &Value) -> Result<AgentRequest> {
    let actual = zero_protocol::agent::validate_actor_payload(payload).map_err(bad)?;
    let expected = render_strategy_request(
        &c.authority.host,
        &c.advisory,
        &actual.prompt,
        &c.authority.http_profile_name,
        actual.continuation_of.clone(),
    )
    .map_err(bad)?;
    if serde_json::to_value(&actual)? != serde_json::to_value(&expected)?
        || payload["strategy_context"] != context(c)?
    {
        return Err(bad("root request bypasses captured advisory or authority"));
    }
    provider(payload, &actual, c)?;
    http(payload, c)?;
    Ok(actual)
}
pub(crate) fn forbid_queue(conn: &Connection, session: &str) -> Result<()> {
    if load(conn, session)?.is_some() {
        Err(bad(
            "use explicit RunStrategyAgent; queued arbitrary requests are unsupported",
        ))
    } else {
        Ok(())
    }
}
pub(crate) fn authorize(
    conn: &Connection,
    session: &str,
    command: &str,
    payload: &Value,
) -> Result<()> {
    let Some(c) = load(conn, session)? else {
        return Ok(());
    };
    let Some(parentid) = payload.get("parent_operation") else {
        root_request(&c, payload)?;
        return Ok(());
    };
    let parent = op(conn, parentid.as_str().ok_or_else(|| bad("parent absent"))?)?;
    if parent.session_id != session || parent.status != OperationStatus::Running {
        return Err(bad("effect requires running session parent"));
    }
    let actor = if parent.payload["kind"] == "agent_web_experiment" {
        op(
            conn,
            parent.payload["parent_operation"]
                .as_str()
                .ok_or_else(|| bad("experiment actor absent"))?,
        )?
    } else {
        parent.clone()
    };
    let root = if let Some(id) = actor.payload.get("parent_operation") {
        op(conn, id.as_str().ok_or_else(|| bad("actor parent absent"))?)?
    } else {
        actor.clone()
    };
    if actor.session_id != session
        || root.session_id != session
        || root.payload.get("parent_operation").is_some()
        || actor.payload["strategy_context"] != context(&c)?
        || parent.owner != root.owner
        || actor.owner != root.owner
    {
        return Err(bad("effect outside captured actor lineage"));
    }
    let request = root_request(&c, &root.payload)?;
    match payload["kind"].as_str().unwrap_or("") {
        "scoped_web_agent" => {
            if parent.id != root.id {
                return Err(bad("recursive delegate"));
            }
            let child = zero_protocol::agent::validate_actor_payload(payload).map_err(bad)?;
            let role = request
                .delegation_policy
                .as_ref()
                .and_then(|p| {
                    p.roles
                        .iter()
                        .find(|r| payload["delegation_role"] == r.name)
                })
                .ok_or_else(|| bad("unknown delegated role"))?;
            crate::campaign::delegation::child_request(
                conn,
                session,
                root.owner.as_deref().ok_or_else(|| bad("owner absent"))?,
                &request,
                &parent,
                command,
                payload,
                role,
            )?;
            if payload["strategy_context"] != context(&c)? {
                return Err(bad("child strategy capture differs"));
            }
            provider(payload, &child, &c)?;
            http(payload, &c)?;
        }
        "agent_delegation" => {
            if parent.id != root.id {
                return Err(bad("recursive group"));
            }
            crate::campaign::delegation::group_request(
                conn, session, &request, &parent, command, payload,
            )?;
        }
        "agent_inference" => {
            let ar = zero_protocol::agent::validate_actor_payload(&parent.payload).map_err(bad)?;
            provider(payload, &ar, &c)?;
            if payload["request"]["instructions"] != ar.instructions
                || payload["request"]["model"] != ar.model
            {
                return Err(bad("inference authority differs"));
            }
        }
        "agent_http" | "agent_web_experiment" => {
            http(payload, &c)?;
            if payload["http_context"] != actor.payload["http_context"] {
                return Err(bad("effect HTTP account differs"));
            }
        }
        _ => return Err(bad("effect is not supported by captured strategy adapter")),
    }
    Ok(())
}
