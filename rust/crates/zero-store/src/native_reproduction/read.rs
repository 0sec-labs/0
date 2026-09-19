//! A pinned, bounded view of both the original review and its reproduction.
//! Archive manifests are historical identity evidence; raw source is not copied.
use super::*;
use crate::campaign_snapshot::{Cell, MAX_BYTES, MAX_RECORDS, capture};
use rusqlite::types::Value as SqlValue;
use std::collections::BTreeSet;

const TABLES: &[&str] = &[
    "sessions",
    "operations",
    "events",
    "reservations",
    "operation_artifacts",
    "agent_steering_windows",
    "source_triage_decisions",
    "reviews",
    "source_archives",
    "native_reproductions",
];

impl Store {
    /// Freeze both complete session journals in one SQLite read transaction.
    /// The returned private database is query-only and contains no archive chunks.
    /// This supplies existing provenance readers; it is not execution authority or
    /// a portable source attestation, and cannot be used to restore source files.
    pub fn native_reproduction_read_snapshot(&self, key: &str) -> Result<Self> {
        let source = self.conn.unchecked_transaction()?;
        let frozen = capture_snapshot(&source, key)?;
        source.commit()?;
        Ok(frozen)
    }

    #[cfg(test)]
    fn native_reproduction_read_snapshot_inner(
        &self,
        key: &str,
        after_pin: impl FnOnce(),
    ) -> Result<Self> {
        let source = self.conn.unchecked_transaction()?;
        let frozen = capture_snapshot_inner(&source, key, after_pin)?;
        source.commit()?;
        Ok(frozen)
    }

    /// Fingerprint a complete, validated two-session evidence view. Raw source
    /// chunks and mutable wall-clock observation times are not part of this ID.
    pub fn native_reproduction_evidence_digest(&self, key: &str) -> Result<String> {
        let view = self.native_reproduction_read_snapshot(key)?;
        evidence_digest(&view, key)
    }
}

/// The caller owns the source transaction, including any later admission CAS.
/// No nested transaction is opened on `conn`; hydration uses another connection.
pub(crate) fn capture_snapshot(conn: &Connection, key: &str) -> Result<Store> {
    capture_snapshot_inner(conn, key, || {})
}

pub(crate) fn capture_snapshot_with_extra_session(
    source: &Connection,
    key: &str,
    session: &str,
) -> Result<Store> {
    id(session)?;
    capture_snapshot_sessions(source, key, Some(session), || {})
}

fn capture_snapshot_inner(
    source: &Connection,
    key: &str,
    after_pin: impl FnOnce(),
) -> Result<Store> {
    capture_snapshot_sessions(source, key, None, after_pin)
}

