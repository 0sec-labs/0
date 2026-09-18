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
            plan: Box::new(final_plan(f)),
        },
    )
    .await
    {
        Reply::StrategySearchCreated { snapshot, .. } => snapshot.campaign.campaign.id,
        v => panic!("{v:?}"),
    }
}
#[tokio::test]
async fn explicit_selector_measures_final_and_imports_complete_prior_history() {
    let mut provider = Http::new().await;
    let (f, harness) = setup(&provider);
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
    assert_eq!(report.schema_version, 2);
    assert_eq!(report.qualification, "adaptive_search_fixture");
    assert_eq!(report.proposals.len(), 3);
    assert_eq!(report.evaluations.len(), 2);
    assert!(!report.evaluations[0].improved);
    assert_eq!(
        report.final_measurement.as_ref().unwrap().decision,
        StrategyDecision::ImprovedForFixtureSuite
    );
    assert_eq!(report.usage.model_calls, 35);
    assert_eq!(report.usage.runs, 24);
    assert_eq!(report.usage.http_requests, 8);
    assert_eq!(report.usage.model_reserved_micro_usd, 0);
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
    let first = &report.proposals[0].proposal;
    sql.execute(
        "DELETE FROM strategy_search_proposals WHERE id=?1",
        [&first.id],
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
    provider.quiet().await;
    assert_eq!(provider.count(), 35);
}
#[tokio::test]
async fn stop_is_not_permission_to_expose_final() {
    let mut provider = Http::new().await;
    let (f, harness) = setup(&provider);
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
async fn cancelled_final_keeps_selection_exposure_and_hold_without_retry() {
    let mut provider = Http::new().await;
    let (f, harness) = setup(&provider);
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
        if incoming.body["tools"][0]["name"]=="submit_strategy_proposal"{let args=if !proposed{proposed=true;json!({"action":"propose","advisory":f.setup.plan.candidate,"rationale":"Inspect actual evidence."})}else{let input:Value=serde_json::from_str(incoming.body["input"][0]["content"][0]["text"].as_str().unwrap()).unwrap();json!({"action":"select_final","evaluation_id":input["development_feedback"]["evaluations"][0]["evaluation_id"],"rationale":"Commit this improved candidate."})};incoming.finish(json!([tool("action","submit_strategy_proposal",args)])).await;}else{let sql=rusqlite::Connection::open(f.setup.path()).unwrap();let selected:bool=sql.query_row("SELECT EXISTS(SELECT 1 FROM strategy_search_selections WHERE campaign_id=?1)",[&id],|r|r.get(0)).unwrap();drop(sql);if selected{break incoming;}respond(incoming).await;}
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
    assert_eq!(provider.count(), 15);
    restarted.shutdown().await.unwrap();
}
