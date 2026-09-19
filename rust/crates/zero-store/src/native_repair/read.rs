//! One bounded view of the source review, baseline reproduction and repair.
use super::*;

impl Store {
    /// Capture all three journals under one source read transaction. Raw archive
    /// chunks are excluded; this view verifies evidence and cannot restore files.
    pub fn native_repair_read_snapshot(&self, key: &str) -> Result<Self> {
        let tx = self.conn.unchecked_transaction()?;
        let original = bound(&tx, key, &mut Reader::new())?;
        // bound checks global command witnesses before any rows are omitted.
        validate_session(&tx, &original.record.session_id)?;
        let view = crate::native_reproduction::capture_snapshot_with_extra_session(
            &tx,
            &original.record.source_reproduction_id,
            &original.record.session_id,
        )?;
        let copied = view.native_repair(key)?;
        if copied.record != original.record
            || serde_json::to_value(copied.operation)? != serde_json::to_value(original.operation)?
        {
            return Err(bad("repair read view differs from source"));
        }
        tx.commit()?;
        Ok(view)
    }
}

fn validate_session(conn: &Connection, session: &str) -> Result<()> {
    crate::admission_closure::validate(conn, session)?;
    for table in [
        "scans",
        "reviews",
        "source_archives",
        "native_reproductions",
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
            return Err(bad("unsupported repair session membership"));
        }
    }
    let foreign:bool=conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM campaigns WHERE journal_session_id=?1) OR EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND (kind GLOB 'scan_*' OR kind GLOB 'http_*' OR kind GLOB 'web_experiment_*' OR kind GLOB 'campaign_*' OR kind GLOB 'strategy_*' OR kind GLOB 'agent_input_*' OR kind='agent_steering_enqueued' OR kind GLOB '*question*' OR kind GLOB '*approval*')) OR EXISTS(SELECT 1 FROM tool_approval_consumptions WHERE effect_operation_id IN (SELECT id FROM operations WHERE session_id=?1))",
        [session], |r|r.get(0))?;
    if foreign {
        return Err(bad("unsupported repair session witness"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zero_protocol::source_archive::SourceArchive;

    fn fixture() -> (
        tempfile::TempDir,
        Store,
        NativeRepairAdmission,
        SourceArchive,
    ) {
        let (dir, mut store, admission) = super::super::tests::admitted_source();
        store
            .admit_native_repair("repair", "owner", &admission)
            .unwrap();
        let reproduction = store
            .native_reproduction(&admission.authorization.reproduction_id)
            .unwrap();
        let archive = store
            .review_source_archive(&reproduction.record.source_review_id)
            .unwrap()
            .unwrap();
        (dir, store, admission, archive)
    }

    #[test]
    fn three_session_capture_retains_metadata_and_evidence_without_raw_chunks() {
        let (dir, mut store, admission, archive) = fixture();
        let digest = store
            .retain_operation_artifact(
                &admission.operation_id,
                "owner",
                "fixture.repair.evidence",
                b"complete retained repair evidence",
            )
            .unwrap();
        let original = store.native_repair(&admission.id).unwrap();
        let reproduction = store
            .native_reproduction(&admission.authorization.reproduction_id)
            .unwrap();
        let view = store.native_repair_read_snapshot(&admission.id).unwrap();
        let sessions: u64 = view
            .conn
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sessions, 3);
        assert_eq!(
            view.native_repair(&admission.id).unwrap().record,
            original.record
        );
        assert_eq!(
            view.native_reproduction(&reproduction.record.id)
                .unwrap()
                .record,
            reproduction.record
        );
        assert_eq!(
            view.review_source_archive_manifest(&reproduction.record.source_review_id)
                .unwrap(),
            Some(archive.manifest)
        );
        assert_eq!(
            view.artifact(&digest).unwrap(),
            b"complete retained repair evidence"
        );
        for chunk in archive.blobs.keys() {
            assert!(
                view.artifact(chunk).is_err(),
                "report view must not hydrate raw source"
            );
        }
        assert!(
            view.conn.execute("DELETE FROM native_repairs", []).is_err(),
            "captured view must be query-only"
        );
        drop(store);
        std::fs::remove_file(dir.path().join("db")).unwrap();
        assert_eq!(
            view.native_repair(&admission.id).unwrap().record,
            original.record
        );
        assert_eq!(
            view.artifact(&digest).unwrap(),
            b"complete retained repair evidence"
        );
        assert!(
            view.review_snapshot(&reproduction.record.source_review_id)
                .is_ok()
        );
    }

    #[test]
    fn captured_view_is_pinned_and_fresh_view_observes_durable_close() {
        let (_dir, mut store, admission, _) = fixture();
        let old = store.native_repair_read_snapshot(&admission.id).unwrap();
        assert!(!old.native_repair_closed(&admission.id).unwrap());
        store
            .stop_native_repair(&admission.id, "owner", ReviewCloseReason::Cancelled)
            .unwrap();
        let latest = store.native_repair_read_snapshot(&admission.id).unwrap();
        assert!(!old.native_repair_closed(&admission.id).unwrap());
        assert!(latest.native_repair_closed(&admission.id).unwrap());
        let close_count = |db: &Store| -> u64 {
            db.conn.query_row("SELECT count(*) FROM events WHERE kind='native_repair_closed' AND session_id=?1", [&admission.session_id], |r| r.get(0)).unwrap()
        };
        assert_eq!(close_count(&old), 0);
        assert_eq!(close_count(&latest), 1);
    }

    #[test]
    fn missing_raw_source_is_tolerated_but_ordinary_evidence_is_required() {
        let (_dir, mut store, admission, archive) = fixture();
        let digest = store
            .retain_operation_artifact(
                &admission.operation_id,
                "owner",
                "fixture.repair.evidence",
                b"independent ordinary evidence",
            )
            .unwrap();
        store
            .conn
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        for chunk in archive.blobs.keys() {
            assert_eq!(
                store
                    .conn
                    .execute("DELETE FROM artifacts WHERE digest=?1", [chunk])
                    .unwrap(),
                1
            );
        }
        let view = store.native_repair_read_snapshot(&admission.id).unwrap();
        assert_eq!(
            view.artifact(&digest).unwrap(),
            b"independent ordinary evidence"
        );
        assert_eq!(
            store
                .conn
                .execute("DELETE FROM artifacts WHERE digest=?1", [&digest])
                .unwrap(),
            1
        );
        assert!(
            store.native_repair_read_snapshot(&admission.id).is_err(),
            "ordinary evidence cannot be silently omitted"
        );
    }

    #[test]
    fn foreign_session_witness_and_raw_chunk_disguised_as_evidence_are_rejected() {
        for raw_attachment in [false, true] {
            let (_dir, mut store, admission, archive) = fixture();
            assert!(store.native_repair_read_snapshot(&admission.id).is_ok());
            if raw_attachment {
                let raw = archive.blobs.values().next().unwrap();
                store
                    .retain_operation_artifact(
                        &admission.operation_id,
                        "owner",
                        "fixture.raw-smuggling",
                        raw,
                    )
                    .unwrap();
            } else {
                let tx = store.conn.transaction().unwrap();
                append(
                    &tx,
                    &admission.session_id,
                    "http_rate_updated",
                    &json!({"unrelated_authority":true}),
                )
                .unwrap();
                tx.commit().unwrap();
            }
            assert!(store.native_repair_read_snapshot(&admission.id).is_err());
        }
    }

    #[test]
    fn repair_artifacts_share_the_aggregate_three_session_read_bound() {
        let (_dir, mut store, admission, _) = fixture();
        assert!(store.native_repair_read_snapshot(&admission.id).is_ok());
        // Construct an oversized retained evidence projection directly. Normal
        // per-operation retention is tighter, but a damaged database must also
        // fail the independently enforced aggregate read bound before hydration.
        let mut retained = 0;
        let mut ordinal = 0;
        while retained < crate::campaign_snapshot::MAX_BYTES {
            let bytes = vec![ordinal as u8; crate::MAX_ARTIFACT_BYTES];
            let digest = format!("sha256:{:x}", Sha256::digest(&bytes));
            let name = format!("fixture.repair.{ordinal}");
            let tx = store.conn.transaction().unwrap();
            tx.execute(
                "INSERT INTO artifacts(digest,bytes) VALUES(?1,?2)",
                params![digest, bytes],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO operation_artifacts(operation_id,name,digest) VALUES(?1,?2,?3)",
                params![admission.operation_id, name, digest],
            )
            .unwrap();
            append(&tx, &admission.session_id, "operation_artifact", &json!({"operation_id":admission.operation_id,"name":name,"digest":digest,"bytes":bytes.len()})).unwrap();
            tx.commit().unwrap();
            retained += bytes.len();
            ordinal += 1;
        }
        let failure = match store.native_repair_read_snapshot(&admission.id) {
            Ok(_) => panic!("repair evidence bypassed the aggregate view budget"),
            Err(error) => error.to_string(),
        };
        assert!(
            failure.contains("read view artifact byte bound"),
            "{failure}"
        );
    }
}