fn capture_snapshot_sessions(
    source: &Connection,
    key: &str,
    extra_session: Option<&str>,
    after_pin: impl FnOnce(),
) -> Result<Store> {
    if source.is_autocommit() {
        return Err(bad(
            "evidence capture requires an existing source transaction",
        ));
    }
    crate::schema::validate_current(source)?;
    let mut reader = Reader::new();
    let original = bound(source, key, &mut reader)?;
    // Global parent/admission markers must agree before reducing the database
    // to two sessions; a foreign duplicate must not disappear in the copy.
    for sql in [
        "SELECT count(*) FROM operations INDEXED BY native_reproduction_parent_command WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.kind') END='native_source_reproduction' AND json_extract(payload,'$.command_id')=?1",
        "SELECT count(*) FROM events INDEXED BY native_reproduction_admission_command WHERE kind='command_admitted' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.payload.kind') END='native_source_reproduction' AND json_extract(payload,'$.payload.command_id')=?1",
    ] {
        let count: u64 = source.query_row(sql, [&original.record.command_id], |r| r.get(0))?;
        if count != 1 {
            return Err(bad("global command identity differs in read view"));
        }
    }
    let review = crate::review::snapshot_source_record(source, &original.record.source_review_id)?;
    let manifest = crate::source_archive::manifest_for_record(source, &review)?
        .ok_or_else(|| bad("source archive metadata absent"))?;
    let raw_chunks: BTreeSet<_> = manifest
        .files
        .iter()
        .flat_map(|f| &f.chunks)
        .map(|c| c.sha256.as_str())
        .collect();
    let parameters = [
        SqlValue::Text(review.session_id.clone()),
        SqlValue::Text(original.record.session_id.clone()),
        extra_session
            .map(|s| SqlValue::Text(s.into()))
            .unwrap_or(SqlValue::Null),
    ];
    if extra_session.is_some_and(|s| s == review.session_id || s == original.record.session_id) {
        return Err(bad("additional read session aliases original evidence"));
    }
    after_pin();
    validate_sessions(source, &review, &original.record)?;

    let mut remaining = reader.remaining.min(MAX_BYTES);
    let mut count = 0;
    let mut tables = Vec::new();
    for table in TABLES
        .iter()
        .copied()
        .chain(extra_session.map(|_| "native_repairs"))
    {
        let filter = match table {
            "sessions" => "id IN (?1,?2,?3)",
            "operation_artifacts" | "agent_steering_windows" => {
                "operation_id IN (SELECT id FROM operations WHERE session_id IN (?1,?2,?3))"
            }
            _ => "session_id IN (?1,?2,?3)",
        };
        tables.push((
            table,
            capture::read_rows(
                source,
                table,
                filter,
                &parameters,
                &mut remaining,
                &mut count,
            )?,
        ));
    }
    let digests = capture::strings(
        source,
        "SELECT CASE WHEN length(digest)=71 THEN digest END FROM (SELECT digest FROM operation_artifacts WHERE operation_id IN (SELECT id FROM operations WHERE session_id IN (?1,?2,?3)) UNION SELECT source_review_sha256 AS digest FROM source_triage_decisions WHERE session_id IN (?1,?2,?3) UNION SELECT manifest_sha256 AS digest FROM source_archives WHERE session_id IN (?1,?2,?3)) ORDER BY digest LIMIT 65537",
        &parameters,
        MAX_RECORDS,
    )?;
    let mut artifacts = Vec::new();
    for digest in digests {
        // Never silently strip an attachment: either retain its complete
        // evidence or reject a request to smuggle operational source into it.
        if raw_chunks.contains(digest.as_str()) {
            return Err(bad("raw archive chunk referenced by read evidence"));
        }
        let size: usize = source.query_row(
            "SELECT length(bytes) FROM artifacts WHERE digest=?1",
            [&digest],
            |r| r.get(0),
        )?;
        if size > crate::MAX_ARTIFACT_BYTES || size > remaining {
            return Err(bad("read view artifact byte bound"));
        }
        remaining -= size;
        artifacts.push((digest.clone(), crate::artifacts::read(source, &digest)?));
    }
    let mut conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", true)?;
    crate::schema::initialize(&mut conn)?;
    let tx = conn.transaction()?;
    tx.pragma_update(None, "defer_foreign_keys", true)?;
    for (digest, bytes) in artifacts {
        tx.execute(
            "INSERT INTO artifacts(digest,bytes) VALUES(?1,?2)",
            params![digest, bytes],
        )?;
    }
    for (table, rows) in tables {
        let columns = capture::columns(&tx, table)?;
        let sql = format!(
            "INSERT INTO {table}({}) VALUES({})",
            columns.join(","),
            vec!["?"; columns.len()].join(",")
        );
        let mut insert = tx.prepare(&sql)?;
        for row in rows {
            insert.execute(rusqlite::params_from_iter(row.into_iter().map(
                |cell| match cell {
                    Cell::Null => SqlValue::Null,
                    Cell::Integer(n) => SqlValue::Integer(n),
                    Cell::Text(s) => SqlValue::Text(s),
                },
            )))?;
        }
    }
    if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(bad("foreign reference in reproduction read view"));
    }
    tx.commit()?;
    conn.pragma_update(None, "query_only", true)?;
    let frozen = Store { conn };
    let copied = frozen.native_reproduction(key)?;
    if copied.record != original.record
        || serde_json::to_value(copied.operation)? != serde_json::to_value(original.operation)?
    {
        return Err(bad("source and read view differ"));
    }
    frozen.review_snapshot(&review.id)?;
    Ok(frozen)
}

