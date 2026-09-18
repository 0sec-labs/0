//! Independent host-plan authority checks used before every fresh HTTP permit.
use crate::{Error, Operation, OperationStatus, Result, Store};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use zero_protocol::{agent::validate_actor_payload, web::WebVerificationRequest};
use zero_web_verification::FrozenPlan;
fn invalid() -> Error {
    Error::Conflict("frozen web verification authority mismatch".into())
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(invalid)
}
fn operation(conn: &Connection, id: &str) -> Result<Operation> {
    if id.is_empty() || id.len() > 4096 {
        return Err(invalid());
    }
    let bounded:bool=conn.query_row("SELECT length(CAST(payload AS BLOB))<=16777216 AND coalesce(length(CAST(outcome AS BLOB)),0)<=16777216 FROM operations WHERE id=?1",[id],|r|r.get(0)).optional()?.ok_or_else(invalid)?;
    if !bounded {
        return Err(invalid());
    }
    crate::operations::operation(conn, id)
}
fn admission(conn: &Connection, op: &Operation) -> Result<()> {
    let mut stmt=conn.prepare("SELECT CASE WHEN length(CAST(payload AS BLOB))<=16777216 THEN payload END FROM events WHERE session_id=?1 AND kind='command_admitted' AND json_extract(payload,'$.id')=?2 LIMIT 2")?;
    let values = stmt
        .query_map(params![op.session_id, op.id], |r| {
            r.get::<_, Option<String>>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if values.len() != 1 {
        return Err(invalid());
    }
    let original: Operation = serde_json::from_str(values[0].as_deref().ok_or_else(invalid)?)?;
    if original.id != op.id
        || original.session_id != op.session_id
        || original.command_id != op.command_id
        || original.payload != op.payload
        || original.status != OperationStatus::Admitted
        || original.owner.is_some()
        || original.outcome.is_some()
    {
        return Err(invalid());
    }
    Ok(())
}
pub(super) fn parent(conn: &Connection, op: &Operation) -> Result<FrozenPlan> {
    admission(conn, op)?;
    if op.payload["kind"] != "host_web_verification"
        || op.payload["http_output_version"] != 2
        || op.payload.get("parent_operation").is_some()
    {
        return Err(invalid());
    }
    let frozen = FrozenPlan::from_intent(op.payload.get("execution_intent").ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let request: WebVerificationRequest = serde_json::from_value(op.payload["request"].clone())?;
    if frozen.intent()["session_id"] != op.session_id
        || frozen.intent()["http_context"] != op.payload["http_context"]
        || frozen.intent_sha256() != request.expected_intent_sha256
        || op.payload["intent_sha256"] != frozen.intent_sha256()
        || op.payload["plan_sha256"] != frozen.plan_sha256()
        || (frozen.approval_required()
            && request.approved_intent_sha256.as_deref() != Some(frozen.intent_sha256()))
        || request
            .approved_intent_sha256
            .as_deref()
            .is_some_and(|s| s != frozen.intent_sha256())
    {
        return Err(invalid());
    }
    let review = operation(conn, &frozen.plan().web_operation_id)?;
    admission(conn, &review)?;
    let actor = validate_actor_payload(&review.payload).map_err(|_| invalid())?;
    if review.session_id != op.session_id
        || review.status != OperationStatus::Succeeded
        || actor.web_submission_max_hypotheses.is_none()
        || review.payload.get("parent_operation").is_some()
        || review.payload["http_context"] != op.payload["http_context"]
        || serde_json::to_value(&actor.tool_approval_policy)?
            != frozen.intent()["inherited_tool_approval_policy"]
    {
        return Err(invalid());
    }
    let normalized = FrozenPlan::new(
        &op.session_id,
        request.plan,
        review.payload["http_context"].clone(),
        actor.tool_approval_policy,
    )
    .map_err(|_| invalid())?;
    if normalized.intent() != frozen.intent() {
        return Err(invalid());
    }
    // Store validates the retained review identity; engine independently validates
    // provider/citation provenance during preparation and report inspection.
    let record = crate::web_triage::validated_finding(
        conn,
        &op.session_id,
        &review.id,
        &frozen.plan().hypothesis_id,
    )?;
    if record.web_review_sha256 != frozen.plan().web_review_sha256 {
        return Err(invalid());
    }
    let context = &op.payload["http_context"];
    let root_id: String = conn
        .query_row(
            "SELECT id FROM operations WHERE session_id=?1 AND command_id=?2",
            params![op.session_id, text(context, "original_root_command")?],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(invalid)?;
    let root = operation(conn, &root_id)?;
    admission(conn, &root)?;
    validate_actor_payload(&root.payload).map_err(|_| invalid())?;
    if root.payload.get("parent_operation").is_some() || root.payload["http_context"] != *context {
        return Err(invalid());
    }
    Ok(frozen)
}
pub(super) fn effect(conn: &Connection, op: &Operation) -> Result<()> {
    if op.payload["origin"]["kind"] == "frozen_agent_experiment" {
        return crate::web_experiment::effect(conn, op);
    }
    let parent_id = text(&op.payload, "parent_operation")?;
    let verification = operation(conn, parent_id)?;
    if verification.payload["kind"] != "host_web_verification" && op.payload.get("origin").is_none()
    {
        return Ok(());
    }
    let frozen = parent(conn, &verification)?;
    admission(conn, op)?;
    let origin = &op.payload["origin"];
    let case = origin["case_index"]
        .as_u64()
        .and_then(|v| usize::try_from(v).ok())
        .ok_or_else(invalid)?;
    let repeat = origin["repeat_index"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(invalid)?;
    let request = frozen.request(case, repeat).map_err(|_| invalid())?;
    let case_name = &frozen.plan().cases.get(case).ok_or_else(invalid)?.name;
    let expected = json!({"kind":"frozen_web_plan","plan_sha256":frozen.plan_sha256(),"case_index":case,"case_name":case_name,"repeat_index":repeat});
    if origin != &expected
        || op.session_id != verification.session_id
        || op.payload["kind"] != "agent_http"
        || op.payload["http_output_version"] != 2
        || op.payload.get("call_id").is_some()
        || op.payload.get("approval_operation").is_some()
        || op.payload["http_context"] != verification.payload["http_context"]
        || op.payload["request"] != serde_json::to_value(request)?
        || op.command_id != format!("{}:web:case:{case}:{repeat}", verification.id)
    {
        return Err(invalid());
    }
    Ok(())
}
impl Store {
    pub fn validate_web_verification_parent(&self, operation: &Operation) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let current = self::operation(&tx, &operation.id)?;
        if current.session_id != operation.session_id
            || current.command_id != operation.command_id
            || current.payload != operation.payload
        {
            return Err(invalid());
        }
        Ok(parent(&tx, &current)?.intent().clone())
    }
}

impl Store {
    /// Establish an interrupted operation from its admission, ownership and
    /// immutable Unknown witness without interpreting an arbitrary reason as proof.
    pub fn validate_unknown_operation(&self, supplied: &Operation) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let current = operation(&tx, &supplied.id)?;
        if current.status != OperationStatus::Unknown
            || serde_json::to_value(&current)? != serde_json::to_value(supplied)?
        {
            return Err(invalid());
        }
        admission(&tx, &current)?;
        let lookup = |kind: &str| -> Result<Value> {
            let mut stmt=tx.prepare("SELECT CASE WHEN length(CAST(payload AS BLOB))<=16777216 THEN payload END FROM events WHERE session_id=?1 AND kind=?2 AND coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id'))=?3 LIMIT 2")?;
            let rows = stmt
                .query_map(params![current.session_id, kind, current.id], |r| {
                    r.get::<_, Option<String>>(0)
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            if rows.len() != 1 {
                return Err(invalid());
            }
            Ok(serde_json::from_str(
                rows[0].as_deref().ok_or_else(invalid)?,
            )?)
        };
        let started: Operation = serde_json::from_value(lookup("operation_started")?)?;
        if started.id != current.id
            || started.session_id != current.session_id
            || started.command_id != current.command_id
            || started.payload != current.payload
            || started.owner != current.owner
            || started.owner.is_none()
            || started.status != OperationStatus::Running
            || started.outcome.is_some()
        {
            return Err(invalid());
        }
        let witness = lookup("operation_unknown")?;
        if witness.get("id").is_some() {
            if witness != serde_json::to_value(&current)? {
                return Err(invalid());
            }
        } else {
            let expected = json!({"operation_id":current.id,"owner":current.owner});
            let epoch = json!({"operation_id":current.id,"owner":current.owner,"reason":"previous engine epoch ended"});
            if current.outcome.is_some() || (witness != expected && witness != epoch) {
                return Err(invalid());
            }
        }
        let settled:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='operation_settled' AND json_extract(payload,'$.id')=?2)",params![current.session_id,current.id],|r|r.get(0))?;
        if settled {
            return Err(invalid());
        }
        Ok(())
    }
}
