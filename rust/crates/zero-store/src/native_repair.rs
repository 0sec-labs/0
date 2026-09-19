//! Atomic host authorization for repairing a retained observed reproduction.
//! Generic session capabilities remain closed; owned dispatch uses explicit gates.
use crate::{
    Error, Operation, OperationStatus, Result, Store, append, integer,
    workflow::{self, Reader},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zero_protocol::{
    review::ReviewCloseReason,
    review_repair::{NativeRepairRecord, ReviewRepairPlan},
    verification::{Disposition, Mode, ReproductionOutcome},
};
use zero_verification::FrozenPlan;
mod authority;
mod read;
const MAX_INTENT: usize = 2 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeRepairAdmission {
    pub id: String,
    pub session_id: String,
    pub operation_id: String,
    pub authorization: ReviewRepairPlan,
    /// Exact operation and complete two-session evidence independently assessed by Engine.
    pub reproduction_operation_id: String,
    pub reproduction_evidence_sha256: String,
}
pub struct AdmittedNativeRepair {
    pub record: NativeRepairRecord,
    pub operation: Operation,
    pub duplicate: bool,
}
fn bad(value: impl std::fmt::Display) -> Error {
    Error::Conflict(format!("native repair: {value}"))
}
fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&serde_json::to_value(value)?)?)
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("sha256:{:x}", Sha256::digest(encode(value)?)))
}
fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(bad)?
        .as_millis()
        .try_into()
        .map_err(bad)
}
fn id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(bad("identifier bounds"));
    }
    Ok(())
}
fn epoch(conn: &Connection, owner: &str) -> Result<()> {
    id(owner)?;
    let actual:Option<String>=conn.query_row("SELECT CASE WHEN length(CAST(owner AS BLOB))<=4096 THEN owner END FROM engine_epoch WHERE singleton=1",[],|r|r.get(0)).optional()?;
    if actual.as_deref() != Some(owner) {
        return Err(bad("owner epoch differs"));
    }
    Ok(())
}
fn validate(a: &NativeRepairAdmission) -> Result<()> {
    let ids = [&a.id, &a.session_id, &a.operation_id];
    if ids.iter().collect::<std::collections::BTreeSet<_>>().len() != 3 {
        return Err(bad("duplicate identities"));
    }
    for value in ids.into_iter().chain([&a.reproduction_operation_id]) {
        if uuid::Uuid::parse_str(value).map_err(bad)?.to_string() != *value {
            return Err(bad("noncanonical identity"));
        }
    }
    a.authorization.validate_envelope().map_err(bad)?;
    if !zero_protocol::is_sha256(&a.reproduction_evidence_sha256)
        || encode(a)?.len() > MAX_INTENT - 1024
    {
        return Err(bad("admission identity or bound"));
    }
    zero_repair::expected_receipt(&a.authorization.materialize).map_err(bad)?;
    Ok(())
}
/// Recompute under the caller's IMMEDIATE transaction. The Engine independently
/// assesses this same complete evidence view before supplying its digest; a
/// structurally valid outcome supplied directly to Store is not an oracle proof.
fn source(conn: &Connection, a: &NativeRepairAdmission) -> Result<()> {
    let view =
        crate::native_reproduction::capture_snapshot(conn, &a.authorization.reproduction_id)?;
    if crate::native_reproduction::evidence_digest(&view, &a.authorization.reproduction_id)?
        != a.reproduction_evidence_sha256
    {
        return Err(bad("independently assessed evidence changed"));
    }
    let baseline = view.native_reproduction(&a.authorization.reproduction_id)?;
    let outcome: ReproductionOutcome = serde_json::from_value(
        baseline
            .operation
            .outcome
            .clone()
            .ok_or_else(|| bad("baseline outcome absent"))?,
    )?;
    if baseline.operation.id != a.reproduction_operation_id
        || baseline.operation.status != OperationStatus::Succeeded
        || outcome.error.is_some()
        || outcome.stop_reason.is_some()
        || !outcome.assessment.as_ref().is_some_and(|v| {
            v.disposition == Disposition::ObservedForPlan && !v.vulnerability_reportable
        })
    {
        return Err(bad("baseline must be the exact observed reproduction"));
    }
    let original = view.native_reproduction_authorization(&a.authorization.reproduction_id)?;
    let logical = FrozenPlan::new(original.plan).map_err(bad)?;
    if serde_json::to_value(&a.authorization.materialize.baseline)?
        != serde_json::to_value(&logical.plan().snapshot)?
        || logical
            .plan()
            .cases
            .iter()
            .any(|c| c.mode == Mode::Attack && c.safe_expected.is_none())
    {
        return Err(bad("original snapshot or safe expectations differ"));
    }
    let executions = logical
        .plan()
        .cases
        .len()
        .checked_mul(logical.plan().repeats)
        .and_then(|n| n.checked_mul(2))
        .ok_or_else(|| bad("execution count overflow"))?;
    if executions > a.authorization.max_executions as usize {
        return Err(bad(
            "two fresh repair matrices exceed execution authorization",
        ));
    }
    if a.session_id == baseline.record.session_id
        || a.session_id == baseline.record.source_session_id
        || a.operation_id == baseline.operation.id
        || a.operation_id == baseline.record.source_operation_id
    {
        return Err(bad("repair requires independent ownership"));
    }
    Ok(())
}
fn intent(a: &NativeRepairAdmission, command: &str, created: u64, deadline: u64) -> Value {
    json!({"schema_version":1,"kind":"native_repair_intent","command_id":command,"created_at_ms":created,"deadline_at_ms":deadline,"admission":a})
}
struct Bound {
    record: NativeRepairRecord,
    admission: NativeRepairAdmission,
    operation: Operation,
    close: Option<ReviewCloseReason>,
}
fn bound(conn: &Connection, key: &str, r: &mut Reader) -> Result<Bound> {
    id(key)?;
    let (raw,sequence,close,close_sequence):(String,u64,Option<String>,Option<u64>)=conn.query_row("SELECT CASE WHEN length(CAST(record AS BLOB))<=65536 THEN record END,binding_sequence,close_reason,close_sequence FROM native_repairs WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    r.charge(raw.len(), 65536)?;
    let record: NativeRepairRecord = serde_json::from_str(&raw)?;
    let matches:bool=conn.query_row("SELECT id=?2 AND command_id=?3 AND session_id=?4 AND operation_id=?5 AND source_reproduction_id=?6 AND intent_sha256=?7 AND sequence=?8 FROM native_repairs WHERE id=?1",params![key,record.id,record.command_id,record.session_id,record.operation_id,record.source_reproduction_id,record.intent_sha256,integer(record.sequence)?],|r|r.get(0))?;
    let global:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY native_repair_command WHERE kind='native_repair_created' AND json_extract(payload,'$.command_id')=?1",[&record.command_id],|r|r.get(0))?;
    let parents:u64=conn.query_row("SELECT count(*) FROM operations INDEXED BY native_repair_parent_command WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.kind') END='native_source_repair' AND json_extract(payload,'$.command_id')=?1",[&record.command_id],|r|r.get(0))?;
    let admissions:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY native_repair_admission_command WHERE kind='command_admitted' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.payload.kind') END='native_source_repair' AND json_extract(payload,'$.payload.command_id')=?1",[&record.command_id],|r|r.get(0))?;
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='native_repair_created'",
        [&record.session_id],
        |r| r.get(0),
    )?;
    let (kind, witness) = r.event(conn, &record.session_id, sequence)?;
    if !matches
        || record.schema_version != 1
        || global != 1
        || parents != 1
        || admissions != 1
        || count != 1
        || kind != "native_repair_created"
        || witness != serde_json::to_value(&record)?
    {
        return Err(bad("catalog or creation witness differs"));
    }
    let bytes = r.artifact(conn, &record.intent_sha256, MAX_INTENT)?;
    let captured: Value = serde_json::from_slice(&bytes)?;
    let a: NativeRepairAdmission = serde_json::from_value(captured["admission"].clone())?;
    validate(&a)?;
    let deadline = record
        .created_at_ms
        .checked_add(a.authorization.deadline_ms)
        .ok_or_else(|| bad("deadline overflow"))?;
    if encode(&captured)? != bytes
        || captured != intent(&a, &record.command_id, record.created_at_ms, deadline)
        || a.id != record.id
        || a.session_id != record.session_id
        || a.operation_id != record.operation_id
        || a.authorization.reproduction_id != record.source_reproduction_id
        || a.reproduction_operation_id != record.reproduction_operation_id
        || a.reproduction_evidence_sha256 != record.reproduction_evidence_sha256
        || hash(&a.authorization)? != record.authorization_sha256
        || record.deadline_at_ms != deadline
    {
        return Err(bad("immutable authority differs"));
    }
    let session = crate::get_session(conn, &record.session_id)?;
    if session.generation != format!("native-repair:{}", record.id)
        || session.generation_epoch.is_some()
        || session.budget_limit != 0
        || session.created_at_ms != record.created_at_ms
        || r.event(conn, &session.id, 1)?
            != ("session_created".into(), serde_json::to_value(&session)?)
    {
        return Err(bad("session authority differs"));
    }
    let operation = workflow::operation(conn, &record.operation_id, r)?;
    if operation.session_id != record.session_id
        || operation.command_id != format!("native-repair:{}", record.id)
        || operation.payload
            != json!({"kind":"native_source_repair","command_id":record.command_id,"repair_id":record.id,"intent_sha256":record.intent_sha256})
    {
        return Err(bad("parent authority differs"));
    }
    let attachment:String=conn.query_row("SELECT CASE WHEN length(CAST(digest AS BLOB))=71 THEN digest END FROM operation_artifacts WHERE operation_id=?1 AND name='native_repair.intent'",[&operation.id],|r|r.get(0))?;
    if attachment != record.intent_sha256 {
        return Err(bad("intent attachment differs"));
    }
    let reservations: u64 = conn.query_row(
        "SELECT count(*) FROM reservations WHERE session_id=?1",
        [&session.id],
        |r| r.get(0),
    )?;
    let budget_events:u64=conn.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND kind IN ('budget_reserved','budget_settled','budget_reconciled')",[&session.id],|r|r.get(0))?;
    if reservations != 0 || budget_events != 0 {
        return Err(bad("verification cannot spend model budget"));
    }
    let closes: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='native_repair_closed'",
        [&session.id],
        |r| r.get(0),
    )?;
    let close = match (close, close_sequence) {
        (None, None) if closes == 0 => None,
        (Some(reason), Some(seq)) if closes == 1 => {
            let reason = match reason.as_str() {
                "cancelled" => ReviewCloseReason::Cancelled,
                "deadline" => ReviewCloseReason::Deadline,
                _ => return Err(bad("close reason differs")),
            };
            let expected = json!({"repair_id":record.id,"operation_id":operation.id,"reason":reason,"owner":operation.owner});
            if seq <= sequence
                || r.event(conn, &session.id, seq)? != ("native_repair_closed".into(), expected)
            {
                return Err(bad("close witness differs"));
            }
            Some(reason)
        }
        _ => return Err(bad("close projection differs")),
    };
    crate::admission_closure::validate(conn, &session.id)?;
    let b = Bound {
        record,
        admission: a,
        operation,
        close,
    };
    authority::validate_bound(conn, &b, r)?;
    Ok(b)
}
fn by_command(conn: &Connection, command: &str) -> Result<Option<Bound>> {
    id(command)?;
    let key: Option<String> = conn
        .query_row(
            "SELECT CASE WHEN length(id)<=256 THEN id END FROM native_repairs WHERE command_id=?1",
            [command],
            |r| r.get(0),
        )
        .optional()?;
    let count:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY native_repair_command WHERE kind='native_repair_created' AND json_extract(payload,'$.command_id')=?1",[command],|r|r.get(0))?;
    let parents:u64=conn.query_row("SELECT count(*) FROM operations INDEXED BY native_repair_parent_command WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.kind') END='native_source_repair' AND json_extract(payload,'$.command_id')=?1",[command],|r|r.get(0))?;
    let admissions:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY native_repair_admission_command WHERE kind='command_admitted' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.payload.kind') END='native_source_repair' AND json_extract(payload,'$.payload.command_id')=?1",[command],|r|r.get(0))?;
    match key {
        Some(key) if count == 1 && parents == 1 && admissions == 1 => {
            Ok(Some(bound(conn, &key, &mut Reader::new())?))
        }
        None if count == 0 && parents == 0 && admissions == 0 => Ok(None),
        _ => Err(bad("command projection or witness missing")),
    }
}
/// Caller has validated the owned Running parent in this immediate transaction.
fn close_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    b: &Bound,
    owner: &str,
    reason: ReviewCloseReason,
) -> Result<()> {
    let sequence: u64 = tx.query_row(
        "SELECT coalesce(max(sequence),0)+1 FROM events WHERE session_id=?1",
        [&b.record.session_id],
        |r| r.get(0),
    )?;
    let text = match reason {
        ReviewCloseReason::Cancelled => "cancelled",
        ReviewCloseReason::Deadline => "deadline",
    };
    tx.execute(
        "UPDATE native_repairs SET close_reason=?2,close_sequence=?3 WHERE id=?1",
        params![b.record.id, text, integer(sequence)?],
    )?;
    append(
        tx,
        &b.record.session_id,
        "native_repair_closed",
        &json!({"repair_id":b.record.id,"operation_id":b.operation.id,"reason":reason,"owner":owner}),
    )
}
/// All generic mutation APIs fail closed on any surviving native marker.
/// This includes zero-cost reservations and a deleted/renamed projection.
pub(crate) fn forbid_generic(conn: &Connection, session: &str) -> Result<()> {
    let marked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM native_repairs WHERE session_id=?1) OR EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND generation LIKE 'native-repair:%') OR EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind IN ('native_repair_created','native_repair_closed','native_repair_preparation_started','native_repair_source_bound','native_repair_effect_started')) OR EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='command_admitted' AND json_valid(payload) AND json_extract(payload,'$.payload.kind')='native_source_repair') OR EXISTS(SELECT 1 FROM operations WHERE session_id=?1 AND json_valid(payload) AND json_extract(payload,'$.kind')='native_source_repair')",[session],|r|r.get(0))?;
    if marked {
        return Err(bad(
            "generic capabilities cannot widen native repair authority",
        ));
    }
    Ok(())
}
impl Store {
    pub fn admit_native_repair(
        &mut self,
        command: &str,
        owner: &str,
        a: &NativeRepairAdmission,
    ) -> Result<AdmittedNativeRepair> {
        id(command)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(b) = by_command(&tx, command)? {
            if hash(&a.authorization)? != b.record.authorization_sha256
                || a.reproduction_operation_id != b.record.reproduction_operation_id
                || a.reproduction_evidence_sha256 != b.record.reproduction_evidence_sha256
            {
                return Err(bad("command reused with changed authorization"));
            }
            return Ok(AdmittedNativeRepair {
                record: b.record,
                operation: b.operation,
                duplicate: true,
            });
        }
        epoch(&tx, owner)?;
        validate(a)?;
        source(&tx, a)?;
        let created = now()?;
        let deadline = created
            .checked_add(a.authorization.deadline_ms)
            .ok_or_else(|| bad("deadline overflow"))?;
        integer(deadline)?;
        let value = intent(a, command, created, deadline);
        let bytes = encode(&value)?;
        if bytes.len() > MAX_INTENT {
            return Err(bad("intent byte bound"));
        }
        let digest = hash(&value)?;
        let session = zero_protocol::session::Session {
            id: a.session_id.clone(),
            generation: format!("native-repair:{}", a.id),
            generation_epoch: None,
            created_at_ms: created,
            budget_limit: 0,
        };
        tx.execute(
            "INSERT INTO sessions(id,generation,created_at_ms,budget_limit) VALUES(?1,?2,?3,0)",
            params![session.id, session.generation, integer(created)?],
        )?;
        append(
            &tx,
            &session.id,
            "session_created",
            &serde_json::to_value(&session)?,
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
            params![digest, bytes],
        )?;
        if crate::artifacts::read(&tx, &digest)? != bytes {
            return Err(bad("intent artifact collision"));
        }
        let payload = json!({"kind":"native_source_repair","command_id":command,"repair_id":a.id,"intent_sha256":digest});
        let text = String::from_utf8(encode(&payload)?).map_err(bad)?;
        let payload_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let mut operation = Operation {
            id: a.operation_id.clone(),
            session_id: session.id.clone(),
            command_id: format!("native-repair:{}", a.id),
            payload,
            status: OperationStatus::Admitted,
            owner: None,
            outcome: None,
        };
        tx.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES(?1,?2,?3,?4,?5,'admitted')",params![operation.id,operation.session_id,operation.command_id,text,payload_hash])?;
        append(
            &tx,
            &session.id,
            "command_admitted",
            &serde_json::to_value(&operation)?,
        )?;
        tx.execute(
            "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
            params![operation.id, owner],
        )?;
        operation.status = OperationStatus::Running;
        operation.owner = Some(owner.into());
        append(
            &tx,
            &session.id,
            "operation_started",
            &serde_json::to_value(&operation)?,
        )?;
        tx.execute("INSERT INTO operation_artifacts(operation_id,name,digest) VALUES(?1,'native_repair.intent',?2)",params![operation.id,digest])?;
        append(
            &tx,
            &session.id,
            "operation_artifact",
            &json!({"operation_id":operation.id,"name":"native_repair.intent","digest":digest,"bytes":bytes.len()}),
        )?;
        let sequence: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM native_repairs",
            [],
            |r| r.get(0),
        )?;
        let record = NativeRepairRecord {
            schema_version: 1,
            id: a.id.clone(),
            command_id: command.into(),
            session_id: session.id.clone(),
            operation_id: operation.id.clone(),
            source_reproduction_id: a.authorization.reproduction_id.clone(),
            reproduction_operation_id: a.reproduction_operation_id.clone(),
            reproduction_evidence_sha256: a.reproduction_evidence_sha256.clone(),
            authorization_sha256: hash(&a.authorization)?,
            intent_sha256: digest,
            created_at_ms: created,
            deadline_at_ms: deadline,
            sequence,
        };
        let binding_sequence: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM events WHERE session_id=?1",
            [&session.id],
            |r| r.get(0),
        )?;
        tx.execute("INSERT INTO native_repairs(sequence,id,command_id,session_id,operation_id,source_reproduction_id,intent_sha256,record,binding_sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![integer(sequence)?,record.id,command,session.id,operation.id,record.source_reproduction_id,record.intent_sha256,String::from_utf8(encode(&record)?).map_err(bad)?,integer(binding_sequence)?])?;
        append(
            &tx,
            &session.id,
            "native_repair_created",
            &serde_json::to_value(&record)?,
        )?;
        tx.commit()?;
        Ok(AdmittedNativeRepair {
            record,
            operation,
            duplicate: false,
        })
    }
    pub fn native_repair(&self, key: &str) -> Result<AdmittedNativeRepair> {
        let tx = self.conn.unchecked_transaction()?;
        let b = bound(&tx, key, &mut Reader::new())?;
        Ok(AdmittedNativeRepair {
            record: b.record,
            operation: b.operation,
            duplicate: false,
        })
    }
    pub fn native_repair_by_session(&self, session: &str) -> Result<Option<NativeRepairRecord>> {
        id(session)?;
        let tx = self.conn.unchecked_transaction()?;
        let key: Option<String> = tx.query_row("SELECT CASE WHEN length(id)<=256 THEN id END FROM native_repairs WHERE session_id=?1", [session], |r| r.get(0)).optional()?;
        match key {
            Some(key) => Ok(Some(bound(&tx, &key, &mut Reader::new())?.record)),
            None => {
                forbid_generic(&tx, session)?;
                Ok(None)
            }
        }
    }
    pub fn native_repair_by_command(&self, command: &str) -> Result<Option<NativeRepairRecord>> {
        let tx = self.conn.unchecked_transaction()?;
        Ok(by_command(&tx, command)?.map(|b| b.record))
    }
    /// A validated read used to classify rejected next-case admission. This does
    /// not create a close receipt or give permission to replay any operation.
    pub fn native_repair_closed(&self, key: &str) -> Result<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let b = bound(&tx, key, &mut Reader::new())?;
        Ok(b.close.is_some() || now()? >= b.record.deadline_at_ms)
    }

    pub fn stop_native_repair(
        &mut self,
        key: &str,
        owner: &str,
        reason: ReviewCloseReason,
    ) -> Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let b = bound(&tx, key, &mut Reader::new())?;
        if b.close.is_some() || b.operation.status != OperationStatus::Running {
            return Ok(false);
        }
        epoch(&tx, owner)?;
        if b.operation.owner.as_deref() != Some(owner)
            || (reason == ReviewCloseReason::Deadline && now()? < b.record.deadline_at_ms)
        {
            return Err(bad("stop owner or deadline differs"));
        }
        close_in_transaction(&tx, &b, owner, reason)?;
        tx.commit()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod authority_tests;
