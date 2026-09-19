//! Independent host authorization for an archive-backed reproduction.
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
    agent::{AgentRequest, AgentResult, AgentStatus},
    review::ReviewCloseReason,
    review_reproduction::{NativeReproductionRecord, ReviewReproductionPlan},
    verification::{ReproductionOutcome, ReproductionStop},
};
use zero_verification::FrozenPlan;
mod authority;
mod read;
pub(crate) use read::{capture_snapshot, capture_snapshot_with_extra_session, evidence_digest};
const MAX_INTENT: usize = 2 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeReproductionAdmission {
    pub id: String,
    pub session_id: String,
    pub operation_id: String,
    pub authorization: ReviewReproductionPlan,
    /// Hash of the complete source operation independently validated by Engine.
    pub source_operation_sha256: String,
}
pub struct AdmittedNativeReproduction {
    pub record: NativeReproductionRecord,
    pub operation: Operation,
    pub duplicate: bool,
}
fn bad(value: impl std::fmt::Display) -> Error {
    Error::Conflict(format!("native reproduction: {value}"))
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
fn validate(a: &NativeReproductionAdmission) -> Result<FrozenPlan> {
    let ids = [&a.id, &a.session_id, &a.operation_id];
    if ids.iter().collect::<std::collections::BTreeSet<_>>().len() != 3 {
        return Err(bad("duplicate identities"));
    }
    for value in ids {
        if uuid::Uuid::parse_str(value).map_err(bad)?.to_string() != *value {
            return Err(bad("noncanonical identity"));
        }
    }
    a.authorization.validate_envelope().map_err(bad)?;
    if !zero_protocol::is_sha256(&a.source_operation_sha256) || encode(a)?.len() > MAX_INTENT - 1024
    {
        return Err(bad("admission identity or bound"));
    }
    FrozenPlan::new(a.authorization.plan.clone()).map_err(bad)
}
fn source(conn: &Connection, a: &NativeReproductionAdmission, r: &mut Reader) -> Result<String> {
    let review = crate::review::snapshot_source_record(conn, &a.authorization.review_id)?;
    let root = workflow::operation(conn, &review.root_operation_id, r)?;
    let controller = workflow::operation(conn, &review.controller_operation_id, r)?;
    if review.root_operation_id != a.authorization.source_operation_id
        || root.status != OperationStatus::Succeeded
        || matches!(
            controller.status,
            OperationStatus::Admitted | OperationStatus::Running
        )
        || hash(&root)? != a.source_operation_sha256
    {
        return Err(bad(
            "source must be the exact independently validated drained review",
        ));
    }
    let request: AgentRequest = serde_json::from_value(root.payload["request"].clone())?;
    let result: AgentResult = serde_json::from_value(
        root.outcome
            .clone()
            .ok_or_else(|| bad("source outcome absent"))?,
    )?;
    if result.status != AgentStatus::Completed
        || result.error.is_some()
        || result.source_recovery_path.is_some()
        || serde_json::to_value(request.snapshot_request().map_err(bad)?.snapshot)?
            != serde_json::to_value(&a.authorization.plan.snapshot)?
    {
        return Err(bad("source actor or snapshot differs"));
    }
    let outcome = result
        .source_review
        .ok_or_else(|| bad("structured source submission absent"))?;
    let review_result = outcome
        .review
        .ok_or_else(|| bad("structured source result absent"))?;
    if outcome.error.is_some()
        || review_result.bundle_sha256 != a.authorization.plan.source_bundle_digest
        || !review_result
            .hypotheses
            .iter()
            .any(|h| h.id == a.authorization.plan.hypothesis_id)
    {
        return Err(bad("source bundle or hypothesis differs"));
    }
    for name in ["source.bundle", "source.review"] {
        let digest:String=conn.query_row("SELECT CASE WHEN length(digest)=71 THEN digest END FROM operation_artifacts WHERE operation_id=?1 AND name=?2",params![root.id,name],|r|r.get(0))?;
        if outcome.artifacts.get(name) != Some(&digest) {
            return Err(bad("source artifact reference differs"));
        }
        if name == "source.bundle" && digest != a.authorization.plan.source_bundle_digest {
            return Err(bad("source bundle attachment differs"));
        }
        if name == "source.bundle" {
            r.artifact(conn, &digest, MAX_INTENT)?;
        }
        if name == "source.review"
            && serde_json::from_slice::<Value>(&r.artifact(conn, &digest, MAX_INTENT)?)?
                != serde_json::to_value(&review_result)?
        {
            return Err(bad("source review attachment differs"));
        }
    }
    let manifest = crate::source_archive::manifest_for_record(conn, &review)?
        .ok_or_else(|| bad("complete source archive absent"))?;
    if hash(&manifest)? != a.authorization.archive_manifest_sha256 {
        return Err(bad("archive manifest differs"));
    }
    if a.session_id == review.session_id
        || a.operation_id == root.id
        || a.operation_id == controller.id
    {
        return Err(bad("followup must have independent ownership"));
    }
    Ok(review.session_id)
}
fn intent(a: &NativeReproductionAdmission, command: &str, created: u64, deadline: u64) -> Value {
    json!({"schema_version":1,"kind":"native_reproduction_intent","command_id":command,"created_at_ms":created,"deadline_at_ms":deadline,"admission":a})
}
struct Bound {
    record: NativeReproductionRecord,
    admission: NativeReproductionAdmission,
    operation: Operation,
    close: Option<ReviewCloseReason>,
}
fn bound(conn: &Connection, key: &str, r: &mut Reader) -> Result<Bound> {
    id(key)?;
    let (raw,sequence,close,close_sequence):(String,u64,Option<String>,Option<u64>)=conn.query_row("SELECT CASE WHEN length(CAST(record AS BLOB))<=65536 THEN record END,binding_sequence,close_reason,close_sequence FROM native_reproductions WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or_else(||Error::NotFound(key.into()))?;
    r.charge(raw.len(), 65536)?;
    let record: NativeReproductionRecord = serde_json::from_str(&raw)?;
    let matches:bool=conn.query_row("SELECT id=?2 AND command_id=?3 AND session_id=?4 AND operation_id=?5 AND source_review_id=?6 AND intent_sha256=?7 AND sequence=?8 FROM native_reproductions WHERE id=?1",params![key,record.id,record.command_id,record.session_id,record.operation_id,record.source_review_id,record.intent_sha256,integer(record.sequence)?],|r|r.get(0))?;
    let global:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY native_reproduction_command WHERE kind='native_reproduction_created' AND json_extract(payload,'$.command_id')=?1",[&record.command_id],|r|r.get(0))?;
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='native_reproduction_created'",
        [&record.session_id],
        |r| r.get(0),
    )?;
    let (kind, witness) = r.event(conn, &record.session_id, sequence)?;
    if !matches
        || record.schema_version != 1
        || global != 1
        || count != 1
        || kind != "native_reproduction_created"
        || witness != serde_json::to_value(&record)?
    {
        return Err(bad("catalog or creation witness differs"));
    }
    let bytes = r.artifact(conn, &record.intent_sha256, MAX_INTENT)?;
    let captured: Value = serde_json::from_slice(&bytes)?;
    let a: NativeReproductionAdmission = serde_json::from_value(captured["admission"].clone())?;
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
        || a.authorization.review_id != record.source_review_id
        || a.authorization.source_operation_id != record.source_operation_id
        || a.source_operation_sha256 != record.source_operation_sha256
        || hash(&a.authorization)? != record.authorization_sha256
        || record.deadline_at_ms != deadline
        || source(conn, &a, r)? != record.source_session_id
    {
        return Err(bad("immutable authority differs"));
    }
    let session = crate::get_session(conn, &record.session_id)?;
    if session.generation != format!("native-reproduction:{}", record.id)
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
        || operation.command_id != format!("native-reproduction:{}", record.id)
        || operation.payload
            != json!({"kind":"native_source_reproduction","command_id":record.command_id,"reproduction_id":record.id,"intent_sha256":record.intent_sha256})
    {
        return Err(bad("parent authority differs"));
    }
    let attachment:String=conn.query_row("SELECT digest FROM operation_artifacts WHERE operation_id=?1 AND name='native_reproduction.intent'",[&operation.id],|r|r.get(0))?;
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
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='native_reproduction_closed'",
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
            let expected = json!({"reproduction_id":record.id,"operation_id":operation.id,"reason":reason,"owner":operation.owner});
            if seq <= sequence
                || r.event(conn, &session.id, seq)?
                    != ("native_reproduction_closed".into(), expected)
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
    authority::validate_bound_source(conn, &b, r)?;
    Ok(b)
}
fn by_command(conn: &Connection, command: &str) -> Result<Option<Bound>> {
    id(command)?;
    let key:Option<String>=conn.query_row("SELECT CASE WHEN length(id)<=256 THEN id END FROM native_reproductions WHERE command_id=?1",[command],|r|r.get(0)).optional()?;
    let count:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY native_reproduction_command WHERE kind='native_reproduction_created' AND json_extract(payload,'$.command_id')=?1",[command],|r|r.get(0))?;
    let parents:u64=conn.query_row("SELECT count(*) FROM operations INDEXED BY native_reproduction_parent_command WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.kind') END='native_source_reproduction' AND json_extract(payload,'$.command_id')=?1",[command],|r|r.get(0))?;
    let admissions:u64=conn.query_row("SELECT count(*) FROM events INDEXED BY native_reproduction_admission_command WHERE kind='command_admitted' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.payload.kind') END='native_source_reproduction' AND json_extract(payload,'$.payload.command_id')=?1",[command],|r|r.get(0))?;
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
        "UPDATE native_reproductions SET close_reason=?2,close_sequence=?3 WHERE id=?1",
        params![b.record.id, text, integer(sequence)?],
    )?;
    append(
        tx,
        &b.record.session_id,
        "native_reproduction_closed",
        &json!({"reproduction_id":b.record.id,"operation_id":b.operation.id,"reason":reason,"owner":owner}),
    )
}
/// All generic mutation APIs fail closed on any surviving native marker.
/// This includes zero-cost reservations and a deleted/renamed projection.
pub(crate) fn forbid_generic(conn: &Connection, session: &str) -> Result<()> {
    crate::native_repair::forbid_generic(conn, session)?;
    forbid_membership(conn, session)
}
// Membership probes must not reject a different workflow before its own
// cancellation handler can inspect it. Mutation fences above cover both.
fn forbid_membership(conn: &Connection, session: &str) -> Result<()> {
    let marked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM native_reproductions WHERE session_id=?1) OR EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND generation LIKE 'native-reproduction:%') OR EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind IN ('native_reproduction_created','native_reproduction_closed','native_reproduction_preparation_started','native_reproduction_source_bound','native_reproduction_effect_started')) OR EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='command_admitted' AND json_valid(payload) AND json_extract(payload,'$.payload.kind')='native_source_reproduction') OR EXISTS(SELECT 1 FROM operations WHERE session_id=?1 AND json_valid(payload) AND json_extract(payload,'$.kind')='native_source_reproduction')",[session],|r|r.get(0))?;
    if marked {
        return Err(bad(
            "generic capabilities cannot widen native reproduction authority",
        ));
    }
    Ok(())
}
pub(crate) fn authorization_record(
    conn: &Connection,
    key: &str,
    reader: &mut Reader,
) -> Result<(NativeReproductionRecord, ReviewReproductionPlan)> {
    let b = bound(conn, key, reader)?;
    Ok((b.record, b.admission.authorization))
}
impl Store {
    pub fn admit_native_reproduction(
        &mut self,
        command: &str,
        owner: &str,
        a: &NativeReproductionAdmission,
    ) -> Result<AdmittedNativeReproduction> {
        id(command)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(b) = by_command(&tx, command)? {
            if hash(&a.authorization)? != b.record.authorization_sha256 {
                return Err(bad("command reused with changed authorization"));
            }
            return Ok(AdmittedNativeReproduction {
                record: b.record,
                operation: b.operation,
                duplicate: true,
            });
        }
        epoch(&tx, owner)?;
        validate(a)?;
        let source_session = source(&tx, a, &mut Reader::new())?;
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
            generation: format!("native-reproduction:{}", a.id),
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
        let payload = json!({"kind":"native_source_reproduction","command_id":command,"reproduction_id":a.id,"intent_sha256":digest});
        let text = String::from_utf8(encode(&payload)?).map_err(bad)?;
        let payload_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let mut operation = Operation {
            id: a.operation_id.clone(),
            session_id: session.id.clone(),
            command_id: format!("native-reproduction:{}", a.id),
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
        tx.execute("INSERT INTO operation_artifacts(operation_id,name,digest) VALUES(?1,'native_reproduction.intent',?2)",params![operation.id,digest])?;
        append(
            &tx,
            &session.id,
            "operation_artifact",
            &json!({"operation_id":operation.id,"name":"native_reproduction.intent","digest":digest,"bytes":bytes.len()}),
        )?;
        let sequence: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM native_reproductions",
            [],
            |r| r.get(0),
        )?;
        let record = NativeReproductionRecord {
            schema_version: 1,
            id: a.id.clone(),
            command_id: command.into(),
            session_id: session.id.clone(),
            operation_id: operation.id.clone(),
            source_review_id: a.authorization.review_id.clone(),
            source_session_id: source_session,
            source_operation_id: a.authorization.source_operation_id.clone(),
            source_operation_sha256: a.source_operation_sha256.clone(),
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
        tx.execute("INSERT INTO native_reproductions(sequence,id,command_id,session_id,operation_id,source_review_id,intent_sha256,record,binding_sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![integer(sequence)?,record.id,command,session.id,operation.id,record.source_review_id,record.intent_sha256,String::from_utf8(encode(&record)?).map_err(bad)?,integer(binding_sequence)?])?;
        append(
            &tx,
            &session.id,
            "native_reproduction_created",
            &serde_json::to_value(&record)?,
        )?;
        tx.commit()?;
        Ok(AdmittedNativeReproduction {
            record,
            operation,
            duplicate: false,
        })
    }
    pub fn native_reproduction(&self, key: &str) -> Result<AdmittedNativeReproduction> {
        let tx = self.conn.unchecked_transaction()?;
        let b = bound(&tx, key, &mut Reader::new())?;
        Ok(AdmittedNativeReproduction {
            record: b.record,
            operation: b.operation,
            duplicate: false,
        })
    }
    pub fn native_reproduction_by_session(
        &self,
        session: &str,
    ) -> Result<Option<NativeReproductionRecord>> {
        id(session)?;
        let tx = self.conn.unchecked_transaction()?;
        let key: Option<String> = tx.query_row("SELECT CASE WHEN length(id)<=256 THEN id END FROM native_reproductions WHERE session_id=?1", [session], |r| r.get(0)).optional()?;
        match key {
            Some(key) => Ok(Some(bound(&tx, &key, &mut Reader::new())?.record)),
            None => {
                forbid_membership(&tx, session)?;
                Ok(None)
            }
        }
    }
    pub fn native_reproduction_by_command(
        &self,
        command: &str,
    ) -> Result<Option<NativeReproductionRecord>> {
        let tx = self.conn.unchecked_transaction()?;
        Ok(by_command(&tx, command)?.map(|b| b.record))
    }
    /// A validated read used to classify rejected next-case admission. This does
    /// not create a close receipt or give permission to replay any operation.
    pub fn native_reproduction_closed(&self, key: &str) -> Result<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let b = bound(&tx, key, &mut Reader::new())?;
        Ok(b.close.is_some() || now()? >= b.record.deadline_at_ms)
    }

    /// Finalize under the same write transaction as close/deadline evaluation.
    /// A won stop cannot be overwritten by a worker's earlier success decision.
    pub fn settle_native_reproduction(
        &mut self,
        key: &str,
        owner: &str,
        proposed: OperationStatus,
        outcome: &ReproductionOutcome,
        cancel_requested: bool,
    ) -> Result<Operation> {
        if !matches!(
            proposed,
            OperationStatus::Succeeded
                | OperationStatus::Failed
                | OperationStatus::Cancelled
                | OperationStatus::Unknown
        ) {
            return Err(bad("finalization requires a terminal proposed status"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let b = bound(&tx, key, &mut Reader::new())?;
        epoch(&tx, owner)?;
        if b.operation.owner.as_deref() != Some(owner)
            || b.operation.status != OperationStatus::Running
        {
            return Err(bad(
                "finalization requires the current owned Running parent",
            ));
        }
        let mut result = outcome.clone();
        let expired = now()? >= b.record.deadline_at_ms;
        let closed = b.close.is_some() || expired || cancel_requested;
        if b.close.is_none() && (expired || cancel_requested) {
            close_in_transaction(
                &tx,
                &b,
                owner,
                if expired {
                    ReviewCloseReason::Deadline
                } else {
                    ReviewCloseReason::Cancelled
                },
            )?;
        }
        let status = if closed && proposed != OperationStatus::Unknown {
            result.stop_reason = Some(ReproductionStop::Cancelled);
            OperationStatus::Cancelled
        } else {
            proposed
        };
        let text = match status {
            OperationStatus::Succeeded => "succeeded",
            OperationStatus::Failed => "failed",
            OperationStatus::Cancelled => "cancelled",
            OperationStatus::Unknown => "unknown",
            _ => return Err(bad("invalid terminal status")),
        };
        let value = serde_json::to_value(result)?;
        let encoded = encode(&value)?;
        if encoded.len() > MAX_INTENT {
            return Err(bad("terminal reproduction outcome exceeds bound"));
        }
        tx.execute(
            "UPDATE operations SET status=?2,outcome=?3 WHERE id=?1",
            params![
                b.operation.id,
                text,
                String::from_utf8(encoded).map_err(bad)?
            ],
        )?;
        let mut operation = b.operation;
        operation.status = status;
        operation.outcome = Some(value);
        append(
            &tx,
            &operation.session_id,
            if status == OperationStatus::Unknown {
                "operation_unknown"
            } else {
                "operation_settled"
            },
            &serde_json::to_value(&operation)?,
        )?;
        tx.commit()?;
        Ok(operation)
    }
    pub fn stop_native_reproduction(
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
