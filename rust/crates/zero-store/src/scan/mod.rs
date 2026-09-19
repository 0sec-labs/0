//! Atomic standalone scans and immutable session authority.
use crate::workflow::Reader;
use crate::{Error, Operation, OperationStatus, Result, Store, append, integer};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zero_protocol::{campaign::CampaignProviderContext, managed_scan::ManagedScanGrant, scan::*};
mod admission;
mod hooks;
mod managed;
mod read;
pub(crate) use hooks::{authorize, budget_denied, forbid_input, guard_effect, guard_reservation};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScanAdmission {
    pub scan_id: String,
    pub session_id: String,
    pub controller_operation_id: String,
    pub root_operation_id: String,
    pub input_target: String,
    pub target: String,
    pub profile_name: String,
    pub profile: ScanProfile,
    pub root_payload: Value,
    pub provider_context: BTreeMap<String, CampaignProviderContext>,
}
pub struct AdmittedScan {
    pub scan: ScanRecord,
    pub controller: Operation,
    pub root: Operation,
    pub duplicate: bool,
}
fn bad(s: impl std::fmt::Display) -> Error {
    Error::Conflict(format!("scan: {s}"))
}
fn encode(v: &impl Serialize) -> Result<String> {
    Ok(serde_json::to_string(&serde_json::to_value(v)?)?)
}
fn hash(v: &impl Serialize) -> Result<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(encode(v)?.as_bytes())
    ))
}
fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(bad)?
        .as_millis()
        .try_into()
        .map_err(bad)
}
fn id(v: &str) -> Result<()> {
    if v.is_empty() || v.len() > 256 || v.contains('\0') {
        Err(bad("identifier bounds"))
    } else {
        Ok(())
    }
}
fn epoch(conn: &Connection, owner: &str) -> Result<()> {
    let actual:Option<String>=conn.query_row("SELECT CASE WHEN length(CAST(owner AS BLOB))<=4096 THEN owner END FROM engine_epoch WHERE singleton=1",[],|r|r.get(0)).optional()?;
    if actual.as_deref() != Some(owner) {
        return Err(bad("owner epoch differs"));
    }
    Ok(())
}
fn context(r: &ScanRecord) -> Value {
    json!({"schema_version":1,"scan_id":r.id,"intent_sha256":r.intent_sha256,"deadline_at_ms":r.deadline_at_ms})
}

pub(crate) fn hooks_account(conn: &Connection, session: &str, context: &Value) -> Result<()> {
    if let Some(b) = read::binding(conn, session, &mut Reader::new())? {
        if context != &b.root.payload["http_context"] {
            return Err(bad("HTTP account differs from scan root"));
        }
    }
    Ok(())
}

pub(crate) fn snapshot_source_record(conn: &Connection, key: &str) -> Result<ScanRecord> {
    Ok(read::bound(conn, key, &mut Reader::new())?.record)
}
