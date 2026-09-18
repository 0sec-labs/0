//! Immutable bytes retained atomically with their operation attribution.
use crate::{Error, Result, Store, append};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
pub const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;
const MAX_OPERATION_BYTES: usize = 32 * 1024 * 1024;
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub(super) fn read(conn: &Connection, id: &str) -> Result<Vec<u8>> {
    if !zero_protocol::is_sha256(id) {
        return Err(Error::Invalid("invalid artifact digest".into()));
    }
    let (size, bytes): (usize, Option<Vec<u8>>) = conn.query_row(
        "SELECT length(bytes),CASE WHEN length(bytes)<=?2 THEN bytes ELSE NULL END FROM artifacts WHERE digest=?1",
        params![id, MAX_ARTIFACT_BYTES], |r| Ok((r.get(0)?,r.get(1)?)))
        .optional()?.ok_or_else(|| Error::NotFound(id.into()))?;
    let bytes = bytes
        .filter(|v| size <= MAX_ARTIFACT_BYTES && v.len() == size)
        .ok_or_else(|| Error::Invalid("artifact byte limit or corruption".into()))?;
    if digest(&bytes) != id {
        return Err(Error::Invalid("artifact content identity mismatch".into()));
    }
    Ok(bytes)
}
impl Store {
    /// Retain source/plan/evidence bytes before publishing an outcome reference.
    /// New attachments require Running ownership. Exact retries are inert, even
    /// after settlement; an existing name can never point to different bytes.
    pub fn retain_operation_artifact(
        &mut self,
        operation: &str,
        owner: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<String> {
        if bytes.len() > MAX_ARTIFACT_BYTES
            || name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return Err(Error::Invalid("artifact size or attachment name".into()));
        }
        let id = digest(bytes);
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (session, actual_owner, state): (String, Option<String>, String) = tx
            .query_row(
                "SELECT session_id,owner,status FROM operations WHERE id=?1",
                [operation],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(operation.into()))?;
        if actual_owner.as_deref() != Some(owner) {
            return Err(Error::Conflict("artifact owner mismatch".into()));
        }
        let prior: Option<String> = tx
            .query_row(
                "SELECT digest FROM operation_artifacts WHERE operation_id=?1 AND name=?2",
                params![operation, name],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            if prior != id || read(&tx, &prior)? != bytes {
                return Err(Error::Conflict(
                    "artifact attachment cannot be replaced".into(),
                ));
            }
            return Ok(id);
        }
        if state != "running" {
            return Err(Error::Conflict(
                "artifact attachment requires running operation".into(),
            ));
        }
        let (count,total): (usize,usize)=tx.query_row("SELECT count(*),coalesce(sum(length(a.bytes)),0) FROM operation_artifacts AS o JOIN artifacts AS a ON a.digest=o.digest WHERE o.operation_id=?1",[operation],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if count >= 64 || total.saturating_add(bytes.len()) > MAX_OPERATION_BYTES {
            return Err(Error::Invalid("operation artifact retention limit".into()));
        }
        tx.execute(
            "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
            params![id, bytes],
        )?;
        if read(&tx, &id)? != bytes {
            return Err(Error::Conflict("artifact collision".into()));
        }
        tx.execute(
            "INSERT INTO operation_artifacts(operation_id,name,digest) VALUES(?1,?2,?3)",
            params![operation, name, id],
        )?;
        append(
            &tx,
            &session,
            "operation_artifact",
            &serde_json::json!({"operation_id":operation,"name":name,"digest":id,"bytes":bytes.len()}),
        )?;
        tx.commit()?;
        Ok(id)
    }
    /// Hash-check retained bytes. No filesystem path resolution or execution.
    pub fn artifact(&self, digest: &str) -> Result<Vec<u8>> {
        read(&self.conn, digest)
    }
    pub fn operation_artifacts(&self, operation: &str) -> Result<BTreeMap<String, String>> {
        self.get_operation(operation)?;
        let mut stmt=self.conn.prepare("SELECT name,digest FROM operation_artifacts WHERE operation_id=?1 ORDER BY name LIMIT 65")?;
        let result: BTreeMap<String, String> = stmt
            .query_map([operation], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        if result.len() > 64 {
            return Err(Error::Invalid("operation artifact count limit".into()));
        }
        Ok(result)
    }
}
