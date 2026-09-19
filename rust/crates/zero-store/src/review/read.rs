use super::*;
pub(super) struct Bound {
    pub record: ReviewRecord,
    pub admission: ReviewAdmission,
    pub controller: Operation,
    pub root: Operation,
    pub close: Option<ReviewCloseReason>,
}
pub(super) fn by_command(
    conn: &Connection,
    command: &str,
    r: &mut Reader,
) -> Result<Option<ReviewRecord>> {
    id(command)?;
    let key:Option<String>=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM reviews WHERE command_id=?1",[command],|r|r.get(0)).optional()?;
    let count:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY review_command_created WHERE kind='review_created' AND json_extract(payload,'$.command_id')=?1",[command],|r|r.get(0))?;
    match key {
        Some(key) if count == 1 => Ok(Some(bound(conn, &key, r)?.record)),
        None if count == 0 => Ok(None),
        _ => Err(bad("global command projection or witness missing")),
    }
}
pub(super) fn binding(conn: &Connection, session: &str, r: &mut Reader) -> Result<Option<Bound>> {
    let key:Option<String>=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM reviews WHERE session_id=?1",[session],|r|r.get(0)).optional()?;
    if let Some(key) = key {
        return Ok(Some(bound(conn, &key, r)?));
    }
    let marked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND generation LIKE 'native-review:%') OR EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='review_created')",[session],|r|r.get(0))?;
    if marked {
        return Err(bad("review binding projection missing"));
    }
    Ok(None)
}
pub(super) fn bound(conn: &Connection, key: &str, r: &mut Reader) -> Result<Bound> {
    id(key)?;
    let (raw,sequence):(String,u64)=conn.query_row("SELECT CASE WHEN length(CAST(record AS BLOB))<=65536 THEN record END,binding_sequence FROM reviews WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    r.charge(raw.len(), 65536)?;
    let v: ReviewRecord = serde_json::from_str(&raw)?;
    let valid:bool=conn.query_row("SELECT id=?2 AND sequence=?3 AND command_id=?4 AND session_id=?5 AND controller_operation_id=?6 AND root_operation_id=?7 AND intent_sha256=?8 FROM reviews WHERE id=?1",params![key,v.id,integer(v.sequence)?,v.command_id,v.session_id,v.controller_operation_id,v.root_operation_id,v.intent_sha256],|r|r.get(0))?;
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='review_created'",
        [&v.session_id],
        |r| r.get(0),
    )?;
    let global:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY review_command_created WHERE kind='review_created' AND json_extract(payload,'$.command_id')=?1",[&v.command_id],|r|r.get(0))?;
    let (kind, witness) = r.event(conn, &v.session_id, sequence)?;
    if !valid
        || v.schema_version != 1
        || count != 1
        || global != 1
        || kind != "review_created"
        || witness != serde_json::to_value(&v)?
    {
        return Err(bad("catalog binding witness differs"));
    }
    let captured: Value =
        serde_json::from_slice(&r.artifact(conn, &v.intent_sha256, MAX_INTENT_BYTES)?)?;
    let a: ReviewAdmission = serde_json::from_value(captured["admission"].clone())?;
    validate(&a)?;
    let deadline = v
        .created_at_ms
        .checked_add(a.profile.deadline_ms)
        .ok_or_else(|| bad("deadline overflow"))?;
    if captured != intent(&a, &v.command_id, v.created_at_ms, deadline)
        || a.review_id != v.id
        || a.session_id != v.session_id
        || a.controller_operation_id != v.controller_operation_id
        || a.root_operation_id != v.root_operation_id
        || a.input_path != v.input_path
        || a.canonical_path != v.canonical_path
        || a.snapshot.digest != v.snapshot_sha256
        || a.profile_name != v.profile_name
        || hash(&a.profile)? != v.profile_sha256
        || deadline != v.deadline_at_ms
    {
        return Err(bad("immutable review intent differs"));
    }
    let bounded: bool = conn.query_row(
        "SELECT length(CAST(generation AS BLOB))<=256 FROM sessions WHERE id=?1",
        [&v.session_id],
        |r| r.get(0),
    )?;
    if !bounded {
        return Err(bad("session metadata bounds"));
    }
    let session = crate::get_session(conn, &v.session_id)?;
    if session.generation != format!("native-review:{}", v.id)
        || session.generation_epoch.is_some()
        || session.created_at_ms != v.created_at_ms
        || session.budget_limit != a.profile.budget_limit
    {
        return Err(bad("session authority differs"));
    }
    let controller = workflow::operation(conn, &v.controller_operation_id, r)?;
    let root = workflow::operation(conn, &v.root_operation_id, r)?;
    let mut expected = a.root_payload.clone();
    expected["review_operation_id"] = json!(controller.id);
    expected["review_context"] = context(&v);
    if root.payload != expected
        || controller.payload
            != json!({"kind":"native_review","review_id":v.id,"intent_sha256":v.intent_sha256,"root_operation_id":root.id})
        || controller.session_id != v.session_id
        || root.session_id != v.session_id
        || controller.owner != root.owner
        || root.command_id != format!("review:{}:root", v.id)
        || controller.command_id != format!("review:{}", v.id)
    {
        return Err(bad("root/controller authority differs"));
    }
    let attached:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM operation_artifacts WHERE operation_id=?1 AND name='review.intent' AND digest=?2)",params![controller.id,v.intent_sha256],|r|r.get(0))?;
    if !attached {
        return Err(bad("intent attachment missing"));
    }
    let (reason,seq):(Option<String>,Option<u64>)=conn.query_row("SELECT CASE WHEN length(CAST(close_reason AS BLOB))<=16 THEN close_reason END,close_sequence FROM reviews WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='review_admission_closed'",
        [&v.session_id],
        |r| r.get(0),
    )?;
    let close = match (reason, seq) {
        (None, None) if count == 0 => None,
        (Some(reason), Some(seq)) if count == 1 => {
            let reason: ReviewCloseReason = serde_json::from_value(json!(reason))?;
            let (kind, witness) = r.event(conn, &v.session_id, seq)?;
            if kind != "review_admission_closed"
                || witness
                    != json!({"review_id":v.id,"controller_operation_id":controller.id,"reason":reason,"owner":controller.owner})
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
impl Store {
    pub fn review_by_command(&self, command: &str) -> Result<Option<ReviewRecord>> {
        let tx = self.conn.unchecked_transaction()?;
        by_command(&tx, command, &mut Reader::new())
    }
    pub fn review_by_session(&self, session: &str) -> Result<Option<ReviewRecord>> {
        id(session)?;
        let tx = self.conn.unchecked_transaction()?;
        Ok(binding(&tx, session, &mut Reader::new())?.map(|b| b.record))
    }
    pub fn review_record(&self, key: &str) -> Result<ReviewRecord> {
        let tx = self.conn.unchecked_transaction()?;
        Ok(bound(&tx, key, &mut Reader::new())?.record)
    }
    pub fn review_snapshot(&self, key: &str) -> Result<ReviewSnapshot> {
        let tx = self.conn.unchecked_transaction()?;
        let mut reader = Reader::new();
        let b = bound(&tx, key, &mut reader)?;
        crate::admission_closure::validate(&tx, &b.record.session_id)?;
        let budget = workflow::checked_budget(&tx, &b.record.session_id, &mut reader)?;
        let sequence: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0) FROM events WHERE session_id=?1",
            [&b.record.session_id],
            |r| r.get(0),
        )?;
        Ok(ReviewSnapshot {
            review: b.record,
            controller_status: b.controller.status,
            root_status: b.root.status,
            close_reason: b.close,
            budget,
            currency: b.admission.profile.currency,
            observed_sequence: sequence,
            observed_at_ms: now()?,
        })
    }
}
