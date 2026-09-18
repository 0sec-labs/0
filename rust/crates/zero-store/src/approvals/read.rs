use super::*;
pub(super) struct Checked {
    pub record: Record,
    pub intent: Rc<Value>,
    pub operation: Rc<Operation>,
}
fn receipt(
    conn: &Connection,
    session: &str,
    key: &str,
    cache: &mut Cache,
) -> Result<Option<Receipt>> {
    cache.reads.witnesses.reserve(32 * 1024)?;
    let row=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=4096 THEN id END,CASE WHEN length(CAST(session_id AS BLOB))<=4096 THEN session_id END,CASE WHEN length(CAST(command_id AS BLOB))<=4096 THEN command_id END,CASE WHEN length(intent_sha256)<=71 THEN intent_sha256 END,CASE WHEN length(decision)<=7 THEN decision END,sequence FROM tool_approval_decisions WHERE approval_operation_id=?1",[key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,u64>(5)?))).optional()?;
    let Some(row) = row else { return Ok(None) };
    let result = Receipt {
        id: row.0,
        session_id: row.1,
        command_id: row.2,
        approval_operation_id: key.into(),
        intent_sha256: row.3,
        decision: serde_json::from_value(json!(row.4))?,
        sequence: row.5,
    };
    let (kind, event) = cache
        .reads
        .witnesses
        .event(conn, session, result.sequence, 128 * 1024)?;
    if result.session_id != session
        || kind != "tool_approval_decided"
        || *event != serde_json::to_value(&result)?
    {
        return Err(bad("approval decision differs from immutable witness"));
    }
    Ok(Some(result))
}
pub(super) fn checked(
    conn: &Connection,
    session: &str,
    key: &str,
    cache: &mut Cache,
) -> Result<Checked> {
    id(session)?;
    id(key)?;
    cache.reads.witnesses.reserve(32 * 1024)?;
    let (actor_id,root_id,sequence,digest):(String,String,u64,String)=conn.query_row("SELECT CASE WHEN length(CAST(actor_operation_id AS BLOB))<=4096 THEN actor_operation_id END,CASE WHEN length(CAST(root_operation_id AS BLOB))<=4096 THEN root_operation_id END,sequence,CASE WHEN length(intent_sha256)<=71 THEN intent_sha256 END FROM tool_approvals WHERE operation_id=?1 AND session_id=?2",params![key,session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    let op = cache.reads.operation(conn, key)?;
    if op.session_id != session
        || op.payload["kind"] != "agent_approved_tool"
        || op.payload["parent_operation"] != actor_id
        || op.payload["root_operation"] != root_id
        || op.payload["intent_sha256"] != digest
    {
        return Err(bad("approval index differs from operation"));
    }
    check_admission(conn, &op, sequence, cache)?;
    let attachment:String=conn.query_row("SELECT CASE WHEN length(digest)<=71 THEN digest END FROM operation_artifacts WHERE operation_id=?1 AND name='approval.intent'",[key],|r|r.get(0))?;
    if attachment != digest {
        return Err(bad("approval intent attachment changed"));
    }
    let intent = cache.artifact(conn, &digest)?;
    let actor = cache.reads.operation(conn, &actor_id)?;
    let root = cache.reads.operation(conn, &root_id)?;
    if actor.session_id != session
        || root.session_id != session
        || zero_protocol::agent::validate_actor_payload(&actor.payload).is_err()
        || zero_protocol::agent::validate_actor_payload(&root.payload).is_err()
        || root.payload.get("parent_operation").is_some()
        || actor.payload["parent_operation"]
            .as_str()
            .unwrap_or(&actor.id)
            != root_id
    {
        return Err(bad("approval actor/root identity changed"));
    }
    let field = |name: &str| {
        op.payload[name]
            .as_str()
            .ok_or_else(|| bad("approval identity absent"))
    };
    let alias = field("tool_name")?;
    let expected = intent::derive(
        conn,
        &actor,
        &op.command_id,
        field("origin_inference_id")?,
        field("call_id")?,
        alias,
        &intent["effect_payload"],
        cache,
    )?;
    if *intent != expected {
        return Err(bad(
            "approval intent differs from original call and authority",
        ));
    }
    let decision = receipt(conn, session, key, cache)?;
    if decision.as_ref().is_some_and(|d| d.intent_sha256 != digest) {
        return Err(bad("approval decision intent differs"));
    }
    cache.reads.witnesses.reserve(16 * 1024)?;
    let consumed=conn.query_row("SELECT CASE WHEN length(CAST(effect_operation_id AS BLOB))<=4096 THEN effect_operation_id END,CASE WHEN length(CAST(effect_command_id AS BLOB))<=4096 THEN effect_command_id END,CASE WHEN length(effect_payload_sha256)<=71 THEN effect_payload_sha256 END,sequence FROM tool_approval_consumptions WHERE approval_operation_id=?1",[key],|r|Ok(Consumption{effect_operation_id:r.get(0)?,effect_command_id:r.get(1)?,effect_payload_sha256:r.get(2)?,sequence:r.get(3)?})).optional()?;
    let mut effect_status = None;
    let status = if let Some(c) = &consumed {
        if decision.as_ref().map(|d| d.decision) != Some(Decision::Approve) || c.sequence <= 2 {
            return Err(bad("approval consumed without permission"));
        }
        let (kind, event) = cache
            .reads
            .witnesses
            .event(conn, session, c.sequence, 128 * 1024)?;
        if kind != "tool_approval_consumed"
            || *event != json!({"approval_operation_id":key,"intent_sha256":digest,"consumption":c})
        {
            return Err(bad("approval consume witness differs"));
        }
        let effect = cache.reads.operation(conn, &c.effect_operation_id)?;
        let mut expected = intent["effect_payload"].clone();
        expected["approval_operation"] = json!(key);
        if effect.session_id != session
            || effect.command_id != c.effect_command_id
            || intent["effect_command_id"] != c.effect_command_id
            || effect.payload != expected
            || hash(&effect.payload)? != c.effect_payload_sha256
        {
            return Err(bad("consumed effect differs from approved intent"));
        }
        check_admission(conn, &effect, c.sequence - 2, cache)?;
        effect_status = Some(effect.status);
        Status::Consumed
    } else if decision.as_ref().map(|d| d.decision) == Some(Decision::Deny) {
        if op.status != OperationStatus::Succeeded
            || op.outcome.as_ref() != Some(&terminal(key, &digest, "denied"))
        {
            return Err(bad("denied approval has inconsistent terminal outcome"));
        }
        Status::Denied
    } else if op.status == OperationStatus::Cancelled {
        if op.outcome.as_ref() != Some(&terminal(key, &digest, "cancelled")) {
            return Err(bad("approval cancellation receipt differs"));
        }
        Status::Cancelled
    } else if op.status == OperationStatus::Running
        && op.owner.is_some()
        && op.owner == actor.owner
        && actor.owner == root.owner
        && actor.status == OperationStatus::Running
        && root.status == OperationStatus::Running
    {
        if decision.is_some() {
            Status::Approved
        } else {
            Status::Pending
        }
    } else {
        if op.status == OperationStatus::Succeeded {
            return Err(bad("unconsumed approval cannot succeed"));
        }
        Status::Interrupted
    };
    let preview = serde_json::to_string(
        &json!({"tool":alias,"arguments":intent["arguments"],"effect":intent["effect_payload"]}),
    )?;
    let truncated = preview.len() > 8192;
    let mut end = preview.len().min(8192);
    while !preview.is_char_boundary(end) {
        end -= 1;
    }
    let record = Record {
        operation_id: key.into(),
        session_id: session.into(),
        actor_operation_id: actor_id,
        root_operation_id: root_id,
        sequence,
        intent_sha256: digest.clone(),
        intent_artifact: digest,
        tool_name: alias.into(),
        preview: preview[..end].into(),
        preview_truncated: truncated,
        status,
        operation_status: op.status,
        decision,
        consumption: consumed,
        effect_status,
    };
    Ok(Checked {
        record,
        intent,
        operation: op,
    })
}
impl Store {
    pub fn get_tool_approval(&self, session: &str, key: &str) -> Result<Record> {
        let tx = self.conn.unchecked_transaction()?;
        let value = checked(&tx, session, key, &mut Cache::default())?.record;
        tx.commit()?;
        Ok(value)
    }
    pub fn tool_approval_intent(&self, session: &str, key: &str) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let value = (*checked(&tx, session, key, &mut Cache::default())?.intent).clone();
        tx.commit()?;
        Ok(value)
    }
    pub fn tool_approvals(
        &self,
        session: &str,
        root: Option<&str>,
        after: u64,
        limit: u32,
    ) -> Result<Vec<Record>> {
        id(session)?;
        if let Some(root) = root {
            id(root)?;
        }
        if !(1..=100).contains(&limit) {
            return Err(Error::Invalid("approval page limit must be 1..100".into()));
        }
        let tx = self.conn.unchecked_transaction()?;
        crate::get_session(&tx, session)?;
        let keys = {
            let mut stmt=tx.prepare(if root.is_some(){"SELECT CASE WHEN length(CAST(operation_id AS BLOB))<=4096 THEN operation_id END FROM tool_approvals WHERE session_id=?1 AND sequence>?2 AND root_operation_id=?3 ORDER BY sequence LIMIT ?4"}else{"SELECT CASE WHEN length(CAST(operation_id AS BLOB))<=4096 THEN operation_id END FROM tool_approvals WHERE session_id=?1 AND sequence>?2 AND ?3 IS NULL ORDER BY sequence LIMIT ?4"})?;
            let rows = stmt.query_map(params![session, integer(after)?, root, limit], |r| {
                r.get::<_, String>(0)
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut cache = Cache::default();
        let mut out = vec![];
        let mut size = 2;
        for key in keys {
            let record = match checked(&tx, session, &key, &mut cache) {
                Err(Error::Invalid(e)) if e == READ_BUDGET && !out.is_empty() => break,
                r => r?.record,
            };
            let bytes = serde_json::to_vec(&record)?.len() + 1;
            if size + bytes > 1024 * 1024 {
                if out.is_empty() {
                    return Err(bad("approval record exceeds page bound"));
                }
                break;
            }
            size += bytes;
            out.push(record);
        }
        tx.commit()?;
        Ok(out)
    }
    pub fn tool_approval_decision_by_command(
        &self,
        session: &str,
        command: &str,
    ) -> Result<Option<Receipt>> {
        id(session)?;
        id(command)?;
        let tx = self.conn.unchecked_transaction()?;
        let key:Option<String>=tx.query_row("SELECT CASE WHEN length(CAST(approval_operation_id AS BLOB))<=4096 THEN approval_operation_id END FROM tool_approval_decisions WHERE session_id=?1 AND command_id=?2",params![session,command],|r|r.get(0)).optional()?;
        let receipt = key
            .map(|key| {
                checked(&tx, session, &key, &mut Cache::default()).map(|c| c.record.decision)
            })
            .transpose()?
            .flatten();
        tx.commit()?;
        Ok(receipt)
    }
}
