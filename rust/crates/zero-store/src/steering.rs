//! Immutable steering intent, atomic inference capture, and terminal sealing.
use crate::{Error, Operation, OperationStatus, Result, Store, append, integer, nonempty};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zero_protocol::steering::{
    AgentSteeringMessage as Message, AgentSteeringStatus as Status, SteeringInput,
};
const PAGE: usize = 1024 * 1024;
const ROW: usize = 32 * 1024 * 1024;
pub(super) fn id(s: &str) -> Result<()> {
    nonempty(s)?;
    if s.len() > 4096 {
        return Err(Error::Invalid("steering identity exceeds 4 KiB".into()));
    }
    Ok(())
}
fn conflict(s: &str) -> Error {
    Error::Conflict(s.into())
}
pub(super) fn operation(conn: &Connection, key: &str) -> Result<Operation> {
    id(key)?;
    let row = conn.query_row("SELECT id,CASE WHEN length(CAST(session_id AS BLOB))<=4096 THEN session_id END,CASE WHEN length(CAST(command_id AS BLOB))<=4096 THEN command_id END,CASE WHEN length(CAST(payload AS BLOB))<=?2 THEN payload END,CASE WHEN length(status)<=32 THEN status END,CASE WHEN length(CAST(owner AS BLOB))<=4096 THEN owner END FROM operations WHERE id=?1",params![key,ROW],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    if row.3.is_none() {
        return Err(Error::Invalid(
            "steering operation exceeds read bound".into(),
        ));
    }
    Ok(Operation {
        id: row.0,
        session_id: row.1,
        command_id: row.2,
        payload: serde_json::from_str(&row.3.unwrap_or_default())?,
        status: serde_json::from_value(json!(row.4))?,
        owner: row.5,
        outcome: None,
    })
}
fn target(conn: &Connection, session: &str, key: &str, owner: Option<&str>) -> Result<Operation> {
    id(session)?;
    let op = operation(conn, key)?;
    if op.session_id != session
        || zero_protocol::agent::validate_actor_payload(&op.payload).is_err()
    {
        return Err(conflict("steering target is not an agent in this session"));
    }
    if let Some(owner) = owner {
        id(owner)?;
        if op.status != OperationStatus::Running || op.owner.as_deref() != Some(owner) {
            return Err(conflict("steering actor ownership changed"));
        }
    }
    Ok(op)
}
fn sealed(conn: &Connection, op: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT sealed FROM agent_steering_windows WHERE operation_id=?1",
            [op],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false))
}
pub(super) const READ_BUDGET: &str = "steering page witness read budget exceeded";
#[derive(Default)]
pub(super) struct Witnesses {
    events: std::collections::BTreeMap<(String, u64), (String, Value)>,
    bytes: usize,
}
impl Witnesses {
    pub(super) fn reserve(&mut self, size: usize) -> Result<()> {
        if self.bytes.saturating_add(size) > 64 * 1024 * 1024 {
            return Err(Error::Invalid(READ_BUDGET.into()));
        }
        self.bytes += size;
        Ok(())
    }
    pub(super) fn event(
        &mut self,
        conn: &Connection,
        session: &str,
        sequence: u64,
        max: usize,
    ) -> Result<&(String, Value)> {
        let key = (session.to_owned(), sequence);
        if !self.events.contains_key(&key) {
            let (kind,size):(String,usize)=conn.query_row("SELECT CASE WHEN length(CAST(kind AS BLOB))<=128 THEN kind END,length(CAST(payload AS BLOB)) FROM events WHERE session_id=?1 AND sequence=?2",params![session,integer(sequence)?],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(||conflict("steering witness event missing"))?;
            if size > max {
                return Err(Error::Invalid("steering witness exceeds byte bound".into()));
            }
            self.reserve(size)?;
            let text: String = conn.query_row(
                "SELECT payload FROM events WHERE session_id=?1 AND sequence=?2",
                params![session, integer(sequence)?],
                |r| r.get(0),
            )?;
            self.events
                .insert(key.clone(), (kind, serde_json::from_str(&text)?));
        }
        self.events
            .get(&key)
            .ok_or_else(|| conflict("steering witness cache missing"))
    }
}
fn identity(m: &Message) -> Value {
    json!({"id":m.id,"session_id":m.session_id,"operation_id":m.operation_id,"sequence":m.sequence,"command_id":m.command_id,"prompt":m.prompt})
}
fn message(conn: &Connection, key: &str) -> Result<(Message, Option<u64>)> {
    message_cached(conn, key, &mut Witnesses::default())
}
fn message_cached(
    conn: &Connection,
    key: &str,
    witnesses: &mut Witnesses,
) -> Result<(Message, Option<u64>)> {
    id(key)?;
    let row=conn.query_row("SELECT id,CASE WHEN length(CAST(session_id AS BLOB))<=4096 THEN session_id END,CASE WHEN length(CAST(operation_id AS BLOB))<=4096 THEN operation_id END,sequence,CASE WHEN length(CAST(command_id AS BLOB))<=4096 THEN command_id END,CASE WHEN length(CAST(prompt AS BLOB))<=16384 THEN prompt END,CASE WHEN length(CAST(inference_operation_id AS BLOB))<=4096 THEN inference_operation_id END,capture_sequence FROM agent_steering WHERE id=?1",[key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,u64>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<u64>>(7)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    for value in [&row.0, &row.1, &row.2, &row.4] {
        id(value)?;
    }
    if let Some(value) = &row.6 {
        id(value)?;
    }
    let mut m = Message {
        id: row.0,
        session_id: row.1,
        operation_id: row.2,
        sequence: row.3,
        command_id: row.4,
        prompt: row
            .5
            .ok_or_else(|| Error::Invalid("steering prompt exceeds bound".into()))?,
        status: Status::Pending,
        inference_operation_id: row.6,
    };
    if m.prompt.trim().is_empty()
        || m.prompt.contains('\0')
        || m.inference_operation_id.is_some() != row.7.is_some()
    {
        return Err(conflict("invalid persisted steering intent"));
    }
    let (kind, value) = witnesses.event(conn, &m.session_id, m.sequence, 128 * 1024)?;
    if kind != "agent_steering_enqueued" || *value != identity(&m) {
        return Err(conflict(
            "steering intent differs from original admission event",
        ));
    }
    m.status = if let Some(inference) = &m.inference_operation_id {
        let sequence = row
            .7
            .ok_or_else(|| conflict("missing steering capture sequence"))?;
        let (kind, witness) = witnesses.event(conn, &m.session_id, sequence, ROW)?;
        let input = json!({"id":m.id,"sequence":m.sequence,"prompt":m.prompt});
        if kind != "command_admitted"
            || witness["id"] != *inference
            || witness["session_id"] != m.session_id
            || witness["status"] != "admitted"
            || !witness["owner"].is_null()
            || !witness["outcome"].is_null()
            || witness["payload"]["kind"] != "agent_inference"
            || witness["payload"]["parent_operation"] != m.operation_id
            || !witness["payload"]["steering"]
                .as_array()
                .is_some_and(|a| a.len() <= 32 && a.iter().filter(|v| *v == &input).count() == 1)
        {
            return Err(conflict(
                "steering capture differs from inference admission witness",
            ));
        }
        Status::Captured
    } else {
        let (session, status): (String, String) = conn.query_row(
            "SELECT CASE WHEN length(CAST(session_id AS BLOB))<=4096 THEN session_id END,CASE WHEN length(status)<=32 THEN status END FROM operations WHERE id=?1",
            [&m.operation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let status: OperationStatus = serde_json::from_value(json!(status))?;
        if session != m.session_id {
            return Err(conflict("steering target session changed"));
        }
        if status == OperationStatus::Running && !sealed(conn, &m.operation_id)? {
            Status::Pending
        } else {
            Status::Undelivered
        }
    };
    Ok((m, row.7))
}
fn pending(conn: &Connection, session: &str, op: &str) -> Result<Vec<SteeringInput>> {
    let mut stmt=conn.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=4096 THEN id END FROM agent_steering WHERE operation_id=?1 AND inference_operation_id IS NULL ORDER BY sequence LIMIT 33")?;
    let ids = stmt
        .query_map([op], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if ids.len() > 32 {
        return Err(conflict("steering pending bound exceeded"));
    }
    ids.into_iter()
        .map(|key| {
            let (m, _) = message(conn, &key)?;
            if m.session_id != session || m.operation_id != op || m.status != Status::Pending {
                return Err(conflict("steering pending identity changed"));
            }
            Ok(SteeringInput {
                id: m.id,
                sequence: m.sequence,
                prompt: m.prompt,
            })
        })
        .collect()
}
impl Store {
    pub fn agent_steering_by_command(
        &self,
        session: &str,
        command: &str,
    ) -> Result<Option<Message>> {
        id(session)?;
        id(command)?;
        let tx = self.conn.unchecked_transaction()?;
        let key: Option<String> = tx
            .query_row(
                "SELECT CASE WHEN length(CAST(id AS BLOB))<=4096 THEN id END FROM agent_steering WHERE session_id=?1 AND command_id=?2",
                params![session, command],
                |r| r.get(0),
            )
            .optional()?;
        let result = key.map(|key| message(&tx, &key).map(|r| r.0)).transpose()?;
        tx.commit()?;
        Ok(result)
    }
    pub fn enqueue_agent_steering(
        &mut self,
        session: &str,
        op: &str,
        command: &str,
        prompt: &str,
    ) -> Result<(Message, bool)> {
        for value in [session, op, command] {
            id(value)?;
        }
        crate::scan::forbid_input(&self.conn, session)?;
        crate::campaign::forbid_input(&self.conn, session)?;
        if prompt.trim().is_empty() || prompt.len() > 16384 || prompt.contains('\0') {
            return Err(Error::Invalid(
                "steering prompt requires 1..16384 UTF-8 bytes without NUL".into(),
            ));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT CASE WHEN length(CAST(id AS BLOB))<=4096 THEN id END FROM agent_steering WHERE session_id=?1 AND command_id=?2",
                params![session, command],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(key) = existing {
            let (m, _) = message(&tx, &key)?;
            if m.operation_id != op || m.prompt != prompt {
                return Err(conflict("steering command retry changed intent"));
            }
            tx.commit()?;
            return Ok((m, true));
        }
        let actor = target(&tx, session, op, None)?;
        if actor.status != OperationStatus::Running || sealed(&tx, op)? {
            return Err(conflict("steering target no longer accepts messages"));
        }
        let (total,waiting):(u64,u64)=tx.query_row("SELECT count(*),coalesce(sum(inference_operation_id IS NULL),0) FROM agent_steering WHERE operation_id=?1",[op],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if total >= 128 || waiting >= 32 {
            return Err(conflict("steering target inbox limit reached"));
        }
        let sequence: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM events WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )?;
        let m = Message {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session.into(),
            operation_id: op.into(),
            sequence,
            command_id: command.into(),
            prompt: prompt.into(),
            status: Status::Pending,
            inference_operation_id: None,
        };
        tx.execute("INSERT INTO agent_steering(id,session_id,operation_id,sequence,command_id,prompt) VALUES(?1,?2,?3,?4,?5,?6)",params![m.id,session,op,integer(sequence)?,command,prompt])?;
        append(&tx, session, "agent_steering_enqueued", &identity(&m))?;
        tx.commit()?;
        Ok((m, false))
    }
    pub fn agent_steering(
        &self,
        session: &str,
        op: &str,
        after_sequence: u64,
        limit: u32,
    ) -> Result<Vec<Message>> {
        if !(1..=100).contains(&limit) {
            return Err(Error::Invalid("steering page limit must be 1..100".into()));
        }
        let tx = self.conn.unchecked_transaction()?;
        target(&tx, session, op, None)?;
        let ids = {
            let mut stmt=tx.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=4096 THEN id END FROM agent_steering WHERE operation_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
            stmt.query_map(params![op, integer(after_sequence)?, limit], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut rows = vec![];
        let mut bytes = 2usize;
        let mut witnesses = Witnesses::default();
        for key in ids {
            let (m, _) = match message_cached(&tx, &key, &mut witnesses) {
                Err(Error::Invalid(reason)) if reason == READ_BUDGET && !rows.is_empty() => break,
                result => result?,
            };
            let size = serde_json::to_vec(&m)?.len() + 1;
            if bytes + size > PAGE {
                break;
            }
            bytes += size;
            rows.push(m);
        }
        tx.commit()?;
        Ok(rows)
    }
    pub fn pending_agent_steering(
        &self,
        session: &str,
        op: &str,
        owner: &str,
    ) -> Result<Vec<SteeringInput>> {
        let tx = self.conn.unchecked_transaction()?;
        target(&tx, session, op, Some(owner))?;
        let result = if sealed(&tx, op)? {
            vec![]
        } else {
            pending(&tx, session, op)?
        };
        tx.commit()?;
        Ok(result)
    }
    /// False leaves the inbox open because pending messages won the boundary race.
    pub fn seal_agent_steering(
        &mut self,
        session: &str,
        op: &str,
        owner: &str,
        force: bool,
    ) -> Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        target(&tx, session, op, Some(owner))?;
        if sealed(&tx, op)? {
            tx.commit()?;
            return Ok(true);
        }
        let waiting:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_steering WHERE operation_id=?1 AND inference_operation_id IS NULL)",[op],|r|r.get(0))?;
        if waiting && !force {
            tx.commit()?;
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO agent_steering_windows(operation_id,sealed) VALUES(?1,1)",
            [op],
        )?;
        append(
            &tx,
            session,
            "agent_steering_sealed",
            &json!({"operation_id":op,"forced":force}),
        )?;
        tx.commit()?;
        Ok(true)
    }
    /// Capture the sampled immutable prefix and admit the actual model request in one commit.
    pub fn admit_steered_inference(
        &mut self,
        session: &str,
        op: &str,
        owner: &str,
        command: &str,
        payload: &Value,
        selected: &[SteeringInput],
    ) -> Result<Operation> {
        for value in [session, op, owner, command] {
            id(value)?;
        }
        if selected.len() > 32
            || payload["kind"] != "agent_inference"
            || payload["parent_operation"] != op
        {
            return Err(conflict("invalid steered inference identity"));
        }
        let expected = serde_json::to_value(selected)?;
        if payload.get("steering").is_some_and(|v| v != &expected)
            || (!selected.is_empty() && payload.get("steering").is_none())
        {
            return Err(conflict(
                "inference steering receipt differs from selected messages",
            ));
        }
        let text = serde_json::to_string(payload)?;
        if text.len() > 8 * 1024 * 1024 {
            return Err(Error::Invalid("steered inference exceeds 8 MiB".into()));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::scan::authorize(&tx, session, command, payload)?;
        crate::campaign::authorize(&tx, session, command, payload)?;
        crate::strategy_session::authorize(&tx, session, command, payload)?;
        target(&tx, session, op, Some(owner))?;
        if sealed(&tx, op)? {
            return Err(conflict("steering actor is sealed"));
        }
        let waiting = pending(&tx, session, op)?;
        if waiting.get(..selected.len()) != Some(selected) {
            return Err(conflict(
                "steering selection is not the original pending prefix",
            ));
        }
        let fresh = uuid::Uuid::new_v4().to_string();
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        tx.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES(?1,?2,?3,?4,?5,'admitted')",params![fresh,session,command,text,hash])?;
        let mut model = operation(&tx, &fresh)?;
        let sequence: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM events WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )?;
        append(
            &tx,
            session,
            "command_admitted",
            &serde_json::to_value(&model)?,
        )?;
        for item in selected {
            tx.execute("UPDATE agent_steering SET inference_operation_id=?2,capture_sequence=?3 WHERE id=?1 AND inference_operation_id IS NULL",params![item.id,fresh,integer(sequence)?])?;
        }
        tx.execute(
            "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
            params![fresh, owner],
        )?;
        model.status = OperationStatus::Running;
        model.owner = Some(owner.into());
        append(
            &tx,
            session,
            "operation_started",
            &serde_json::to_value(&model)?,
        )?;
        tx.commit()?;
        Ok(model)
    }
    /// Reconstruct only event-anchored messages captured by this exact admitted request.
    pub fn inference_steering(&self, inference: &Operation) -> Result<Vec<SteeringInput>> {
        let tx = self.conn.unchecked_transaction()?;
        let current = operation(&tx, &inference.id)?;
        if current.session_id != inference.session_id
            || current.command_id != inference.command_id
            || current.payload != inference.payload
        {
            return Err(conflict("inference identity differs from journal"));
        }
        let entries = {
            let mut stmt=tx.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=4096 THEN id END FROM agent_steering WHERE inference_operation_id=?1 ORDER BY sequence LIMIT 33")?;
            stmt.query_map([&inference.id], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        if entries.len() > 32 {
            return Err(conflict("inference steering capture exceeds bound"));
        }
        let mut result = vec![];
        let mut capture = None;
        let mut witnesses = Witnesses::default();
        for key in entries {
            let (m, sequence) = message_cached(&tx, &key, &mut witnesses)?;
            if m.session_id != inference.session_id
                || inference.payload["parent_operation"] != m.operation_id
                || inference.payload["kind"] != "agent_inference"
                || capture.is_some_and(|s| Some(s) != sequence)
            {
                return Err(conflict("captured steering target/inference mismatch"));
            }
            capture = sequence;
            result.push(SteeringInput {
                id: m.id,
                sequence: m.sequence,
                prompt: m.prompt,
            });
        }
        let expected = serde_json::to_value(&result)?;
        if inference
            .payload
            .get("steering")
            .is_some_and(|v| v != &expected)
            || (!result.is_empty() && inference.payload.get("steering").is_none())
        {
            return Err(conflict("captured steering differs from inference payload"));
        }
        if let Some(sequence) = capture {
            let (kind, witness) = witnesses.event(&tx, &inference.session_id, sequence, ROW)?;
            let mut admitted = inference.clone();
            admitted.status = OperationStatus::Admitted;
            admitted.owner = None;
            admitted.outcome = None;
            if kind != "command_admitted" || *witness != serde_json::to_value(admitted)? {
                return Err(conflict(
                    "captured inference differs from original admission",
                ));
            }
        }
        tx.commit()?;
        Ok(result)
    }
}
