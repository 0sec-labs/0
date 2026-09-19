#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zero_protocol::{review::*, source_archive::*};
use zero_store::{ReviewAdmission, Store};
fn hash(v: &Value) -> String {
    zero_web_verification::hash(v).unwrap()
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

fn source(data: Vec<u8>) -> SourceArchive {
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
    let digest = hash(&json!([{"path":file.path,"digest":file.sha256,"bytes":file.bytes}]));
    SourceArchive {
        manifest: ArchiveManifest {
            schema_version: 1,
            snapshot_sha256: digest,
            files: vec![file],
        },
        blobs,
    }
}
fn fixture() -> (tempfile::TempDir, Store, ReviewAdmission, SourceArchive) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let archive = source(b"complete binary source\0\xff".to_vec());
    let admission = prepared(&archive);
    store.admit_review("run", "owner", &admission).unwrap();
    (dir, store, admission, archive)
}
#[test]
fn full_source_roundtrip_and_inert_retry_after_close_owner_loss_and_readonly_reopen() {
    let (dir, mut store, a, archive) = fixture();
    assert!(store.review_source_archive(&a.review_id).unwrap().is_none());
    assert!(
        store
            .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
            .is_err()
    );
    store
        .begin_review_source_preparation(&a.root_operation_id, "owner")
        .unwrap();
    let digest = store
        .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
        .unwrap();
    assert_eq!(
        store.review_source_archive(&a.review_id).unwrap(),
        Some(archive.clone())
    );
    assert!(
        store
            .operation_artifacts(&a.root_operation_id)
            .unwrap()
            .is_empty()
    );
    store
        .request_review_stop(&a.review_id, "owner", ReviewCloseReason::Cancelled)
        .unwrap();
    store.claim_engine_epoch("next").unwrap();
    assert_eq!(
        store
            .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
            .unwrap(),
        digest
    );
    assert!(
        store
            .retain_review_source_archive(&a.root_operation_id, "next", &archive)
            .is_err()
    );
    let mut changed = archive.clone();
    changed.manifest.files[0].executable = false;
    assert!(
        store
            .retain_review_source_archive(&a.root_operation_id, "owner", &changed)
            .is_err()
    );
    drop(store);
    let read = Store::open_read_only(dir.path().join("db")).unwrap();
    assert_eq!(
        read.review_source_archive(&a.review_id).unwrap(),
        Some(archive)
    );
}
#[test]
fn archive_cannot_attach_to_foreign_closed_or_expired_authority() {
    for mode in 0..5 {
        let (_dir, mut store, a, archive) = fixture();
        store
            .begin_review_source_preparation(&a.root_operation_id, "owner")
            .unwrap();
        match mode {
            0 => {
                store
                    .request_review_stop(&a.review_id, "owner", ReviewCloseReason::Cancelled)
                    .unwrap();
            }
            1 => {
                store.claim_engine_epoch("next").unwrap();
            }
            2 => {}
            3 => {}
            _ => {}
        }
        let root = if mode == 3 {
            &a.controller_operation_id
        } else {
            &a.root_operation_id
        };
        let owner = if mode == 2 { "other" } else { "owner" };
        let mut wrong = archive.clone();
        if mode == 4 {
            wrong.manifest.snapshot_sha256 = format!("sha256:{}", "f".repeat(64));
        }
        assert!(
            store
                .retain_review_source_archive(root, owner, &wrong)
                .is_err(),
            "mode{mode}"
        );
        assert!(store.review_source_archive(&a.review_id).unwrap().is_none());
    }
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let archive = source(vec![1]);
    let mut a = prepared(&archive);
    a.profile.deadline_ms = 100;
    a.root_payload["request"] = serde_json::to_value(
        a.profile
            .request(a.snapshot.clone(), &a.root_operation_id)
            .unwrap(),
    )
    .unwrap();
    store.admit_review("run", "owner", &a).unwrap();
    store
        .begin_review_source_preparation(&a.root_operation_id, "owner")
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(110));
    assert!(
        store
            .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
            .is_err()
    );
}
#[test]
fn insertion_failure_rolls_back_manifest_chunks_projection_and_witness() {
    let (dir, mut store, a, archive) = fixture();
    store
        .begin_review_source_preparation(&a.root_operation_id, "owner")
        .unwrap();
    let sql = rusqlite::Connection::open(dir.path().join("db")).unwrap();
    let before: u64 = sql
        .query_row("SELECT count(*) FROM artifacts", [], |r| r.get(0))
        .unwrap();
    sql.execute_batch("CREATE TRIGGER deny_archive BEFORE INSERT ON source_archives BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(
        store
            .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
            .is_err()
    );
    assert_eq!(
        sql.query_row("SELECT count(*) FROM artifacts", [], |r| r.get::<_, u64>(0))
            .unwrap(),
        before
    );
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM events WHERE kind='review_source_archived'",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        0
    );
    assert!(store.review_source_archive(&a.review_id).unwrap().is_none());
}
#[test]
fn deleted_projection_or_witness_and_changed_chunks_never_look_absent() {
    for mutation in 0..5 {
        let (dir, mut store, a, archive) = fixture();
        store
            .begin_review_source_preparation(&a.root_operation_id, "owner")
            .unwrap();
        let digest = store
            .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
            .unwrap();
        let sql = rusqlite::Connection::open(dir.path().join("db")).unwrap();
        match mutation {
            0 => {
                sql.execute("DELETE FROM source_archives", []).unwrap();
            }
            1 => {
                sql.execute("DELETE FROM events WHERE kind='review_source_archived'", [])
                    .unwrap();
            }
            2 => {
                sql.execute(
                    "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
                    rusqlite::params![b"changed".as_slice(), archive.blobs.keys().next().unwrap()],
                )
                .unwrap();
            }
            3 => {
                sql.execute("DELETE FROM events WHERE kind='operation_detail' AND json_extract(payload,'$.kind')='review_source_preparation_started'",[]).unwrap();
            }
            _ => {
                sql.execute(
                    "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
                    rusqlite::params![b"{}".as_slice(), digest],
                )
                .unwrap();
            }
        }
        assert!(
            store.review_source_archive(&a.review_id).is_err(),
            "mutation{mutation}"
        );
        assert!(
            store
                .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
                .is_err()
        );
    }
}
#[test]
fn archives_over_generic_attachment_limit_stay_out_of_report_read_views() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let mut data = Vec::new();
    for n in 0..5 {
        data.extend(std::iter::repeat_n(n, CHUNK_BYTES));
    }
    let archive = source(data);
    let mut a = prepared(&archive);
    a.profile.deadline_ms = 300000;
    store.admit_review("large", "owner", &a).unwrap();
    store
        .begin_review_source_preparation(&a.root_operation_id, "owner")
        .unwrap();
    let digest = store
        .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
        .unwrap();
    assert_eq!(
        store.review_source_archive(&a.review_id).unwrap(),
        Some(archive)
    );
    let view = store.review_read_snapshot(&a.review_id).unwrap();
    assert_eq!(view.review_record(&a.review_id).unwrap().id, a.review_id);
    assert!(view.artifact(&digest).is_err());
}
#[test]
fn schema_eighteen_migration_preserves_old_review_and_none_is_honest() {
    let (dir, store, a, _) = fixture();
    drop(store);
    let sql = rusqlite::Connection::open(dir.path().join("db")).unwrap();
    sql.execute_batch(
        "DROP INDEX source_archive_command; DROP TABLE source_archives; PRAGMA user_version=18;",
    )
    .unwrap();
    assert!(matches!(
        Store::open_read_only(dir.path().join("db")),
        Err(zero_store::Error::Schema(18))
    ));
    let store = Store::open(dir.path().join("db")).unwrap();
    assert!(store.review_source_archive(&a.review_id).unwrap().is_none());
    assert_eq!(store.review_record(&a.review_id).unwrap().id, a.review_id);
}
#[test]
fn changed_eighteen_schema_rejects_before_archive_migration() {
    let (dir, store, _, _) = fixture();
    drop(store);
    let sql = rusqlite::Connection::open(dir.path().join("db")).unwrap();
    sql.execute_batch("DROP INDEX source_archive_command; DROP TABLE source_archives; PRAGMA user_version=18; CREATE INDEX alien ON sessions(created_at_ms);").unwrap();
    assert!(matches!(
        Store::open(dir.path().join("db")),
        Err(zero_store::Error::ForeignDatabase)
    ));
    assert_eq!(
        sql.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        18
    );
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='source_archives'",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn archive_must_precede_first_model_admission_but_historical_retry_is_inert() {
    for retained_first in [false, true] {
        let (dir, mut store, a, archive) = fixture();
        store
            .begin_review_source_preparation(&a.root_operation_id, "owner")
            .unwrap();
        if retained_first {
            store
                .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
                .unwrap();
        }
        let payload = json!({"kind":"agent_inference","parent_operation":a.root_operation_id,"request":a.root_payload["review_template"],"endpoint":a.root_payload["endpoint"],"rates":a.root_payload["rates"],"wire_api":"responses"});
        store
            .admit_owned_batch(
                &a.session_id,
                "owner",
                &[(format!("{}:model:0", a.root_operation_id), payload)],
            )
            .unwrap();
        assert_eq!(
            store
                .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
                .is_ok(),
            retained_first
        );
        if retained_first {
            // Move both the immutable archive event and its projection after the
            // inference; a consistent projection edit still violates causality.
            let sql = rusqlite::Connection::open(dir.path().join("db")).unwrap();
            let next: u64 = sql
                .query_row(
                    "SELECT max(sequence)+1 FROM events WHERE session_id=?1",
                    [&a.session_id],
                    |r| r.get(0),
                )
                .unwrap();
            sql.execute(
                "UPDATE events SET sequence=?1 WHERE kind='review_source_archived'",
                [next],
            )
            .unwrap();
            sql.execute("UPDATE source_archives SET sequence=?1", [next])
                .unwrap();
            assert!(store.review_source_archive(&a.review_id).is_err());
        } else {
            assert!(store.review_source_archive(&a.review_id).unwrap().is_none());
        }
    }
}

