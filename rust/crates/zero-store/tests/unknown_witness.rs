#![allow(clippy::unwrap_used)]
use rusqlite::{Connection, params};
use serde_json::json;
use zero_store::Store;
#[test]
fn unknown_requires_exact_admission_started_and_recovery_witness() {
    for mode in 0..3 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = Store::open(&path).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let session = store.create_session("g", 100).unwrap().id;
        let op = store
            .admit_owned_batch(
                &session,
                "owner",
                &[("run".into(), json!({"kind":"fixture"}))],
            )
            .unwrap()
            .remove(0);
        match mode {
            0 => {
                store
                    .mark_operation_unknown(&op.id, "owner", "worker interrupted")
                    .unwrap();
            }
            1 => {
                store.recover_owner("owner").unwrap();
            }
            _ => {
                store.claim_engine_epoch("replacement").unwrap();
            }
        }
        let unknown = store.get_operation(&op.id).unwrap();
        store.validate_unknown_operation(&unknown).unwrap();
        let mut forged = unknown.clone();
        forged.outcome = Some(json!({"reason":"forged"}));
        assert!(store.validate_unknown_operation(&forged).is_err());
        drop(store);
        let store = Store::open_read_only(&path).unwrap();
        store.validate_unknown_operation(&unknown).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute("UPDATE events SET payload=json_set(payload,'$.owner','changed-owner') WHERE session_id=?1 AND kind='operation_unknown'",[&session]).unwrap();
        assert!(store.validate_unknown_operation(&unknown).is_err());
        conn.execute(
            "DELETE FROM events WHERE session_id=?1 AND kind='operation_unknown'",
            [&session],
        )
        .unwrap();
        assert!(store.validate_unknown_operation(&unknown).is_err());
        conn.execute("INSERT INTO events(session_id,sequence,kind,payload) SELECT ?1,coalesce(max(sequence),0)+1,'operation_unknown',?2 FROM events WHERE session_id=?1",params![session,serde_json::to_string(&unknown).unwrap()]).unwrap();
        store.validate_unknown_operation(&unknown).unwrap();
        conn.execute("UPDATE events SET payload=json_set(payload,'$.owner','changed-owner') WHERE session_id=?1 AND kind='operation_started'",[&session]).unwrap();
        assert!(store.validate_unknown_operation(&unknown).is_err());
    }
}
