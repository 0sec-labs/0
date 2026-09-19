//! Bounded logical campaign evidence. Packages contain data, never executable SQL.
pub(crate) mod capture;
mod package;
mod review;
mod scan;
mod search;
use crate::{Error, Result, Store};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
// Portable layout version, independent of the live SQLite schema. Additive
// Store migrations must preserve retained campaign evidence identities.
const SNAPSHOT_STORE_LAYOUT: u32 = 14;
pub(crate) const MAX_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_RECORDS: usize = 65_536;
const MAX_CHUNK: usize = 4 * 1024 * 1024;
const MAX_MANIFEST: usize = 1024 * 1024;
const TABLES: &[&str] = &[
    "engine_epoch",
    "sessions",
    "operations",
    "events",
    "reservations",
    "campaigns",
    "campaign_runs",
    "campaign_exposures",
    "campaign_debits",
    "http_accounts",
    "http_dispatches",
    "http_rates",
    "web_experiment_admissions",
    "operation_artifacts",
    "agent_steering_windows",
    "web_triage_decisions",
];
const SEARCH_TABLES: &[&str] = &[
    "strategy_searches",
    "strategy_search_proposals",
    "strategy_search_evaluations",
    "strategy_search_selections",
];
#[derive(Clone, Copy, PartialEq, Eq)]
enum Layout {
    FixedPair,
    Search,
}
impl Layout {
    fn version(self) -> u32 {
        match self {
            Self::FixedPair => 1,
            Self::Search => 2,
        }
    }
    fn store_schema(self) -> u32 {
        match self {
            Self::FixedPair => SNAPSHOT_STORE_LAYOUT,
            Self::Search => 16,
        }
    }
    fn max_sessions(self) -> usize {
        match self {
            Self::FixedPair => 129,
            Self::Search => 145,
        }
    }
    fn tables(self) -> Vec<&'static str> {
        let mut tables = TABLES.to_vec();
        if self == Self::Search {
            tables.extend_from_slice(SEARCH_TABLES);
        }
        tables
    }
    fn from_manifest(manifest: &Manifest) -> Result<Self> {
        match (manifest.schema_version, manifest.store_schema) {
            (1, SNAPSHOT_STORE_LAYOUT) => Ok(Self::FixedPair),
            (2, 16) => Ok(Self::Search),
            _ => Err(invalid("unsupported portable layout")),
        }
    }
}
fn invalid(message: &str) -> Error {
    Error::Invalid(format!("campaign evidence: {message}"))
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum Cell {
    Null,
    Integer(i64),
    Text(String),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    bytes: u64,
    chunks: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    name: String,
    rows: Vec<Reference>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    store_schema: u32,
    campaign_id: String,
    sessions: Vec<String>,
    tables: Vec<Table>,
    artifacts: BTreeMap<String, Reference>,
    record_count: u32,
    total_unique_bytes: u64,
}
/// Source capture and portable reconstruction share the same inert data shape.
/// Possessing this package alone does not attest a trusted execution source.
#[derive(Debug)]
pub struct CampaignSnapshotData {
    manifest: Manifest,
    bytes: Vec<u8>,
    digest: String,
    blobs: BTreeMap<String, Vec<u8>>,
}
impl CampaignSnapshotData {
    pub fn manifest_bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
    pub fn blobs(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.blobs
    }
    pub fn campaign_id(&self) -> &str {
        &self.manifest.campaign_id
    }
}
impl Store {
    /// A private immutable connection; no recovery, owner claim or dispatch.
    pub fn hydrate_campaign_snapshot(data: &CampaignSnapshotData) -> Result<Self> {
        let mut conn = rusqlite::Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", true)?;
        crate::schema::initialize(&mut conn)?;
        let tx = conn.transaction()?;
        tx.pragma_update(None, "defer_foreign_keys", true)?;
        for (digest, reference) in &data.manifest.artifacts {
            let bytes = data.join(reference)?;
            if hash(&bytes) != *digest || bytes.len() > crate::MAX_ARTIFACT_BYTES {
                return Err(invalid("retained artifact identity or size differs"));
            }
            tx.execute(
                "INSERT INTO artifacts(digest,bytes) VALUES(?1,?2)",
                rusqlite::params![digest, bytes],
            )?;
        }
        for table in &data.manifest.tables {
            let columns = capture::columns(&tx, &table.name)?;
            let placeholders = vec!["?"; columns.len()].join(",");
            let sql = format!(
                "INSERT INTO {}({}) VALUES({})",
                table.name,
                columns.join(","),
                placeholders
            );
            let mut insert = tx.prepare(&sql)?;
            for reference in &table.rows {
                let cells: Vec<Cell> = serde_json::from_slice(&data.join(reference)?)?;
                if cells.len() != columns.len() {
                    return Err(invalid("record column count differs"));
                }
                let values = cells.into_iter().map(|cell| match cell {
                    Cell::Null => rusqlite::types::Value::Null,
                    Cell::Integer(n) => rusqlite::types::Value::Integer(n),
                    Cell::Text(s) => rusqlite::types::Value::Text(s),
                });
                insert.execute(rusqlite::params_from_iter(values))?;
            }
        }
        if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
            return Err(invalid("foreign record reference"));
        }
        tx.commit()?;
        conn.pragma_update(None, "query_only", true)?;
        let frozen = Self { conn };
        // Metadata validation also catches omitted run projections against retained journal witnesses.
        let layout = Layout::from_manifest(&data.manifest)?;
        frozen.campaign(data.campaign_id())?;
        let refrozen = match layout {
            Layout::FixedPair => frozen.freeze_campaign(data.campaign_id())?,
            Layout::Search => {
                frozen.search_snapshot(data.campaign_id())?;
                frozen.freeze_strategy_search(data.campaign_id())?
            }
        };
        if refrozen.manifest_bytes() != data.manifest_bytes() {
            return Err(invalid("package contains omitted or foreign records"));
        }
        Ok(frozen)
    }
}