#[test]
fn archive_projection_or_marker_alone_keeps_generic_session_authority_closed() {
    for keep_projection in [false, true] {
        let (dir, mut store, a, archive) = fixture();
        store
            .begin_review_source_preparation(&a.root_operation_id, "owner")
            .unwrap();
        store
            .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
            .unwrap();
        let sql = rusqlite::Connection::open(dir.path().join("db")).unwrap();
        sql.execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM reviews; DELETE FROM events WHERE kind='review_created'; UPDATE sessions SET generation='apparently-generic';").unwrap();
        if keep_projection {
            sql.execute("DELETE FROM events WHERE kind='review_source_archived'", [])
                .unwrap();
        } else {
            sql.execute("DELETE FROM source_archives", []).unwrap();
        }
        assert!(store.review_by_session(&a.session_id).is_err());
        assert!(
            store
                .admit_command(
                    &a.session_id,
                    "bypass",
                    &json!({"kind":"responses_inference"})
                )
                .is_err()
        );
        assert!(
            store
                .admit_owned_batch(
                    &a.session_id,
                    "owner",
                    &[("bypass".into(), json!({"kind":"offline_snapshot_agent"}))]
                )
                .is_err()
        );
        assert!(store.review_source_archive(&a.review_id).is_err());
    }
}

