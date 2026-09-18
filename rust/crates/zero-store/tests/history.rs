#![allow(clippy::unwrap_used)]
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use zero_protocol::{
    agent::AgentStatus,
    history::{MAX_DISPLAY_TEXT_BYTES, MAX_HISTORY_PAGE_BYTES, SessionCursor},
};
use zero_store::{OperationStatus, Store};

fn payload(prompt: &str) -> Value {
    json!({"kind":"offline_snapshot_agent","request":{"provider":"private-provider","model":"private-model","instructions":"HOST-INSTRUCTIONS-SECRET","prompt":prompt,"execution":{"execution_id":"e","image":"local","argv":["true"],"snapshot":{"id":"s","root":"/private-source-root","digest":format!("sha256:{}","a".repeat(64)),"files":[{"path":"a","bytes":0,"digest":format!("sha256:{}","b".repeat(64))}]},"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024},"max_turns":2,"reservation_per_turn":10},"endpoint":"PRIVATE-ENDPOINT"})
}
fn admit(store: &mut Store, session: &str, command: &str, prompt: &str) -> String {
    store
        .admit_command(session, command, &payload(prompt))
        .unwrap()
        .operation
        .id
}
fn finish(store: &mut Store, id: &str, text: &str, error: Option<&str>) {
    store.begin_operation(id, "owner").unwrap();
    store
        .settle_operation(
            id,
            "owner",
            OperationStatus::Succeeded,
            &json!({"status":"completed","text":text,"turns":1,"tool_calls":2,"error":error}),
        )
        .unwrap();
}
#[test]
fn tied_session_timestamps_restart_cursors_and_readonly_do_not_recover() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let mut ids = Vec::new();
    for _ in 0..5 {
        ids.push(store.create_session("g", 100).unwrap().id);
    }
    Connection::open(&path)
        .unwrap()
        .execute("UPDATE sessions SET created_at_ms=123", [])
        .unwrap();
    ids.sort();
    let op = admit(&mut store, &ids[0], "active", "still running");
    store.begin_operation(&op, "owner").unwrap();
    let page = store.session_list_page(None, 2).unwrap();
    assert_eq!(
        page.sessions
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>(),
        ids[..2]
    );
    let cursor = page.next_cursor.unwrap();
    let readonly = Store::open_read_only(&path).unwrap();
    let before = std::fs::read(&path).unwrap();
    let page = readonly.session_list_page(Some(&cursor), 2).unwrap();
    assert_eq!(
        page.sessions
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>(),
        ids[2..4]
    );
    let last = readonly
        .session_list_page(page.next_cursor.as_ref(), 2)
        .unwrap();
    assert_eq!(last.sessions[0].id, ids[4]);
    assert!(last.next_cursor.is_none());
    assert_eq!(
        readonly.session_history(&ids[0], None, 1).unwrap().entries[0].status,
        OperationStatus::Running
    );
    assert_eq!(
        store.get_operation(&op).unwrap().status,
        OperationStatus::Running
    );
    assert_eq!(before, std::fs::read(&path).unwrap());
    assert!(
        readonly
            .session_list_page(
                Some(&SessionCursor {
                    created_at_ms: 124,
                    id: ids[0].clone()
                }),
                2
            )
            .is_err()
    );
    assert!(readonly.session_list_page(None, 0).is_err());
    assert!(readonly.session_list_page(None, 101).is_err());
    drop(readonly);
    drop(store);
    let reopened = Store::open_read_only(&path).unwrap();
    assert_eq!(
        reopened
            .session_list_page(Some(&cursor), 2)
            .unwrap()
            .sessions[0]
            .id,
        ids[2]
    );
}
#[test]
fn history_newest_first_is_anchored_scoped_and_hides_authority() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let a = store.create_session("g", 100).unwrap().id;
    let b = store.create_session("g", 100).unwrap().id;
    let first = admit(&mut store, &a, "first", "hello");
    finish(&mut store, &first, "reply", None);
    let other = admit(&mut store, &b, "foreign", "FOREIGN-PROMPT");
    finish(&mut store, &other, "FOREIGN-REPLY", None);
    store.admit_command(&a,"model-child",&json!({"kind":"agent_inference","parent_operation":first,"request":{"input":"RAW-REPLAY"}})).unwrap();
    let mut child = payload("CHILD-PROMPT");
    child["parent_operation"] = json!(first);
    store.admit_command(&a, "agent-child", &child).unwrap();
    let second = admit(&mut store, &a, "second", "next");
    let page = store.session_history(&a, None, 1).unwrap();
    assert_eq!(page.entries[0].operation_id, second);
    assert_eq!(page.entries[0].status, OperationStatus::Admitted);
    assert_eq!(page.entries[0].agent_status, None);
    assert_eq!(page.entries[0].reply_text, None);
    let next = page.next_before_sequence.unwrap();
    drop(store);
    let reopened = Store::open_read_only(&path).unwrap();
    let page = reopened.session_history(&a, Some(next), 10).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert!(page.next_before_sequence.is_none());
    let entry = &page.entries[0];
    assert_eq!(entry.operation_id, first);
    assert_eq!(entry.agent_status, Some(AgentStatus::Completed));
    assert_eq!(entry.reply_text.as_ref().unwrap().text, "reply");
    assert_eq!(entry.tool_calls, Some(2));
    let wire = serde_json::to_string(&page).unwrap();
    for secret in [
        "HOST-INSTRUCTIONS-SECRET",
        "PRIVATE-ENDPOINT",
        "private-provider",
        "private-model",
        "private-source-root",
        "FOREIGN",
        "RAW-REPLAY",
        "CHILD-PROMPT",
    ] {
        assert!(!wire.contains(secret), "leaked {secret}");
    }
    assert!(reopened.session_history("missing", None, 10).is_err());
}
#[test]
fn recovered_and_uncertain_operations_are_truthful_not_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    store.claim_engine_epoch("owner").unwrap();
    let session = store.create_session("g", 10).unwrap().id;
    let never = admit(&mut store, &session, "never", "not started");
    let lost = admit(&mut store, &session, "lost", "lost owner");
    store.begin_operation(&lost, "owner").unwrap();
    store.claim_engine_epoch("new-owner").unwrap();
    let page = store.session_history(&session, None, 10).unwrap();
    assert_eq!(page.entries[0].operation_id, lost);
    assert_eq!(page.entries[0].status, OperationStatus::Unknown);
    assert!(page.entries[0].agent_status.is_none());
    assert_eq!(page.entries[1].operation_id, never);
    assert_eq!(page.entries[1].status, OperationStatus::Failed);
    assert_eq!(page.entries[1].error.as_ref().unwrap().text, "not_started");
    let explicit = admit(&mut store, &session, "explicit", "uncertain");
    store.begin_operation(&explicit, "new-owner").unwrap();
    store
        .mark_operation_unknown(&explicit, "new-owner", "worker panicked")
        .unwrap();
    let page = store.session_history(&session, None, 1).unwrap();
    assert_eq!(
        page.entries[0].error.as_ref().unwrap().text,
        "worker panicked"
    );
    assert_eq!(
        store.get_operation(&lost).unwrap().status,
        OperationStatus::Unknown
    );
}
#[test]
fn escaped_unicode_truncates_safely_and_wire_byte_pages_do_not_skip() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let session = store.create_session("g", 100).unwrap().id;
    let prompt = format!("{}€suffix", "x".repeat(MAX_DISPLAY_TEXT_BYTES - 1));
    let id = admit(&mut store, &session, "unicode", &prompt);
    finish(&mut store, &id, &prompt, Some(&prompt));
    let entry = store
        .session_history(&session, None, 1)
        .unwrap()
        .entries
        .remove(0);
    assert_eq!(entry.prompt.text.len(), MAX_DISPLAY_TEXT_BYTES - 1);
    assert!(entry.prompt.truncated);
    assert!(entry.reply_text.unwrap().truncated);
    assert!(entry.error.unwrap().truncated);
    for i in 0..12 {
        let id = admit(
            &mut store,
            &session,
            &format!("escape{i}"),
            &"\0".repeat(MAX_DISPLAY_TEXT_BYTES),
        );
        finish(
            &mut store,
            &id,
            &"\0".repeat(MAX_DISPLAY_TEXT_BYTES),
            Some(&"\0".repeat(MAX_DISPLAY_TEXT_BYTES)),
        );
    }
    let mut cursor = None;
    let mut seen = std::collections::BTreeSet::new();
    let mut pages = 0;
    loop {
        let page = store.session_history(&session, cursor, 100).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_HISTORY_PAGE_BYTES);
        assert!(!page.entries.is_empty());
        for entry in &page.entries {
            assert!(seen.insert(entry.operation_id.clone()));
        }
        pages += 1;
        cursor = page.next_before_sequence;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), 13);
    assert!(pages > 1);
    assert_eq!(
        store.get_operation(&id).unwrap().payload["request"]["prompt"],
        prompt
    );
}
#[test]
fn corruption_and_oversized_sql_rows_fail_explicitly_without_cursor_advance() {
    for mutation in [
        "UPDATE operations SET payload_hash='wrong'",
        "UPDATE operations SET command_id='changed'",
        "UPDATE operations SET outcome='{\"status\":\"completed\"}'",
        "UPDATE operations SET outcome='{\"status\":\"cancelled\",\"text\":\"x\",\"turns\":1,\"tool_calls\":0,\"error\":null}'",
        "UPDATE events SET payload='invalid JSON' WHERE kind='command_admitted'",
        "UPDATE events SET payload=json_set(payload,'$.session_id','foreign') WHERE kind='command_admitted'",
        "UPDATE operations SET payload=json_set(payload,'$.request.prompt','forged')",
        "UPDATE events SET payload=CAST(zeroblob(33554433) AS TEXT) WHERE kind='command_admitted'",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = Store::open(&path).unwrap();
        let session = store.create_session("g", 100).unwrap().id;
        let id = admit(&mut store, &session, "turn", "hello");
        finish(&mut store, &id, "good", None);
        Connection::open(&path)
            .unwrap()
            .execute_batch(mutation)
            .unwrap();
        assert!(
            store.session_history(&session, None, 10).is_err(),
            "accepted {mutation}"
        );
    }
}
#[test]
fn cumulative_read_budget_pages_large_private_payloads_without_exposing_them() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let session = store.create_session("g", 100).unwrap().id;
    for i in 0..6 {
        let mut value = payload("small prompt");
        value["request"]["instructions"] = json!("x".repeat(6 * 1024 * 1024));
        store
            .admit_command(&session, &format!("c{i}"), &value)
            .unwrap();
    }
    let first = store.session_history(&session, None, 100).unwrap();
    assert!(!first.entries.is_empty());
    assert!(first.entries.len() < 6);
    assert!(serde_json::to_vec(&first).unwrap().len() < 10000);
    let next = store
        .session_history(&session, first.next_before_sequence, 100)
        .unwrap();
    assert_eq!(first.entries.len() + next.entries.len(), 6);
    assert!(next.next_before_sequence.is_none());
}
#[test]
fn sessions_also_bound_escaped_wire_bytes_and_reject_oversized_values() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    for _ in 0..4 {
        store.create_session(&"\u{0001}".repeat(60000), 0).unwrap();
    }
    let first = store.session_list_page(None, 100).unwrap();
    assert_eq!(first.sessions.len(), 1);
    assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_HISTORY_PAGE_BYTES);
    Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE sessions SET generation=?1",
            params!["x".repeat(MAX_HISTORY_PAGE_BYTES + 1)],
        )
        .unwrap();
    assert!(store.session_list_page(None, 100).is_err());
}

