//! A bounded, inert read view of one scan. This is not an export or source attestation.
use super::*;
use rusqlite::{Connection, types::Value};

const SCAN_TABLES: &[&str] = &[
    "sessions",
    "operations",
    "events",
    "reservations",
    "http_accounts",
    "http_dispatches",
    "http_rates",
    "web_experiment_admissions",
    "operation_artifacts",
    "agent_steering_windows",
    "web_triage_decisions",
    "scans",
];
impl Store {
    /// Copy a complete bounded session closure from one pinned source transaction.
    /// Readers may use their usual nested read transactions against the resulting
    /// private query-only database without racing a live external owner.
    pub fn scan_read_snapshot(&self, id: &str) -> Result<Self> {
        self.scan_read_snapshot_inner(id, || {})
    }
    fn scan_read_snapshot_inner(&self, id: &str, after_pin: impl FnOnce()) -> Result<Self> {
        let source = self.conn.unchecked_transaction()?;
        crate::schema::validate_current(&source)?;
        let record = crate::scan::snapshot_source_record(&source, id)?;
        crate::review::forbid_input(&source, &record.session_id)?;
        after_pin();
        let parameter = [Value::Text(record.session_id.clone())];
        for table in [
            "reviews",
            "source_archives",
            "agent_inputs",
            "agent_steering",
            "operator_questions",
            "operator_question_decisions",
            "tool_approvals",
            "tool_approval_decisions",
            "source_triage_decisions",
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
                return Err(invalid("unsupported membership in scan read view"));
            }
        }
        let foreign_controller: bool = source.query_row(
            "SELECT EXISTS(SELECT 1 FROM campaigns WHERE journal_session_id=?1)",
            [&record.session_id],
            |r| r.get(0),
        )?;
        if foreign_controller {
            return Err(invalid("scan is also a campaign controller"));
        }
        let mut remaining = MAX_BYTES;
        let mut count = 0;
        let mut rows = Vec::new();
        for table in SCAN_TABLES {
            let filter = match *table {
                "sessions" => "id=?1",
                "http_dispatches" | "http_rates" => {
                    "account_id IN (SELECT id FROM http_accounts WHERE session_id=?1)"
                }
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
            "SELECT DISTINCT CASE WHEN length(digest)=71 THEN digest END FROM operation_artifacts WHERE operation_id IN (SELECT id FROM operations WHERE session_id=?1) ORDER BY digest LIMIT 65537",
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
                return Err(invalid("scan artifact read exceeds bound"));
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
            return Err(invalid("foreign reference in scan read view"));
        }
        tx.commit()?;
        conn.pragma_update(None, "query_only", true)?;
        let frozen = Store { conn };
        if frozen.scan_record(id)? != record {
            return Err(invalid("scan source and read view differ"));
        }
        frozen.validate_session_admission_closure(&record.session_id)?;
        Ok(frozen)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ScanAdmission;
    use serde_json::{Value, json};
    use zero_protocol::{model::ResponsesRequest, scan::*};
    fn hash(v: &Value) -> String {
        zero_web_verification::hash(v).unwrap()
    }
    fn prepared() -> ScanAdmission {
        let profile:ScanProfile=serde_json::from_value(json!({"schema_version":1,"kind":"scoped_http","provider":"p","model":"m","instructions":"Host instructions","http_profile":"target","budget_limit":10,"currency":"units","reservation_per_turn":6,"max_turns":3,"max_hypotheses":2,"deadline_ms":60000})).unwrap();
        let scan_id = uuid::Uuid::new_v4().to_string();
        let session_id = uuid::Uuid::new_v4().to_string();
        let limits=serde_json::from_value(json!({"model_micro_usd":10,"model_calls":4,"http_requests":4,"http_request_body_bytes":1000,"http_response_decoded_bytes":1000,"experiments":2,"runs":4,"max_parallel_runs":1})).unwrap();
        let policy = zero_http::normalize_policy(
            zero_protocol::strategy_search::search_fixture_profile(
                "http://127.0.0.1:8080/",
                &limits,
            )
            .unwrap(),
        )
        .unwrap();
        let target = "http://127.0.0.1:8080/";
        let root_command = format!("scan:{scan_id}:root");
        let pd = hash(&serde_json::to_value(&policy).unwrap());
        let context = json!({"schema_version":1,"profile_name":"target","profile":policy,"profile_sha256":pd,"original_root_command":root_command,"account_id":hash(&json!({"session_id":session_id,"original_root_command":root_command,"profile_sha256":pd}))});
        let request = profile.request(target).unwrap();
        let template:ResponsesRequest=serde_json::from_value(json!({"model":"m","instructions":request.instructions,"input":[],"max_output_tokens":8192,"tools":[{"name":"http_request","description":"HTTP","parameters":{"type":"object"}},{"name":"submit_web_hypotheses","description":"Submit","parameters":{"type":"object"}}]})).unwrap();
        let pins = json!({"p":{"endpoint":"http://127.0.0.1:9090/responses","wire_api":"responses","rates":{"input":1,"cached_input":1,"output":1}}});
        ScanAdmission {
            scan_id,
            session_id,
            controller_operation_id: uuid::Uuid::new_v4().to_string(),
            root_operation_id: uuid::Uuid::new_v4().to_string(),
            input_target: target.into(),
            target: target.into(),
            profile_name: "scan".into(),
            profile,
            provider_context: serde_json::from_value(pins.clone()).unwrap(),
            root_payload: json!({"kind":"scoped_web_agent","request":request,"endpoint":pins["p"]["endpoint"],"rates":pins["p"]["rates"],"http_context":context,"http_output_version":2,"scan_template":template}),
        }
    }

    fn fixture() -> (tempfile::TempDir, Store, ScanAdmission) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("db")).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let prepared = prepared();
        store.admit_scan("scan-create", "owner", &prepared).unwrap();
        (dir, store, prepared)
    }
    #[test]
    fn scan_read_view_pins_real_account_and_close_frontier_before_writer_commit() {
        let (dir, store, a) = fixture();
        store
            .conn
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        let before = store.scan_snapshot(&a.scan_id).unwrap();
        let mut writer = Store::open(dir.path().join("db")).unwrap();
        let pinned = store
            .scan_read_snapshot_inner(&a.scan_id, || {
                assert!(
                    writer
                        .request_scan_stop(&a.scan_id, "owner", ScanCloseReason::Cancelled)
                        .unwrap()
                );
            })
            .unwrap();
        let retained = pinned.scan_snapshot(&a.scan_id).unwrap();
        assert_eq!(retained.scan, before.scan);
        assert_eq!(retained.observed_sequence, before.observed_sequence);
        assert_eq!(retained.close_reason, None);
        assert_eq!(
            store.scan_snapshot(&a.scan_id).unwrap().close_reason,
            Some(ScanCloseReason::Cancelled)
        );
        assert!(
            pinned
                .conn
                .execute("UPDATE scans SET close_reason='cancelled'", [])
                .is_err()
        );
        drop(writer);
        drop(store);
        drop(dir);
        assert_eq!(pinned.scan_record(&a.scan_id).unwrap(), before.scan);
    }
    #[test]
    fn scan_view_rejects_orphan_unknown_or_global_duplicate_creation() {
        for orphan in [true, false] {
            let (_dir, mut store, a) = fixture();
            if orphan {
                store.conn.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status,owner) VALUES('orphan',?1,'orphan','{}','unused','unknown','owner')",[&a.session_id]).unwrap();
            } else {
                let other = store.create_session("unrelated", 10).unwrap();
                store.conn.execute("INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,999,'scan_created',?2)",rusqlite::params![other.id,serde_json::to_string(&store.scan_record(&a.scan_id).unwrap()).unwrap()]).unwrap();
            }
            assert!(store.scan_read_snapshot(&a.scan_id).is_err());
        }
    }
    #[test]
    fn scan_view_rejects_review_membership_even_without_its_projection() {
        for kind in ["review_created", "review_source_archived"] {
            let (_dir, store, a) = fixture();
            store
                .conn
                .execute(
                    "INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,999,?2,'{}')",
                    rusqlite::params![a.session_id, kind],
                )
                .unwrap();
            assert!(store.scan_read_snapshot(&a.scan_id).is_err());
        }
    }
    #[test]
    fn scan_view_rejects_oversized_unrelated_journal_record_before_copy() {
        let (_dir, store, a) = fixture();
        store.conn.execute("INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,999,'unrelated',replace(hex(zeroblob(17000000)),'0','x'))",[&a.session_id]).unwrap();
        assert!(store.scan_read_snapshot(&a.scan_id).is_err());
    }
}
