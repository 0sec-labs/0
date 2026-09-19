//! A bounded, inert read view of one review. This is not an export or source attestation.
use super::*;
use rusqlite::{Connection, types::Value};

const REVIEW_TABLES: &[&str] = &[
    "sessions",
    "operations",
    "events",
    "reservations",
    "operation_artifacts",
    "agent_steering_windows",
    "source_triage_decisions",
    "reviews",
];
impl Store {
    /// Copy a complete bounded session closure from one pinned source transaction.
    /// Readers may use their usual nested read transactions against the resulting
    /// private query-only database without racing a live external owner.
    pub fn review_read_snapshot(&self, id: &str) -> Result<Self> {
        self.review_read_snapshot_inner(id, || {})
    }
    fn review_read_snapshot_inner(&self, id: &str, after_pin: impl FnOnce()) -> Result<Self> {
        let source = self.conn.unchecked_transaction()?;
        crate::schema::validate_current(&source)?;
        let record = crate::review::snapshot_source_record(&source, id)?;
        after_pin();
        let parameter = [Value::Text(record.session_id.clone())];
        for table in [
            "scans",
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
            let forbidden: bool = source.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE session_id=?1)"),
                [&record.session_id],
                |r| r.get(0),
            )?;
            if forbidden {
                return Err(invalid("unsupported membership in review read view"));
            }
        }
        let foreign_controller: bool = source.query_row(
            "SELECT EXISTS(SELECT 1 FROM campaigns WHERE journal_session_id=?1)",
            [&record.session_id],
            |r| r.get(0),
        )?;
        if foreign_controller {
            return Err(invalid("review is also a campaign controller"));
        }
        // Projection deletion must not hide a foreign workflow or unsupported input.
        let foreign_witness: bool = source.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND (kind GLOB 'scan_*' OR kind GLOB 'http_*' OR kind GLOB 'web_experiment_*' OR kind GLOB 'campaign_*' OR kind GLOB 'strategy_*' OR kind GLOB 'agent_input_*' OR kind='agent_steering_enqueued' OR kind GLOB '*question*' OR kind GLOB '*approval*')) OR EXISTS(SELECT 1 FROM tool_approval_consumptions WHERE effect_operation_id IN (SELECT id FROM operations WHERE session_id=?1))",
            [&record.session_id], |r| r.get(0))?;
        if foreign_witness {
            return Err(invalid("unsupported workflow witness in review read view"));
        }
        let (operation_bytes, operation_max): (usize, usize) = source.query_row(
            "SELECT coalesce(sum(length(CAST(payload AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0)),0),coalesce(max(length(CAST(payload AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0)),0) FROM operations WHERE session_id=?1",
            [&record.session_id], |r| Ok((r.get(0)?,r.get(1)?)))?;
        if operation_bytes > MAX_BYTES || operation_max > 32 * 1024 * 1024 {
            return Err(invalid("review operation exceeds source bound"));
        }
        let unsupported: bool = source.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE session_id=?1 AND CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload,'$.kind'),'') NOT IN ('native_review','offline_snapshot_agent','agent_inference','agent_source_tool','agent_tool','agent_delegation') OR json_type(payload,'$.scan_operation_id') IS NOT NULL OR json_type(payload,'$.scan_context') IS NOT NULL OR json_type(payload,'$.http_context') IS NOT NULL OR json_type(payload,'$.strategy_capture') IS NOT NULL ELSE 1 END)",
            [&record.session_id], |r| r.get(0))?;
        let foreign_parent: bool = source.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations o WHERE o.session_id=?1 AND json_type(o.payload,'$.parent_operation') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations p WHERE p.id=json_extract(o.payload,'$.parent_operation') AND p.session_id=o.session_id))",
            [&record.session_id], |r| r.get(0))?;
        let detached: bool = source.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations o WHERE o.session_id=?1 AND o.id NOT IN (?2,?3) AND NOT EXISTS(SELECT 1 FROM operations p WHERE p.id=json_extract(o.payload,'$.parent_operation') AND p.session_id=o.session_id AND ((p.id=?3 AND json_extract(o.payload,'$.kind') IN ('agent_inference','agent_source_tool','agent_tool','agent_delegation')) OR (json_extract(p.payload,'$.kind')='agent_delegation' AND json_extract(p.payload,'$.parent_operation')=?3 AND json_extract(o.payload,'$.kind')='offline_snapshot_agent') OR (json_extract(p.payload,'$.kind')='offline_snapshot_agent' AND json_extract(o.payload,'$.kind') IN ('agent_inference','agent_source_tool','agent_tool') AND EXISTS(SELECT 1 FROM operations g WHERE g.id=json_extract(p.payload,'$.parent_operation') AND g.session_id=o.session_id AND json_extract(g.payload,'$.kind')='agent_delegation' AND json_extract(g.payload,'$.parent_operation')=?3)))))",
            rusqlite::params![record.session_id, record.controller_operation_id, record.root_operation_id], |r| r.get(0))?;
        if unsupported || foreign_parent || detached {
            return Err(invalid(
                "unsupported operation or foreign parent in review read view",
            ));
        }
        let mut remaining = MAX_BYTES;
        let mut count = 0;
        let mut rows = Vec::new();
        for table in REVIEW_TABLES {
            let filter = match *table {
                "sessions" => "id=?1",
                "operation_artifacts" | "agent_steering_windows" => {
                    "operation_id IN (SELECT id FROM operations WHERE session_id=?1)"
                }
                _ => "session_id=?1",
            };
            rows.push((
                *table,
                capture::read_rows(
                    &source,
                    table,
                    filter,
                    &parameter,
                    &mut remaining,
                    &mut count,
                )?,
            ));
        }
        let digests = capture::strings(
            &source,
            "SELECT CASE WHEN length(digest)=71 THEN digest END FROM (SELECT digest FROM operation_artifacts WHERE operation_id IN (SELECT id FROM operations WHERE session_id=?1) UNION SELECT source_review_sha256 AS digest FROM source_triage_decisions WHERE session_id=?1) ORDER BY digest LIMIT 65537",
            &parameter,
            MAX_RECORDS,
        )?;
        let mut artifacts = Vec::new();
        for digest in digests {
            let size: usize = source.query_row(
                "SELECT length(bytes) FROM artifacts WHERE digest=?1",
                [&digest],
                |r| r.get(0),
            )?;
            if size > crate::MAX_ARTIFACT_BYTES || size > remaining {
                return Err(invalid("review artifact read exceeds bound"));
            }
            remaining -= size;
            artifacts.push((digest.clone(), crate::artifacts::read(&source, &digest)?));
        }
        source.commit()?;
        let mut conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", true)?;
        crate::schema::initialize(&mut conn)?;
        let tx = conn.transaction()?;
        tx.pragma_update(None, "defer_foreign_keys", true)?;
        for (digest, bytes) in artifacts {
            tx.execute(
                "INSERT INTO artifacts(digest,bytes) VALUES(?1,?2)",
                rusqlite::params![digest, bytes],
            )?;
        }
        for (table, rows) in rows {
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
                        Cell::Null => Value::Null,
                        Cell::Integer(n) => Value::Integer(n),
                        Cell::Text(s) => Value::Text(s),
                    },
                )))?;
            }
        }
        if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
            return Err(invalid("foreign reference in review read view"));
        }
        tx.commit()?;
        conn.pragma_update(None, "query_only", true)?;
        let frozen = Store { conn };
        if frozen.review_record(id)? != record {
            return Err(invalid("review source and read view differ"));
        }
        frozen.review_snapshot(id)?;
        Ok(frozen)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ReviewAdmission;
    use serde_json::{Value, json};
    use zero_protocol::review::*;
    fn hash(v: &Value) -> String {
        zero_web_verification::hash(v).unwrap()
    }
    fn prepared() -> ReviewAdmission {
        let profile:ReviewProfile=serde_json::from_value(json!({"schema_version":1,"provider":"p","model":"m","instructions":"Host review","question":"Inspect input handling","execution":{"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"budget_limit":10,"currency":"units","reservation_per_turn":6,"max_turns":3,"max_hypotheses":2,"deadline_ms":60000})).unwrap();
        let files =
            json!([{"path":"app.rs","digest":format!("sha256:{}","b".repeat(64)),"bytes":10}]);
        let snapshot: zero_protocol::SnapshotPin = serde_json::from_value(
            json!({"id":"source","root":"/source","files":files,"digest":hash(&files)}),
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
            root_payload: json!({"kind":"offline_snapshot_agent","request":request,"endpoint":pins["p"]["endpoint"],"rates":pins["p"]["rates"],"review_template":template}),
            provider_context: serde_json::from_value(pins).unwrap(),
        }
    }
    fn fixture() -> (tempfile::TempDir, Store, ReviewAdmission) {
        let d = tempfile::tempdir().unwrap();
        let mut s = Store::open(d.path().join("db")).unwrap();
        s.claim_engine_epoch("owner").unwrap();
        (d, s, prepared())
    }

    #[test]
    fn pinned_review_survives_writer_close_and_source_deletion() {
        let (dir, mut store, a) = fixture();
        store.admit_review("run", "owner", &a).unwrap();
        store
            .conn
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        let before = store.review_snapshot(&a.review_id).unwrap();
        let mut writer = Store::open(dir.path().join("db")).unwrap();
        let frozen = store
            .review_read_snapshot_inner(&a.review_id, || {
                writer
                    .request_review_stop(&a.review_id, "owner", ReviewCloseReason::Cancelled)
                    .unwrap();
            })
            .unwrap();
        let pinned = frozen.review_snapshot(&a.review_id).unwrap();
        assert_eq!(pinned.review, before.review);
        assert_eq!(pinned.observed_sequence, before.observed_sequence);
        assert_eq!(pinned.close_reason, None);
        assert_eq!(
            store.review_snapshot(&a.review_id).unwrap().close_reason,
            Some(ReviewCloseReason::Cancelled)
        );
        assert!(frozen.conn.execute("DELETE FROM reviews", []).is_err());
        drop(writer);
        drop(store);
        drop(dir);
        assert_eq!(frozen.review_record(&a.review_id).unwrap(), before.review);
    }

    #[test]
    fn foreign_projection_deleted_markers_and_missing_admissions_fail_closed() {
        for mutation in [0, 1, 2, 3] {
            let (_dir, mut store, a) = fixture();
            store.admit_review("run", "owner", &a).unwrap();
            match mutation {
                0 => {
                    store.conn.execute("DELETE FROM events WHERE kind='command_admitted' AND json_extract(payload,'$.id')=?1", [&a.root_operation_id]).unwrap();
                }
                1 => {
                    let tx = store.conn.transaction().unwrap();
                    crate::append(
                        &tx,
                        &a.session_id,
                        "agent_input_queued",
                        &json!({"input_id":"deleted"}),
                    )
                    .unwrap();
                    tx.commit().unwrap();
                }
                2 => {
                    let tx = store.conn.transaction().unwrap();
                    crate::append(
                        &tx,
                        &a.session_id,
                        "campaign_session_bound",
                        &json!({"campaign_id":"deleted"}),
                    )
                    .unwrap();
                    tx.commit().unwrap();
                }
                _ => {
                    store.conn.execute("DELETE FROM reviews", []).unwrap();
                }
            }
            assert!(
                store.review_read_snapshot(&a.review_id).is_err(),
                "mutation {mutation}"
            );
        }
    }

    #[test]
    fn retained_artifacts_are_complete_and_hash_checked() {
        let (_dir, mut store, a) = fixture();
        store.admit_review("run", "owner", &a).unwrap();
        let digest = store
            .retain_operation_artifact(
                &a.root_operation_id,
                "owner",
                "source.fixture",
                b"retained source observation",
            )
            .unwrap();
        let frozen = store.review_read_snapshot(&a.review_id).unwrap();
        assert_eq!(
            frozen.artifact(&digest).unwrap(),
            b"retained source observation"
        );
        store
            .conn
            .execute(
                "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
                rusqlite::params![b"changed".as_slice(), digest],
            )
            .unwrap();
        assert!(store.review_read_snapshot(&a.review_id).is_err());
    }
}
