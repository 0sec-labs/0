#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_store::{Operation, OperationStatus, Store};
use zero_web_verification::{FrozenExperiment, experiment_tool_definition, hash};
struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    session: String,
    actor: Operation,
}
impl Fixture {
    fn new(gated: bool) -> Self {
        Self::with_limit(gated, 1)
    }
    fn with_limit(gated: bool, limit: u32) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("state.db")).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let session = store.create_session("g", 100).unwrap().id;
        let profile=zero_http::normalize_policy(serde_json::from_value(json!({"schema_version":1,"base_url":"http://localhost","in_scope":["localhost"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["POST"],"allowed_headers":[],"limits":{"timeout_ms":1000,"max_request_body_bytes":1048576,"max_response_wire_bytes":16777216,"max_response_decoded_bytes":16777216,"max_request_header_bytes":65536,"max_request_headers":128,"max_response_header_bytes":65536,"max_response_headers":128,"max_dns_answers":64,"max_dns_cname_depth":8,"max_dns_queries":16},"rate":{"default":{"requests_per_interval":5,"interval_ms":1000,"burst":5},"per_host":{},"jitter_ms":0},"budget":{"max_requests":100,"max_request_body_bytes":1000000,"max_response_decoded_bytes":100000000}})).unwrap()).unwrap();
        let digest = hash(&profile).unwrap();
        let context = json!({"schema_version":1,"profile_name":"fixture","profile":profile,"profile_sha256":digest,"account_id":hash(&json!({"session_id":session,"original_root_command":"root","profile_sha256":digest})).unwrap(),"original_root_command":"root"});
        let mut request = json!({"provider":"p","model":"m","instructions":"i","prompt":"p","http_profile":"fixture","web_experiment_policy":{"schema_version":1,"max_experiments":limit,"max_cases":2,"max_repeats":2},"max_turns":3,"reservation_per_turn":10});
        if gated {
            request["tool_approval_policy"] = json!({"require_approval":["http_request"]});
        }
        let actor=store.admit_owned_batch(&session,"owner",&[("root".into(),json!({"kind":"scoped_web_agent","request":request,"http_context":context,"http_output_version":2}))]).unwrap().remove(0);
        Self {
            dir,
            store,
            session,
            actor,
        }
    }
    fn prepare(&mut self, turn: u32) -> (Operation, FrozenExperiment, Value, String) {
        self.prepare_prior(turn, None)
    }
    fn prepare_prior(
        &mut self,
        turn: u32,
        prior: Option<Value>,
    ) -> (Operation, FrozenExperiment, Value, String) {
        self.prepare_padded(turn, prior, 0)
    }
    fn prepare_padded(
        &mut self,
        turn: u32,
        prior: Option<Value>,
        padding: usize,
    ) -> (Operation, FrozenExperiment, Value, String) {
        let policy =
            serde_json::from_value(self.actor.payload["request"]["web_experiment_policy"].clone())
                .unwrap();
        let mut args = json!({"hypothesis":{"title":"Prediction","explanation":"\\".repeat(8192)},"purpose":"Contrast control","repeats":2,"cases":[{"name":"attack","role":"attack","request":{"url":"/attack"},"expected":{"status":200,"body_sha256":hash(&json!("a")).unwrap()}},{"name":"control","role":"legitimate_control","request":{"url":"/control"},"expected":{"status":200,"body_sha256":hash(&json!("b")).unwrap()}}]});
        if let Some(prior) = prior {
            args["hypothesis"]["prior_revision"] = prior;
        }
        let origin=self.store.admit_command(&self.session,&format!("{}:model:{turn}",self.actor.id),&json!({"kind":"agent_inference","parent_operation":self.actor.id,"request":{"tools":[experiment_tool_definition(&policy)],"input":["x".repeat(padding)]}})).unwrap().operation;
        self.store.begin_operation(&origin.id, "owner").unwrap();
        let origin=self.store.settle_operation(&origin.id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","response_id":"r","content":[{"type":"tool_call","id":"call","name":"run_web_experiment","arguments":args}],"usage":null,"replay":[],"error":null})).unwrap();
        let frozen = FrozenExperiment::new(
            &self.session,
            &self.actor.id,
            &origin.id,
            "call",
            policy,
            serde_json::from_value(args).unwrap(),
            self.actor.payload["http_context"].clone(),
            serde_json::from_value(self.actor.payload["request"]["tool_approval_policy"].clone())
                .unwrap(),
        )
        .unwrap();
        let payload = frozen
            .parent_payload(
                &hash(&self.actor.payload).unwrap(),
                &source_hash(&origin.payload),
                &hash(&origin.outcome).unwrap(),
            )
            .unwrap();
        (
            origin,
            frozen,
            payload,
            format!("{}:tool:{turn}:0", self.actor.id),
        )
    }
    fn sql(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.dir.path().join("state.db")).unwrap()
    }
}
#[test]
fn quota_is_atomic_shared_and_not_refunded_on_failure_or_projection_deletion() {
    let mut f = Fixture::new(false);
    let (_, frozen, payload, command) = f.prepare(0);
    let op = f
        .store
        .admit_web_experiment(&f.session, &f.actor.id, "owner", &command, &payload)
        .unwrap();
    assert_eq!(
        f.store.validate_web_experiment_parent(&op).unwrap(),
        *frozen.intent()
    );
    f.store
        .settle_operation(
            &op.id,
            "owner",
            OperationStatus::Failed,
            &json!({"error":"failed"}),
        )
        .unwrap();
    let (_, _, second, command2) = f.prepare(1);
    assert!(matches!(
        f.store
            .admit_web_experiment(&f.session, &f.actor.id, "owner", &command2, &second),
        Err(zero_store::Error::BudgetExceeded)
    ));
    assert!(
        f.store
            .get_operation_by_command(&f.session, &command2)
            .is_err()
    );
    let sql = f.sql();
    sql.execute("DELETE FROM web_experiment_admissions", [])
        .unwrap();
    assert!(
        f.store
            .admit_web_experiment(&f.session, &f.actor.id, "owner", &command2, &second)
            .is_err()
    );
    assert!(
        f.store
            .get_operation_by_command(&f.session, &command2)
            .is_err()
    );
}
#[test]
fn wrong_owner_changed_origin_and_ungated_bypass_never_allocate() {
    let mut f = Fixture::new(true);
    let (_, _, payload, command) = f.prepare(0);
    assert!(
        f.store
            .admit_web_experiment(&f.session, &f.actor.id, "owner", &command, &payload)
            .is_err()
    );
    assert!(
        f.store
            .admit_web_experiment(&f.session, &f.actor.id, "other", &command, &payload)
            .is_err()
    );
    assert!(
        f.store
            .get_operation_by_command(&f.session, &command)
            .is_err()
    );
    assert_eq!(
        f.sql()
            .query_row("SELECT count(*) FROM web_experiment_admissions", [], |r| {
                r.get::<_, u64>(0)
            })
            .unwrap(),
        0
    );
    let mut f = Fixture::new(false);
    let (origin, _, payload, command) = f.prepare(0);
    f.sql().execute("UPDATE operations SET outcome=json_set(outcome,'$.content[0].arguments.purpose','changed') WHERE id=?1",[origin.id]).unwrap();
    assert!(
        f.store
            .admit_web_experiment(&f.session, &f.actor.id, "owner", &command, &payload)
            .is_err()
    );
}
#[test]
fn whole_matrix_approval_and_quota_commit_together() {
    use zero_protocol::approvals::ToolApprovalDecision;
    let mut f = Fixture::new(true);
    let (origin, _, payload, command) = f.prepare(0);
    let approval = f
        .store
        .create_tool_approval(
            &f.session,
            &f.actor.id,
            "owner",
            &command,
            &origin.id,
            "call",
            "run_web_experiment",
            &payload,
        )
        .unwrap();
    f.store
        .decide_tool_approval(
            &f.session,
            "approve",
            &approval.operation_id,
            &approval.intent_sha256,
            &ToolApprovalDecision::Approve,
            "owner",
        )
        .unwrap();
    let op = f
        .store
        .consume_tool_approval(
            &f.session,
            &approval.operation_id,
            "owner",
            &approval.intent_sha256,
            &format!("{command}:effect"),
            &payload,
        )
        .unwrap();
    f.store.validate_web_experiment_parent(&op).unwrap();
    let (origin, _, payload, command) = f.prepare(1);
    let approval = f
        .store
        .create_tool_approval(
            &f.session,
            &f.actor.id,
            "owner",
            &command,
            &origin.id,
            "call",
            "run_web_experiment",
            &payload,
        )
        .unwrap();
    f.store
        .decide_tool_approval(
            &f.session,
            "approve2",
            &approval.operation_id,
            &approval.intent_sha256,
            &ToolApprovalDecision::Approve,
            "owner",
        )
        .unwrap();
    assert!(matches!(
        f.store.consume_tool_approval(
            &f.session,
            &approval.operation_id,
            "owner",
            &approval.intent_sha256,
            &format!("{command}:effect"),
            &payload
        ),
        Err(zero_store::Error::BudgetExceeded)
    ));
    assert!(
        f.store
            .get_tool_approval(&f.session, &approval.operation_id)
            .unwrap()
            .consumption
            .is_none()
    );
    assert!(
        f.store
            .get_operation_by_command(&f.session, &format!("{command}:effect"))
            .is_err()
    );
}

