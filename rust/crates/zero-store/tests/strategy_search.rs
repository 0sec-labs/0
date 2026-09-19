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
        Self::with_config(config())
    }
    fn with_config(cfg: StrategySearchConfiguration) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("db")).unwrap();
        store.claim_engine_epoch("owner").unwrap();
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
    retire_development(&mut f, &e, &a);
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
    // The first candidate is unsuccessful; its complete paid history and advisory
    // must remain in portable evidence after another candidate is registered.
    assert!(f.store.freeze_campaign(&f.c.id).is_err());
    let frozen = f.store.freeze_strategy_search(&f.c.id).unwrap();
    let packaged =
        zero_store::CampaignSnapshotData::from_package(frozen.manifest_bytes(), |digest| {
            Ok(frozen.blobs().get(digest).unwrap().clone())
        })
        .unwrap();
    let campaign_id = f.c.id.clone();
    drop(f);
    let restored = Store::hydrate_campaign_snapshot(&packaged).unwrap();
    assert_eq!(restored.search_evaluations(&campaign_id).unwrap().len(), 2);
    assert_eq!(restored.search_proposals(&campaign_id).unwrap().len(), 2);
    for (evaluation, advice) in [(&e, &a), (&e2, &b)] {
        assert_eq!(
            restored.artifact(&evaluation.candidate_sha256).unwrap(),
            serde_json::to_vec(&serde_json::to_value(advice).unwrap()).unwrap()
        );
    }
    assert_eq!(
        restored
            .campaign(&campaign_id)
            .unwrap()
            .usage
            .model_charged_micro_usd,
        2
    );
    assert_eq!(
        restored
            .freeze_strategy_search(&campaign_id)
            .unwrap()
            .digest(),
        packaged.digest()
    );
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

fn retire_development(f: &mut F, e: &SearchEvaluation, a: &StrategyArtifact) {
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
}

