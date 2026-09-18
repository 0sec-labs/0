#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_protocol::{
    campaign::*, session::OperationStatus, strategy::StrategyArtifact, strategy_search::*,
};
use zero_store::{Operation, Store};
fn hash(v: &Value) -> String {
    zero_web_verification::hash(v).unwrap()
}
fn config() -> StrategySearchConfiguration {
    let digest = hash(&json!("host"));
    let baseline = json!({"schema_version":1,"advisory_utf8":"Check public controls"});
    let limits = json!({"model_micro_usd":100,"model_calls":20,"http_requests":10,"http_request_body_bytes":1000,"http_response_decoded_bytes":1000,"experiments":2,"runs":16,"max_parallel_runs":1});
    let providers = json!({"p":{"endpoint":"http://localhost:9090/responses","wire_api":"responses","rates":{"input":1,"cached_input":1,"output":1}}});
    let policy = search_fixture_profile(
        "http://127.0.0.1:8080/",
        &serde_json::from_value(limits.clone()).unwrap(),
    )
    .unwrap();
    let authority = json!({"schema_version":1,"host":{"provider":"p","model":"m","instructions":"Host fixed","max_turns":2,"reservation_per_turn":10,"max_hypotheses":2},"provider_context":providers,"http_profile_name":"runtime","http_policy":policy,"campaign_limits":limits,"accepted_suite_sha256":[digest],"minimum_development_gain":1,"minimum_final_gain":1,"canary_required":true});
    let expiry = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 600000;
    serde_json::from_value(json!({"kind":"strategy_search","schema_version":1,"capture":{"registry":{"schema_version":1,"registry_id":"00000000-0000-4000-8000-000000000001","genesis_sha256":digest},"generation":digest,"epoch":1,"state_sha256":digest,"advisory_sha256":hash(&baseline),"advisory":baseline,"host_policy_sha256":digest,"authority":authority},"plan":{"schema_version":1,"objective":"Improve control checks","proposer":{"provider":"p","model":"proposer","instructions":"Propose bounded advice","reservation_micro_usd":60,"max_output_tokens":1000},"scenarios":[{"id":"positive","family":"p","lane":"development","public_task":"Inspect resource","resource_path":"/secret","control_path":"/control","marker":"PRIVATE_positive_123456","positive":true},{"id":"negative","family":"n","lane":"development","public_task":"Inspect control","resource_path":"/resource","control_path":"/control","marker":"PRIVATE_negative_123456","positive":false}],"repeats":2,"max_proposals":4,"max_candidates":3,"limits":limits,"expires_at_ms":expiry,"minimum_development_gain":1},"proposer_context":providers["p"]})).unwrap()
}
struct F {
    dir: tempfile::TempDir,
    store: Store,
    c: Campaign,
    cfg: StrategySearchConfiguration,
    controller: Operation,
}
impl F {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("db")).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let cfg = config();
        let c = store.create_strategy_search("create", &cfg).unwrap().0;
        let controller=store.admit_owned_batch(&c.journal_session_id,"owner",&[(format!("strategy-search:{}",c.id),json!({"kind":"strategy_search","campaign_id":c.id,"controller_plan_sha256":c.plan.controller_plan_sha256}))]).unwrap().remove(0);
        Self {
            dir,
            store,
            c,
            cfg,
            controller,
        }
    }
    fn first(&mut self) -> (SearchProposal, Operation) {
        let request = render_search_proposal(&self.cfg, 0, None).unwrap();
        let (p, o, duplicate) = self
            .store
            .admit_search_proposal(&self.c.id, "owner", 0, &request, None)
            .unwrap();
        assert!(!duplicate);
        (p, o)
    }
    fn finish(&mut self, p: &SearchProposal, o: &Operation, text: &str, charge: u64) {
        self.store
            .settle_budget(&p.session_id, &o.id, charge)
            .unwrap();
        self.store.settle_operation(&o.id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","response_id":"r","content":[{"type":"tool_call","id":"call","name":"submit_strategy_proposal","arguments":{"action":"propose","advisory":{"schema_version":1,"advisory_utf8":text},"rationale":"Check controls"}}],"usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0},"usage_is_final":true,"replay":[],"error":null})).unwrap();
    }
    fn feedback(&mut self, p: &SearchProposal) -> (Value, String) {
        let v = json!({"schema_version":1,"kind":"strategy_search_development_feedback","campaign_id":self.c.id,"config_sha256":self.c.plan.controller_plan_sha256,"prior_attempts":1,"proposals":[{"attempt_index":0,"operation_id":p.operation_id}],"evaluations":[]});
        let bytes = serde_json::to_vec(&v).unwrap();
        let digest = self
            .store
            .retain_operation_artifact(&self.controller.id, "owner", "search.feedback.1", &bytes)
            .unwrap();
        (v, digest)
    }
}
#[test]
fn proposal_uses_same_account_atomic_reservation_and_no_budget_reset() {
    let mut f = F::new();
    let (p, o) = f.first();
    assert_eq!(
        f.store
            .campaign(&f.c.id)
            .unwrap()
            .usage
            .model_reserved_micro_usd,
        60
    );
    assert_eq!(f.store.budget(&p.session_id).unwrap().reserved, 60);
    f.finish(&p, &o, "Candidate", 50);
    let (v, d) = f.feedback(&p);
    let request = render_search_proposal(&f.cfg, 1, Some(v)).unwrap();
    assert!(matches!(
        f.store
            .admit_search_proposal(&f.c.id, "owner", 1, &request, Some(&d)),
        Err(zero_store::Error::BudgetExceeded)
    ));
    assert_eq!(f.store.search_proposals(&f.c.id).unwrap().len(), 1);
    let sql = rusqlite::Connection::open(f.dir.path().join("db")).unwrap();
    let n: u64 = sql
        .query_row(
            "SELECT count(*) FROM sessions WHERE generation LIKE 'strategy-proposal:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
    assert_eq!(
        f.store
            .campaign(&f.c.id)
            .unwrap()
            .usage
            .model_charged_micro_usd,
        50
    );
}
#[test]
fn proposal_recovery_retry_and_public_admission_fail_closed() {
    let mut f = F::new();
    let (p, o) = f.first();
    assert!(
        f.store
            .admit_owned_batch(
                &p.session_id,
                "owner",
                &[("attack".into(), json!({"kind":"inference"}))]
            )
            .is_err()
    );
    assert!(
        f.store
            .reconcile_budget(&p.session_id, &o.id, 0, "guess")
            .is_err()
    );
    f.store.claim_engine_epoch("next").unwrap();
    assert_eq!(
        f.store.search_snapshot(&f.c.id).unwrap().unknown_proposals,
        1
    );
    let request = render_search_proposal(&f.cfg, 0, None).unwrap();
    let (_, prior, duplicate) = f
        .store
        .admit_search_proposal(&f.c.id, "next", 0, &request, None)
        .unwrap();
    assert!(duplicate);
    assert_eq!(prior.status, OperationStatus::Unknown);
    assert_eq!(
        f.store
            .campaign(&f.c.id)
            .unwrap()
            .usage
            .model_reserved_micro_usd,
        60
    );
}
#[test]
fn deleted_projection_and_search_marker_cannot_escape_membership() {
    let mut f = F::new();
    let (p, _) = f.first();
    let sql = rusqlite::Connection::open(f.dir.path().join("db")).unwrap();
    sql.execute("DELETE FROM strategy_search_proposals", [])
        .unwrap();
    assert!(f.store.search_snapshot(&f.c.id).is_err());
    assert!(
        f.store
            .admit_owned_batch(
                &p.session_id,
                "owner",
                &[("escape".into(), json!({"kind":"inference"}))]
            )
            .is_err()
    );
    sql.execute("DELETE FROM strategy_searches", []).unwrap();
    assert!(
        f.store
            .admit_owned_batch(
                &f.c.journal_session_id,
                "owner",
                &[("escape".into(), json!({"kind":"inference"}))]
            )
            .is_err()
    );
}
#[test]
fn candidate_pair_records_bind_actual_proposal_and_global_slots() {
    let mut f = F::new();
    assert!(
        f.store
            .create_campaign_exposure(
                &f.c.id,
                "forbidden-final",
                &hash(&json!("suite")),
                &hash(&json!("pair")),
                &hash(&json!("candidate"))
            )
            .is_err()
    );
    let (p, o) = f.first();
    f.finish(&p, &o, "Candidate A", 1);
    let advice = StrategyArtifact {
        schema_version: 1,
        advisory_utf8: "Candidate A".into(),
    };
    let e = f
        .store
        .register_search_evaluation(
            &f.c.id,
            "pair-a",
            &p.id,
            &hash(&json!("generation-a")),
            &advice,
        )
        .unwrap()
        .0;
    assert_eq!(e.schedule_start, 0);
    assert_eq!(e.run_count, 8);
    assert!(
        f.store
            .register_search_evaluation(
                &f.c.id,
                "pair-b",
                &p.id,
                &hash(&json!("generation-b")),
                &StrategyArtifact {
                    schema_version: 1,
                    advisory_utf8: "Forged candidate".into()
                }
            )
            .is_err()
    );
    assert_eq!(
        f.store
            .search_candidates(&f.c.id, 0, 1)
            .unwrap()
            .candidates
            .len(),
        1
    );
    let mut altered = f.cfg.clone();
    altered.plan.scenarios[0].lane = CampaignLane::Final;
    assert!(altered.plan.validate().is_err());
}
#[test]
fn changing_candidates_share_account_and_global_schedule() {
    let mut f = F::new();
    let (p, o) = f.first();
    f.finish(&p, &o, "Candidate A", 1);
    let a = StrategyArtifact {
        schema_version: 1,
        advisory_utf8: "Candidate A".into(),
    };
    let e = f
        .store
        .register_search_evaluation(&f.c.id, "pair-a", &p.id, &hash(&json!("generation-a")), &a)
        .unwrap()
        .0;
    let (feedback, digest) = f.feedback(&p);
    let request = render_search_proposal(&f.cfg, 1, Some(feedback.clone())).unwrap();
    assert!(
        f.store
            .admit_search_proposal(&f.c.id, "owner", 1, &request, Some(&digest))
            .is_err()
    );
    for index in 0..e.run_count {
        let repeat = index / 4;
        let scenario = &f.cfg.plan.scenarios[((index % 4) / 2) as usize];
        let variant = if (index % 2 == 0) == (repeat % 2 == 0) {
            CampaignVariant::Baseline
        } else {
            CampaignVariant::Candidate
        };
        let origin = "http://127.0.0.1:8080";
        let profile = format!("strategy_search_{}_{}", f.c.id, index);
        let request = zero_protocol::strategy_registry::render_strategy_request(
            &f.cfg.capture.authority.host,
            if variant == CampaignVariant::Baseline {
                &f.cfg.capture.advisory
            } else {
                &a
            },
            &scenario.public_task,
            &profile,
            None,
        )
        .unwrap();
        let spec = CampaignRunSpec {
            candidate_sha256: e.candidate_sha256.clone(),
            suite_sha256: hash(&serde_json::to_value(&f.cfg.plan.scenarios).unwrap()),
            evaluation_pair_sha256: e.evaluation_pair_sha256.clone(),
            schedule_index: index,
            lane: CampaignLane::Development,
            scenario_id: scenario.id.clone(),
            repeat_index: repeat,
            variant,
            fixture_origin: origin.into(),
            request,
            provider_context: f.cfg.capture.authority.provider_context.clone(),
            http_policy: zero_http::normalize_policy(
                search_fixture_profile(origin, &f.cfg.plan.limits).unwrap(),
            )
            .unwrap(),
            exposure_id: None,
        };
        if index == 0 {
            let mut forged = spec.clone();
            forged.request.instructions = "wider authority".into();
            assert!(
                f.store
                    .create_campaign_run(&f.c.id, "forged", &forged, "owner")
                    .is_err()
            );
        }
        let run = f
            .store
            .create_search_evaluation_run(&e.id, &format!("run-{index}"), &spec, "owner")
            .unwrap()
            .0;
        f.store
            .settle_campaign_run_without_root(
                &f.c.id,
                &run.id,
                "owner",
                CampaignRunStatus::Failed,
                "fixture deliberately does not start actor",
            )
            .unwrap();
    }
    let (p2, o2, duplicate) = f
        .store
        .admit_search_proposal(&f.c.id, "owner", 1, &request, Some(&digest))
        .unwrap();
    assert!(!duplicate);
    f.finish(&p2, &o2, "Candidate B", 1);
    let b = StrategyArtifact {
        schema_version: 1,
        advisory_utf8: "Candidate B".into(),
    };
    let e2 = f
        .store
        .register_search_evaluation(&f.c.id, "pair-b", &p2.id, &hash(&json!("generation-b")), &b)
        .unwrap()
        .0;
    assert_eq!(e2.schedule_start, 8);
    assert_eq!(e2.campaign_id, e.campaign_id);
    let snapshot = f.store.search_snapshot(&f.c.id).unwrap();
    assert_eq!(snapshot.campaign.usage.model_calls, 2);
    assert_eq!(snapshot.campaign.usage.model_charged_micro_usd, 2);
    assert_eq!(snapshot.candidates, 2);
}
#[test]
fn durable_stop_prevents_another_proposal() {
    let mut f = F::new();
    let (p, o) = f.first();
    f.store.settle_budget(&p.session_id, &o.id, 1).unwrap();
    f.store.settle_operation(&o.id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","response_id":"r","content":[{"type":"tool_call","id":"call","name":"submit_strategy_proposal","arguments":{"action":"stop","reason":"No further change"}}],"usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0},"usage_is_final":true,"replay":[],"error":null})).unwrap();
    let (v, d) = f.feedback(&p);
    let request = render_search_proposal(&f.cfg, 1, Some(v)).unwrap();
    let error = f
        .store
        .admit_search_proposal(&f.c.id, "owner", 1, &request, Some(&d))
        .unwrap_err();
    assert!(error.to_string().contains("already stopped"));
    assert_eq!(
        f.store.search_snapshot(&f.c.id).unwrap().proposal_attempts,
        1
    );
}
#[test]
fn whole_search_read_preflight_rejects_small_budget_before_report_reads() {
    let mut f = F::new();
    f.first();
    let mut too_small = 1;
    assert!(
        f.store
            .search_evidence_preflight(&f.c.id, &mut too_small)
            .is_err()
    );
    assert_eq!(too_small, 1);
    let mut budget = 64 * 1024 * 1024;
    f.store
        .search_evidence_preflight(&f.c.id, &mut budget)
        .unwrap();
    assert!(budget < 64 * 1024 * 1024);
    assert_eq!(
        f.store.search_snapshot(&f.c.id).unwrap().active_proposals,
        1
    );
}

#[test]
fn unwitnessed_protected_exposure_is_not_hidden_by_search_status() {
    let f = F::new();
    let sql = rusqlite::Connection::open(f.dir.path().join("db")).unwrap();
    sql.execute(
        "INSERT INTO campaign_exposures VALUES('forged',?1,'final',?2,?3,'{}',1)",
        rusqlite::params![f.c.id, hash(&json!("suite")), hash(&json!("pair"))],
    )
    .unwrap();
    assert!(f.store.search_configuration(&f.c.id).is_err());
    assert!(f.store.search_snapshot(&f.c.id).is_err());
}