#[test]
fn prior_revision_requires_retained_exact_hypothesis_and_causal_source() {
    let mut f = Fixture::with_limit(false, 2);
    let (_, first, payload, command) = f.prepare(0);
    let old = f
        .store
        .admit_web_experiment(&f.session, &f.actor.id, "owner", &command, &payload)
        .unwrap();
    let (_, _, payload2, command2) = f.prepare_prior(
        1,
        Some(json!({"operation_id":old.id,"hypothesis_sha256":first.hypothesis_sha256()})),
    );
    assert!(
        f.store
            .admit_web_experiment(&f.session, &f.actor.id, "owner", &command2, &payload2)
            .is_err()
    );
    assert!(
        f.store
            .get_operation_by_command(&f.session, &command2)
            .is_err()
    );
    f.store
        .retain_operation_artifact(
            &old.id,
            "owner",
            "experiment.hypothesis",
            &serde_json::to_vec(first.hypothesis()).unwrap(),
        )
        .unwrap();
    // Late retention cannot retroactively establish the original model's input.
    assert!(
        f.store
            .admit_web_experiment(&f.session, &f.actor.id, "owner", &command2, &payload2)
            .is_err()
    );
    let (_, _, payload2, command2) = f.prepare_prior(
        2,
        Some(json!({"operation_id":old.id,"hypothesis_sha256":first.hypothesis_sha256()})),
    );
    let next = f
        .store
        .admit_web_experiment(&f.session, &f.actor.id, "owner", &command2, &payload2)
        .unwrap();
    f.store.validate_web_experiment_parent(&next).unwrap();
    f.sql().execute("DELETE FROM operation_artifacts WHERE operation_id=?1 AND name='experiment.hypothesis'",[old.id]).unwrap();
    assert!(f.store.validate_web_experiment_parent(&next).is_err());
}
#[test]
fn native_definition_is_bound_and_discovery_uses_admission_identity() {
    let mut f = Fixture::new(false);
    let (origin, _, payload, command) = f.prepare(0);
    let sql = f.sql();
    sql.execute("UPDATE operations SET payload=json_set(payload,'$.request.tools[0].description','spoof') WHERE id=?1",[origin.id]).unwrap();
    assert!(
        f.store
            .admit_web_experiment(&f.session, &f.actor.id, "owner", &command, &payload)
            .is_err()
    );
    let mut f = Fixture::new(false);
    let (_, frozen, payload, command) = f.prepare(0);
    let op = f
        .store
        .admit_web_experiment(&f.session, &f.actor.id, "owner", &command, &payload)
        .unwrap();
    let page = f
        .store
        .experiment_operation_candidates(&f.session, None, 10)
        .unwrap();
    assert_eq!(page.experiments.len(), 1);
    assert_eq!(
        page.experiments[0].hypothesis_sha256.as_deref(),
        Some(frozen.hypothesis_sha256())
    );
    f.sql()
        .execute("UPDATE operations SET payload='{}' WHERE id=?1", [&op.id])
        .unwrap();
    let page = f
        .store
        .experiment_operation_candidates(&f.session, None, 10)
        .unwrap();
    assert_eq!(
        page.experiments[0].hypothesis_sha256.as_deref(),
        Some(frozen.hypothesis_sha256())
    );
    assert!(f.store.validate_web_experiment_parent(&op).is_err());
}

fn source_hash(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap())
    )
}
#[test]
fn source_hash_bound_is_independent_of_frozen_effect_intent_bound() {
    let mut f = Fixture::new(false);
    let (_, _, payload, command) = f.prepare_padded(0, None, 9 * 1024 * 1024);
    let op = f
        .store
        .admit_web_experiment(&f.session, &f.actor.id, "owner", &command, &payload)
        .unwrap();
    f.store.validate_web_experiment_parent(&op).unwrap();
}
