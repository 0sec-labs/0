use serde_json::json;
use zero_protocol::campaign::{CampaignLimits, CampaignPlan};
use zero_store::{CampaignSnapshotData, Store};
fn fixture() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("state.db")).unwrap();
    store.claim_engine_epoch("snapshot-owner").unwrap();
    let config = json!({"host":"private controller fixture"});
    let plan = CampaignPlan {
        schema_version: 1,
        controller_plan_sha256: zero_web_verification::hash(&config).unwrap(),
        baseline_sha256: format!("sha256:{}", "a".repeat(64)),
        limits: CampaignLimits {
            model_micro_usd: 100,
            model_calls: 8,
            http_requests: 8,
            http_request_body_bytes: 1024,
            http_response_decoded_bytes: 8192,
            experiments: 2,
            runs: 8,
            max_parallel_runs: 1,
        },
        expires_at_ms: 9_000_000_000_000,
    };
    let campaign = store
        .create_campaign_with_artifact("create", &plan, &serde_json::to_vec(&config).unwrap())
        .unwrap()
        .0;
    (dir, store, campaign.id)
}
#[test]
fn package_roundtrip_is_private_readonly_and_survives_source_deletion() {
    let (dir, mut source, id) = fixture();
    let foreign = source
        .create_session("unrelated private session", 10)
        .unwrap();
    let data = source.freeze_campaign(&id).unwrap();
    source.claim_engine_epoch("different-live-owner").unwrap();
    assert_eq!(source.freeze_campaign(&id).unwrap().digest(), data.digest());
    assert!(!String::from_utf8_lossy(data.manifest_bytes()).contains(&foreign.id));
    let restored = CampaignSnapshotData::from_package(data.manifest_bytes(), |key| {
        Ok(data.blobs()[key].clone())
    })
    .unwrap();
    assert_eq!(data.digest(), restored.digest());
    drop(source);
    std::fs::remove_file(dir.path().join("state.db")).unwrap();
    let mut frozen = Store::hydrate_campaign_snapshot(&restored).unwrap();
    assert_eq!(frozen.campaign(&id).unwrap().usage.runs, 0);
    assert!(frozen.create_session("mutation forbidden", 1).is_err());
    assert_eq!(frozen.freeze_campaign(&id).unwrap().digest(), data.digest());
}
#[test]
fn changed_chunk_and_unknown_table_or_expansion_fail_closed() {
    let (_dir, store, id) = fixture();
    let data = store.freeze_campaign(&id).unwrap();
    assert!(
        CampaignSnapshotData::from_package(data.manifest_bytes(), |key| {
            let mut bytes = data.blobs()[key].clone();
            bytes.push(0);
            Ok(bytes)
        })
        .is_err()
    );
    let mut manifest: serde_json::Value = serde_json::from_slice(data.manifest_bytes()).unwrap();
    manifest["tables"][0]["name"] = json!("sqlite_schema");
    assert!(
        CampaignSnapshotData::from_package(&serde_json::to_vec(&manifest).unwrap(), |key| Ok(data
            .blobs()[key]
            .clone()))
        .is_err()
    );
    let mut manifest: serde_json::Value = serde_json::from_slice(data.manifest_bytes()).unwrap();
    manifest["tables"][1]["rows"][0]["bytes"] = json!(u64::MAX);
    assert!(
        CampaignSnapshotData::from_package(&serde_json::to_vec(&manifest).unwrap(), |key| Ok(data
            .blobs()[key]
            .clone()))
        .is_err()
    );
}
#[test]
fn source_never_silently_omits_orphan_run_binding_or_oversized_record() {
    let (dir, store, id) = fixture();
    let sql = rusqlite::Connection::open(dir.path().join("state.db")).unwrap();
    let journal = store.campaign(&id).unwrap().campaign.journal_session_id;
    sql.execute("INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,999,'campaign_run_admitted',?2)",rusqlite::params![journal,json!({"session_id":"missing-run"}).to_string()]).unwrap();
    assert!(
        store
            .freeze_campaign(&id)
            .unwrap_err()
            .to_string()
            .contains("membership")
    );
    sql.execute("DELETE FROM events WHERE sequence=999", [])
        .unwrap();
    sql.execute(
        "INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,999,'host-note',?2)",
        rusqlite::params![journal, "!".repeat(33 * 1024 * 1024)],
    )
    .unwrap();
    assert!(
        store
            .freeze_campaign(&id)
            .unwrap_err()
            .to_string()
            .contains("bound")
    );
}

#[test]
fn schema_thirteen_migration_preserves_existing_campaign_snapshot() {
    let (dir, store, id) = fixture();
    let before = store.freeze_campaign(&id).unwrap().digest().to_owned();
    drop(store);
    let path = dir.path().join("state.db");
    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch("DROP TABLE strategy_search_evaluations; DROP TABLE strategy_search_proposals; DROP TABLE strategy_searches; DROP TABLE strategy_sessions; PRAGMA user_version=13;")
        .unwrap();
    drop(sql);
    assert!(matches!(
        Store::open_read_only(&path),
        Err(zero_store::Error::Schema(13))
    ));
    let upgraded = Store::open(&path).unwrap();
    assert_eq!(upgraded.freeze_campaign(&id).unwrap().digest(), before);
    drop(upgraded);
    assert_eq!(
        Store::open_read_only(&path)
            .unwrap()
            .campaign(&id)
            .unwrap()
            .usage
            .runs,
        0
    );
}

