#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use std::collections::BTreeMap;
use zero_protocol::{
    campaign::*,
    model::{Rates, WireApi},
};
use zero_store::{Operation, Store};
fn hash(v: &Value) -> String {
    zero_web_verification::hash(v).unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    campaign: Campaign,
    spec: CampaignRunSpec,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("state.db")).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let config = json!({"controller":"host fixture"});
        let bytes = serde_json::to_vec(&config).unwrap();
        let plan = CampaignPlan {
            schema_version: 1,
            controller_plan_sha256: hash(&config),
            baseline_sha256: hash(&json!("baseline")),
            expires_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 600000,
            limits: CampaignLimits {
                model_micro_usd: 100,
                model_calls: 8,
                http_requests: 2,
                http_request_body_bytes: 100,
                http_response_decoded_bytes: 200,
                experiments: 2,
                runs: 8,
                max_parallel_runs: 2,
            },
        };
        let campaign = store
            .create_campaign_with_artifact("create", &plan, &bytes)
            .unwrap()
            .0;
        let http_policy=zero_http::normalize_policy(serde_json::from_value(json!({"schema_version":1,"base_url":"http://localhost:8080/","in_scope":["localhost"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["POST"],"allowed_headers":[],"limits":{"timeout_ms":1000,"max_request_body_bytes":100,"max_response_wire_bytes":100,"max_response_decoded_bytes":100,"max_request_header_bytes":1000,"max_request_headers":10,"max_response_header_bytes":1000,"max_response_headers":10,"max_dns_answers":8,"max_dns_cname_depth":4,"max_dns_queries":8},"rate":{"default":{"requests_per_interval":100,"interval_ms":1000,"burst":100},"per_host":{},"jitter_ms":0},"budget":{"max_requests":20,"max_request_body_bytes":1000,"max_response_decoded_bytes":2000}})).unwrap()).unwrap();
        let request=serde_json::from_value(json!({"provider":"p","model":"m","instructions":"host frozen","prompt":"private scenario task","http_profile":"fixture","max_turns":2,"reservation_per_turn":60})).unwrap();
        let spec = CampaignRunSpec {
            candidate_sha256: hash(&json!("candidate")),
            suite_sha256: hash(&json!("suite")),
            evaluation_pair_sha256: hash(&json!("pair")),
            schedule_index: 0,
            lane: CampaignLane::Development,
            scenario_id: "case".into(),
            repeat_index: 0,
            variant: CampaignVariant::Candidate,
            fixture_origin: "http://localhost:8080".into(),
            request,
            http_policy,
            provider_context: BTreeMap::from([(
                "p".into(),
                CampaignProviderContext {
                    endpoint: "http://localhost:9090/responses".into(),
                    wire_api: WireApi::Responses,
                    rates: Rates {
                        input: 1,
                        cached_input: 1,
                        output: 1,
                    },
                    hosted_catalog: None,
                },
            )]),
            exposure_id: None,
        };
        Self {
            dir,
            store,
            campaign,
            spec,
        }
    }
    fn run(&mut self, index: u32) -> CampaignRun {
        let mut spec = self.spec.clone();
        spec.schedule_index = index;
        self.store
            .create_campaign_run(&self.campaign.id, &format!("run-{index}"), &spec, "owner")
            .unwrap()
            .0
    }
    fn root(&mut self, r: &CampaignRun) -> Operation {
        let profile = serde_json::to_value(&r.spec.http_policy).unwrap();
        let digest = hash(&profile);
        let context = json!({"schema_version":1,"profile_name":"fixture","profile":profile,"profile_sha256":digest,"account_id":hash(&json!({"session_id":r.session_id,"original_root_command":r.run_command_id,"profile_sha256":digest})),"original_root_command":r.run_command_id});
        self.store.admit_owned_batch(&r.session_id,"owner",&[(r.run_command_id.clone(),json!({"kind":"scoped_web_agent","request":r.spec.request,"endpoint":r.spec.provider_context["p"].endpoint,"rates":r.spec.provider_context["p"].rates,"http_context":context}))]).unwrap().remove(0)
    }
    fn inference(&mut self, r: &CampaignRun, root: &Operation, turn: u32) -> Operation {
        self.store.admit_owned_batch(&r.session_id,"owner",&[(format!("{}:model:{turn}",root.id),json!({"kind":"agent_inference","parent_operation":root.id,"endpoint":r.spec.provider_context["p"].endpoint,"rates":r.spec.provider_context["p"].rates,"request":{"model":"m","instructions":"host frozen","tools":[],"input":[]}}))]).unwrap().remove(0)
    }
    fn sql(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.dir.path().join("state.db")).unwrap()
    }
}
#[test]
fn aggregate_model_admission_is_atomic_with_session_and_unknown_holds() {
    let mut f = Fixture::new();
    let a = f.run(0);
    let b = f.run(1);
    let ar = f.root(&a);
    let br = f.root(&b);
    let ai = f.inference(&a, &ar, 0);
    let bi = f.inference(&b, &br, 0);
    f.store.reserve_budget(&a.session_id, &ai.id, 60).unwrap();
    assert!(matches!(
        f.store.reserve_budget(&b.session_id, &bi.id, 60),
        Err(zero_store::Error::BudgetExceeded)
    ));
    assert_eq!(f.store.budget(&b.session_id).unwrap().reserved, 0);
    assert_eq!(
        f.store
            .campaign(&f.campaign.id)
            .unwrap()
            .usage
            .model_reserved_micro_usd,
        60
    );
    f.store.settle_budget(&a.session_id, &ai.id, 20).unwrap();
    f.store.reserve_budget(&b.session_id, &bi.id, 60).unwrap();
    f.store.claim_engine_epoch("next").unwrap();
    let snapshot = f.store.campaign(&f.campaign.id).unwrap();
    assert_eq!(snapshot.usage.model_charged_micro_usd, 20);
    assert_eq!(snapshot.usage.model_reserved_micro_usd, 60);
    assert_eq!(snapshot.usage.unknown_runs, 2);
    assert!(
        f.store
            .reconcile_budget(&b.session_id, &bi.id, 0, "manual guess")
            .is_err()
    );
    let read = Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    assert_eq!(read.campaign(&f.campaign.id).unwrap().usage.model_calls, 2);
}
#[test]
fn bound_session_projection_cannot_be_removed_or_terminal_status_forged() {
    let mut f = Fixture::new();
    let a = f.run(0);
    let root = f.root(&a);
    f.sql()
        .execute(
            "UPDATE operations SET status='succeeded',outcome='{}' WHERE id=?1",
            [&root.id],
        )
        .unwrap();
    assert!(f.store.campaign(&f.campaign.id).is_err());
    f.sql()
        .execute(
            "UPDATE operations SET status='running',outcome=NULL WHERE id=?1",
            [&root.id],
        )
        .unwrap();
    f.sql()
        .execute("DELETE FROM campaign_runs WHERE id=?1", [&a.id])
        .unwrap();
    assert!(
        f.store
            .admit_command(
                &a.session_id,
                "escape",
                &json!({"kind":"responses_inference"})
            )
            .is_err()
    );
    assert!(f.store.campaign(&f.campaign.id).is_err());
}
#[test]
fn exposure_survives_cancel_and_retry_and_new_campaign_cannot_reset_suite() {
    let mut f = Fixture::new();
    let e = f
        .store
        .create_campaign_exposure(
            &f.campaign.id,
            "final",
            &f.spec.suite_sha256,
            &f.spec.evaluation_pair_sha256,
            &f.spec.candidate_sha256,
        )
        .unwrap()
        .0;
    f.store.cancel_campaign(&f.campaign.id).unwrap();
    let retry = f
        .store
        .create_campaign_exposure(
            &f.campaign.id,
            "final",
            &f.spec.suite_sha256,
            &f.spec.evaluation_pair_sha256,
            &f.spec.candidate_sha256,
        )
        .unwrap();
    assert!(retry.1);
    assert_eq!(retry.0.id, e.id);
    let c = f
        .store
        .create_campaign_with_artifact(
            "second",
            &f.campaign.plan,
            &serde_json::to_vec(&json!({"controller":"host fixture"})).unwrap(),
        )
        .unwrap()
        .0;
    assert!(
        f.store
            .create_campaign_exposure(
                &c.id,
                "reuse",
                &f.spec.suite_sha256,
                &f.spec.evaluation_pair_sha256,
                &f.spec.candidate_sha256
            )
            .is_err()
    );
    f.sql()
        .execute("DELETE FROM campaign_exposures WHERE id=?1", [e.id])
        .unwrap();
    assert!(
        f.store
            .create_campaign_exposure(
                &c.id,
                "reuse2",
                &f.spec.suite_sha256,
                &f.spec.evaluation_pair_sha256,
                &f.spec.candidate_sha256
            )
            .is_err()
    );
}
#[test]
fn no_root_retirement_and_metadata_page_preserve_counts_without_private_prompt() {
    let mut f = Fixture::new();
    let a = f.run(0);
    f.store
        .settle_campaign_run_without_root(
            &f.campaign.id,
            &a.id,
            "owner",
            CampaignRunStatus::Failed,
            "profile rejected before root",
        )
        .unwrap();
    let b = f.run(1);
    f.store.cancel_campaign(&f.campaign.id).unwrap();
    assert_eq!(
        f.store.campaign_run(&f.campaign.id, &b.id).unwrap().status,
        CampaignRunStatus::Cancelled
    );
    let (retry, duplicate) = f
        .store
        .create_campaign_run(&f.campaign.id, "run-0", &a.spec, "another-owner")
        .unwrap();
    assert!(duplicate);
    assert_eq!(retry.status, CampaignRunStatus::Failed);
    let page = f.store.campaign_runs(&f.campaign.id, 0, 1).unwrap();
    let bytes = serde_json::to_string(&page).unwrap();
    assert!(!bytes.contains("private scenario"));
    assert!(!bytes.contains("provider_context"));
    assert_eq!(page.runs.len(), 1);
    assert!(page.next_after_sequence.is_some());
    assert_eq!(f.store.campaign(&f.campaign.id).unwrap().usage.runs, 2);
}
#[test]
fn unsupported_inputs_routes_and_price_drift_reject_before_admission() {
    let mut f = Fixture::new();
    let r = f.run(0);
    for kind in [
        "responses_inference",
        "source_hypothesis_review",
        "sandbox",
        "plugin",
        "scoped_web_agent",
    ] {
        assert!(
            f.store
                .admit_command(&r.session_id, "bad", &json!({"kind":kind}))
                .is_err()
        );
    }
    assert!(
        f.store
            .enqueue_agent(&r.session_id, "input", &r.spec.request, &None)
            .is_err()
    );
    let root = f.root(&r);
    assert!(
        f.store
            .enqueue_agent_steering(&r.session_id, &root.id, "steer", "change task")
            .is_err()
    );
    let bad = json!({"kind":"agent_inference","parent_operation":root.id,"endpoint":"http://localhost:9091/responses","rates":r.spec.provider_context["p"].rates,"request":{"model":"m","instructions":"host frozen"}});
    assert!(
        f.store
            .admit_command(&r.session_id, "bad-route", &bad)
            .is_err()
    );
    assert!(
        f.store
            .admit_command(
                &f.campaign.journal_session_id,
                "bad-controller",
                &json!({"kind":"sandbox"})
            )
            .is_err()
    );
}
#[test]
fn http_ports_and_aggregate_hops_are_checked_before_account_mutation() {
    let mut f = Fixture::new();
    let a = f.run(0);
    let b = f.run(1);
    let ar = f.root(&a);
    let br = f.root(&b);
    let ac = ar.payload["http_context"].clone();
    let bc = br.payload["http_context"].clone();
    for (r, c) in [(&a, &ac), (&b, &bc)] {
        f.store.ensure_http_account(&r.session_id, c).unwrap();
    }
    let effect = |store: &mut Store, r: &CampaignRun, root: &Operation, n: &str| {
        store.admit_owned_batch(&r.session_id,"owner",&[(n.into(),json!({"kind":"agent_http","parent_operation":root.id,"http_context":root.payload["http_context"]}))]).unwrap().remove(0)
    };
    let e1 = effect(&mut f.store, &a, &ar, "e1");
    let e2 = effect(&mut f.store, &b, &br, "e2");
    let intent = |c: &Value, port: u16| json!({"index":0,"host":"localhost","profile_sha256":c["profile_sha256"],"url":format!("http://localhost:{port}/"),"method":"POST","addresses":[format!("127.0.0.1:{port}")],"selected_address":format!("127.0.0.1:{port}"),"request_body_bytes":2,"response_decoded_limit":100});
    assert!(
        f.store
            .admit_http_hop(
                &a.session_id,
                &e1.id,
                "owner",
                ac["account_id"].as_str().unwrap(),
                &intent(&ac, 9090),
                1000
            )
            .is_err()
    );
    assert_eq!(
        f.store
            .campaign(&f.campaign.id)
            .unwrap()
            .usage
            .http_requests,
        0
    );
    let one = f
        .store
        .admit_http_hop(
            &a.session_id,
            &e1.id,
            "owner",
            ac["account_id"].as_str().unwrap(),
            &intent(&ac, 8080),
            1000,
        )
        .unwrap();
    let id = match one {
        zero_store::HttpAdmission::Admitted { receipt } => receipt,
        _ => panic!("permit"),
    };
    f.store
        .admit_http_hop(
            &b.session_id,
            &e2.id,
            "owner",
            bc["account_id"].as_str().unwrap(),
            &intent(&bc, 8080),
            1000,
        )
        .unwrap();
    let third = effect(&mut f.store, &a, &ar, "e3");
    assert!(matches!(
        f.store.admit_http_hop(
            &a.session_id,
            &third.id,
            "owner",
            ac["account_id"].as_str().unwrap(),
            &intent(&ac, 8080),
            2000
        ),
        Err(zero_store::Error::BudgetExceeded)
    ));
    let u = f.store.campaign(&f.campaign.id).unwrap().usage;
    assert_eq!(u.http_requests, 2);
    assert_eq!(u.http_response_reserved_bytes, 200);
    f.sql()
        .execute(
            "DELETE FROM campaign_debits WHERE id=?1",
            [format!("http:{id}")],
        )
        .unwrap();
    assert!(f.store.campaign(&f.campaign.id).is_err());
}
#[test]
fn schema12_migration_preserves_existing_session_and_has_exact_readonly_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let s = store.create_session("legacy", 50).unwrap();
    drop(store);
    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch("DROP INDEX campaign_root_lifecycle;DROP INDEX campaign_exposure_witness;DROP TABLE campaign_debits;DROP TABLE campaign_exposures;DROP TABLE campaign_runs;DROP INDEX review_command_created; DROP TABLE reviews; DROP INDEX scan_command_created; DROP TABLE scans; DROP TABLE strategy_search_selections; DROP TABLE strategy_search_evaluations; DROP TABLE strategy_search_proposals; DROP TABLE strategy_searches; DROP TABLE strategy_sessions; DROP TABLE campaigns;PRAGMA user_version=12;").unwrap();
    drop(sql);
    assert!(Store::open_read_only(&path).is_err());
    let store = Store::open(&path).unwrap();
    assert_eq!(store.budget(&s.id).unwrap().limit, 50);
    drop(store);
    Store::open_read_only(&path).unwrap();
}
#[test]
fn concurrent_connections_cannot_reserve_two_full_campaign_allowances() {
    let mut f = Fixture::new();
    let a = f.run(0);
    let b = f.run(1);
    let ar = f.root(&a);
    let br = f.root(&b);
    let ai = f.inference(&a, &ar, 0);
    let bi = f.inference(&b, &br, 0);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let path = f.dir.path().join("state.db");
    let workers = [(a.session_id, ai.id), (b.session_id, bi.id)]
        .into_iter()
        .map(|(session, op)| {
            let barrier = barrier.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                let mut store = Store::open(path).unwrap();
                barrier.wait();
                store.reserve_budget(&session, &op, 60).is_ok()
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        workers
            .into_iter()
            .map(|w| w.join().unwrap() as u32)
            .sum::<u32>(),
        1
    );
    assert_eq!(
        f.store
            .campaign(&f.campaign.id)
            .unwrap()
            .usage
            .model_reserved_micro_usd,
        60
    );
}
#[test]
fn actual_model_charge_overshoot_is_retained_and_blocks_later_admission() {
    let mut f = Fixture::new();
    let a = f.run(0);
    let root = f.root(&a);
    let first = f.inference(&a, &root, 0);
    f.store
        .reserve_budget(&a.session_id, &first.id, 60)
        .unwrap();
    f.store
        .settle_budget(&a.session_id, &first.id, 120)
        .unwrap();
    assert_eq!(
        f.store
            .campaign(&f.campaign.id)
            .unwrap()
            .usage
            .model_charged_micro_usd,
        120
    );
    assert_eq!(f.store.budget(&a.session_id).unwrap().charged, 120);
    let second = f.inference(&a, &root, 1);
    assert!(matches!(
        f.store.reserve_budget(&a.session_id, &second.id, 60),
        Err(zero_store::Error::BudgetExceeded)
    ));
    assert_eq!(
        f.store.campaign(&f.campaign.id).unwrap().usage.model_calls,
        1
    );
}
#[test]
fn cancelled_projection_cannot_reopen_and_corrupt_scalar_fails_bounded() {
    let mut f = Fixture::new();
    let r = f.run(0);
    f.store.cancel_campaign(&f.campaign.id).unwrap();
    f.sql()
        .execute(
            "UPDATE campaigns SET cancel_sequence=NULL WHERE id=?1",
            [&f.campaign.id],
        )
        .unwrap();
    assert!(f.store.campaign(&f.campaign.id).is_err());
    let mut g = Fixture::new();
    let run = g.run(0);
    g.sql()
        .execute(
            "UPDATE campaign_runs SET owner=?2 WHERE id=?1",
            rusqlite::params![run.id, "x".repeat(2 * 1024 * 1024)],
        )
        .unwrap();
    assert!(g.store.campaign(&g.campaign.id).is_err());
    assert!(
        f.store
            .admit_command(
                &r.session_id,
                &r.run_command_id,
                &json!({"kind":"scoped_web_agent","request":r.spec.request})
            )
            .is_err()
    );
}

#[test]
fn retired_run_projection_cannot_be_deleted_to_readmit_root() {
    let mut f = Fixture::new();
    let run = f
        .store
        .create_campaign_run(&f.campaign.id, "retire", &f.spec, "owner")
        .unwrap()
        .0;
    f.store
        .settle_campaign_run_without_root(
            &f.campaign.id,
            &run.id,
            "owner",
            CampaignRunStatus::Cancelled,
            "host cancelled",
        )
        .unwrap();
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    db.execute(
        "UPDATE campaign_runs SET closed=NULL,close_sequence=NULL,close_reason=NULL WHERE id=?1",
        [&run.id],
    )
    .unwrap();
    assert!(f.store.campaign_run(&f.campaign.id, &run.id).is_err());
    assert!(f.store.campaign(&f.campaign.id).is_err());
    assert!(
        f.store
            .admit_command(
                &run.session_id,
                &run.run_command_id,
                &json!({"kind":"scoped_web_agent","request":run.spec.request})
            )
            .is_err()
    );
}

#[test]
fn delegated_request_is_exact_parent_role_and_original_task_with_atomic_rejection() {
    let mut f = Fixture::new();
    f.spec.request.context_policy = Some(
        serde_json::from_value(
            json!({"schema_version":1,"max_input_bytes":2048,"keep_recent_rounds":1}),
        )
        .unwrap(),
    );
    f.spec.request.web_submission_max_hypotheses = Some(2);
    f.spec.request.web_experiment_policy = Some(
        serde_json::from_value(
            json!({"schema_version":1,"max_experiments":2,"max_cases":2,"max_repeats":2}),
        )
        .unwrap(),
    );
    f.spec.request.delegation_policy=Some(serde_json::from_value(json!({"max_parallel":1,"max_children":1,"roles":[{"name":"child","provider":"p","model":"m","instructions":"Role guidance","description":"HTTP investigation","tools":["http_request"],"max_turns":2,"reservation_per_turn":5}]})).unwrap());
    let r = f.run(0);
    let profile = serde_json::to_value(&r.spec.http_policy).unwrap();
    let digest = hash(&profile);
    let http = json!({"schema_version":1,"profile_name":"fixture","profile":profile,"profile_sha256":digest,"account_id":hash(&json!({"session_id":r.session_id,"original_root_command":r.run_command_id,"profile_sha256":digest})),"original_root_command":r.run_command_id});
    let role = json!({"name":"child","endpoint":r.spec.provider_context["p"].endpoint,"rates":r.spec.provider_context["p"].rates,"wire_api":"responses","http_context":http,"http_output_version":2,"template":{"tools":[{"name":"http_request"}]}});
    let context = json!({"roles":[role]});
    let root_payload = json!({"kind":"scoped_web_agent","request":r.spec.request,"endpoint":r.spec.provider_context["p"].endpoint,"rates":r.spec.provider_context["p"].rates,"http_context":http,"http_output_version":2,"delegation_context":context});
    let root = f
        .store
        .admit_owned_batch(
            &r.session_id,
            "owner",
            &[(r.run_command_id.clone(), root_payload)],
        )
        .unwrap()
        .remove(0);
    let origin = f.inference(&r, &root, 0);
    let tasks = json!([{"role":"child","prompt":"Model-selected task"}]);
    let outcome = json!({"status":"completed","response_id":null,"content":[{"type":"tool_call","id":"call","name":"delegate_tasks","arguments":{"tasks":tasks}}],"usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0},"usage_is_final":true,"replay":[],"error":null});
    f.store
        .settle_operation(
            &origin.id,
            "owner",
            zero_store::OperationStatus::Succeeded,
            &outcome,
        )
        .unwrap();
    let command = format!("{}:tool:0:0", root.id);
    let child_command = format!("{command}:agent:0");
    let group = json!({"kind":"agent_delegation","parent_operation":root.id,"call_id":"call","tasks":tasks,"child_commands":[child_command],"delegation_context_sha256":hash(&context)});
    let mut child_request = r.spec.request.clone();
    child_request.instructions =
        "host frozen\n\nHost-defined delegated role child:\nRole guidance".into();
    child_request.prompt = "Model-selected task".into();
    child_request.reservation_per_turn = 5;
    child_request.context_policy = None;
    child_request.delegation_policy = None;
    child_request.web_submission_max_hypotheses = None;
    child_request.web_experiment_policy = None;
    let child = json!({"kind":"scoped_web_agent","parent_operation":root.id,"request":child_request,"endpoint":role["endpoint"],"rates":role["rates"],"wire_api":"responses","http_context":http,"http_output_version":2,"delegation_template":role["template"],"delegation_role":"child","delegation_group_command":command,"delegation_index":0});
    for (field, value) in [
        ("instructions", json!("Role guidance")),
        ("prompt", json!("substituted task")),
        ("context_policy", json!(r.spec.request.context_policy)),
        ("web_submission_max_hypotheses", json!(2)),
        (
            "web_experiment_policy",
            json!(r.spec.request.web_experiment_policy),
        ),
        ("max_turns", json!(3)),
        ("model", json!("other")),
    ] {
        let mut changed = child.clone();
        changed["request"][field] = value;
        assert!(
            f.store
                .admit_owned_batch(
                    &r.session_id,
                    "owner",
                    &[
                        (command.clone(), group.clone()),
                        (child_command.clone(), changed)
                    ]
                )
                .is_err(),
            "accepted changed {field}"
        );
        assert!(
            f.store
                .get_operation_by_command(&r.session_id, &command)
                .is_err()
        );
    }
    let mut forged = group.clone();
    forged["tasks"][0]["prompt"] = json!("not the original inference task");
    assert!(
        f.store
            .admit_owned_batch(
                &r.session_id,
                "owner",
                &[
                    (command.clone(), forged),
                    (child_command.clone(), child.clone())
                ]
            )
            .is_err()
    );
    let admitted = f
        .store
        .admit_owned_batch(
            &r.session_id,
            "owner",
            &[(command, group), (child_command, child)],
        )
        .unwrap();
    assert_eq!(admitted.len(), 2);
    assert_eq!(
        admitted[1].payload["request"]["prompt"],
        "Model-selected task"
    );
}
