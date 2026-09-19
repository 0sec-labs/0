//! Host-only one-use Python fixture exposure, bound to paid retained inference.
//! This witness is not production eligibility and is never a model tool.
use crate::{Error, Result, Store, append};
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use zero_protocol::{
    model::{Completion, CompletionStatus, Content, Rates},
    session::{BudgetSnapshot, OperationStatus},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PythonHoldoutClaim {
    pub session_id: String,
    pub command_id: String,
    pub operation_id: String,
    pub request_sha256: String,
    pub intent_sha256: String,
    pub suite_sha256: String,
    pub candidate_sha256: String,
    pub source_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PythonHoldoutReceipt {
    pub schema_version: u32,
    pub claim: PythonHoldoutClaim,
    pub budget: BudgetSnapshot,
    pub proposal_charge: u64,
    pub sequence: u64,
    pub receipt_sha256: String,
}
/// Only a verified retained Store witness constructs this host capability.
/// It authorizes one private controller's evaluation, never production activation.
pub struct VerifiedPythonHoldout(PythonHoldoutReceipt);
impl VerifiedPythonHoldout {
    pub fn receipt(&self) -> &PythonHoldoutReceipt {
        &self.0
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn validate(claim: &PythonHoldoutClaim) -> Result<()> {
    for id in [&claim.session_id, &claim.command_id, &claim.operation_id] {
        if id.is_empty() || id.len() > 256 {
            return Err(invalid("Python proposal identity bound"));
        }
    }
    for digest in [
        &claim.request_sha256,
        &claim.intent_sha256,
        &claim.suite_sha256,
        &claim.candidate_sha256,
        &claim.source_sha256,
    ] {
        if !zero_protocol::is_sha256(digest) {
            return Err(invalid("Python proposal digest invalid"));
        }
    }
    Ok(())
}
fn settled_inference(
    conn: &Connection,
    session: &str,
    command: &str,
    operation_id: &str,
    request_sha: &str,
) -> Result<(zero_protocol::session::Operation, u64)> {
    crate::admission_closure::validate(conn, &session)?;
    let size: usize = conn.query_row("SELECT length(CAST(payload AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0) FROM operations WHERE id=?1", [&operation_id], |r|r.get(0))?;
    if size > 2 * 1024 * 1024 {
        return Err(invalid("Python proposal operation exceeds bound"));
    }
    let operation = crate::operations::operation(conn, &operation_id)?;
    if operation.session_id != session
        || operation.command_id != command
        || operation.status != OperationStatus::Succeeded
    {
        return Err(invalid(
            "Python proposal inference not successful or identity differs",
        ));
    }
    if !matches!(
        operation.payload["kind"].as_str(),
        Some(
            "responses_inference"
                | "chat_inference"
                | "anthropic_inference"
                | "google_inference"
                | "ollama_inference"
        )
    ) || hash(&serde_json::to_vec(&operation.payload["request"])?) != request_sha
    {
        return Err(invalid("Python proposal retained request differs"));
    }
    let mut witnesses=conn.prepare("SELECT CASE WHEN length(CAST(payload AS BLOB))<=2097152 THEN payload END FROM events WHERE session_id=?1 AND kind='operation_settled' AND json_extract(payload,'$.id')=?2 LIMIT 2")?;
    let rows = witnesses
        .query_map(params![session, operation_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() != 1
        || serde_json::from_str::<zero_protocol::session::Operation>(&rows[0])? != operation
    {
        return Err(invalid("Python proposal settlement witness differs"));
    }
    let completion: Completion = serde_json::from_value(
        operation
            .outcome
            .clone()
            .ok_or_else(|| invalid("proposal outcome missing"))?,
    )?;
    if completion.status != CompletionStatus::Completed
        || !completion.usage_is_final
        || completion.error.is_some()
    {
        return Err(invalid("Python proposal requires completed final usage"));
    }
    let rates: Rates = serde_json::from_value(operation.payload["rates"].clone())?;
    let charge = completion
        .usage
        .as_ref()
        .and_then(|u| rates.charge(u))
        .ok_or_else(|| invalid("Python proposal usage is not usable"))?;
    let settled: Option<u64> = conn.query_row(
        "SELECT charged FROM reservations WHERE session_id=?1 AND id=?2",
        params![session, operation_id],
        |r| r.get(0),
    )?;
    let witnesses:u64=conn.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND kind='budget_settled' AND json_extract(payload,'$.reservation_id')=?2 AND json_extract(payload,'$.charged')=?3",params![session,operation_id,charge],|r|r.get(0))?;
    if witnesses != 1 || settled != Some(charge) {
        return Err(invalid(
            "Python proposal accounting is unsettled or changed",
        ));
    }
    Ok((operation, charge))
}
fn retained(conn: &Connection, claim: &PythonHoldoutClaim) -> Result<u64> {
    let (operation, charge) = settled_inference(
        conn,
        &claim.session_id,
        &claim.command_id,
        &claim.operation_id,
        &claim.request_sha256,
    )?;
    let completion: Completion = serde_json::from_value(
        operation
            .outcome
            .ok_or_else(|| invalid("proposal outcome missing"))?,
    )?;
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|c| match c {
            Content::ToolCall {
                name, arguments, ..
            } => Some((name, arguments)),
            _ => None,
        })
        .collect();
    if calls.len() != 1 || calls[0].0 != "submit_python_candidate" {
        return Err(invalid(
            "Python proposal requires one submit_python_candidate call",
        ));
    }
    let output = calls[0]
        .1
        .as_object()
        .ok_or_else(|| invalid("Python proposal arguments"))?;
    let source = output
        .get("source_utf8")
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid("Python proposal source missing"))?;
    let rationale = output
        .get("rationale")
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid("Python proposal rationale missing"))?;
    if output.len() != 3
        || output.get("action").and_then(|v| v.as_str()) != Some("propose")
        || source.is_empty()
        || source.len() > 32768
        || source.contains('\0')
        || rationale.is_empty()
        || rationale.len() > 4096
        || hash(source.as_bytes()) != claim.source_sha256
    {
        return Err(invalid("Python proposal source-only identity differs"));
    }
    Ok(charge)
}
fn marker(suite: &str) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(
        &json!({"schema_version":1,"kind":"python_holdout_consumed","suite_sha256":suite}),
    )?)
}
fn receipt_hash(receipt: &PythonHoldoutReceipt) -> Result<String> {
    let mut value = receipt.clone();
    value.receipt_sha256.clear();
    Ok(hash(&serde_json::to_vec(&value)?))
}
fn existing(conn: &Connection, claim: &PythonHoldoutClaim) -> Result<Option<PythonHoldoutReceipt>> {
    let marker_bytes = marker(&claim.suite_sha256)?;
    let marker_digest = hash(&marker_bytes);
    let present: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM artifacts WHERE digest=?1)",
        [&marker_digest],
        |r| r.get(0),
    )?;
    let mut query=conn.prepare("SELECT session_id,sequence,CASE WHEN length(CAST(payload AS BLOB))<=8192 THEN payload END FROM events WHERE kind='python_holdout_exposed' AND (json_extract(payload,'$.claim.suite_sha256')=?1 OR json_extract(payload,'$.claim.operation_id')=?2) LIMIT 2")?;
    let rows = query
        .query_map(params![claim.suite_sha256, claim.operation_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.is_empty() && !present {
        return Ok(None);
    }
    if rows.len() != 1 || !present || crate::artifacts::read(conn, &marker_digest)? != marker_bytes
    {
        return Err(invalid("Python holdout witness missing or inconsistent"));
    }
    let (session, sequence, raw) = &rows[0];
    let receipt: PythonHoldoutReceipt = serde_json::from_str(raw)?;
    if receipt.schema_version != 1
        || receipt.claim != *claim
        || receipt.claim.session_id != *session
        || receipt.sequence != *sequence
        || receipt.receipt_sha256 != receipt_hash(&receipt)?
        || crate::artifacts::read(conn, &receipt.receipt_sha256)?
            != serde_json::to_vec(&{
                let mut unsigned = receipt.clone();
                unsigned.receipt_sha256.clear();
                unsigned
            })?
    {
        return Err(invalid(
            "Python holdout already exposed or receipt integrity mismatch",
        ));
    }
    if receipt.proposal_charge != retained(conn, claim)?
        || receipt.budget.reserved != 0
        || receipt.budget.charged > receipt.budget.limit
    {
        return Err(invalid(
            "Python holdout proposal accounting witness differs",
        ));
    }
    Ok(Some(receipt))
}
impl Store {
    pub fn claim_python_holdout(
        &mut self,
        owner: &str,
        claim: &PythonHoldoutClaim,
    ) -> Result<VerifiedPythonHoldout> {
        validate(claim)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let epoch: String = tx.query_row(
            "SELECT owner FROM engine_epoch WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        if epoch != owner {
            return Err(invalid("Python holdout owner is not current engine epoch"));
        }
        if let Some(receipt) = existing(&tx, claim)? {
            return Ok(VerifiedPythonHoldout(receipt));
        }
        crate::campaign::forbid_input(&tx, &claim.session_id)?;
        crate::scan::forbid_input(&tx, &claim.session_id)?;
        crate::review::forbid_input(&tx, &claim.session_id)?;
        crate::strategy_session::forbid_queue(&tx, &claim.session_id)?;
        let charge = retained(&tx, claim)?;
        let budget = crate::budget::snapshot(&tx, &claim.session_id)?;
        if budget.reserved != 0 || budget.charged > budget.limit {
            return Err(Error::BudgetExceeded);
        }
        let sequence: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM events WHERE session_id=?1",
            [&claim.session_id],
            |r| r.get(0),
        )?;
        let mut receipt = PythonHoldoutReceipt {
            schema_version: 1,
            claim: claim.clone(),
            budget,
            proposal_charge: charge,
            sequence,
            receipt_sha256: String::new(),
        };
        let unsigned = serde_json::to_vec(&receipt)?;
        receipt.receipt_sha256 = hash(&unsigned);
        for bytes in [marker(&claim.suite_sha256)?, unsigned] {
            let digest = hash(&bytes);
            tx.execute(
                "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
                params![digest, bytes],
            )?;
            if crate::artifacts::read(&tx, &digest)? != bytes {
                return Err(invalid("Python exposure artifact collision"));
            }
        }
        append(
            &tx,
            &claim.session_id,
            "python_holdout_exposed",
            &serde_json::to_value(&receipt)?,
        )?;
        tx.commit()?;
        Ok(VerifiedPythonHoldout(receipt))
    }
    pub fn verify_python_holdout(
        &self,
        claim: &PythonHoldoutClaim,
    ) -> Result<VerifiedPythonHoldout> {
        validate(claim)?;
        let tx = self.conn.unchecked_transaction()?;
        let receipt =
            existing(&tx, claim)?.ok_or_else(|| invalid("Python holdout witness absent"))?;
        tx.commit()?;
        Ok(VerifiedPythonHoldout(receipt))
    }
}