#[test]
fn archive_command_prevents_reuse_when_original_binding_and_creation_are_lost() {
    for mutation in 0..4 {
        let (dir, mut store, a, archive) = fixture();
        store
            .begin_review_source_preparation(&a.root_operation_id, "owner")
            .unwrap();
        store
            .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
            .unwrap();
        let sql = rusqlite::Connection::open(dir.path().join("db")).unwrap();
        if mutation < 2 {
            sql.execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM reviews; DELETE FROM events WHERE kind='review_created';").unwrap();
            if mutation == 0 {
                sql.execute("DELETE FROM source_archives", []).unwrap();
            } else {
                sql.execute("DELETE FROM events WHERE kind='review_source_archived'", [])
                    .unwrap();
            }
        } else if mutation == 2 {
            sql.execute("UPDATE source_archives SET command_id='changed'", [])
                .unwrap();
        } else {
            sql.execute("UPDATE events SET payload=json_set(payload,'$.command_id','changed') WHERE kind='review_source_archived'",[]).unwrap();
        }
        let before: u64 = sql
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert!(
            store.review_by_command("run").is_err(),
            "mutation{mutation}"
        );
        assert!(
            store
                .admit_review("run", "owner", &prepared(&archive))
                .is_err()
        );
        assert_eq!(
            sql.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            before
        );
    }
}

#[test]
fn archived_selected_bytes_remain_bound_to_the_original_workspace_scope() {
    use zero_protocol::workspace::{WorkspaceSelectionPolicy, WorkspaceSelectionReceipt};
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let archive = source(b"only selected application bytes".to_vec());
    let mut a = prepared(&archive);
    let policy = WorkspaceSelectionPolicy::ExcludeNativeState {
        state_relative_path: ".0sec/native/state.db".into(),
    };
    a.workspace_selection = Some(WorkspaceSelectionReceipt {
        schema_version: 1,
        original_root: "/original/workspace".into(),
        exclusions: policy.exclusions().unwrap(),
        policy,
        snapshot_sha256: a.snapshot.digest.clone(),
        file_count: a.snapshot.files.len() as u32,
        bytes: a.snapshot.files.iter().map(|f| f.bytes).sum(),
    });
    a.root_payload["request"] = serde_json::to_value(
        a.profile
            .request_with_selection(
                a.snapshot.clone(),
                &a.root_operation_id,
                a.workspace_selection.as_ref(),
            )
            .unwrap(),
    )
    .unwrap();
    store.admit_review("selected", "owner", &a).unwrap();
    store
        .begin_review_source_preparation(&a.root_operation_id, "owner")
        .unwrap();
    store
        .retain_review_source_archive(&a.root_operation_id, "owner", &archive)
        .unwrap();
    assert_eq!(
        store.review_source_archive(&a.review_id).unwrap(),
        Some(archive)
    );
    let sql = rusqlite::Connection::open(dir.path().join("db")).unwrap();
    sql.execute("UPDATE reviews SET record=json_set(record,'$.workspace_selection.original_root','/forged')",[]).unwrap();
    sql.execute("UPDATE events SET payload=json_set(payload,'$.workspace_selection.original_root','/forged') WHERE kind='review_created'",[]).unwrap();
    assert!(store.review_source_archive(&a.review_id).is_err());
}
