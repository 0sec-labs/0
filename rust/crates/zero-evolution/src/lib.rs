//! Immutable generations and durable lifecycle bookkeeping. The trusted caller
//! supplies evaluation reports and preparation callbacks; this crate does not
//! execute candidates, attest evaluator honesty or undo external effects.
mod lifecycle;
mod schema;
mod types;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
pub use types::*;

pub const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_JSON_BYTES: usize = 1024 * 1024;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("SQLite: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("missing immutable record: {0}")]
    Missing(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("ineligible: {0}")]
    Ineligible(String),
    #[error("preparation failed: {0}")]
    Preparation(String),
}
pub type Result<T> = std::result::Result<T, Error>;
pub struct Registry {
    conn: Connection,
    owner: String,
}
impl Registry {
    /// Initial state is used only for a new registry. Existing state is never reset.
    pub fn open(
        path: impl AsRef<Path>,
        initial_schema: &str,
        initial_state: &Value,
    ) -> Result<Self> {
        nonempty(initial_schema)?;
        let json = encode(initial_state)?;
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", true)?;
        schema::initialize(&mut conn, initial_schema, &json)?;
        Ok(Self {
            conn,
            owner: uuid::Uuid::new_v4().to_string(),
        })
    }
    pub fn put_artifact(&mut self, bytes: &[u8]) -> Result<String> {
        if bytes.is_empty() || bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(Error::Invalid("artifact must be 1..64 MiB".into()));
        }
        let digest = hash(bytes);
        self.conn.execute(
            "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES (?1,?2)",
            params![digest, bytes],
        )?;
        if self.artifact(&digest)? != bytes {
            return Err(Error::Conflict("artifact hash collision/corruption".into()));
        }
        Ok(digest)
    }
    pub fn artifact(&self, digest: &str) -> Result<Vec<u8>> {
        artifact(&self.conn, digest)
    }
    pub fn register_generation(&mut self, manifest: &Manifest) -> Result<String> {
        nonempty(&manifest.state_schema)?;
        if manifest.protocol_version == 0
            || manifest.components.len() > 256
            || manifest.compatible_state_schemas.len() > 64
        {
            return Err(Error::Invalid("manifest limits or protocol version".into()));
        }
        for name in &manifest.compatible_state_schemas {
            nonempty(name)?;
        }
        for name in manifest.components.keys() {
            nonempty(name)?;
        }
        let json = encode(manifest)?;
        let digest = hash(json.as_bytes());
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for id in std::iter::once(&manifest.engine_artifact)
            .chain(manifest.components.values())
            .chain(std::iter::once(&manifest.policy_artifact))
        {
            artifact(&tx, id)?;
        }
        insert_json(&tx, "generations", &digest, &json)?;
        tx.commit()?;
        Ok(digest)
    }
    pub fn generation(&self, digest: &str) -> Result<Manifest> {
        read_json(&self.conn, "generations", digest)
    }
    pub fn record_evaluation(&mut self, receipt: &EvaluationReceipt) -> Result<String> {
        if receipt.evidence_artifacts.is_empty() || receipt.evidence_artifacts.len() > 256 {
            return Err(Error::Invalid(
                "receipt requires 1..256 retained evidence artifacts".into(),
            ));
        }
        let json = encode(receipt)?;
        let digest = hash(json.as_bytes());
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidate: Manifest = read_json(&tx, "generations", &receipt.candidate)?;
        let _: Manifest = read_json(&tx, "generations", &receipt.baseline)?;
        if receipt.policy_artifact != candidate.policy_artifact {
            return Err(Error::Invalid(
                "receipt policy differs from candidate manifest".into(),
            ));
        }
        for id in std::iter::once(&receipt.evaluator_artifact)
            .chain(std::iter::once(&receipt.policy_artifact))
            .chain(receipt.evidence_artifacts.values())
        {
            artifact(&tx, id)?;
        }
        insert_json(&tx, "receipts", &digest, &json)?;
        tx.commit()?;
        Ok(digest)
    }
    pub fn evaluation(&self, digest: &str) -> Result<EvaluationReceipt> {
        read_json(&self.conn, "receipts", digest)
    }
    /// Caller asserts receipt authority separately; exact identities and decision
    /// are checked here, but a digest does not prove evaluation actually occurred.
    pub fn admit_eligibility(
        &mut self,
        candidate: &str,
        receipt_id: &str,
        baseline: &str,
        evaluator: &str,
        policy: &str,
    ) -> Result<String> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let receipt: EvaluationReceipt = read_json(&tx, "receipts", receipt_id)?;
        if receipt.candidate != candidate
            || receipt.baseline != baseline
            || receipt.evaluator_artifact != evaluator
            || receipt.policy_artifact != policy
            || receipt.decision != EvaluationDecision::Eligible
        {
            return Err(Error::Ineligible(
                "evaluation identities or decision do not match".into(),
            ));
        }
        let eligibility = Eligibility {
            generation: candidate.into(),
            receipt: Some(receipt_id.into()),
            bootstrap_reason: None,
        };
        let json = encode(&eligibility)?;
        let id = hash(json.as_bytes());
        insert_json(&tx, "eligibilities", &id, &json)?;
        tx.commit()?;
        Ok(id)
    }
    /// Explicitly trust an unmeasured initial baseline. This is not an evaluation.
    /// Bootstrap permission cannot activate an unseen generation after epoch zero.
    pub fn authorize_baseline(&mut self, generation: &str, reason: &str) -> Result<String> {
        nonempty(reason)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = lifecycle::current(&tx)?;
        if state.epoch != 0 || state.generation.is_some() {
            return Err(Error::Ineligible(
                "bootstrap requires an empty active registry".into(),
            ));
        }
        let _: Manifest = read_json(&tx, "generations", generation)?;
        let json = encode(&Eligibility {
            generation: generation.into(),
            receipt: None,
            bootstrap_reason: Some(reason.into()),
        })?;
        let id = hash(json.as_bytes());
        insert_json(&tx, "eligibilities", &id, &json)?;
        tx.commit()?;
        Ok(id)
    }
}
fn nonempty(s: &str) -> Result<()> {
    if s.trim().is_empty() || s.len() > 4096 {
        Err(Error::Invalid("string must be 1..4096 bytes".into()))
    } else {
        Ok(())
    }
}
fn canonical(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical(map[key].clone())))
                    .collect(),
            )
        }
        Value::Array(a) => Value::Array(a.into_iter().map(canonical).collect()),
        v => v,
    }
}
fn encode<T: Serialize>(value: &T) -> Result<String> {
    let json = serde_json::to_string(&canonical(serde_json::to_value(value)?))?;
    if json.len() > MAX_JSON_BYTES {
        return Err(Error::Invalid("JSON record exceeds 1 MiB".into()));
    }
    Ok(json)
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn artifact(conn: &Connection, id: &str) -> Result<Vec<u8>> {
    let bytes: Vec<u8> = conn
        .query_row("SELECT bytes FROM artifacts WHERE digest=?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| Error::Missing(id.into()))?;
    if bytes.len() > MAX_ARTIFACT_BYTES || hash(&bytes) != id {
        return Err(Error::Invalid("artifact digest mismatch".into()));
    }
    Ok(bytes)
}
fn read_json<T: DeserializeOwned>(conn: &Connection, table: &str, id: &str) -> Result<T> {
    let json: String = conn
        .query_row(
            &format!("SELECT json FROM {table} WHERE digest=?1"),
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::Missing(id.into()))?;
    if json.len() > MAX_JSON_BYTES || hash(json.as_bytes()) != id {
        return Err(Error::Invalid("record digest mismatch".into()));
    }
    Ok(serde_json::from_str(&json)?)
}
fn insert_json(conn: &Connection, table: &str, id: &str, json: &str) -> Result<()> {
    conn.execute(
        &format!("INSERT OR IGNORE INTO {table}(digest,json) VALUES (?1,?2)"),
        params![id, json],
    )?;
    let stored: String = conn.query_row(
        &format!("SELECT json FROM {table} WHERE digest=?1"),
        [id],
        |r| r.get(0),
    )?;
    if stored != json {
        return Err(Error::Conflict("immutable record collision".into()));
    }
    Ok(())
}
