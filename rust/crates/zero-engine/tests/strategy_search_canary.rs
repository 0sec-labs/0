#[path = "strategy_search_final/mod.rs"]
mod fixture;
use fixture::*;
use serde_json::{Value, json};
use zero_protocol::{
    Command, Reply, strategy::StrategyDecision, strategy_registry::StrategyImportRequest,
};
async fn create(f: &Bound, engine: &zero_engine::Engine) -> String {
    match command(
        engine,
        Command::CreateStrategySearch {
            command_id: "final-search".into(),
            plan: Box::new(canary_plan(f)),
        },
    )
    .await
    {
        Reply::StrategySearchCreated { snapshot, .. } => snapshot.campaign.campaign.id,
        v => panic!("{v:?}"),
    }
}
#[tokio::test]
async fn fresh_canary_uses_original_account_and_source_proof_unlocks_guarded_activation() {
    let mut provider = Http::new().await;
    let (f, harness) = canary_setup(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let id = create(&f, &engine).await;
    let e = engine.clone();
    let c = id.clone();
    let mut task =
        tokio::spawn(
            async move { command(&e, Command::RunStrategySearch { campaign_id: c }).await },
        );
    let mut proposals = 0;
    let reply = loop {
        tokio::select! {r=&mut task=>break r.unwrap(),incoming=provider.next()=>{if incoming.body["tools"][0]["name"]=="submit_strategy_proposal"{
        let text=incoming.body["input"][0]["content"][0]["text"].as_str().unwrap();let input:Value=serde_json::from_str(text).unwrap();for s in &f.setup.plan.scenarios{assert!(!text.contains(&s.marker));}
        let args=match proposals{0=>json!({"action":"propose","advisory":{"schema_version":1,"advisory_utf8":"FIRST: stop and submit empty hypotheses."},"rationale":"Measure a conservative alternative."}),1=>{assert_eq!(input["development_feedback"]["evaluations"][0]["improved"],false);json!({"action":"propose","advisory":f.setup.plan.candidate,"rationale":"Inspect actual retained resource evidence."})},2=>{let evaluation=&input["development_feedback"]["evaluations"][1];assert_eq!(evaluation["improved"],true);json!({"action":"select_final","evaluation_id":evaluation["evaluation_id"],"rationale":"Select the independently improved candidate for protected testing."})},_=>panic!("proposal after Final selection")};proposals+=1;incoming.finish(json!([tool("action","submit_strategy_proposal",args)])).await;
        }else{respond(incoming).await;}}}
    };
    let report = match reply {
        Reply::StrategySearchReport { report } => report,
        v => panic!("{v:?}"),
    };
    assert_eq!(report.schema_version, 3);
    assert_eq!(report.qualification, "adaptive_search_fixture");
    assert_eq!(report.proposals.len(), 3);
    assert_eq!(report.evaluations.len(), 2);
    assert!(!report.evaluations[0].improved);
    assert_eq!(
        report.final_measurement.as_ref().unwrap().decision,
        StrategyDecision::ImprovedForFixtureSuite
    );
    assert_eq!(report.usage.model_calls, 47);
    assert_eq!(report.usage.runs, 32);
    assert_eq!(report.usage.http_requests, 12);
    assert_eq!(report.usage.model_reserved_micro_usd, 0);
    let canary = report.canary_measurement.as_ref().unwrap();
    assert_eq!(canary.decision, StrategyDecision::ImprovedForFixtureSuite);
    assert_eq!(canary.cases.len(), 8);
    assert!(
        canary
            .cases
            .iter()
            .all(|r| r.lane == zero_protocol::campaign::CampaignLane::Canary)
    );
    assert_eq!(
        report
            .selection
            .as_ref()
            .unwrap()
            .canary
            .as_ref()
            .unwrap()
            .schedule_start,
        24
    );
    let evidence = zero_engine::export_strategy_search_evidence(&f.setup.path(), &id).unwrap();
    assert_eq!(evidence.report().report_sha256, report.report_sha256);
    let rechecked =
        zero_engine::reassess_strategy_search_evidence(evidence.manifest_bytes(), |h| {
            Ok(evidence.blobs()[h].clone())
        })
        .unwrap();
    assert_eq!(evidence.evidence_sha256(), rechecked.evidence_sha256());
    assert!(zero_engine::export_strategy_evidence(&f.setup.path(), &id).is_err());
    let prepared =
        zero_engine::prepare_strategy_search_eligibility(&f.setup.path(), &f.registry, &id)
            .unwrap();
    let request = StrategyImportRequest {
        command_id: "complete-search".into(),
        campaign_id: id.clone(),
        expected_evidence_sha256: prepared.evidence_sha256,
    };
    let imported =
        zero_engine::import_strategy_search_eligibility(&f.setup.path(), &f.registry, &request)
            .unwrap();
    assert!(!imported.duplicate);
    assert_eq!(imported.receipt.candidate_generation, f.candidate);
    assert_eq!(
        f.restored().current().unwrap().generation.as_deref(),
        Some(f.capture.generation.as_str())
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    let sql = rusqlite::Connection::open(f.setup.path()).unwrap();
    sql.pragma_update(None, "foreign_keys", false).unwrap();
    sql.execute(
        "DELETE FROM campaign_runs WHERE campaign_id=?1 AND schedule_index=24",
        [&id],
    )
    .unwrap();
    drop(sql);
    assert!(zero_engine::export_strategy_search_evidence(&f.setup.path(), &id).is_err());
    std::fs::remove_file(f.setup.path()).unwrap();
    let retry =
        zero_engine::import_strategy_search_eligibility(&f.setup.path(), &f.registry, &request)
            .unwrap();
    assert!(retry.duplicate);
    assert_eq!(canonical(&retry.receipt), canonical(&imported.receipt));
    assert!(
        zero_engine::read_strategy_eligibility_receipt(&f.registry, &imported.receipt_sha256)
            .is_err()
    );
    let shown = zero_engine::read_strategy_search_eligibility_receipt(
        &f.registry,
        &imported.receipt_sha256,
    )
    .unwrap();
    assert_eq!(shown.receipt.evidence_sha256, evidence.evidence_sha256());
    assert_eq!(
        imported.usability,
        zero_protocol::strategy_registry::StrategyEligibilityUsability::Current
    );
    let mut host = f.restored();
    let initial = host.current().unwrap();
    let migrate = |_: &zero_evolution::Manifest, s: &zero_evolution::RuntimeState| {
        Ok(zero_evolution::PreparedState {
            state_schema: s.state_schema.clone(),
            state: s.state.clone(),
        })
    };
    let prepared = host
        .prepare_activation(
            &f.candidate,
            &imported.receipt.eligibility_sha256,
            &initial,
            &f.grants,
            migrate,
        )
        .unwrap();
    host.commit(prepared).unwrap();
    assert_eq!(host.strategy_capture().unwrap().generation, f.candidate);
    assert!(
        host.prepare_activation(
            &f.candidate,
            &imported.receipt.eligibility_sha256,
            &initial,
            &f.grants,
            migrate
        )
        .is_err()
    );
    let sql = rusqlite::Connection::open(&f.registry).unwrap();
    let baseline_eligibility: String = sql.query_row("SELECT digest FROM eligibilities WHERE json_extract(json,'$.strategy_scope.kind')='bootstrap'",[],|r|r.get(0)).unwrap();
    let active = host.current().unwrap();
    let rollback = host
        .prepare_rollback(
            &f.capture.generation,
            &baseline_eligibility,
            &active,
            &f.grants,
            migrate,
        )
        .unwrap();
    host.commit(rollback).unwrap();
    assert_eq!(
        host.strategy_capture().unwrap().generation,
        f.capture.generation
    );
    assert_eq!(host.current().unwrap().epoch, initial.epoch + 2);
    provider.quiet().await;
    assert_eq!(provider.count(), 47);
}

fn canary_setup(provider: &Http) -> (Bound, zero_harness::Harness) {
    let mut setup = Setup::new();
    setup.plan.limits.runs = 32;
    let canaries: Vec<_> = setup
        .plan
        .scenarios
        .iter()
        .filter(|s| s.lane == zero_protocol::campaign::CampaignLane::Final)
        .cloned()
        .map(|mut s| {
            s.lane = zero_protocol::campaign::CampaignLane::Canary;
            s.id = format!("canary-{}", s.id);
            s.family = format!("canary-{}", s.family);
            s.marker = format!("PRIVATE_FIXTURE_CANARY_{}", s.positive);
            s
        })
        .collect();
    setup.plan.scenarios.extend(canaries);
    Bound::with_setup(setup, provider)
}
fn canary_plan(f: &Bound) -> zero_protocol::strategy_search::StrategySearchPlan {
    let mut p = final_plan(f);
    p.schema_version = 3;
    p.protected_canary = Some(zero_protocol::strategy_search::SearchFinalPolicy {
        scenarios: f
            .setup
            .plan
            .scenarios
            .iter()
            .filter(|s| s.lane == zero_protocol::campaign::CampaignLane::Canary)
            .cloned()
            .collect(),
        repeats: 2,
        minimum_gain: 1,
    });
    p
}

#[tokio::test]
async fn stop_does_not_expose_final_or_canary() {
    let mut provider = Http::new().await;
    let (f, harness) = canary_setup(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let id = create(&f, &engine).await;
    let e = engine.clone();
    let c = id.clone();
    let task =
        tokio::spawn(
            async move { command(&e, Command::RunStrategySearch { campaign_id: c }).await },
        );
    provider
        .next()
        .await
        .finish(json!([tool(
            "stop",
            "submit_strategy_proposal",
            json!({"action":"stop","reason":"No further work is useful."})
        )]))
        .await;
    let report = match task.await.unwrap() {
        Reply::StrategySearchReport { report } => report,
        v => panic!("{v:?}"),
    };
    assert!(report.selection.is_none());
    assert!(report.final_measurement.is_none());
    assert_eq!(report.stop_reason.as_deref(), Some("model_chose_stop"));
    let sql = rusqlite::Connection::open(f.setup.path()).unwrap();
    let n: u64 = sql
        .query_row(
            "SELECT count(*) FROM campaign_exposures WHERE campaign_id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    drop(sql);
    assert!(zero_engine::export_strategy_search_evidence(&f.setup.path(), &id).is_err());
    provider.quiet().await;
    assert_eq!(provider.count(), 1);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancelled_canary_keeps_same_account_hold_without_replay() {
    let mut provider = Http::new().await;
    let (f, harness) = canary_setup(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let id = create(&f, &engine).await;
    let e = engine.clone();
    let c = id.clone();
    let mut task =
        tokio::spawn(
            async move { command(&e, Command::RunStrategySearch { campaign_id: c }).await },
        );
    let mut proposed = false;
    let held = loop {
        tokio::select! {r=&mut task=>panic!("premature {r:?}"),incoming=provider.next()=>{
        if incoming.body["tools"][0]["name"]=="submit_strategy_proposal"{let args=if !proposed{proposed=true;json!({"action":"propose","advisory":f.setup.plan.candidate,"rationale":"Inspect actual evidence."})}else{let input:Value=serde_json::from_str(incoming.body["input"][0]["content"][0]["text"].as_str().unwrap()).unwrap();json!({"action":"select_final","evaluation_id":input["development_feedback"]["evaluations"][0]["evaluation_id"],"rationale":"Commit this improved candidate."})};incoming.finish(json!([tool("action","submit_strategy_proposal",args)])).await;}else{let sql=rusqlite::Connection::open(f.setup.path()).unwrap();let selected:bool=sql.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE kind='operation_detail' AND json_extract(payload,'$.kind')='strategy_search_final_completed')",[],|r|r.get(0)).unwrap();drop(sql);if selected{break incoming;}respond(incoming).await;}
        }}
    };
    assert!(matches!(
        command(
            &engine,
            Command::CancelStrategySearch {
                campaign_id: id.clone()
            }
        )
        .await,
        Reply::StrategySearchCancelled { .. }
    ));
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    drop(held);
    let report = match reply {
        Reply::StrategySearchReport { report } => report,
        v => panic!("{v:?}"),
    };
    assert!(report.selection.is_some());
    assert_ne!(
        report.canary_measurement.as_ref().unwrap().decision,
        StrategyDecision::ImprovedForFixtureSuite
    );
    assert_eq!(
        report.final_measurement.as_ref().unwrap().decision,
        StrategyDecision::ImprovedForFixtureSuite
    );
    assert_eq!(report.usage.model_reserved_micro_usd, 5);
    assert_eq!(report.proposals.len(), 2);
    assert!(zero_engine::export_strategy_search_evidence(&f.setup.path(), &id).is_err());
    engine.shutdown().await.unwrap();
    drop(engine);
    let restarted = f.setup.engine();
    assert!(matches!(
        command(&restarted, Command::RunStrategySearch { campaign_id: id }).await,
        Reply::StrategySearchReport { .. }
    ));
    provider.quiet().await;
    assert_eq!(provider.count(), 27);
    restarted.shutdown().await.unwrap();
}

async fn one_candidate(
    f: &Bound,
    engine: &std::sync::Arc<zero_engine::Engine>,
    provider: &mut Http,
    id: &str,
    fail_final: bool,
) -> zero_protocol::strategy_search::StrategySearchReport {
    let e = engine.clone();
    let id_owned = id.to_owned();
    let mut task = tokio::spawn(async move {
        command(
            &e,
            Command::RunStrategySearch {
                campaign_id: id_owned,
            },
        )
        .await
    });
    let mut proposed = false;
    let mut selected = false;
    loop {
        tokio::select! {
            result = &mut task => return match result.unwrap() { Reply::StrategySearchReport {report} => report, r => panic!("{r:?}") },
            incoming = provider.next() => {
                if incoming.body["tools"][0]["name"] == "submit_strategy_proposal" {
                    let args = if !proposed { proposed=true; json!({"action":"propose","advisory":f.setup.plan.candidate,"rationale":"Measure a bounded candidate"}) } else {
                        assert!(!selected); selected=true;
                        let input:Value=serde_json::from_str(incoming.body["input"][0]["content"][0]["text"].as_str().unwrap()).unwrap();
                        json!({"action":"select_final","evaluation_id":input["development_feedback"]["evaluations"][0]["evaluation_id"],"rationale":"Select improved candidate"})
                    };
                    incoming.finish(json!([tool("proposal","submit_strategy_proposal",args)])).await;
                } else if fail_final && selected {
                    incoming.finish(json!([tool("empty","submit_web_hypotheses",json!({"hypotheses":[]}))])).await;
                } else { respond(incoming).await; }
            }
        }
    }
}
#[tokio::test]
async fn known_final_failure_never_dispatches_canary() {
    let mut provider = Http::new().await;
    let (f, h) = canary_setup(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, h);
    let id = create(&f, &engine).await;
    let report = one_candidate(&f, &engine, &mut provider, &id, true).await;
    assert_eq!(
        report.final_measurement.as_ref().unwrap().decision,
        StrategyDecision::NotImproved
    );
    assert!(report.canary_measurement.as_ref().unwrap().cases.is_empty());
    assert_eq!(report.usage.runs, 16);
    assert_eq!(report.usage.model_calls, 22);
    assert!(zero_engine::export_strategy_search_evidence(&f.setup.path(), &id).is_err());
    engine.shutdown().await.unwrap();
    provider.quiet().await;
}
#[tokio::test]
async fn canary_cannot_reset_original_model_allowance() {
    let mut provider = Http::new().await;
    let (f, h) = canary_setup(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, h);
    let mut p = canary_plan(&f);
    p.limits.model_micro_usd = 55;
    let id = match command(
        &engine,
        Command::CreateStrategySearch {
            command_id: "tight".into(),
            plan: Box::new(p),
        },
    )
    .await
    {
        Reply::StrategySearchCreated { snapshot, .. } => snapshot.campaign.campaign.id,
        r => panic!("{r:?}"),
    };
    let report = one_candidate(&f, &engine, &mut provider, &id, false).await;
    assert_eq!(
        report.final_measurement.as_ref().unwrap().decision,
        StrategyDecision::ImprovedForFixtureSuite
    );
    assert_ne!(
        report.canary_measurement.as_ref().unwrap().decision,
        StrategyDecision::ImprovedForFixtureSuite
    );
    assert_eq!(report.usage.model_calls, 26);
    assert_eq!(report.usage.model_charged_micro_usd, 52);
    assert_eq!(report.usage.model_reserved_micro_usd, 0);
    assert!(zero_engine::export_strategy_search_evidence(&f.setup.path(), &id).is_err());
    engine.shutdown().await.unwrap();
    provider.quiet().await;
}
#[tokio::test]
async fn canary_corpus_reuse_and_private_leaks_reject_before_campaign_admission() {
    let provider = Http::new().await;
    let (f, h) = canary_setup(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, h);
    let original = canary_plan(&f);
    for n in 0..4 {
        let mut p = original.clone();
        match n {
            0 => {
                p.protected_canary.as_mut().unwrap().scenarios[0].family =
                    p.protected_final.as_ref().unwrap().scenarios[0]
                        .family
                        .clone();
            }
            1 => {
                p.proposer
                    .instructions
                    .push_str(&p.protected_canary.as_ref().unwrap().scenarios[0].marker);
            }
            2 => {
                p.protected_final.as_mut().unwrap().scenarios[0].marker = format!(
                    "prefix{}suffix",
                    p.protected_canary.as_ref().unwrap().scenarios[0].marker
                );
            }
            _ => {
                p.limits.runs = 16;
            }
        }
        assert!(matches!(
            command(
                &engine,
                Command::CreateStrategySearch {
                    command_id: format!("bad-{n}"),
                    plan: Box::new(p)
                }
            )
            .await,
            Reply::Error { .. }
        ));
    }
    assert_eq!(provider.count(), 0);
    let sql = rusqlite::Connection::open(f.setup.path()).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM campaigns", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        0
    );
    engine.shutdown().await.unwrap();
}