/// Hash an already validated private in-memory capture. Query-only ownership is required so its
/// complete metadata/artifact inventory cannot change between table reads.
/// Capture authenticated the artifact bytes; the canonical digest stream needs
/// only their content IDs and lengths, never a second copy of their contents.
pub(crate) fn evidence_digest(view: &Store, key: &str) -> Result<String> {
    id(key)?;
    let readonly: bool = view
        .conn
        .pragma_query_value(None, "query_only", |row| row.get(0))?;
    if !readonly || view.conn.path().is_some_and(|path| !path.is_empty()) {
        return Err(bad(
            "evidence digest requires a query-only in-memory captured view",
        ));
    }
    // Authenticate the requested root and source binding even for crate callers.
    let captured = view.native_reproduction(key)?;
    view.review_snapshot(&captured.record.source_review_id)?;
    let mut remaining = MAX_BYTES;
    let mut count = 0;
    // A SQL text byte can require six JSON bytes (a control character escape).
    // Stream that worst case, preserving the original 64 MiB source read bound
    // without allocating an escaped JSON representation or narrowing old inputs.
    let mut output = DigestWriter {
        hasher: Sha256::new(),
        remaining: MAX_BYTES * 6,
    };
    output.token(b"[")?;
    output.json(&"zero-native-reproduction-evidence-v1")?;
    output.token(b",")?;
    output.json(&key)?;
    output.token(b",[")?;
    for (index, table) in TABLES.iter().enumerate() {
        let columns = capture::columns(&view.conn, table)?;
        let rows = capture::read_rows(&view.conn, table, "1", &[], &mut remaining, &mut count)?;
        if index != 0 {
            output.token(b",")?;
        }
        output.token(b"[")?;
        output.json(table)?;
        output.token(b",")?;
        output.json(&columns)?;
        output.token(b",")?;
        output.json(&rows)?;
        output.token(b"]")?;
    }
    output.token(b"],[")?;
    let (artifacts,bytes):(usize,usize)=view.conn.query_row(
        "SELECT count(*),coalesce(sum(length(bytes)+length(CAST(digest AS BLOB))+32),0) FROM artifacts",
        [],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if artifacts > MAX_RECORDS.saturating_sub(count) || bytes > remaining {
        return Err(bad("evidence digest artifact inventory exceeds bound"));
    }
    let mut query=view.conn.prepare("SELECT CASE WHEN length(CAST(digest AS BLOB))=71 THEN digest END,length(bytes) FROM artifacts ORDER BY digest")?;
    let mut rows = query.query([])?;
    let mut first = true;
    while let Some(row) = rows.next()? {
        let digest: String = row.get(0)?;
        let size: usize = row.get(1)?;
        if !zero_protocol::is_sha256(&digest) || size > crate::MAX_ARTIFACT_BYTES {
            return Err(bad("evidence digest artifact identity or size differs"));
        }
        if !first {
            output.token(b",")?;
        }
        first = false;
        output.json(&(digest, size))?;
    }
    output.token(b"]]")?;
    Ok(format!("sha256:{:x}", output.hasher.finalize()))
}

struct DigestWriter {
    hasher: Sha256,
    remaining: usize,
}
impl std::io::Write for DigestWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(std::io::Error::other(
                "native reproduction encoded evidence bound",
            ));
        }
        self.remaining -= bytes.len();
        self.hasher.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl DigestWriter {
    fn token(&mut self, bytes: &[u8]) -> Result<()> {
        std::io::Write::write_all(self, bytes).map_err(bad)
    }
    fn json(&mut self, value: &impl Serialize) -> Result<()> {
        serde_json::to_writer(self, value)?;
        Ok(())
    }
}