/// Original-account witness for Development-only search experiments.
/// It carries no private-suite or production activation permission.
pub struct VerifiedPythonSearchInference {
    operation: zero_protocol::session::Operation,
    charge: u64,
    budget: BudgetSnapshot,
}
impl VerifiedPythonSearchInference {
    pub fn operation(&self) -> &zero_protocol::session::Operation {
        &self.operation
    }
    pub fn charge(&self) -> u64 {
        self.charge
    }
    pub fn budget(&self) -> &BudgetSnapshot {
        &self.budget
    }
}
impl Store {
    pub fn verify_python_search_inference(
        &self,
        owner: &str,
        session: &str,
        command: &str,
        operation_id: &str,
        request_sha: &str,
    ) -> Result<VerifiedPythonSearchInference> {
        if [session, command, operation_id]
            .iter()
            .any(|v| v.is_empty() || v.len() > 256)
            || !zero_protocol::is_sha256(request_sha)
        {
            return Err(invalid("Python search identity bound"));
        }
        let tx = self.conn.unchecked_transaction()?;
        let epoch: String = tx.query_row(
            "SELECT owner FROM engine_epoch WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        if epoch != owner {
            return Err(invalid("Python search owner is not current engine epoch"));
        }
        crate::campaign::forbid_input(&tx, session)?;
        crate::scan::forbid_input(&tx, session)?;
        crate::review::forbid_input(&tx, session)?;
        crate::strategy_session::forbid_queue(&tx, session)?;
        let (operation, charge) =
            settled_inference(&tx, session, command, operation_id, request_sha)?;
        let budget = crate::budget::snapshot(&tx, session)?;
        if budget.reserved != 0 || budget.charged > budget.limit {
            return Err(Error::BudgetExceeded);
        }
        tx.commit()?;
        Ok(VerifiedPythonSearchInference {
            operation,
            charge,
            budget,
        })
    }
}

impl Store {
    /// Read-only original inference/accounting proof. This returns no execution capability.
    pub fn inspect_python_search_inference(
        &self,
        session: &str,
        command: &str,
        operation_id: &str,
        request_sha: &str,
    ) -> Result<u64> {
        let tx = self.conn.unchecked_transaction()?;
        let (_, charge) = settled_inference(&tx, session, command, operation_id, request_sha)?;
        tx.commit()?;
        Ok(charge)
    }
}
