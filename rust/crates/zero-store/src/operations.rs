use crate::{Admission, Error, Operation, OperationStatus, Result, Store, append, nonempty};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), canonical(&map[k])))
                    .collect(),
            )
        }
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}
fn encoded(value: &Value) -> Result<String> {
    Ok(serde_json::to_string(&canonical(value))?)
}
fn status(value: OperationStatus) -> &'static str {
    match value {
        OperationStatus::Admitted => "admitted",
        OperationStatus::Running => "running",
        OperationStatus::Succeeded => "succeeded",
        OperationStatus::Failed => "failed",
        OperationStatus::Cancelled => "cancelled",
        OperationStatus::Unknown => "unknown",
    }
}
fn decode(value: &str) -> Result<OperationStatus> {
    match value {
        "admitted" => Ok(OperationStatus::Admitted),
        "running" => Ok(OperationStatus::Running),
        "succeeded" => Ok(OperationStatus::Succeeded),
        "failed" => Ok(OperationStatus::Failed),
        "cancelled" => Ok(OperationStatus::Cancelled),
        "unknown" => Ok(OperationStatus::Unknown),
        _ => Err(Error::Invalid("invalid persisted operation status".into())),
    }
}
pub(super) fn operation(conn: &Connection, id: &str) -> Result<Operation> {
    let row=conn.query_row("SELECT id,session_id,command_id,payload,status,owner,outcome FROM operations WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?))).optional()?.ok_or_else(||Error::NotFound(id.into()))?;
    Ok(Operation {
        id: row.0,
        session_id: row.1,
        command_id: row.2,
        payload: serde_json::from_str(&row.3)?,
        status: decode(&row.4)?,
        owner: row.5,
        outcome: row.6.map(|v| serde_json::from_str(&v)).transpose()?,
    })
}
impl Store {
    /// Admit and start one fresh, bounded group before any external dispatch.
    /// A duplicate anywhere rejects the whole batch; callers replay the owning
    /// root receipt rather than restarting children independently.
    pub fn admit_owned_batch(
        &mut self,
        session: &str,
        owner: &str,
        intents: &[(String, Value)],
    ) -> Result<Vec<Operation>> {
        nonempty(owner)?;
        if owner.len() > 4096 || !(1..=17).contains(&intents.len()) {
            return Err(Error::Invalid(
                "owned batch requires 1..17 intents and a bounded owner".into(),
            ));
        }
        let mut commands = std::collections::BTreeSet::new();
        let mut encoded_intents = Vec::with_capacity(intents.len());
        let mut bytes = 0usize;
        for (command, payload) in intents {
            nonempty(command)?;
            if command.len() > 4096 || !commands.insert(command) {
                return Err(Error::Invalid(
                    "batch command identities must be bounded and unique".into(),
                ));
            }
            let text = encoded(payload)?;
            bytes = bytes.saturating_add(text.len());
            if text.len() > 4 * 1024 * 1024 || bytes > 32 * 1024 * 1024 {
                return Err(Error::Invalid(
                    "batch payload exceeds per-intent or aggregate bound".into(),
                ));
            }
            let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
            encoded_intents.push((command, text, hash));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::get_session(&tx, session)?;
        let mut operations = Vec::with_capacity(intents.len());
        for (command, text, hash) in encoded_intents {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM operations WHERE session_id=?1 AND command_id=?2)",
                params![session, command],
                |row| row.get(0),
            )?;
            if exists {
                return Err(Error::Conflict(command.clone()));
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES (?1,?2,?3,?4,?5,'admitted')",params![id,session,command,text,hash])?;
            let mut op = operation(&tx, &id)?;
            append(
                &tx,
                session,
                "command_admitted",
                &serde_json::to_value(&op)?,
            )?;
            tx.execute(
                "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
                params![id, owner],
            )?;
            op.status = OperationStatus::Running;
            op.owner = Some(owner.into());
            append(
                &tx,
                session,
                "operation_started",
                &serde_json::to_value(&op)?,
            )?;
            operations.push(op);
        }
        tx.commit()?;
        Ok(operations)
    }

    /// Durable host detail for an operation owned by this exact controller.
    /// The fixed outer kind prevents details from impersonating lifecycle events.
    /// Terminal details allow recording lease release after outcome settlement.
    pub fn append_operation_event(
        &mut self,
        id: &str,
        owner: &str,
        kind: &str,
        details: &Value,
    ) -> Result<zero_protocol::session::SessionEvent> {
        if kind.is_empty()
            || kind.len() > 128
            || !kind
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return Err(Error::Invalid("invalid operation detail kind".into()));
        }
        let payload = json!({"operation_id":id,"kind":kind,"details":details});
        if serde_json::to_vec(&payload)?.len() > 1024 * 1024 {
            return Err(Error::Invalid("operation detail exceeds 1 MiB".into()));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let op = operation(&tx, id)?;
        if op.owner.as_deref() != Some(owner) || op.status == OperationStatus::Admitted {
            return Err(Error::Conflict("operation detail owner mismatch".into()));
        }
        append(&tx, &op.session_id, "operation_detail", &payload)?;
        let sequence = tx.query_row(
            "SELECT MAX(sequence) FROM events WHERE session_id=?1",
            [&op.session_id],
            |r| r.get(0),
        )?;
        let event = zero_protocol::session::SessionEvent {
            session_id: op.session_id,
            sequence,
            kind: "operation_detail".into(),
            payload,
        };
        tx.commit()?;
        Ok(event)
    }
    pub fn get_operation(&self, id: &str) -> Result<Operation> {
        operation(&self.conn, id)
    }
    pub fn get_operation_by_command(&self, session: &str, command: &str) -> Result<Operation> {
        let id: String = self
            .conn
            .query_row(
                "SELECT id FROM operations WHERE session_id=?1 AND command_id=?2",
                params![session, command],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(command.into()))?;
        operation(&self.conn, &id)
    }
    pub fn admit_command(
        &mut self,
        session: &str,
        command_id: &str,
        payload: &Value,
    ) -> Result<Admission> {
        nonempty(command_id)?;
        let payload_text = encoded(payload)?;
        let hash = format!("{:x}", Sha256::digest(payload_text.as_bytes()));
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::get_session(&tx, session)?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT id,payload FROM operations WHERE session_id=?1 AND command_id=?2",
                params![session, command_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((id, old)) = existing {
            if old != payload_text {
                return Err(Error::Conflict(command_id.into()));
            }
            return Ok(Admission {
                operation: operation(&tx, &id)?,
                duplicate: true,
            });
        }
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES (?1,?2,?3,?4,?5,'admitted')",params![id,session,command_id,payload_text,hash])?;
        let operation = operation(&tx, &id)?;
        append(
            &tx,
            session,
            "command_admitted",
            &serde_json::to_value(&operation)?,
        )?;
        tx.commit()?;
        Ok(Admission {
            operation,
            duplicate: false,
        })
    }
    pub fn begin_operation(&mut self, id: &str, owner: &str) -> Result<Operation> {
        nonempty(owner)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut op = operation(&tx, id)?;
        // Starting is not retryable: even the same owner must not execute twice.
        if op.status != OperationStatus::Admitted {
            return Err(Error::Conflict(id.into()));
        }
        tx.execute(
            "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
            params![id, owner],
        )?;
        op.status = OperationStatus::Running;
        op.owner = Some(owner.into());
        append(
            &tx,
            &op.session_id,
            "operation_started",
            &serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn settle_operation(
        &mut self,
        id: &str,
        owner: &str,
        new_status: OperationStatus,
        outcome: &Value,
    ) -> Result<Operation> {
        if !matches!(
            new_status,
            OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled
        ) {
            return Err(Error::Invalid("settlement requires terminal status".into()));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut op = operation(&tx, id)?;
        if op.owner.as_deref() != Some(owner) {
            return Err(Error::Conflict("operation owner mismatch".into()));
        }
        if op.status == new_status
            && op
                .outcome
                .as_ref()
                .is_some_and(|v| canonical(v) == canonical(outcome))
        {
            return Ok(op);
        }
        if op.status != OperationStatus::Running {
            return Err(Error::Conflict(id.into()));
        }
        tx.execute(
            "UPDATE operations SET status=?2,outcome=?3 WHERE id=?1",
            params![id, status(new_status), encoded(outcome)?],
        )?;
        op.status = new_status;
        op.outcome = Some(outcome.clone());
        append(
            &tx,
            &op.session_id,
            "operation_settled",
            &serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    /// Marks only this owner's failed worker as uncertain; other operations continue.
    pub fn mark_operation_unknown(
        &mut self,
        id: &str,
        owner: &str,
        reason: &str,
    ) -> Result<Operation> {
        nonempty(reason)?;
        self.mark_operation_unknown_with_outcome(id, owner, &json!({"reason":reason}))
    }
    /// Preserve known partial evidence while refusing to replay an uncertain effect.
    pub fn mark_operation_unknown_with_outcome(
        &mut self,
        id: &str,
        owner: &str,
        outcome: &Value,
    ) -> Result<Operation> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut op = operation(&tx, id)?;
        if op.owner.as_deref() != Some(owner) {
            return Err(Error::Conflict("operation owner mismatch".into()));
        }
        if op.status == OperationStatus::Unknown && op.outcome.as_ref() == Some(outcome) {
            return Ok(op);
        }
        if op.status != OperationStatus::Running {
            return Err(Error::Conflict(id.into()));
        }
        tx.execute(
            "UPDATE operations SET status='unknown',outcome=?2 WHERE id=?1",
            params![id, encoded(outcome)?],
        )?;
        op.status = OperationStatus::Unknown;
        op.outcome = Some(outcome.clone());
        append(
            &tx,
            &op.session_id,
            "operation_unknown",
            &serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    /// Caller must establish that this exact owner is dead/quiescent before recovery.
    /// Unknown operations retain ownership and reservations and are never re-admitted.
    pub fn recover_owner(&mut self, owner: &str) -> Result<usize> {
        nonempty(owner)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows = {
            let mut stmt=tx.prepare("SELECT id,session_id FROM operations WHERE owner=?1 AND status='running' ORDER BY id")?;
            stmt.query_map([owner], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
        };
        for (id, session) in &rows {
            tx.execute("UPDATE operations SET status='unknown' WHERE id=?1", [id])?;
            append(
                &tx,
                session,
                "operation_unknown",
                &json!({"operation_id":id,"owner":owner}),
            )?;
        }
        tx.commit()?;
        Ok(rows.len())
    }
}
