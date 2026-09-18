//! Durable experiment admissions; not a second monetary or HTTP allowance.
use crate::questions::Reads;
use crate::{Error, Operation, Result, append, integer};
use rusqlite::{Connection, Transaction, params};
use serde_json::{Value, json};
use zero_web_verification::FrozenExperiment;
fn invalid() -> Error {
    Error::Conflict("experiment quota or immutable witness differs".into())
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"operation_id":r.get::<_,String>(0)?,"session_id":r.get::<_,String>(1)?,"account_id":r.get::<_,String>(2)?,"policy_sha256":r.get::<_,String>(3)?,"intent_sha256":r.get::<_,String>(4)?,"hypothesis_sha256":r.get::<_,String>(5)?,"sequence":r.get::<_,u64>(6)?}),
    )
}
pub(super) fn check(
    conn: &Connection,
    session: &str,
    frozen: &FrozenExperiment,
    reads: &mut Reads,
) -> Result<Vec<Value>> {
    let account = frozen.intent()["http_context"]["account_id"]
        .as_str()
        .ok_or_else(invalid)?;
    let policy = zero_web_verification::hash(frozen.policy()).map_err(|_| invalid())?;
    let mut stmt=conn.prepare("SELECT CASE WHEN length(CAST(operation_id AS BLOB))<=4096 THEN operation_id END,CASE WHEN length(CAST(session_id AS BLOB))<=4096 THEN session_id END,CASE WHEN length(CAST(account_id AS BLOB))<=71 THEN account_id END,CASE WHEN length(CAST(policy_sha256 AS BLOB))<=71 THEN policy_sha256 END,CASE WHEN length(CAST(intent_sha256 AS BLOB))<=71 THEN intent_sha256 END,CASE WHEN length(CAST(hypothesis_sha256 AS BLOB))<=71 THEN hypothesis_sha256 END,sequence FROM web_experiment_admissions WHERE account_id=?1 ORDER BY sequence LIMIT 33")?;
    let rows = stmt
        .query_map([account], row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > frozen.policy().max_experiments as usize {
        return Err(invalid());
    }
    let mut events=conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='web_experiment_admitted' AND json_extract(payload,'$.account_id')=?2 ORDER BY sequence LIMIT 33")?;
    let sequences = events
        .query_map(params![session, account], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if sequences.len() != rows.len() {
        return Err(invalid());
    }
    for (record, sequence) in rows.iter().zip(sequences) {
        if record["session_id"] != session
            || record["account_id"] != account
            || record["policy_sha256"] != policy
            || record["sequence"] != sequence
            || !record["intent_sha256"]
                .as_str()
                .is_some_and(zero_protocol::is_sha256)
            || !record["hypothesis_sha256"]
                .as_str()
                .is_some_and(zero_protocol::is_sha256)
        {
            return Err(invalid());
        }
        let (kind, witness) = reads.witnesses.event(conn, session, sequence, 16384)?;
        if kind != "web_experiment_admitted" || witness != record {
            return Err(invalid());
        }
    }
    Ok(rows)
}
pub(super) fn require(
    conn: &Connection,
    op: &Operation,
    frozen: &FrozenExperiment,
    reads: &mut Reads,
) -> Result<()> {
    let records = check(conn, &op.session_id, frozen, reads)?;
    let matching = records
        .iter()
        .filter(|r| r["operation_id"] == op.id)
        .collect::<Vec<_>>();
    if matching.len() != 1
        || matching[0]["intent_sha256"] != frozen.intent_sha256()
        || matching[0]["hypothesis_sha256"] != frozen.hypothesis_sha256()
    {
        return Err(invalid());
    }
    Ok(())
}
pub(super) fn admit(
    tx: &Transaction<'_>,
    op: &Operation,
    frozen: &FrozenExperiment,
    reads: &mut Reads,
) -> Result<()> {
    let rows = check(tx, &op.session_id, frozen, reads)?;
    if rows.len() >= frozen.policy().max_experiments as usize {
        return Err(Error::BudgetExceeded);
    }
    if rows.iter().any(|r| r["operation_id"] == op.id) {
        return Err(invalid());
    }
    let sequence = crate::questions::next(tx, &op.session_id)?;
    let account = &frozen.intent()["http_context"]["account_id"];
    let policy = zero_web_verification::hash(frozen.policy()).map_err(|_| invalid())?;
    let record = json!({"operation_id":op.id,"session_id":op.session_id,"account_id":account,"policy_sha256":policy,"intent_sha256":frozen.intent_sha256(),"hypothesis_sha256":frozen.hypothesis_sha256(),"sequence":sequence});
    tx.execute("INSERT INTO web_experiment_admissions(operation_id,session_id,account_id,policy_sha256,intent_sha256,hypothesis_sha256,sequence) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![op.id,op.session_id,account.as_str().ok_or_else(invalid)?,policy,frozen.intent_sha256(),frozen.hypothesis_sha256(),integer(sequence)?])?;
    append(tx, &op.session_id, "web_experiment_admitted", &record)?;
    Ok(())
}
