//! Immutable host decisions, separate from execution command IDs and verification.
use crate::{Error, Result, Store, append, integer};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    time::{SystemTime, UNIX_EPOCH},
};
use zero_protocol::{
    source::{Hypothesis, ReviewResult, VerificationState},
    triage::{
        SourceFindingRecord as Record, SourceFindingStatus as Status, TriageDecision as Decision,
    },
};
const REVIEW_BYTES: usize = 4 * 1024 * 1024;
// Leave room for the protocol response envelope around the bounded payload.
const PAGE_BYTES: usize = 1024 * 1024 - 4096;
const SELECT: &str = "SELECT id,command_id,session_id,source_operation_id,hypothesis_id,source_review_sha256,revision,status,CASE WHEN length(CAST(note AS BLOB))<=4096 THEN note END,created_at_ms FROM source_triage_decisions";
fn status(s: Status) -> &'static str {
    match s {
        Status::New => "new",
        Status::Accepted => "accepted",
        Status::Suppressed => "suppressed",
    }
}
fn decision_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Decision> {
    let revision: u64 = r.get(6)?;
    let s: String = r.get(7)?;
    let status = match s.as_str() {
        "new" => Status::New,
        "accepted" => Status::Accepted,
        "suppressed" => Status::Suppressed,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let note: Option<String> = r.get(8)?;
    Ok(Decision {
        id: r.get(0)?,
        command_id: r.get(1)?,
        session_id: r.get(2)?,
        source_operation_id: r.get(3)?,
        hypothesis_id: r.get(4)?,
        source_review_sha256: r.get(5)?,
        revision,
        expected_revision: revision
            .checked_sub(1)
            .ok_or(rusqlite::Error::InvalidQuery)?,
        status,
        note: note.ok_or(rusqlite::Error::InvalidQuery)?,
        created_at_ms: r.get(9)?,
    })
}
struct Source {
    digest: String,
    review: ReviewResult,
}
fn source(conn: &Connection, session: &str, id: &str) -> Result<Source> {
    let row=conn.query_row("SELECT session_id,status,json_extract(payload,'$.kind'),CASE WHEN length(CAST(outcome AS BLOB))<=8388608 THEN outcome END FROM operations WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))).optional()?.ok_or_else(||Error::NotFound(id.into()))?;
    if row.0 != session || row.1 != "succeeded" {
        return Err(Error::Conflict(
            "triage requires a succeeded source operation in this session".into(),
        ));
    }
    let value: Value = serde_json::from_str(
        &row.3
            .ok_or_else(|| Error::Invalid("source outcome missing or oversized".into()))?,
    )?;
    let outcome = match row.2.as_deref() {
        Some("source_hypothesis_review") => &value,
        Some("offline_snapshot_agent")
            if value["status"] == "completed"
                && value["error"].is_null()
                && value["source_recovery_path"].is_null() =>
        {
            &value["source_review"]
        }
        _ => {
            return Err(Error::Conflict(
                "operation is not a completed source review".into(),
            ));
        }
    };
    if !outcome["error"].is_null() {
        return Err(Error::Conflict("source review retains an error".into()));
    }
    let digest: String = conn
        .query_row(
            "SELECT digest FROM operation_artifacts WHERE operation_id=?1 AND name='source.review'",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::NotFound("source.review attachment".into()))?;
    let size: usize = conn.query_row(
        "SELECT length(bytes) FROM artifacts WHERE digest=?1",
        [&digest],
        |r| r.get(0),
    )?;
    if size > REVIEW_BYTES {
        return Err(Error::Invalid("source review exceeds 4 MiB".into()));
    }
    let bytes = crate::artifacts::read(conn, &digest)?;
    let review: ReviewResult = serde_json::from_slice(&bytes)?;
    if outcome["artifacts"]["source.review"] != digest
        || serde_json::to_value(&review)? != outcome["review"]
        || review.hypotheses.len() > 32
    {
        return Err(Error::Conflict(
            "retained source review identity mismatch".into(),
        ));
    }
    let mut ids = BTreeSet::new();
    if review.hypotheses.iter().any(|h| {
        !zero_protocol::is_sha256(&h.id)
            || !ids.insert(&h.id)
            || h.state != VerificationState::Unverified
    }) {
        return Err(Error::Invalid(
            "invalid or duplicate source hypothesis identity".into(),
        ));
    }
    // Once triage exists, even a consistently rehashed replacement cannot rebind it.
    let mismatch:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM source_triage_decisions WHERE source_operation_id=?1 AND (session_id<>?2 OR source_review_sha256<>?3))",params![id,session,digest],|r|r.get(0))?;
    if mismatch {
        return Err(Error::Conflict("triage review identity changed".into()));
    }
    Ok(Source { digest, review })
}
fn record(
    conn: &Connection,
    session: &str,
    source_id: &str,
    source: &Source,
    hypothesis: &Hypothesis,
) -> Result<Record> {
    let last=conn.query_row(&format!("{SELECT} WHERE session_id=?1 AND source_operation_id=?2 AND hypothesis_id=?3 ORDER BY revision DESC LIMIT 1"),params![session,source_id,hypothesis.id],decision_row).optional()?;
    let record = Record {
        session_id: session.into(),
        source_operation_id: source_id.into(),
        source_review_sha256: source.digest.clone(),
        hypothesis: hypothesis.clone(),
        status: last.as_ref().map_or(Status::New, |d| d.status),
        revision: last.as_ref().map_or(0, |d| d.revision),
        last_decision: last,
    };
    if serde_json::to_vec(&record)?.len() + 128 > PAGE_BYTES {
        return Err(Error::Invalid(
            "source finding exceeds page byte limit".into(),
        ));
    }
    Ok(record)
}
fn check_reply(record: &Record, decision: &Decision, duplicate: bool) -> Result<()> {
    if serde_json::to_vec(&(record, decision, duplicate))?.len() + 128 > PAGE_BYTES {
        return Err(Error::Invalid(
            "triage decision reply exceeds page byte limit".into(),
        ));
    }
    Ok(())
}
fn finding(conn: &Connection, session: &str, source_id: &str, id: &str) -> Result<Record> {
    let source = source(conn, session, source_id)?;
    let hypothesis = source
        .review
        .hypotheses
        .iter()
        .find(|h| h.id == id)
        .ok_or_else(|| Error::NotFound("hypothesis in retained source review".into()))?;
    record(conn, session, source_id, &source, hypothesis)
}
fn history(
    conn: &Connection,
    record: &Record,
    after: u64,
    limit: u32,
    budget: usize,
) -> Result<Vec<Decision>> {
    if !(1..=100).contains(&limit) {
        return Err(Error::Invalid(
            "triage history page limit must be 1..100".into(),
        ));
    }
    let mut stmt=conn.prepare(&format!("{SELECT} WHERE session_id=?1 AND source_operation_id=?2 AND hypothesis_id=?3 AND revision>?4 ORDER BY revision LIMIT ?5"))?;
    let rows = stmt.query_map(
        params![
            record.session_id,
            record.source_operation_id,
            record.hypothesis.id,
            integer(after)?,
            limit
        ],
        decision_row,
    )?;
    let mut result = Vec::new();
    let mut bytes = 2;
    for row in rows {
        let row = row?;
        if row.source_review_sha256 != record.source_review_sha256 {
            return Err(Error::Conflict(
                "triage history review binding mismatch".into(),
            ));
        }
        let size = serde_json::to_vec(&row)?.len() + 1;
        if bytes + size > budget {
            if result.is_empty() {
                return Err(Error::Invalid(
                    "triage decision exceeds page byte limit".into(),
                ));
            }
            break;
        }
        bytes += size;
        result.push(row);
    }
    Ok(result)
}
impl Store {
    /// Offset counts already-read hypotheses in the immutable retained review order.
    pub fn source_findings(
        &self,
        session: &str,
        source_operation: &str,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Record>> {
        if !(1..=32).contains(&limit) {
            return Err(Error::Invalid(
                "source finding page limit must be 1..32".into(),
            ));
        }
        let tx = self.conn.unchecked_transaction()?;
        let source = source(&tx, session, source_operation)?;
        let mut records = Vec::new();
        let mut bytes = 2;
        for hypothesis in source
            .review
            .hypotheses
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
        {
            let record = record(&tx, session, source_operation, &source, hypothesis)?;
            let size = serde_json::to_vec(&record)?.len() + 1;
            if bytes + size > PAGE_BYTES {
                if records.is_empty() {
                    return Err(Error::Invalid(
                        "source finding exceeds page byte limit".into(),
                    ));
                }
                break;
            }
            bytes += size;
            records.push(record);
        }
        tx.commit()?;
        Ok(records)
    }
    pub fn source_finding(
        &self,
        session: &str,
        source_operation: &str,
        hypothesis_id: &str,
    ) -> Result<Record> {
        let tx = self.conn.unchecked_transaction()?;
        let record = finding(&tx, session, source_operation, hypothesis_id)?;
        tx.commit()?;
        Ok(record)
    }
    pub fn source_finding_history(
        &self,
        session: &str,
        source_operation: &str,
        hypothesis_id: &str,
        after_revision: u64,
        limit: u32,
    ) -> Result<Vec<Decision>> {
        let tx = self.conn.unchecked_transaction()?;
        let record = finding(&tx, session, source_operation, hypothesis_id)?;
        let history = history(&tx, &record, after_revision, limit, PAGE_BYTES)?;
        tx.commit()?;
        Ok(history)
    }
    pub fn source_finding_with_history(
        &self,
        session: &str,
        source_operation: &str,
        hypothesis_id: &str,
        after_revision: u64,
        limit: u32,
    ) -> Result<(Record, Vec<Decision>)> {
        let tx = self.conn.unchecked_transaction()?;
        let record = finding(&tx, session, source_operation, hypothesis_id)?;
        let budget = PAGE_BYTES.saturating_sub(serde_json::to_vec(&record)?.len() + 64);
        let history = history(&tx, &record, after_revision, limit, budget)?;
        tx.commit()?;
        Ok((record, history))
    }
    /// Triage command IDs have their own session namespace. Exact retries return
    /// the original decision alongside the current record, never replay a status.
    #[allow(clippy::too_many_arguments)] // Mirrors the explicit protocol decision identity.
    pub fn triage_source_finding(
        &mut self,
        session: &str,
        command: &str,
        source_operation: &str,
        hypothesis_id: &str,
        status_value: Status,
        expected_revision: u64,
        note: &str,
    ) -> Result<(Record, Decision, bool)> {
        if command.trim().is_empty() || command.len() > 1024 || note.len() > 4096 {
            return Err(Error::Invalid(
                "triage command must be 1..1024 bytes and note at most 4 KiB".into(),
            ));
        }
        integer(expected_revision)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = finding(&tx, session, source_operation, hypothesis_id)?;
        let prior = tx
            .query_row(
                &format!("{SELECT} WHERE session_id=?1 AND command_id=?2"),
                params![session, command],
                decision_row,
            )
            .optional()?;
        if let Some(prior) = prior {
            if prior.source_operation_id != source_operation
                || prior.hypothesis_id != hypothesis_id
                || prior.source_review_sha256 != current.source_review_sha256
                || prior.status != status_value
                || prior.expected_revision != expected_revision
                || prior.note != note
            {
                return Err(Error::Conflict(
                    "triage command retry changed original intent".into(),
                ));
            }
            check_reply(&current, &prior, true)?;
            tx.commit()?;
            return Ok((current, prior, true));
        }
        if current.revision != expected_revision {
            return Err(Error::Conflict("triage expected_revision is stale".into()));
        }
        let revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| Error::Invalid("triage revision overflow".into()))?;
        integer(revision)?;
        let created_at_ms: u64 = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Invalid("clock before epoch".into()))?
            .as_millis()
            .try_into()
            .map_err(|_| Error::Invalid("clock overflow".into()))?;
        let decision = Decision {
            id: uuid::Uuid::new_v4().to_string(),
            command_id: command.into(),
            session_id: session.into(),
            source_operation_id: source_operation.into(),
            hypothesis_id: hypothesis_id.into(),
            source_review_sha256: current.source_review_sha256.clone(),
            revision,
            expected_revision,
            status: status_value,
            note: note.into(),
            created_at_ms,
        };
        let mut current = current;
        current.status = status_value;
        current.revision = revision;
        current.last_decision = Some(decision.clone());
        check_reply(&current, &decision, false)?;
        tx.execute("INSERT INTO source_triage_decisions(id,session_id,source_operation_id,hypothesis_id,source_review_sha256,revision,command_id,status,note,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![decision.id,session,source_operation,hypothesis_id,decision.source_review_sha256,integer(revision)?,command,status(status_value),note,integer(created_at_ms)?])?;
        append(
            &tx,
            session,
            "source_finding_triaged",
            &serde_json::to_value(&decision)?,
        )?;
        tx.commit()?;
        Ok((current, decision, false))
    }
}