fn validate_sessions(
    conn: &Connection,
    review: &zero_protocol::review::ReviewRecord,
    native: &NativeReproductionRecord,
) -> Result<()> {
    for session in [&review.session_id, &native.session_id] {
        crate::admission_closure::validate(conn, session)?;
        for table in [
            "scans",
            "native_repairs",
            "http_accounts",
            "web_experiment_admissions",
            "web_triage_decisions",
            "agent_inputs",
            "agent_steering",
            "operator_questions",
            "operator_question_decisions",
            "tool_approvals",
            "tool_approval_decisions",
            "strategy_sessions",
            "campaign_runs",
            "campaign_debits",
            "strategy_search_proposals",
        ] {
            let exists: bool = conn.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE session_id=?1)"),
                [session],
                |r| r.get(0),
            )?;
            if exists {
                return Err(bad("unsupported session membership in read view"));
            }
        }
        let forbidden: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM campaigns WHERE journal_session_id=?1) OR EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND (kind GLOB 'scan_*' OR kind GLOB 'http_*' OR kind GLOB 'web_experiment_*' OR kind GLOB 'campaign_*' OR kind GLOB 'strategy_*' OR kind GLOB 'agent_input_*' OR kind='agent_steering_enqueued' OR kind GLOB '*question*' OR kind GLOB '*approval*')) OR EXISTS(SELECT 1 FROM tool_approval_consumptions WHERE effect_operation_id IN (SELECT id FROM operations WHERE session_id=?1))",
            [session], |r| r.get(0))?;
        if forbidden {
            return Err(bad("unsupported session witness in read view"));
        }
    }
    let mixed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_reproductions WHERE session_id=?1) OR EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind GLOB 'native_reproduction_*') OR EXISTS(SELECT 1 FROM reviews WHERE session_id=?2) OR EXISTS(SELECT 1 FROM source_archives WHERE session_id=?2) OR EXISTS(SELECT 1 FROM source_triage_decisions WHERE session_id=?2) OR EXISTS(SELECT 1 FROM events WHERE session_id=?2 AND kind GLOB 'review_*')",
        params![review.session_id,native.session_id], |r|r.get(0))?;
    if mixed {
        return Err(bad("source and workflow memberships overlap"));
    }
    let unsupported: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM operations WHERE session_id=?1 AND CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload,'$.kind'),'') NOT IN ('native_review','offline_snapshot_agent','agent_inference','agent_source_tool','agent_tool','agent_delegation') OR json_type(payload,'$.scan_operation_id') IS NOT NULL OR json_type(payload,'$.scan_context') IS NOT NULL OR json_type(payload,'$.http_context') IS NOT NULL OR json_type(payload,'$.strategy_capture') IS NOT NULL ELSE 1 END)",
        [&review.session_id], |r|r.get(0))?;
    let detached: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM operations o WHERE o.session_id=?1 AND o.id NOT IN (?2,?3) AND NOT EXISTS(SELECT 1 FROM operations p WHERE p.id=json_extract(o.payload,'$.parent_operation') AND p.session_id=o.session_id AND ((p.id=?3 AND json_extract(o.payload,'$.kind') IN ('agent_inference','agent_source_tool','agent_tool','agent_delegation')) OR (json_extract(p.payload,'$.kind')='agent_delegation' AND json_extract(p.payload,'$.parent_operation')=?3 AND json_extract(o.payload,'$.kind')='offline_snapshot_agent') OR (json_extract(p.payload,'$.kind')='offline_snapshot_agent' AND json_extract(o.payload,'$.kind') IN ('agent_inference','agent_source_tool','agent_tool') AND EXISTS(SELECT 1 FROM operations g WHERE g.id=json_extract(p.payload,'$.parent_operation') AND g.session_id=o.session_id AND json_extract(g.payload,'$.kind')='agent_delegation' AND json_extract(g.payload,'$.parent_operation')=?3)))))",
        params![review.session_id,review.controller_operation_id,review.root_operation_id], |r|r.get(0))?;
    if unsupported || detached {
        return Err(bad("foreign operation in original review"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ReviewAdmission;
    use std::collections::BTreeMap;
    use zero_protocol::{review::*, source_archive::*};
    fn fixture_hash(v: &Value) -> String {
        super::hash(v).unwrap()
    }
    fn prepared(archive: &SourceArchive) -> ReviewAdmission {
        let profile:ReviewProfile=serde_json::from_value(json!({"schema_version":1,"provider":"p","model":"m","instructions":"Host review","question":"Inspect input handling","execution":{"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"budget_limit":10,"currency":"units","reservation_per_turn":6,"max_turns":3,"max_hypotheses":2,"deadline_ms":60000})).unwrap();
        let files = serde_json::to_value(
            archive
                .manifest
                .files
                .iter()
                .map(|f| json!({"path":f.path,"digest":f.sha256,"bytes":f.bytes}))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let snapshot: zero_protocol::SnapshotPin = serde_json::from_value(
            json!({"id":"source","root":"/source","files":files,"digest":fixture_hash(&files)}),
        )
        .unwrap();
        let root = uuid::Uuid::new_v4().to_string();
        let request = profile.request(snapshot.clone(), &root).unwrap();
        let tools: Vec<_> = [
            "list_source_files",
            "read_source_lines",
            "search_source_text",
            "execute_snapshot",
            "submit_source_hypotheses",
        ]
        .into_iter()
        .map(|name| json!({"name":name,"description":"Host tool","parameters":{"type":"object"}}))
        .collect();
        let template = json!({"model":"m","instructions":request.instructions,"input":[],"max_output_tokens":8192,"tools":tools});
        let pins = json!({"p":{"endpoint":"http://127.0.0.1:9090/responses","wire_api":"responses","rates":{"input":1,"cached_input":1,"output":1}}});
        ReviewAdmission {
            review_id: uuid::Uuid::new_v4().to_string(),
            session_id: uuid::Uuid::new_v4().to_string(),
            controller_operation_id: uuid::Uuid::new_v4().to_string(),
            root_operation_id: root,
            input_path: "./source".into(),
            canonical_path: "/source".into(),
            profile_name: "local".into(),
            profile,
            snapshot,
            workspace_selection: None,
            acquisition_receipt: None,
            root_payload: json!({"kind":"offline_snapshot_agent","request":request,"endpoint":pins["p"]["endpoint"],"rates":pins["p"]["rates"],"review_template":template}),
            provider_context: serde_json::from_value(pins).unwrap(),
        }
    }

    fn archive(data: Vec<u8>) -> SourceArchive {
        let sha = |bytes: &[u8]| format!("sha256:{:x}", Sha256::digest(bytes));
        let mut blobs = BTreeMap::new();
        let chunks = data
            .chunks(CHUNK_BYTES)
            .map(|c| {
                let digest = sha(c);
                blobs.insert(digest.clone(), c.to_vec());
                ArchiveChunk {
                    sha256: digest,
                    bytes: c.len() as u64,
                }
            })
            .collect();
        let file = ArchiveFile {
            path: "app.rs".into(),
            sha256: sha(&data),
            bytes: data.len() as u64,
            executable: true,
            chunks,
        };
        let digest =
            fixture_hash(&json!([{"path":file.path,"digest":file.sha256,"bytes":file.bytes}]));
        SourceArchive {
            manifest: ArchiveManifest {
                schema_version: 1,
                snapshot_sha256: digest,
                files: vec![file],
            },
            blobs,
        }
    }

    fn fixture() -> (
        tempfile::TempDir,
        Store,
        NativeReproductionAdmission,
        SourceArchive,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("db")).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let archive = archive(b"original source material".to_vec());
        let review = prepared(&archive);
        store
            .admit_review("original-review", "owner", &review)
            .unwrap();
        store
            .begin_review_source_preparation(&review.root_operation_id, "owner")
            .unwrap();
        let manifest = store
            .retain_review_source_archive(&review.root_operation_id, "owner", &archive)
            .unwrap();
        let bundle = store
            .retain_operation_artifact(
                &review.root_operation_id,
                "owner",
                "source.bundle",
                br#"{"fixture":"bundle"}"#,
            )
            .unwrap();
        let result = json!({"version":1,"bundle_sha256":bundle,"snapshot_sha256":review.snapshot.digest,
        "request_sha256":format!("sha256:{}","c".repeat(64)),"completion_sha256":format!("sha256:{}","d".repeat(64)),
        "model":"m","provider_response_id":null,"submission_call_id":"submit","hypotheses":[
        {"id":"hypothesis","state":"unverified","claim":{"title":"Claim","claimed_severity":"low","explanation":"Needs a controlled test","citations":[]}}]});
        let result_digest = store
            .retain_operation_artifact(
                &review.root_operation_id,
                "owner",
                "source.review",
                &encode(&result).unwrap(),
            )
            .unwrap();
        let actor = json!({"status":"completed","text":"Claim retained","turns":0,"tool_calls":0,"error":null,
        "source_review":{"review":result,"artifacts":{"source.bundle":bundle,"source.review":result_digest},"inference_operation":null,"external_effects_started":false,"error":null}});
        store
            .settle_operation(
                &review.root_operation_id,
                "owner",
                OperationStatus::Succeeded,
                &actor,
            )
            .unwrap();
        store.settle_operation(&review.controller_operation_id,"owner",OperationStatus::Succeeded,
        &json!({"schema_version":1,"review_id":review.review_id,"root_operation_id":review.root_operation_id,"root_status":"succeeded"})).unwrap();
        let plan = json!({"schema_version":1,"oracle_version":zero_verification::ORACLE_VERSION,"hypothesis_id":"hypothesis",
        "source_bundle_digest":bundle,"snapshot":review.snapshot,"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},
        "limits":{"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"repeats":2,
        "cases":[{"id":"attack","mode":"attack","argv":["echo","attack"],"stdin":null,"expected":{"exit_code":0,"stdout":"","stderr":""}},
        {"id":"control","mode":"legitimate_control","argv":["echo","control"],"stdin":null,"expected":{"exit_code":0,"stdout":"","stderr":""}}]});
        let admission = NativeReproductionAdmission {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: uuid::Uuid::new_v4().to_string(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            authorization: ReviewReproductionPlan {
                schema_version: 1,
                review_id: review.review_id,
                source_operation_id: review.root_operation_id.clone(),
                archive_manifest_sha256: manifest,
                plan: serde_json::from_value(plan).unwrap(),
                deadline_ms: 60000,
                max_executions: 4,
            },
            source_operation_sha256: hash(&store.get_operation(&review.root_operation_id).unwrap())
                .unwrap(),
        };
        store
            .admit_native_reproduction("followup", "owner", &admission)
            .unwrap();
        (dir, store, admission, archive)
    }

    #[test]
    fn both_sessions_are_pinned_without_raw_source_and_survive_database_deletion() {
        let (dir, mut store, a, archive) = fixture();
        store
            .begin_native_reproduction_preparation(&a.id, "owner")
            .unwrap();
        let mut pin = a.authorization.plan.snapshot.clone();
        pin.root = "/private-restored-source".into();
        let plan = FrozenPlan::new(a.authorization.plan.clone())
            .unwrap()
            .reanchor_snapshot(&pin)
            .unwrap();
        let record = store.native_reproduction(&a.id).unwrap().record;
        let binding = zero_protocol::review_reproduction::ReviewReproductionBinding {
            schema_version: 1,
            review_id: a.authorization.review_id.clone(),
            source_session_id: record.source_session_id,
            source_operation_id: a.authorization.source_operation_id.clone(),
            archive_manifest_sha256: a.authorization.archive_manifest_sha256.clone(),
            authorization_sha256: record.authorization_sha256,
            logical_plan_sha256: FrozenPlan::new(a.authorization.plan.clone())
                .unwrap()
                .digest()
                .into(),
            execution_plan_sha256: plan.digest().into(),
        };
        store
            .bind_native_reproduction_source(&a.id, "owner", plan.plan(), &binding)
            .unwrap();
        let (child, request) = store
            .admit_native_reproduction_case(&a.id, "owner", 0, 0)
            .unwrap();
        store
            .retain_operation_artifact(
                &child.id,
                "owner",
                "reproduction.request",
                &serde_json::to_vec(&request).unwrap(),
            )
            .unwrap();
        store
            .begin_native_reproduction_effect(&a.id, &child.id, "owner")
            .unwrap();
        let before_digest = store.native_reproduction_evidence_digest(&a.id).unwrap();
        store
            .conn
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        let mut writer = Store::open(dir.path().join("db")).unwrap();
        let frozen = store
            .native_reproduction_read_snapshot_inner(&a.id, || {
                writer
                    .stop_native_reproduction(&a.id, "owner", ReviewCloseReason::Cancelled)
                    .unwrap();
            })
            .unwrap();
        assert_eq!(evidence_digest(&frozen, &a.id).unwrap(), before_digest);
        assert_eq!(
            frozen.native_reproduction_evidence_digest(&a.id).unwrap(),
            before_digest
        );
        assert_ne!(
            store.native_reproduction_evidence_digest(&a.id).unwrap(),
            before_digest
        );
        assert!(store.native_reproduction_closed(&a.id).unwrap());
        assert!(!frozen.native_reproduction_closed(&a.id).unwrap());
        assert_eq!(
            frozen.get_operation(&child.id).unwrap().session_id,
            a.session_id
        );
        assert!(
            frozen
                .operation_artifacts(&child.id)
                .unwrap()
                .contains_key("reproduction.request")
        );
        for chunk in archive.blobs.keys() {
            assert!(frozen.artifact(chunk).is_err());
        }
        assert_eq!(
            frozen
                .review_source_archive_manifest(&a.authorization.review_id)
                .unwrap(),
            Some(archive.manifest)
        );
        assert!(
            frozen
                .review_source_archive(&a.authorization.review_id)
                .is_err()
        );
        assert!(
            frozen
                .conn
                .execute("DELETE FROM native_reproductions", [])
                .is_err()
        );
        drop(writer);
        drop(store);
        drop(dir);
        assert_eq!(
            frozen.native_reproduction_evidence_digest(&a.id).unwrap(),
            before_digest
        );
        assert_eq!(
            frozen
                .native_reproduction(&a.id)
                .unwrap()
                .record
                .source_operation_id,
            a.authorization.source_operation_id
        );
    }

    #[test]
    fn source_blob_loss_does_not_hide_metadata_or_require_source_restoration() {
        let (_dir, store, a, archive) = fixture();
        let before = store.native_reproduction_evidence_digest(&a.id).unwrap();
        for digest in archive.blobs.keys() {
            store
                .conn
                .execute("DELETE FROM artifacts WHERE digest=?1", [digest])
                .unwrap();
        }
        let frozen = store.native_reproduction_read_snapshot(&a.id).unwrap();
        assert_eq!(evidence_digest(&frozen, &a.id).unwrap(), before);
        assert_eq!(
            frozen
                .review_source_archive_manifest(&a.authorization.review_id)
                .unwrap(),
            Some(archive.manifest)
        );
        store
            .conn
            .execute(
                "UPDATE artifacts SET bytes=x'00' WHERE digest=?1",
                [&a.authorization.plan.source_bundle_digest],
            )
            .unwrap();
        assert!(store.native_reproduction_read_snapshot(&a.id).is_err());
        assert!(store.native_reproduction_evidence_digest(&a.id).is_err());
    }

    #[test]
    fn caller_transaction_capture_and_reopen_keep_identity_but_retained_changes_do_not() {
        let (dir, mut store, a, _) = fixture();
        assert!(capture_snapshot(&store.conn, &a.id).is_err());
        assert!(evidence_digest(&store, &a.id).is_err());
        let initial = store.native_reproduction_evidence_digest(&a.id).unwrap();
        {
            let tx = store.conn.unchecked_transaction().unwrap();
            let view = capture_snapshot(&tx, &a.id).unwrap();
            assert!(!tx.is_autocommit());
            assert_eq!(evidence_digest(&view, &a.id).unwrap(), initial);
            tx.commit().unwrap();
        }
        let escaped = b"ordinary retained evidence: \"\\\n\0";
        store
            .retain_operation_artifact(&a.operation_id, "owner", "evidence.fixture", escaped)
            .unwrap();
        let with_artifact = store.native_reproduction_evidence_digest(&a.id).unwrap();
        assert_ne!(with_artifact, initial);
        let outcome = zero_protocol::verification::ReproductionOutcome {
            assessment: None,
            artifacts: BTreeMap::new(),
            children: vec![],
            external_effects_started: false,
            stop_reason: Some(zero_protocol::verification::ReproductionStop::SetupFailed),
            error: Some("setup unavailable".into()),
        };
        store
            .settle_native_reproduction(&a.id, "owner", OperationStatus::Failed, &outcome, false)
            .unwrap();
        let terminal = store.native_reproduction_evidence_digest(&a.id).unwrap();
        assert_ne!(terminal, with_artifact);
        drop(store);
        let readonly = Store::open_read_only(dir.path().join("db")).unwrap();
        readonly
            .conn
            .pragma_update(None, "query_only", true)
            .unwrap();
        assert!(evidence_digest(&readonly, &a.id).is_err());
        assert_eq!(
            readonly.native_reproduction_evidence_digest(&a.id).unwrap(),
            terminal
        );
    }

    #[test]
    fn streamed_hash_is_exact_under_json_escaping_and_enforces_encoded_bound() {
        let value = json!({"escaped": "\0\\\"\n".repeat(16_384), "number": 42});
        let expected = serde_json::to_vec(&value).unwrap();
        let mut writer = DigestWriter {
            hasher: Sha256::new(),
            remaining: expected.len(),
        };
        writer.json(&value).unwrap();
        assert_eq!(writer.remaining, 0);
        assert_eq!(
            writer.hasher.finalize().as_slice(),
            Sha256::digest(&expected).as_slice()
        );
        let mut too_small = DigestWriter {
            hasher: Sha256::new(),
            remaining: expected.len() - 1,
        };
        assert!(too_small.json(&value).is_err());
    }

    #[test]
    fn omitted_authority_foreign_witnesses_and_raw_chunk_attachments_fail_closed() {
        for mode in 0..5 {
            let (_dir, mut store, a, archive) = fixture();
            match mode {
                0 => {
                    store
                        .conn
                        .execute(
                            "DELETE FROM events WHERE session_id=?1 AND kind='command_admitted'",
                            [&a.session_id],
                        )
                        .unwrap();
                }
                1 => {
                    store
                        .conn
                        .execute("DELETE FROM native_reproductions", [])
                        .unwrap();
                }
                2 => {
                    let tx = store.conn.transaction().unwrap();
                    append(
                        &tx,
                        &a.session_id,
                        "campaign_session_bound",
                        &json!({"campaign_id":"omitted"}),
                    )
                    .unwrap();
                    tx.commit().unwrap();
                }
                3 => {
                    store
                        .conn
                        .execute("DELETE FROM source_archives", [])
                        .unwrap();
                }
                _ => {
                    store
                        .retain_operation_artifact(
                            &a.operation_id,
                            "owner",
                            "smuggled.source",
                            archive.blobs.values().next().unwrap(),
                        )
                        .unwrap();
                }
            }
            assert!(
                store.native_reproduction_read_snapshot(&a.id).is_err(),
                "mode {mode}"
            );
        }
    }
}
