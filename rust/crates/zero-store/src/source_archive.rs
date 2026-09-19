//! Full source is operational input, separate from bounded report attachments.
//! Retention grants neither a new actor nor permission to execute restored bytes.
use crate::{Error, Result, Store, append, artifacts, integer, review, workflow::Reader};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zero_protocol::{review::ReviewRecord, source_archive::*};

fn bad(message: impl std::fmt::Display) -> Error {
    Error::Invalid(format!("source archive: {message}"))
}
fn witness(binding: &review::ArchiveBinding, manifest: &str) -> serde_json::Value {
    let mut value = json!({"schema_version":1,"review_id":binding.review.id,"command_id":binding.review.command_id,
        "root_operation_id":binding.review.root_operation_id,
        "snapshot_sha256":binding.review.snapshot_sha256,
        "manifest_sha256":manifest,"owner":binding.owner,
        "preparation_sequence":binding.preparation_sequence});
    if let Some(acquisition) = &binding.review.acquisition_receipt {
        value["acquisition_receipt_sha256"] = json!(acquisition.receipt_sha256());
    }
    value
}
fn inference_before(conn: &Connection, record: &ReviewRecord, sequence: u64) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence<?2 AND kind='command_admitted' AND CASE WHEN length(CAST(payload AS BLOB))<=33554432 AND json_valid(payload) THEN json_extract(payload,'$.payload.kind')='agent_inference' AND json_extract(payload,'$.payload.parent_operation')=?3 ELSE 1 END)",
        params![record.session_id,integer(sequence)?,record.root_operation_id], |r|r.get(0))?)
}
struct Metadata {
    binding: review::ArchiveBinding,
    digest: String,
}
fn metadata(conn: &Connection, record: &ReviewRecord) -> Result<Option<Metadata>> {
    let row: Option<(String, String, String, String, String, u64)> = conn.query_row(
        "SELECT CASE WHEN length(root_operation_id)<=256 THEN root_operation_id END,CASE WHEN length(review_id)<=256 THEN review_id END,CASE WHEN length(session_id)<=256 THEN session_id END,CASE WHEN length(manifest_sha256)=71 THEN manifest_sha256 END,CASE WHEN length(CAST(command_id AS BLOB))<=512 THEN command_id END,sequence FROM source_archives WHERE root_operation_id=?1 OR review_id=?2 OR session_id=?3 OR command_id=?4",
        params![record.root_operation_id,record.id,record.session_id,record.command_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let projections: u64 = conn.query_row(
        "SELECT count(*) FROM source_archives WHERE root_operation_id=?1 OR review_id=?2 OR session_id=?3 OR command_id=?4",
        params![record.root_operation_id,record.id,record.session_id,record.command_id], |r| r.get(0))?;
    let witnesses: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE kind='review_source_archived' AND (session_id=?3 OR CASE WHEN length(CAST(payload AS BLOB))<=4096 AND json_valid(payload) THEN json_extract(payload,'$.root_operation_id')=?1 OR json_extract(payload,'$.review_id')=?2 OR json_extract(payload,'$.command_id')=?4 ELSE 0 END)",
        params![record.root_operation_id,record.id,record.session_id,record.command_id], |r| r.get(0))?;
    let Some((root, review, session, digest, command, sequence)) = row else {
        return if witnesses == 0 && projections == 0 {
            Ok(None)
        } else {
            Err(bad("archive projection missing"))
        };
    };
    if projections != 1
        || witnesses != 1
        || command != record.command_id
        || root != record.root_operation_id
        || review != record.id
        || session != record.session_id
    {
        return Err(bad("archive identity or witness multiplicity differs"));
    }
    let binding = review::archive_binding(conn, &root, None, false)?;
    let mut reader = Reader::new();
    let event_size: usize = conn.query_row(
        "SELECT length(CAST(payload AS BLOB)) FROM events WHERE session_id=?1 AND sequence=?2",
        params![session, integer(sequence)?],
        |r| r.get(0),
    )?;
    if event_size > 4096 {
        return Err(bad("archive witness exceeds metadata bound"));
    }
    let (kind, event) = reader.event(conn, &session, sequence)?;
    if kind != "review_source_archived"
        || event != witness(&binding, &digest)
        || sequence <= binding.preparation_sequence
    {
        return Err(bad("archive journal identity differs"));
    }
    let already_closed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence<?2 AND (kind='review_admission_closed' OR (kind IN ('operation_settled','operation_unknown','operation_not_started') AND coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id')) IN (?3,?4))))",
        params![session,integer(sequence)?,record.root_operation_id,record.controller_operation_id], |r| r.get(0))?;
    if already_closed || inference_before(conn, record, sequence)? {
        return Err(bad(
            "archive was retained after review closure or model admission",
        ));
    }
    Ok(Some(Metadata { binding, digest }))
}

/// Command retries authenticate the independent archive binding without reading
/// full source bytes or requiring the old source directory.
pub(crate) fn validate_command(
    conn: &Connection,
    command: &str,
    record: Option<&ReviewRecord>,
) -> Result<()> {
    if let Some(record) = record {
        if record.command_id != command {
            return Err(bad("review command identity differs"));
        }
        metadata(conn, record)?;
    } else {
        let marked: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM source_archives WHERE command_id=?1) OR EXISTS(SELECT 1 FROM events INDEXED BY source_archive_command WHERE kind='review_source_archived' AND json_extract(payload,'$.command_id')=?1)",
            [command], |r|r.get(0))?;
        if marked {
            return Err(bad("archive command survives a missing review binding"));
        }
    }
    Ok(())
}
fn load_manifest(
    conn: &Connection,
    record: &ReviewRecord,
) -> Result<Option<(review::ArchiveBinding, ArchiveManifest)>> {
    let Some(Metadata { binding, digest }) = metadata(conn, record)? else {
        return Ok(None);
    };
    let mut reader = Reader::new();
    let bytes = reader.artifact(conn, &digest, MAX_MANIFEST_BYTES)?;
    let manifest: ArchiveManifest = serde_json::from_slice(&bytes)?;
    if manifest.canonical_bytes().map_err(bad)? != bytes {
        return Err(bad("manifest encoding is not canonical"));
    }
    if manifest.snapshot_sha256 != binding.snapshot.digest
        || manifest.files.len() != binding.snapshot.files.len()
        || manifest
            .files
            .iter()
            .zip(&binding.snapshot.files)
            .any(|(a, p)| a.path != p.path || a.sha256 != p.digest || a.bytes != p.bytes)
    {
        return Err(bad("manifest differs from the captured snapshot"));
    }
    if let Some(acquisition) = &binding.acquisition_receipt {
        acquisition.validate_archive(&manifest).map_err(bad)?;
    }
    Ok(Some((binding, manifest)))
}
fn load(conn: &Connection, record: &ReviewRecord) -> Result<Option<SourceArchive>> {
    let Some((binding, manifest)) = load_manifest(conn, record)? else {
        return Ok(None);
    };
    // Validate declared aggregate/per-chunk sizes before loading any raw blobs.
    // Manifest and raw data have separate explicit bounds (8 MiB + 64 MiB).
    let mut declared = BTreeMap::new();
    for chunk in manifest.files.iter().flat_map(|f| &f.chunks) {
        if declared
            .insert(chunk.sha256.clone(), chunk.bytes)
            .is_some_and(|previous| previous != chunk.bytes)
        {
            return Err(bad("conflicting chunk lengths"));
        }
    }
    let total = declared
        .values()
        .try_fold(0u64, |n, size| n.checked_add(*size))
        .ok_or_else(|| bad("archive byte overflow"))?;
    if total > MAX_BYTES {
        return Err(bad("archive aggregate byte bound"));
    }
    let mut blobs = BTreeMap::new();
    for (digest, declared) in declared {
        let size: u64 = conn.query_row(
            "SELECT length(bytes) FROM artifacts WHERE digest=?1",
            [&digest],
            |r| r.get(0),
        )?;
        if size != declared || size > CHUNK_BYTES as u64 {
            return Err(bad("retained chunk size differs"));
        }
        blobs.insert(digest.clone(), artifacts::read(conn, &digest)?);
    }
    let archive = SourceArchive { manifest, blobs };
    archive.validate_pin(&binding.snapshot).map_err(bad)?;
    Ok(Some(archive))
}
impl Store {
    /// Persist the entire captured source atomically, after source preparation
    /// permission and before closure. Exact retries are inert after settlement.
    pub fn retain_review_source_archive(
        &mut self,
        root: &str,
        owner: &str,
        archive: &SourceArchive,
    ) -> Result<String> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let binding = review::archive_binding(&tx, root, Some(owner), false)?;
        archive.validate_pin(&binding.snapshot).map_err(bad)?;
        if let Some(acquisition) = &binding.acquisition_receipt {
            acquisition
                .validate_archive(&archive.manifest)
                .map_err(bad)?;
        }
        let bytes = archive.manifest.canonical_bytes().map_err(bad)?;
        let digest = format!("sha256:{:x}", Sha256::digest(&bytes));
        if let Some(prior) = load(&tx, &binding.review)? {
            if prior != *archive {
                return Err(bad("archive cannot be replaced"));
            }
            return Ok(digest);
        }
        let inference_projection: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE session_id=?1 AND CASE WHEN length(CAST(payload AS BLOB))<=33554432 AND json_valid(payload) THEN json_extract(payload,'$.kind')='agent_inference' AND json_extract(payload,'$.parent_operation')=?2 ELSE 1 END)",
            params![binding.review.session_id,root], |r|r.get(0))?;
        if inference_projection || inference_before(&tx, &binding.review, i64::MAX as u64)? {
            return Err(bad(
                "archive retention must precede the first root inference",
            ));
        }
        review::archive_binding(&tx, root, Some(owner), true)?;
        for (sha, data) in archive
            .blobs
            .iter()
            .chain(std::iter::once((&digest, &bytes)))
        {
            tx.execute(
                "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
                params![sha, data],
            )?;
            if artifacts::read(&tx, sha)? != *data {
                return Err(bad("artifact collision"));
            }
        }
        // Hashing/writes can take time; recheck the absolute deadline before commit.
        review::archive_binding(&tx, root, Some(owner), true)?;
        append(
            &tx,
            &binding.review.session_id,
            "review_source_archived",
            &witness(&binding, &digest),
        )?;
        let sequence: u64 = tx.query_row(
            "SELECT max(sequence) FROM events WHERE session_id=?1",
            [&binding.review.session_id],
            |r| r.get(0),
        )?;
        tx.execute("INSERT INTO source_archives(root_operation_id,review_id,session_id,manifest_sha256,sequence,command_id) VALUES(?1,?2,?3,?4,?5,?6)", params![root,binding.review.id,binding.review.session_id,digest,integer(sequence)?,binding.review.command_id])?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| bad("clock before epoch"))?
            .as_millis();
        if now >= u128::from(binding.review.deadline_at_ms) {
            return Err(bad("archive deadline expired before commit"));
        }
        tx.commit()?;
        Ok(digest)
    }

    /// Authenticate the retained manifest and original snapshot without reading
    /// raw chunks. This proves historical identity, not current blob availability
    /// or permission to execute; use `review_source_archive` before restoration.
    pub fn review_source_archive_manifest(
        &self,
        review_id: &str,
    ) -> Result<Option<ArchiveManifest>> {
        let tx = self.conn.unchecked_transaction()?;
        let record = review::snapshot_source_record(&tx, review_id)?;
        Ok(load_manifest(&tx, &record)?.map(|(_, manifest)| manifest))
    }

    /// Explicit full-source read. Metadata/report views deliberately do not call
    /// this API or materialize archive blobs. Old reviews honestly return None.
    pub fn review_source_archive(&self, review_id: &str) -> Result<Option<SourceArchive>> {
        let tx = self.conn.unchecked_transaction()?;
        let record = review::snapshot_source_record(&tx, review_id)?;
        load(&tx, &record)
    }
}

pub(crate) fn manifest_for_record(
    conn: &Connection,
    record: &ReviewRecord,
) -> Result<Option<ArchiveManifest>> {
    Ok(load_manifest(conn, record)?.map(|(_, manifest)| manifest))
}
