use super::*;
use crate::{NativeReproductionAdmission, ReviewAdmission};
use std::collections::BTreeMap;
use zero_protocol::{review::*, review_reproduction::ReviewReproductionPlan, source_archive::*};
fn fixture_hash(v: &Value) -> String {
    hash(v).unwrap()
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
    let digest = fixture_hash(&json!([{"path":file.path,"digest":file.sha256,"bytes":file.bytes}]));
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
        "cases":[{"id":"attack","mode":"attack","argv":["echo","attack"],"stdin":null,"safe_expected":{"exit_code":0,"stdout":"safe","stderr":""},"expected":{"exit_code":0,"stdout":"","stderr":""}},
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

pub(super) fn admitted_source() -> (tempfile::TempDir, Store, NativeRepairAdmission) {
    let (dir, mut store, reproduction, _) = fixture();
    // Store admission verifies structural provenance and an Engine-issued digest;
    // independent semantic matrix assessment is exercised by Engine fixtures.
    let plan = &reproduction.authorization.plan;
    let result = json!({"assessment":{
        "schema_version":1,"oracle_version":zero_verification::ORACLE_VERSION,
        "plan_digest":FrozenPlan::new(plan.clone()).unwrap().digest(),
        "hypothesis_id":plan.hypothesis_id,"source_bundle_digest":plan.source_bundle_digest,
        "snapshot_digest":plan.snapshot.digest,"evidence_digest":format!("sha256:{}","e".repeat(64)),
        "disposition":"observed_for_plan","reasons":["complete_exact_observation"],
        "observed_attempts":4,"required_attempts":4,"vulnerability_reportable":false,
        "assessment_digest":format!("sha256:{}","f".repeat(64))},
        "artifacts":{},"children":[],"external_effects_started":false,"stop_reason":null,"error":null});
    store
        .settle_native_reproduction(
            &reproduction.id,
            "owner",
            OperationStatus::Succeeded,
            &serde_json::from_value(result).unwrap(),
            false,
        )
        .unwrap();
    let admission = NativeRepairAdmission {
        id:uuid::Uuid::new_v4().to_string(),session_id:uuid::Uuid::new_v4().to_string(),operation_id:uuid::Uuid::new_v4().to_string(),
        authorization:serde_json::from_value(json!({"schema_version":1,"reproduction_id":reproduction.id,
        "deadline_ms":60000,"max_executions":8,"materialize":{"baseline":plan.snapshot,"target":"app.rs","allowed_paths":["app.rs"],"protected_paths":[],"expected_preimage_sha256":plan.snapshot.files[0].digest,"replacement":"safe source"}})).unwrap(),
        reproduction_operation_id:reproduction.operation_id,
        reproduction_evidence_sha256:store.native_reproduction_evidence_digest(&reproduction.id).unwrap(),
    };
    (dir, store, admission)
}

#[test]
fn admission_is_atomic_retry_is_readonly_and_authority_is_closed() {
    let (_dir, mut store, a) = admitted_source();
    let first = store.admit_native_repair("repair", "owner", &a).unwrap();
    assert!(!first.duplicate);
    assert_eq!(first.operation.status, OperationStatus::Running);
    assert_eq!(store.get_session(&a.session_id).unwrap().budget_limit, 0);
    assert!(
        store
            .admit_command(&a.session_id, "infer", &json!({"kind":"inference"}))
            .is_err()
    );
    assert!(store.reserve_budget(&a.session_id, "free", 0).is_err());
    assert!(
        store
            .reconcile_budget(&a.session_id, "free", 0, "evidence")
            .is_err()
    );
    let before: u64 = store
        .conn
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap();
    assert!(
        store
            .stop_native_repair(&a.id, "owner", ReviewCloseReason::Cancelled)
            .unwrap()
    );
    let after_stop: u64 = store
        .conn
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(after_stop, before + 1);
    let mut retry = a.clone();
    retry.id = uuid::Uuid::new_v4().to_string();
    assert!(
        store
            .admit_native_repair("repair", "stale-owner", &retry)
            .unwrap()
            .duplicate
    );
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM events", [], |r| r.get::<_, u64>(0))
            .unwrap(),
        after_stop
    );
    assert!(store.native_repair_closed(&a.id).unwrap());
    retry.authorization.materialize.replacement.push('!');
    assert!(
        store
            .admit_native_repair("repair", "owner", &retry)
            .is_err()
    );
    assert_eq!(
        store.native_repair_by_command("repair").unwrap().unwrap(),
        first.record
    );
    assert_eq!(
        store
            .native_repair_by_session(&a.session_id)
            .unwrap()
            .unwrap(),
        first.record
    );
}

#[test]
fn wrong_owner_changed_evidence_and_quota_fail_without_creating_anything() {
    let (_dir, mut store, a) = admitted_source();
    for variant in 0..4 {
        let mut bad = a.clone();
        if variant == 1 {
            bad.reproduction_evidence_sha256 = format!("sha256:{}", "0".repeat(64));
        }
        if variant == 2 {
            bad.reproduction_operation_id = uuid::Uuid::new_v4().to_string();
        }
        if variant == 3 {
            bad.authorization.max_executions = 7;
        }
        assert!(
            store
                .admit_native_repair("bad", if variant == 0 { "wrong" } else { "owner" }, &bad)
                .is_err()
        );
        assert!(store.native_repair_by_command("bad").unwrap().is_none());
        assert!(store.get_session(&a.session_id).is_err());
    }
    // A valid original-session journal change invalidates the earlier assessment CAS.
    store.conn.execute("INSERT INTO events(session_id,sequence,kind,payload) SELECT session_id,max(sequence)+1,'fixture_note','{}' FROM events WHERE session_id=(SELECT session_id FROM native_reproductions WHERE id=?1)",[&a.authorization.reproduction_id]).unwrap();
    assert!(store.admit_native_repair("stale", "owner", &a).is_err());
    assert!(store.native_repair_by_command("stale").unwrap().is_none());
}

#[test]
fn deleted_projection_and_orphan_admission_do_not_free_command_or_session() {
    let (_dir, mut store, a) = admitted_source();
    store.admit_native_repair("repair", "owner", &a).unwrap();
    store
        .conn
        .execute("DELETE FROM native_repairs WHERE id=?1", [&a.id])
        .unwrap();
    assert!(store.native_repair_by_command("repair").is_err());
    assert!(store.native_repair_by_session(&a.session_id).is_err());
    assert!(store.admit_native_repair("repair", "owner", &a).is_err());
    assert!(
        store
            .admit_command(&a.session_id, "escape", &json!({"kind":"source_tool"}))
            .is_err()
    );
    store
        .conn
        .execute(
            "DELETE FROM events WHERE session_id=?1 AND kind='native_repair_created'",
            [&a.session_id],
        )
        .unwrap();
    assert!(store.native_repair_by_command("repair").is_err());
    store
        .conn
        .execute(
            "UPDATE sessions SET generation='other' WHERE id=?1",
            [&a.session_id],
        )
        .unwrap();
    assert!(
        store
            .admit_command(&a.session_id, "escape2", &json!({"kind":"inference"}))
            .is_err()
    );
}

#[test]
fn unknown_owner_recovery_is_retained_and_cannot_restart() {
    let (dir, mut store, a) = admitted_source();
    store.admit_native_repair("repair", "owner", &a).unwrap();
    store.claim_engine_epoch("replacement").unwrap();
    store.recover_owner("owner").unwrap();
    let recovered = store.native_repair(&a.id).unwrap();
    assert_eq!(recovered.operation.status, OperationStatus::Unknown);
    assert!(
        !store
            .stop_native_repair(&a.id, "replacement", ReviewCloseReason::Cancelled)
            .unwrap()
    );
    assert!(
        store
            .admit_native_repair("repair", "replacement", &a)
            .unwrap()
            .duplicate
    );
    drop(store);
    let readonly = Store::open_read_only(dir.path().join("db")).unwrap();
    assert_eq!(
        readonly.native_repair(&a.id).unwrap().operation.status,
        OperationStatus::Unknown
    );
}
