#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_protocol::{review::*, session::OperationStatus};
use zero_store::{ReviewAdmission, Store};
fn hash(v: &Value) -> String {
    zero_web_verification::hash(v).unwrap()
}
fn prepared() -> ReviewAdmission {
    let profile:ReviewProfile=serde_json::from_value(json!({"schema_version":1,"provider":"p","model":"m","instructions":"Host review","question":"Inspect input handling","execution":{"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"budget_limit":10,"currency":"units","reservation_per_turn":6,"max_turns":3,"max_hypotheses":2,"deadline_ms":60000})).unwrap();
    let files = json!([{"path":"app.rs","digest":format!("sha256:{}","b".repeat(64)),"bytes":10}]);
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

#[test]
fn history_paginates_exact_admissions_and_preserves_unknown_without_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let mut ids = Vec::new();
    for index in 0..35 {
        let admission = prepared();
        ids.push(admission.review_id.clone());
        store
            .admit_review(&format!("r{index}"), "owner", &admission)
            .unwrap();
    }
    let page = store.review_page(None, 32).unwrap();
    assert_eq!(page.reviews.len(), 32);
    assert_eq!(page.reviews[0].review.id, ids[34]);
    assert!(
        page.reviews
            .iter()
            .all(|row| row.root_status == OperationStatus::Running)
    );
    let next = store.review_page(page.next_before_sequence, 32).unwrap();
    assert_eq!(
        next.reviews
            .iter()
            .map(|row| row.review.id.as_str())
            .collect::<Vec<_>>(),
        vec![ids[2].as_str(), ids[1].as_str(), ids[0].as_str()]
    );
    assert!(next.next_before_sequence.is_none());
    assert!(store.review_page(Some(1), 1).unwrap().reviews.is_empty());
    for (cursor, limit) in [(None, 0), (None, 33), (Some(0), 1), (Some(u64::MAX), 1)] {
        assert!(store.review_page(cursor, limit).is_err());
    }
    store.claim_engine_epoch("recovered").unwrap();
    drop(store);
    let store = Store::open_read_only(&path).unwrap();
    let page = store.review_page(None, 2).unwrap();
    assert!(
        page.reviews
            .iter()
            .all(|row| row.root_status == OperationStatus::Unknown)
    );
    let value = serde_json::to_value(page).unwrap();
    assert!(value["reviews"][0].get("agent_result").is_none());
    assert!(
        value["reviews"][0]["review"]
            .get("workspace_selection")
            .is_none()
    );
}

#[test]
fn corrupt_or_missing_review_projections_are_not_silently_skipped() {
    for mutation in [
        "UPDATE reviews SET record=json_set(record,'$.input_path','forged')",
        "DELETE FROM reviews",
        "UPDATE reviews SET sequence=99",
        "UPDATE events SET payload=json_set(payload,'$.input_path','forged') WHERE kind='review_created'",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let mut store = Store::open(&path).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        store.admit_review("r", "owner", &prepared()).unwrap();
        drop(store);
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(mutation).unwrap();
        drop(db);
        let store = Store::open_read_only(&path).unwrap();
        assert!(store.review_page(None, 32).is_err(), "{mutation}");
    }
}

#[test]
fn missing_claim_artifacts_do_not_turn_history_into_a_report_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut store = Store::open(&path).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let admission = prepared();
    store.admit_review("r", "owner", &admission).unwrap();
    // A succeeded model container need not have submitted structured claims.
    // This large retained result must be checked for lifecycle but not exported.
    let result = json!({"status":"completed","text":"x".repeat(2*1024*1024),"turns":1,"tool_calls":0,"error":null});
    // Use the actual AgentResult defaults/required fields instead of forging a
    // journal row; typed serialization remains compatible with the lifecycle gate.
    let result: zero_protocol::agent::AgentResult = serde_json::from_value(result).unwrap();
    store
        .settle_operation(
            &admission.root_operation_id,
            "owner",
            OperationStatus::Succeeded,
            &serde_json::to_value(result).unwrap(),
        )
        .unwrap();
    store.settle_operation(&admission.controller_operation_id,"owner",OperationStatus::Succeeded,
        &json!({"schema_version":1,"review_id":admission.review_id,"root_operation_id":admission.root_operation_id,"root_status":"succeeded"})).unwrap();
    let page = store.review_page(None, 1).unwrap();
    assert_eq!(page.reviews[0].root_status, OperationStatus::Succeeded);
    assert!(serde_json::to_vec(&page).unwrap().len() < 8192);
}

#[test]
fn history_byte_cap_shortens_pages_without_skipping_selected_scope() {
    use zero_protocol::workspace::{WorkspaceSelectionPolicy, WorkspaceSelectionReceipt};
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("state.db")).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let mut expected = Vec::new();
    for index in 0..34 {
        let mut admission = prepared();
        admission.input_path = "\"".repeat(8000);
        admission.snapshot.root = format!("/{}", "s".repeat(8000));
        admission.canonical_path = admission.snapshot.root.clone();
        let policy = WorkspaceSelectionPolicy::ExcludeNativeState {
            state_relative_path: "n".repeat(1800),
        };
        let receipt = WorkspaceSelectionReceipt {
            schema_version: 1,
            original_root: format!("/{}", "r".repeat(3000)),
            exclusions: policy.exclusions().unwrap(),
            policy,
            snapshot_sha256: admission.snapshot.digest.clone(),
            file_count: 1,
            bytes: 10,
        };
        admission.root_payload["request"] = serde_json::to_value(
            admission
                .profile
                .request_with_selection(
                    admission.snapshot.clone(),
                    &admission.root_operation_id,
                    Some(&receipt),
                )
                .unwrap(),
        )
        .unwrap();
        admission.workspace_selection = Some(receipt);
        expected.push(admission.review_id.clone());
        store
            .admit_review(&format!("wide-{index}"), "owner", &admission)
            .unwrap();
    }
    expected.reverse();
    let mut cursor = None;
    let mut observed = Vec::new();
    loop {
        let page = store.review_page(cursor, 32).unwrap();
        if cursor.is_none() {
            assert!(page.reviews.len() < 32);
        }
        assert!(!page.reviews.is_empty());
        assert!(serde_json::to_vec(&page).unwrap().len() <= 1024 * 1024);
        observed.extend(page.reviews.into_iter().map(|entry| {
            assert_eq!(
                entry.review.workspace_selection.unwrap().exclusions.len(),
                5
            );
            entry.review.id
        }));
        match page.next_before_sequence {
            Some(next) => {
                assert!(cursor.is_none_or(|previous| next < previous));
                cursor = Some(next);
            }
            None => break,
        }
    }
    assert_eq!(observed, expected);
}
