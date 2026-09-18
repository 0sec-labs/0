//! Queue intent is separate from operation admission: reads never dispatch or recover.
use crate::{Error, Result, Store, append, get_session, integer};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use zero_protocol::{
    agent::AgentRequest,
    queue::{QueuedAgent, QueuedAgentStatus as Status},
};

const REQUEST_BYTES: usize = 128 * 1024;
const RESOLVED_BYTES: usize = REQUEST_BYTES + 128;
const PAGE_BYTES: usize = 1024 * 1024;

fn encoded(request: &AgentRequest) -> Result<String> {
    Ok(serde_json::to_string(&serde_json::to_value(request)?)?)
}
// One bounded predecessor lookup, never a recursive walk of queue history.
fn validate_resolved(conn: &Connection, input: &QueuedAgent) -> Result<()> {
    let Some(resolved) = &input.resolved_request else {
        return Ok(());
    };
    let mut expected = input.request.clone();
    if let Some(predecessor) = &input.after_input {
        if expected.continuation_of.is_some() {
            return Err(Error::Conflict(
                "queue predecessor conflicts with original continuation".into(),
            ));
        }
        let parent = conn.query_row(
            "SELECT o.id,CASE WHEN length(CAST(q.resolved_request AS BLOB))<=?4 THEN q.resolved_request END,CASE WHEN length(CAST(json_extract(o.payload,'$.request') AS BLOB))<=?4 THEN json_extract(o.payload,'$.request') END FROM agent_inputs q JOIN operations o ON o.session_id=q.session_id AND o.command_id=q.run_command_id WHERE q.session_id=?1 AND q.id=?2 AND q.sequence<?3 AND q.cancelled=0 AND o.status='succeeded' AND json_extract(o.payload,'$.kind')='offline_snapshot_agent' AND json_extract(o.outcome,'$.status')='completed'",
            params![input.session_id,predecessor,integer(input.sequence)?,RESOLVED_BYTES],
            |r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?))
        ).optional()?.ok_or_else(||Error::Conflict("resolved queue predecessor is not an earlier completed agent in this session".into()))?;
        let parse = |text: Option<String>| -> Result<Value> {
            let text = text.ok_or_else(|| {
                Error::Conflict("queue predecessor request absent or oversized".into())
            })?;
            Ok(serde_json::from_str(&text)?)
        };
        let parent_request = parse(parent.1)?;
        if parent_request != parse(parent.2)? {
            return Err(Error::Conflict(
                "queue predecessor operation identity mismatch".into(),
            ));
        }
        // Require the retained request to remain an actual typed agent request.
        let _: AgentRequest = serde_json::from_value(parent_request)?;
        expected.continuation_of = Some(parent.0);
    }
    if encoded(&expected)? != encoded(resolved)? {
        return Err(Error::Conflict(
            "resolved queue request differs from original intent".into(),
        ));
    }
    Ok(())
}
fn input(conn: &Connection, session: &str, id: &str) -> Result<QueuedAgent> {
    let (mut result, cancelled) = conn.query_row(
        "SELECT id,sequence,command_id,CASE WHEN length(CAST(request AS BLOB))<=?3 THEN request END,after_input,run_command_id,CASE WHEN length(CAST(resolved_request AS BLOB))<=?4 THEN resolved_request END,cancelled,resolved_request IS NOT NULL FROM agent_inputs WHERE session_id=?1 AND id=?2",
        params![session,id,REQUEST_BYTES,RESOLVED_BYTES], |r| {
            Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,bool>(7)?,r.get::<_,bool>(8)?))
        }).optional()?.ok_or_else(||Error::NotFound(id.into())).and_then(|r| {
            let request = r.3.ok_or_else(||Error::Invalid("queued request exceeds byte limit".into()))?;
            if r.8 && r.6.is_none() { return Err(Error::Invalid("resolved request exceeds byte limit".into())); }
            Ok((QueuedAgent{id:r.0,session_id:session.into(),sequence:r.1,command_id:r.2,request:serde_json::from_str(&request)?,after_input:r.4,run_command_id:r.5,resolved_request:r.6.map(|v|serde_json::from_str(&v)).transpose()?,status:Status::Pending,operation_id:None},r.7))
        })?;
    validate_resolved(conn, &result)?;
    let operation = conn.query_row(
        "SELECT id,status,json_extract(payload,'$.kind'),CASE WHEN length(CAST(json_extract(payload,'$.request') AS BLOB))<=?3 THEN json_extract(payload,'$.request') END,json_extract(outcome,'$.status') FROM operations WHERE session_id=?1 AND command_id=?2",
        params![session,result.run_command_id,RESOLVED_BYTES],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?))).optional()?;
    if let Some((id, status, kind, request, agent_status)) = operation {
        let resolved = result.resolved_request.as_ref().ok_or_else(|| {
            Error::Conflict("queue operation exists without resolved intent".into())
        })?;
        let request: Value = serde_json::from_str(&request.ok_or_else(|| {
            Error::Invalid("queue operation request absent or oversized".into())
        })?)?;
        if cancelled
            || kind.as_deref() != Some("offline_snapshot_agent")
            || request != serde_json::to_value(resolved)?
        {
            return Err(Error::Conflict("queue operation identity mismatch".into()));
        }
        result.status = match status.as_str() {
            "admitted" | "running" => Status::Running,
            "succeeded" if agent_status.as_deref() == Some("completed") => Status::Succeeded,
            "succeeded" => {
                return Err(Error::Conflict(
                    "successful queue operation lacks completed agent outcome".into(),
                ));
            }
            "failed" => Status::Failed,
            "cancelled" => Status::Cancelled,
            "unknown" => Status::Unknown,
            _ => return Err(Error::Invalid("invalid queue operation status".into())),
        };
        result.operation_id = Some(id);
    } else if cancelled {
        result.status = Status::Cancelled;
    }
    Ok(result)
}
impl Store {
    pub fn enqueue_agent(
        &mut self,
        session: &str,
        command: &str,
        request: &AgentRequest,
        after: &Option<String>,
    ) -> Result<(QueuedAgent, bool)> {
        if command.trim().is_empty() || command.len() > 1024 {
            return Err(Error::Invalid(
                "queue command identifier must be 1..1024 bytes".into(),
            ));
        }
        let request_text = encoded(request)?;
        if request_text.len() > REQUEST_BYTES {
            return Err(Error::Invalid("queued request exceeds 128 KiB".into()));
        }
        if after.is_some() && request.continuation_of.is_some() {
            return Err(Error::Invalid(
                "after_input conflicts with continuation_of".into(),
            ));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        get_session(&tx, session)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM agent_inputs WHERE session_id=?1 AND command_id=?2",
                params![session, command],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            let old = input(&tx, session, &id)?;
            if encoded(&old.request)? != request_text || old.after_input != *after {
                return Err(Error::Conflict(command.into()));
            }
            return Ok((old, true));
        }
        if let Some(id) = after {
            input(&tx, session, id)?;
        }
        // The operation journal is authoritative, including after owner recovery.
        let active:i64=tx.query_row("SELECT count(*) FROM agent_inputs q LEFT JOIN operations o ON o.session_id=q.session_id AND o.command_id=q.run_command_id WHERE q.session_id=?1 AND q.cancelled=0 AND (o.id IS NULL OR o.status IN ('admitted','running'))",[session],|r|r.get(0))?;
        if active >= 50 {
            return Err(Error::Conflict(
                "agent queue has 50 pending or running inputs".into(),
            ));
        }
        let sequence: i64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM agent_inputs WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        let run_command = format!("queued-agent:{id}");
        tx.execute("INSERT INTO agent_inputs(id,session_id,sequence,command_id,request,after_input,run_command_id) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,session,sequence,command,request_text,after,run_command])?;
        append(
            &tx,
            session,
            "agent_input_queued",
            &json!({"input_id":id,"sequence":sequence}),
        )?;
        let result = input(&tx, session, &id)?;
        tx.commit()?;
        Ok((result, false))
    }
    pub fn queued_agent(&self, session: &str, id: &str) -> Result<QueuedAgent> {
        input(&self.conn, session, id)
    }
    pub fn queued_agents(&self, session: &str, after: u64, limit: u32) -> Result<Vec<QueuedAgent>> {
        get_session(&self.conn, session)?;
        if limit == 0 || limit > 100 {
            return Err(Error::Invalid("queue page limit must be 1..100".into()));
        }
        let mut stmt=self.conn.prepare("SELECT id FROM agent_inputs WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
        let ids = stmt
            .query_map(params![session, integer(after)?, limit], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut result = Vec::new();
        let mut bytes = 2;
        for id in ids {
            let row = input(&self.conn, session, &id)?;
            let size = serde_json::to_vec(&row)?.len() + 1;
            if bytes + size > PAGE_BYTES {
                if result.is_empty() {
                    return Err(Error::Invalid("queue row exceeds page byte limit".into()));
                }
                break;
            }
            bytes += size;
            result.push(row);
        }
        Ok(result)
    }
    pub fn cancel_queued_agent(&mut self, session: &str, id: &str) -> Result<QueuedAgent> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old = input(&tx, session, id)?;
        if old.operation_id.is_some() {
            return Err(Error::Conflict(
                "dispatched queue input must be cancelled through its operation".into(),
            ));
        }
        if old.status != Status::Cancelled {
            tx.execute(
                "UPDATE agent_inputs SET cancelled=1 WHERE session_id=?1 AND id=?2",
                params![session, id],
            )?;
            append(
                &tx,
                session,
                "agent_input_cancelled",
                &json!({"input_id":id}),
            )?;
        }
        let result = input(&tx, session, id)?;
        tx.commit()?;
        Ok(result)
    }
    /// Resolve only intent. The engine must serialize this with dispatch/cancel
    /// under admission control and check the row again before operation admission.
    pub fn resolve_queued_agent(&mut self, session: &str, id: &str) -> Result<QueuedAgent> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old = input(&tx, session, id)?;
        if old.operation_id.is_some() {
            return Ok(old);
        }
        if old.status != Status::Pending {
            return Err(Error::Conflict("queue input is cancelled".into()));
        }
        let blocked: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_inputs q LEFT JOIN operations o ON o.session_id=q.session_id AND o.command_id=q.run_command_id WHERE q.session_id=?1 AND q.sequence<?2 AND q.cancelled=0 AND (o.id IS NULL OR o.status IN ('admitted','running')))",params![session,integer(old.sequence)?],|r|r.get(0))?;
        if blocked {
            return Err(Error::Conflict(
                "earlier queue input must settle before dispatch".into(),
            ));
        }
        if old.resolved_request.is_some() {
            return Ok(old);
        }
        let mut request = old.request.clone();
        if let Some(predecessor) = &old.after_input {
            let previous = input(&tx, session, predecessor)?;
            if previous.sequence >= old.sequence || previous.status != Status::Succeeded {
                return Err(Error::Conflict(
                    "queue predecessor has not completed successfully".into(),
                ));
            }
            request.continuation_of = previous.operation_id;
        }
        let resolved = encoded(&request)?;
        if resolved.len() > RESOLVED_BYTES {
            return Err(Error::Invalid("resolved request exceeds byte limit".into()));
        }
        tx.execute(
            "UPDATE agent_inputs SET resolved_request=?3 WHERE session_id=?1 AND id=?2",
            params![session, id, resolved],
        )?;
        append(
            &tx,
            session,
            "agent_input_resolved",
            &json!({"input_id":id,"run_command_id":old.run_command_id}),
        )?;
        let result = input(&tx, session, id)?;
        tx.commit()?;
        Ok(result)
    }
}