#[test]
fn continuation_hint_excludes_structured_source_recovery_and_missing_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let session = store.create_session("g", 100).unwrap().id;
    for (command, agent_status, extra, checkpoint, expected) in [
        ("normal", "completed", json!({}), false, true),
        (
            "source",
            "completed",
            json!({"source_review":{"review":null,"artifacts":{},"inference_operation":null,"external_effects_started":true,"error":null}}),
            false,
            false,
        ),
        (
            "cleanup",
            "completed",
            json!({"source_recovery_path":"private-root"}),
            false,
            false,
        ),
        (
            "no-checkpoint",
            "turn_limit",
            json!({"continuation_artifact":format!("sha256:{}","a".repeat(64))}),
            false,
            false,
        ),
        ("checkpoint", "turn_limit", json!({}), true, true),
    ] {
        let id = admit(&mut store, &session, command, "prompt");
        store.begin_operation(&id, "owner").unwrap();
        let mut result =
            json!({"status":agent_status,"text":"reply","turns":1,"tool_calls":0,"error":null});
        result
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        if checkpoint {
            result["continuation_artifact"] = json!(
                store
                    .retain_operation_artifact(
                        &id,
                        "owner",
                        "agent.continuation",
                        b"retained marker; engine must validate contents"
                    )
                    .unwrap()
            );
        }
        let status = if agent_status == "completed" {
            OperationStatus::Succeeded
        } else {
            OperationStatus::Failed
        };
        store
            .settle_operation(&id, "owner", status, &result)
            .unwrap();
        let page = store.session_history(&session, None, 1).unwrap();
        assert_eq!(page.entries[0].continuable, expected, "{command}");
    }
}

#[test]
fn completed_web_submission_is_visible_but_not_continuable() {
    let mut store = Store::open(":memory:").unwrap();
    let session = store.create_session("g", 100).unwrap().id;
    let request = json!({"provider":"p","model":"m","instructions":"i","prompt":"web prompt","http_profile":"scope","web_submission_max_hypotheses":2,"max_turns":2,"reservation_per_turn":10});
    let op = store
        .admit_command(
            &session,
            "web",
            &json!({"kind":"scoped_web_agent","request":request}),
        )
        .unwrap()
        .operation;
    store.begin_operation(&op.id, "owner").unwrap();
    let digest = format!("sha256:{}", "a".repeat(64));
    let review = json!({"schema_version":1,"request_sha256":digest,"completion_sha256":digest,"submission_call_id":"submit","model":"m","provider_response_id":null,"hypotheses":[],"evidence":[]});
    store.settle_operation(&op.id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","text":"empty submission","turns":1,"tool_calls":1,"error":null,"web_review":{"review":review,"artifacts":{},"inference_operation":"inference"}})).unwrap();
    let page = store.session_history(&session, None, 32).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert!(!page.entries[0].continuable);
    assert_eq!(page.entries[0].operation_id, op.id);
}