fn final_config() -> StrategySearchConfiguration {
    let mut cfg = config();
    cfg.schema_version = 2;
    cfg.plan.schema_version = 2;
    let mut scenarios = cfg.plan.scenarios.clone();
    for scenario in &mut scenarios {
        scenario.id.push_str("_final");
        scenario.family.push_str("_final");
        scenario.marker.push_str("_final");
        scenario.lane = CampaignLane::Final;
    }
    let policy = SearchFinalPolicy {
        scenarios,
        repeats: 2,
        minimum_gain: 1,
    };
    cfg.capture.authority.accepted_suite_sha256 = vec![hash(&search_final_suite_value(&policy))];
    cfg.plan.protected_final = Some(policy);
    cfg
}
#[test]
fn final_seal_is_atomic_idempotent_and_blocks_later_development() {
    sealed(false);
}
#[test]
fn canary_seal_shares_account_is_atomic_and_requires_prior_final_completion() {
    sealed(true);
}
fn sealed(canary: bool) {
    let mut cfg = final_config();
    if canary {
        cfg.schema_version = 3;
        cfg.plan.schema_version = 3;
        cfg.plan.limits.runs = 24;
        cfg.capture.authority.campaign_limits.runs = 24;
        let mut policy = cfg.plan.protected_final.clone().unwrap();
        for scenario in &mut policy.scenarios {
            scenario.lane = CampaignLane::Canary;
            scenario.id = format!("canary_{}", scenario.id);
            scenario.family = format!("canary_{}", scenario.family);
            scenario.marker = format!("CANARY_PRIVATE_MARKER_{}", scenario.positive);
        }
        cfg.capture
            .authority
            .accepted_suite_sha256
            .push(hash(&search_final_suite_value(&policy)));
        cfg.plan.protected_canary = Some(policy);
    }
    let mut f = F::with_config(cfg);
    let (p, o) = f.first();
    let advice = StrategyArtifact {
        schema_version: 1,
        advisory_utf8: "Candidate A".into(),
    };
    f.finish(&p, &o, &advice.advisory_utf8, 1);
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
    retire_development(&mut f, &e, &advice);
    // Store transaction test supplies a trusted host matrix witness. The Engine
    // physical fixtures independently reconstruct actual measured matrix rows.
    let cases: Vec<Value> = (0..e.run_count).map(|index| json!({"schedule_index":index,"run_id":"host-fixture","session_id":"host-fixture","operation_id":null,"scenario_id":"positive","family":"p","lane":"development","variant":"baseline","repeat_index":0,"disposition":"observed","matched":true,"supported_findings":0,"unsupported_claims":0,"observations":[],"model_charged_micro_usd":0,"model_reserved_micro_usd":0,"error":null})).collect();
    let matrix = f
        .store
        .retain_operation_artifact(
            &f.controller.id,
            "owner",
            &format!("search.matrix.{}", e.id),
            &serde_json::to_vec(&cases).unwrap(),
        )
        .unwrap();
    f.store
        .append_operation_event(
            &f.controller.id,
            "owner",
            "strategy_search_evaluation_completed",
            &json!({"evaluation_id":e.id,"matrix_sha256":matrix}),
        )
        .unwrap();
    let (feedback, digest) = f.feedback(&p);
    let request = render_search_proposal(&f.cfg, 1, Some(feedback)).unwrap();
    let (selector, operation, _) = f
        .store
        .admit_search_proposal(&f.c.id, "owner", 1, &request, Some(&digest))
        .unwrap();
    f.store
        .settle_budget(&selector.session_id, &operation.id, 1)
        .unwrap();
    f.store.settle_operation(&operation.id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","response_id":"s","content":[{"type":"tool_call","id":"select","name":"submit_strategy_proposal","arguments":{"action":"select_final","evaluation_id":e.id,"rationale":"Measure this candidate independently"}}],"usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0},"usage_is_final":true,"replay":[],"error":null})).unwrap();
    let capture = &f.cfg.capture;
    let binding = zero_protocol::strategy_registry::StrategyRegistryBinding {
        schema_version: 1,
        registry: capture.registry.clone(),
        baseline_generation: capture.generation.clone(),
        baseline_epoch: capture.epoch,
        baseline_state_sha256: capture.state_sha256.clone(),
        candidate_generation: e.candidate_generation.clone(),
        baseline_advisory_sha256: capture.advisory_sha256.clone(),
        candidate_advisory_sha256: e.candidate_sha256.clone(),
        host_policy_sha256: capture.host_policy_sha256.clone(),
        engine_artifact_sha256: hash(&json!("engine")),
        renderer_artifact_sha256: hash(&json!("renderer")),
        evaluator_artifact_sha256: hash(&json!("evaluator")),
    };
    let sql = rusqlite::Connection::open(f.dir.path().join("db")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_selection BEFORE INSERT ON strategy_search_selections BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
    assert!(
        f.store
            .select_search_final(&f.c.id, &selector.id, &e.id, &binding, &matrix, "owner")
            .is_err()
    );
    assert_eq!(
        sql.query_row("SELECT count(*) FROM campaign_exposures", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
    sql.execute_batch("DROP TRIGGER reject_selection;").unwrap();
    let (selected, duplicate) = f
        .store
        .select_search_final(&f.c.id, &selector.id, &e.id, &binding, &matrix, "owner")
        .unwrap();
    assert!(!duplicate);
    assert_eq!(selected.schedule_start, 8);
    if let Some(k) = &selected.canary {
        assert_eq!(k.schedule_start, 16);
        assert_eq!(k.run_count, 8);
        assert_ne!(k.suite_sha256, selected.suite_sha256);
        assert_eq!(
            sql.query_row("SELECT count(*) FROM campaign_exposures", [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            2
        );
        let raw:String=sql.query_row("SELECT record FROM campaign_runs WHERE campaign_id=?1 ORDER BY schedule_index LIMIT 1",[&f.c.id],|r|r.get(0)).unwrap();
        let mut spec: CampaignRunSpec = serde_json::from_str::<CampaignRun>(&raw).unwrap().spec;
        spec.lane = CampaignLane::Canary;
        spec.schedule_index = k.schedule_start;
        spec.suite_sha256 = k.suite_sha256.clone();
        spec.evaluation_pair_sha256 = k.pair_sha256.clone();
        spec.exposure_id = Some(k.exposure_id.clone());
        assert!(
            f.store
                .create_search_final_run(&selected.id, "premature-canary", &spec, "owner")
                .unwrap_err()
                .to_string()
                .contains("completed Final")
        );
        assert_eq!(f.store.campaign(&f.c.id).unwrap().usage.runs, 8);
    }
    let mut budget = 64 * 1024 * 1024;
    f.store
        .search_evidence_preflight(&f.c.id, &mut budget)
        .unwrap();
    let later_feedback = json!({"schema_version":1,"kind":"strategy_search_development_feedback","campaign_id":f.c.id,"config_sha256":f.c.plan.controller_plan_sha256,"prior_attempts":2,"proposals":[{"attempt_index":0,"operation_id":p.operation_id},{"attempt_index":1,"operation_id":selector.operation_id}],"evaluations":[]});
    let later_digest = f
        .store
        .retain_operation_artifact(
            &f.controller.id,
            "owner",
            "search.feedback.2",
            &serde_json::to_vec(&later_feedback).unwrap(),
        )
        .unwrap();
    let later = render_search_proposal(&f.cfg, 2, Some(later_feedback)).unwrap();
    assert!(
        f.store
            .admit_search_proposal(&f.c.id, "owner", 2, &later, Some(&later_digest))
            .unwrap_err()
            .to_string()
            .contains("sealed")
    );
    assert!(
        f.store
            .register_search_evaluation(
                &f.c.id,
                "new-pair",
                &p.id,
                &hash(&json!("another-generation")),
                &advice
            )
            .unwrap_err()
            .to_string()
            .contains("sealed")
    );
    f.store.claim_engine_epoch("next").unwrap();
    assert!(
        f.store
            .select_search_final(&f.c.id, &selector.id, &e.id, &binding, &matrix, "next")
            .unwrap()
            .1
    );
    sql.execute("DELETE FROM strategy_search_selections", [])
        .unwrap();
    assert!(f.store.search_final_selection(&f.c.id).is_err());
    assert!(f.store.search_configuration(&f.c.id).is_err());
}
#[test]
fn final_private_marker_cannot_be_in_captured_advisory() {
    let mut cfg = final_config();
    cfg.capture.advisory.advisory_utf8 = cfg.plan.protected_final.as_ref().unwrap().scenarios[0]
        .marker
        .clone();
    cfg.capture.advisory_sha256 = hash(&serde_json::to_value(&cfg.capture.advisory).unwrap());
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    assert!(
        store
            .create_strategy_search("bad", &cfg)
            .unwrap_err()
            .to_string()
            .contains("private marker")
    );
}

#[test]
fn final_private_marker_in_proposed_candidate_cannot_register_or_evaluate() {
    let mut f = F::with_config(final_config());
    let (p, o) = f.first();
    let text = f.cfg.plan.protected_final.as_ref().unwrap().scenarios[0]
        .marker
        .clone();
    f.finish(&p, &o, &text, 1);
    let advice = StrategyArtifact {
        schema_version: 1,
        advisory_utf8: text,
    };
    assert!(
        f.store
            .register_search_evaluation(
                &f.c.id,
                "leaked",
                &p.id,
                &hash(&json!("leaked-generation")),
                &advice
            )
            .is_err()
    );
    assert!(f.store.search_evaluations(&f.c.id).unwrap().is_empty());
    assert_eq!(f.store.campaign(&f.c.id).unwrap().usage.runs, 0);
    assert_eq!(f.store.campaign(&f.c.id).unwrap().usage.model_calls, 1);
}
