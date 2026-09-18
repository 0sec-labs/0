use serde_json::{Value, json};
use zero_protocol::{
    Operation, OperationStatus,
    approvals::{
        ToolApprovalDecision as Decision, ToolApprovalRecord as Record,
        ToolApprovalStatus as Status,
    },
};
use zero_store::Store;
struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    session: String,
    actor: Operation,
    origin: Operation,
    effect: Value,
    alias: String,
}
impl Fixture {
    fn new(plugin: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("state.db")).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let session = store.create_session("g", 100).unwrap().id;
        let sha = format!("sha256:{}", "a".repeat(64));
        let alias = if plugin {
            "offline_check"
        } else {
            "execute_snapshot"
        }
        .to_string();
        let execution = json!({"execution_id":"profile","image":sha,"snapshot":{"id":"s","root":"/tmp/source","digest":sha,"files":[{"path":"entry","digest":sha,"bytes":0}]},"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":1024});
        let binding = json!({"alias":alias,"plugin":"checker","tool":"check"});
        let context = json!({"generation":"g","epoch":1,"selected":[{"binding":binding,"manifest":sha}],"launch":{"backend":{"type":"docker","image":sha},"interpreter":["node"],"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":1024}});
        let mut payload = json!({"kind":"offline_snapshot_agent","request":{"execution":execution,"tool_approval_policy":{"require_approval":[alias]},"plugin_tools":if plugin{vec![binding.clone()]}else{vec![]}}});
        if plugin {
            payload["plugin_context"] = context.clone();
        }
        let actor = store
            .admit_command(&session, "actor", &payload)
            .unwrap()
            .operation;
        let actor = store.begin_operation(&actor.id, "owner").unwrap();
        let args = if plugin {
            json!({"fixture":"bounded"})
        } else {
            json!({"argv":["node","entry"]})
        };
        let original=store.admit_command(&session,&format!("{}:model:0",actor.id),&json!({"kind":"agent_inference","parent_operation":actor.id,"request":{"tools":[{"name":alias,"description":"bounded offline effect","parameters":{"type":"object"}}]}})).unwrap().operation;
        store.begin_operation(&original.id, "owner").unwrap();
        let origin=store.settle_operation(&original.id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","response_id":"r","content":[{"type":"tool_call","id":"call","name":alias,"arguments":args}],"usage":null,"replay":[],"error":null})).unwrap();
        let effect = if plugin {
            json!({"kind":"agent_plugin","parent_operation":actor.id,"call_id":"call","plugin_context":context,"binding":binding,"input":args})
        } else {
            let execution: zero_protocol::agent::AgentExecution =
                serde_json::from_value(execution).unwrap();
            let mut execution = execution.sandbox_request();
            execution.execution_id = format!("agent-{}-0-0", actor.id);
            execution.argv = vec!["node".into(), "entry".into()];
            json!({"kind":"agent_tool","parent_operation":actor.id,"call_id":"call","request":execution})
        };
        Self {
            dir,
            store,
            session,
            actor,
            origin,
            effect,
            alias,
        }
    }
    fn create(&mut self) -> Record {
        self.store
            .create_tool_approval(
                &self.session,
                &self.actor.id,
                "owner",
                &format!("{}:tool:0:0", self.actor.id),
                &self.origin.id,
                "call",
                &self.alias,
                &self.effect,
            )
            .unwrap()
    }
    fn approve(&mut self, q: &Record) {
        self.store
            .decide_tool_approval(
                &self.session,
                "decision",
                &q.operation_id,
                &q.intent_sha256,
                &Decision::Approve,
                "owner",
            )
            .unwrap();
    }
    fn consume(&mut self, q: &Record) -> zero_store::Result<Operation> {
        self.store.consume_tool_approval(
            &self.session,
            &q.operation_id,
            "owner",
            &q.intent_sha256,
            &format!("{}:tool:0:0:effect", self.actor.id),
            &self.effect,
        )
    }
    fn sql(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.dir.path().join("state.db")).unwrap()
    }
}
#[test]
fn snapshot_and_plugin_approval_are_not_execution_and_exact_consume_is_single_use() {
    for plugin in [false, true] {
        let mut f = Fixture::new(plugin);
        let q = f.create();
        assert_eq!(q.status, Status::Pending);
        assert!(f.consume(&q).is_err());
        assert!(q.consumption.is_none());
        let intent = f
            .store
            .tool_approval_intent(&f.session, &q.operation_id)
            .unwrap();
        assert_eq!(intent["effect_payload"], f.effect);
        assert_eq!(
            f.store.artifact(&q.intent_artifact).unwrap(),
            serde_json::to_vec(&intent).unwrap()
        );
        f.approve(&q);
        let approved = f
            .store
            .get_tool_approval(&f.session, &q.operation_id)
            .unwrap();
        assert_eq!(approved.status, Status::Approved);
        assert_eq!(approved.operation_status, OperationStatus::Running);
        assert!(approved.effect_status.is_none());
        let effect = f.consume(&q).unwrap();
        assert_eq!(effect.payload["approval_operation"], q.operation_id);
        assert!(f.consume(&q).is_err());
        let consumed = f
            .store
            .get_tool_approval(&f.session, &q.operation_id)
            .unwrap();
        assert_eq!(consumed.status, Status::Consumed);
        assert_eq!(consumed.effect_status, Some(OperationStatus::Running));
        f.store
            .settle_operation(
                &effect.id,
                "owner",
                OperationStatus::Failed,
                &json!({"known":true}),
            )
            .unwrap();
        assert_eq!(
            f.store
                .get_tool_approval(&f.session, &q.operation_id)
                .unwrap()
                .effect_status,
            Some(OperationStatus::Failed)
        );
        assert_eq!(
            f.store
                .cancel_tool_approval(&f.session, &q.operation_id, "owner")
                .unwrap()
                .status,
            Status::Consumed
        );
        f.store.claim_engine_epoch("next").unwrap();
        let retry = f
            .store
            .decide_tool_approval(
                &f.session,
                "decision",
                &q.operation_id,
                &q.intent_sha256,
                &Decision::Approve,
                "unrelated",
            )
            .unwrap();
        assert!(retry.2);
        assert_eq!(retry.0.status, Status::Consumed);
        assert!(f.consume(&q).is_err());
        let reader = Store::open_read_only(f.dir.path().join("state.db")).unwrap();
        assert_eq!(
            reader
                .get_tool_approval(&f.session, &q.operation_id)
                .unwrap()
                .status,
            Status::Consumed
        );
        assert_eq!(
            reader
                .tool_approvals(&f.session, Some(&f.actor.id), 0, 100)
                .unwrap()
                .len(),
            1
        );
        assert!(
            reader
                .tool_approvals(&f.session, None, q.sequence, 10)
                .unwrap()
                .is_empty()
        );
    }
}
#[test]
fn denial_cancellation_and_owner_loss_never_consume_or_resume_permission() {
    for mode in [
        "deny",
        "cancel_pending",
        "cancel_approved",
        "restart_pending",
        "restart_approved",
    ] {
        let mut f = Fixture::new(false);
        let q = f.create();
        if mode.ends_with("approved") {
            f.approve(&q);
        }
        let expected = if mode == "deny" {
            f.store
                .decide_tool_approval(
                    &f.session,
                    "d",
                    &q.operation_id,
                    &q.intent_sha256,
                    &Decision::Deny,
                    "owner",
                )
                .unwrap();
            Status::Denied
        } else if mode.starts_with("cancel") {
            f.store
                .cancel_tool_approval(&f.session, &q.operation_id, "owner")
                .unwrap();
            Status::Cancelled
        } else {
            f.store.claim_engine_epoch("next").unwrap();
            Status::Interrupted
        };
        let record = f
            .store
            .get_tool_approval(&f.session, &q.operation_id)
            .unwrap();
        assert_eq!(record.status, expected, "{mode}");
        assert!(record.consumption.is_none());
        assert!(f.consume(&q).is_err());
        assert!(
            f.store
                .decide_tool_approval(
                    &f.session,
                    "late",
                    &q.operation_id,
                    &q.intent_sha256,
                    &Decision::Approve,
                    "owner"
                )
                .is_err()
        );
    }
}
#[test]
fn exact_decision_retry_precedes_liveness_and_changed_intent_conflicts() {
    let mut f = Fixture::new(false);
    let q = f.create();
    f.approve(&q);
    f.store
        .cancel_tool_approval(&f.session, &q.operation_id, "owner")
        .unwrap();
    assert!(
        f.store
            .decide_tool_approval(
                &f.session,
                "decision",
                &q.operation_id,
                &q.intent_sha256,
                &Decision::Approve,
                "not-owner"
            )
            .unwrap()
            .2
    );
    assert!(
        f.store
            .decide_tool_approval(
                &f.session,
                "decision",
                &q.operation_id,
                &q.intent_sha256,
                &Decision::Deny,
                "owner"
            )
            .is_err()
    );
    assert!(
        f.store
            .decide_tool_approval(
                &f.session,
                "decision",
                &q.operation_id,
                &format!("sha256:{}", "b".repeat(64)),
                &Decision::Approve,
                "owner"
            )
            .is_err()
    );
}
#[test]
fn complete_effect_identity_is_checked_before_permission_and_on_consume() {
    for plugin in [false, true] {
        let mut f = Fixture::new(plugin);
        let original = f.effect.clone();
        for field in if plugin {
            vec!["input", "binding", "plugin_context"]
        } else {
            vec!["argv", "backend", "snapshot", "stdin", "memory_mb"]
        } {
            let mut changed = original.clone();
            if plugin {
                changed[field] = json!("forged");
            } else {
                changed["request"][field] = json!("forged");
            }
            assert!(
                f.store
                    .create_tool_approval(
                        &f.session,
                        &f.actor.id,
                        "owner",
                        &format!("{}:tool:0:0", f.actor.id),
                        &f.origin.id,
                        "call",
                        &f.alias,
                        &changed
                    )
                    .is_err(),
                "{field}"
            );
        }
        let q = f.create();
        f.approve(&q);
        let mut changed = original;
        changed["injected"] = json!(true);
        assert!(
            f.store
                .consume_tool_approval(
                    &f.session,
                    &q.operation_id,
                    "owner",
                    &q.intent_sha256,
                    &format!("{}:tool:0:0:effect", f.actor.id),
                    &changed
                )
                .is_err()
        );
        assert_eq!(
            f.store
                .get_tool_approval(&f.session, &q.operation_id)
                .unwrap()
                .status,
            Status::Approved
        );
    }
}
#[test]
fn failed_consume_witness_rolls_back_permission_consumption_and_effect_child() {
    let mut f = Fixture::new(false);
    let q = f.create();
    f.approve(&q);
    f.sql().execute_batch("CREATE TRIGGER fail_consume BEFORE INSERT ON events WHEN NEW.kind='tool_approval_consumed' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(f.consume(&q).is_err());
    assert!(
        f.store
            .get_operation_by_command(&f.session, &format!("{}:tool:0:0:effect", f.actor.id))
            .is_err()
    );
    assert_eq!(
        f.store
            .get_tool_approval(&f.session, &q.operation_id)
            .unwrap()
            .status,
        Status::Approved
    );
    f.sql().execute_batch("DROP TRIGGER fail_consume").unwrap();
    f.consume(&q).unwrap();
}
#[test]
fn approval_creation_and_decision_events_are_atomic() {
    let mut f = Fixture::new(false);
    f.sql().execute_batch("CREATE TRIGGER fail_artifact BEFORE INSERT ON events WHEN NEW.kind='operation_artifact' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(
        f.store
            .create_tool_approval(
                &f.session,
                &f.actor.id,
                "owner",
                &format!("{}:tool:0:0", f.actor.id),
                &f.origin.id,
                "call",
                &f.alias,
                &f.effect
            )
            .is_err()
    );
    assert!(
        f.store
            .tool_approvals(&f.session, None, 0, 100)
            .unwrap()
            .is_empty()
    );
    f.sql().execute_batch("DROP TRIGGER fail_artifact").unwrap();
    let q = f.create();
    f.sql().execute_batch("CREATE TRIGGER fail_decision BEFORE INSERT ON events WHEN NEW.kind='tool_approval_decided' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(
        f.store
            .decide_tool_approval(
                &f.session,
                "d",
                &q.operation_id,
                &q.intent_sha256,
                &Decision::Approve,
                "owner"
            )
            .is_err()
    );
    assert_eq!(
        f.store
            .get_tool_approval(&f.session, &q.operation_id)
            .unwrap()
            .status,
        Status::Pending
    );
    assert!(
        f.store
            .tool_approval_decision_by_command(&f.session, "d")
            .unwrap()
            .is_none()
    );
}
#[test]
fn consume_cancel_race_has_one_owned_disposition() {
    let mut f = Fixture::new(false);
    let q = f.create();
    f.approve(&q);
    let mut other = Store::open(f.dir.path().join("state.db")).unwrap();
    let (s, k, d, e, cmd) = (
        f.session.clone(),
        q.operation_id.clone(),
        q.intent_sha256.clone(),
        f.effect.clone(),
        format!("{}:tool:0:0:effect", f.actor.id),
    );
    let b = std::sync::Arc::new(std::sync::Barrier::new(2));
    let bb = b.clone();
    let task = std::thread::spawn(move || {
        bb.wait();
        other.consume_tool_approval(&s, &k, "owner", &d, &cmd, &e)
    });
    b.wait();
    let cancelled = f
        .store
        .cancel_tool_approval(&f.session, &q.operation_id, "owner")
        .unwrap();
    let consumed = task.join().unwrap();
    let now = f
        .store
        .get_tool_approval(&f.session, &q.operation_id)
        .unwrap();
    assert_eq!(cancelled.status, now.status);
    assert_eq!(consumed.is_ok(), now.status == Status::Consumed);
    assert!(matches!(now.status, Status::Cancelled | Status::Consumed));
}
#[test]
fn forged_admission_intent_decision_and_consumption_are_not_receipts() {
    for mutation in [
        "index",
        "artifact",
        "origin",
        "decision",
        "consume",
        "effect",
        "owner_authority",
    ] {
        let mut f = Fixture::new(false);
        let q = f.create();
        f.approve(&q);
        let e = f.consume(&q).unwrap();
        let conn = f.sql();
        match mutation {
            "index" => {
                conn.execute("UPDATE tool_approvals SET sequence=1", [])
                    .unwrap();
            }
            "artifact" => {
                conn.execute(
                    "UPDATE artifacts SET bytes=X'7b7d' WHERE digest=?1",
                    [&q.intent_sha256],
                )
                .unwrap();
            }
            "origin" => {
                conn.execute("UPDATE operations SET outcome=json_set(outcome,'$.content[0].arguments.argv[0]','changed') WHERE id=?1",[&f.origin.id]).unwrap();
            }
            "decision" => {
                conn.execute("UPDATE tool_approval_decisions SET decision='deny'", [])
                    .unwrap();
            }
            "consume" => {
                conn.execute("UPDATE tool_approval_consumptions SET sequence=1", [])
                    .unwrap();
            }
            "effect" => {
                conn.execute("UPDATE operations SET payload=json_set(payload,'$.request.argv[0]','changed') WHERE id=?1",[&e.id]).unwrap();
            }
            _ => {
                conn.execute("UPDATE operations SET payload=json_set(payload,'$.request.tool_approval_policy.require_approval[0]','other') WHERE id=?1",[&f.actor.id]).unwrap();
            }
        }
        assert!(
            f.store
                .get_tool_approval(&f.session, &q.operation_id)
                .is_err(),
            "{mutation}"
        );
        assert!(
            f.store
                .tool_approval_decision_by_command(&f.session, "decision")
                .is_err(),
            "{mutation}"
        );
    }
}
#[test]
fn schema_eight_readonly_rejects_without_migration_then_write_preserves_journal() {
    let f = Fixture::new(false);
    let path = f.dir.path().join("state.db");
    let before = f.actor.payload.clone();
    drop(f.store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TABLE tool_approval_consumptions; DROP TABLE tool_approval_decisions; DROP TABLE tool_approvals; PRAGMA user_version=8;").unwrap();
    drop(conn);
    assert!(Store::open_read_only(&path).is_err());
    let store = Store::open(&path).unwrap();
    assert_eq!(store.get_operation(&f.actor.id).unwrap().payload, before);
    drop(store);
    assert!(Store::open_read_only(&path).is_ok());
}

#[test]
fn immutable_docker_identity_is_required_only_for_approval_effects() {
    for plugin in [false, true] {
        let mut f = Fixture::new(plugin);
        let mut actor = f.actor.payload.clone();
        if plugin {
            actor["plugin_context"]["launch"]["backend"]["image"] = json!("node:mutable");
            f.effect["plugin_context"] = actor["plugin_context"].clone();
        } else {
            actor["request"]["execution"]["image"] = json!("node:mutable");
            f.effect["request"]["backend"]["image"] = json!("node:mutable");
        }
        f.sql()
            .execute(
                "UPDATE operations SET payload=?2 WHERE id=?1",
                rusqlite::params![f.actor.id, actor.to_string()],
            )
            .unwrap();
        assert!(
            f.store
                .create_tool_approval(
                    &f.session,
                    &f.actor.id,
                    "owner",
                    &format!("{}:tool:0:0", f.actor.id),
                    &f.origin.id,
                    "call",
                    &f.alias,
                    &f.effect
                )
                .is_err()
        );
    }
}
#[test]
fn frozen_intent_bound_rejects_before_wrapper_publication() {
    let mut f = Fixture::new(false);
    let stdin = "x".repeat(8 * 1024 * 1024);
    let mut actor = f.actor.payload.clone();
    actor["request"]["execution"]["stdin"] = json!(stdin);
    f.effect["request"]["stdin"] = actor["request"]["execution"]["stdin"].clone();
    f.sql()
        .execute(
            "UPDATE operations SET payload=?2 WHERE id=?1",
            rusqlite::params![f.actor.id, actor.to_string()],
        )
        .unwrap();
    assert!(
        f.store
            .create_tool_approval(
                &f.session,
                &f.actor.id,
                "owner",
                &format!("{}:tool:0:0", f.actor.id),
                &f.origin.id,
                "call",
                &f.alias,
                &f.effect
            )
            .is_err()
    );
    assert!(
        f.store
            .tool_approvals(&f.session, None, 0, 100)
            .unwrap()
            .is_empty()
    );
    assert!(
        f.store
            .get_operation_by_command(&f.session, &format!("{}:tool:0:0", f.actor.id))
            .is_err()
    );
}
#[test]
fn large_frozen_intents_page_before_shared_read_budget_without_skipping() {
    let mut f = Fixture::new(false);
    let stdin = "é".repeat(3 * 1024 * 1024 / 2);
    let mut actor = f.actor.payload.clone();
    actor["request"]["execution"]["stdin"] = json!(stdin);
    f.effect["request"]["stdin"] = actor["request"]["execution"]["stdin"].clone();
    f.sql()
        .execute(
            "UPDATE operations SET payload=?2 WHERE id=?1",
            rusqlite::params![f.actor.id, actor.to_string()],
        )
        .unwrap();
    let mut completion = f.origin.outcome.clone().unwrap();
    completion["content"]=json!((0..21).map(|i|json!({"type":"tool_call","id":format!("call{i}"),"name":f.alias,"arguments":{"argv":["node","entry"]}})).collect::<Vec<_>>());
    f.sql()
        .execute(
            "UPDATE operations SET outcome=?2 WHERE id=?1",
            rusqlite::params![f.origin.id, completion.to_string()],
        )
        .unwrap();
    let mut expected = Vec::new();
    for i in 0..21 {
        let mut effect = f.effect.clone();
        effect["call_id"] = json!(format!("call{i}"));
        effect["request"]["execution_id"] = json!(format!("agent-{}-0-{i}", f.actor.id));
        let r = f
            .store
            .create_tool_approval(
                &f.session,
                &f.actor.id,
                "owner",
                &format!("{}:tool:0:{i}", f.actor.id),
                &f.origin.id,
                &format!("call{i}"),
                &f.alias,
                &effect,
            )
            .unwrap();
        assert!(r.preview_truncated);
        assert!(r.preview.len() <= 8192);
        expected.push(r.operation_id);
    }
    let first = f.store.tool_approvals(&f.session, None, 0, 100).unwrap();
    assert!(!first.is_empty() && first.len() < expected.len());
    let mut got = Vec::new();
    let mut after = 0;
    loop {
        let page = f
            .store
            .tool_approvals(&f.session, None, after, 100)
            .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= 1024 * 1024);
        if page.is_empty() {
            break;
        }
        after = page.last().unwrap().sequence;
        got.extend(page.into_iter().map(|r| r.operation_id));
    }
    assert_eq!(got, expected);
}