#[test]
fn source_escaped_rows_share_an_expanded_encoding_budget() {
    let (dir, store, id) = fixture();
    let sql = rusqlite::Connection::open(dir.path().join("state.db")).unwrap();
    let journal = store.campaign(&id).unwrap().campaign.journal_session_id;
    // Raw rows fit both source limits. Escaping would expand them past 64 MiB.
    let payload = "\0".repeat(4 * 1024 * 1024);
    for sequence in 900..903 {
        sql.execute(
            "INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,?2,'host-note',?3)",
            rusqlite::params![journal, sequence, payload],
        )
        .unwrap();
    }
    let error = store.freeze_campaign(&id).unwrap_err().to_string();
    assert!(
        error.contains("encoding exceeds expanded byte bound"),
        "{error}"
    );
}

#[test]
fn unknown_operation_without_admission_and_changed_controller_admission_reject() {
    let (dir, mut store, id) = fixture();
    let c = store.campaign(&id).unwrap().campaign;
    let payload = json!({"kind":"strategy_evaluation","campaign_id":id,"controller_plan_sha256":c.plan.controller_plan_sha256,"lane":"development"});
    let command = format!("strategy-evaluation:{id}:development");
    let controller = store
        .admit_command(&c.journal_session_id, &command, &payload)
        .unwrap()
        .operation;
    store.freeze_campaign(&id).unwrap();
    store
        .validate_session_admission_closure(&c.journal_session_id)
        .unwrap();
    let sql = rusqlite::Connection::open(dir.path().join("state.db")).unwrap();
    sql.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status,owner,outcome) VALUES('orphan',?1,'orphan',?2,'unused','unknown','lost-owner',NULL)",rusqlite::params![c.journal_session_id,json!({"kind":"agent_inference","parent_operation":controller.id}).to_string()]).unwrap();
    assert!(
        store
            .freeze_campaign(&id)
            .unwrap_err()
            .to_string()
            .contains("admission witnesses")
    );
    assert!(
        store
            .validate_session_admission_closure(&c.journal_session_id)
            .is_err()
    );
    sql.execute("DELETE FROM operations WHERE id='orphan'", [])
        .unwrap();
    sql.execute("UPDATE events SET payload=json_set(payload,'$.command_id','altered') WHERE session_id=?1 AND kind='command_admitted'",[&c.journal_session_id]).unwrap();
    assert!(
        store
            .validate_session_admission_closure(&c.journal_session_id)
            .is_err()
    );
    assert!(
        store
            .freeze_campaign(&id)
            .unwrap_err()
            .to_string()
            .contains("admission witnesses")
    );
}

#[test]
fn schema_fourteen_migration_preserves_retained_portable_evidence() {
    let (dir, store, id) = fixture();
    let evidence = store.freeze_campaign(&id).unwrap();
    drop(store);
    let path = dir.path().join("state.db");
    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch("DROP TABLE strategy_search_evaluations; DROP TABLE strategy_search_proposals; DROP TABLE strategy_searches; PRAGMA user_version=14;").unwrap();
    drop(sql);
    assert!(matches!(
        Store::open_read_only(&path),
        Err(zero_store::Error::Schema(14))
    ));
    let upgraded = Store::open(&path).unwrap();
    assert_eq!(
        upgraded.freeze_campaign(&id).unwrap().digest(),
        evidence.digest()
    );
    let retained = Store::hydrate_campaign_snapshot(&evidence).unwrap();
    assert_eq!(
        retained.freeze_campaign(&id).unwrap().manifest_bytes(),
        evidence.manifest_bytes()
    );
    drop(upgraded);
    assert!(Store::open_read_only(&path).is_ok());
}

#[test]
fn legacy_portable_evidence_never_omits_search_account_state() {
    let (dir, store, id) = fixture();
    let campaign = store.campaign(&id).unwrap().campaign;
    let sql = rusqlite::Connection::open(dir.path().join("state.db")).unwrap();
    sql.execute(
        "INSERT INTO strategy_searches(campaign_id,config_sha256,sequence) VALUES(?1,?2,2)",
        rusqlite::params![id, campaign.plan.controller_plan_sha256],
    )
    .unwrap();
    assert!(
        store
            .freeze_campaign(&id)
            .unwrap_err()
            .to_string()
            .contains("search evidence")
    );
    sql.execute("DELETE FROM strategy_searches WHERE campaign_id=?1", [&id])
        .unwrap();
    sql.execute("INSERT INTO events(session_id,sequence,kind,payload) VALUES(?1,999,'strategy_search_created','{}')", [&campaign.journal_session_id]).unwrap();
    assert!(
        store
            .freeze_campaign(&id)
            .unwrap_err()
            .to_string()
            .contains("search evidence")
    );
}

#[test]
fn additive_search_schema_preserves_opaque_nonsearch_campaign_artifacts() {
    use sha2::{Digest, Sha256};
    let (_dir, mut store, id) = fixture();
    let mut plan = store.campaign(&id).unwrap().campaign.plan;
    let bytes = b"opaque host controller artifact\0\xff";
    plan.controller_plan_sha256 = format!("sha256:{:x}", Sha256::digest(bytes));
    let campaign = store
        .create_campaign_with_artifact("opaque", &plan, bytes)
        .unwrap()
        .0;
    let evidence = store.freeze_campaign(&campaign.id).unwrap();
    let hydrated = Store::hydrate_campaign_snapshot(&evidence).unwrap();
    assert_eq!(
        hydrated.freeze_campaign(&campaign.id).unwrap().digest(),
        evidence.digest()
    );
}
