#[path = "strategy_search/mod.rs"]
mod strategy_search;
use serde_json::{Value, json};
use strategy_search::*;
use zero_protocol::{Command, Reply};
#[tokio::test]
async fn proposer_revises_from_real_feedback_then_stops_and_offline_report_recomputes() {
    let mut provider = Http::new().await;
    let (f, harness) = Bound::new(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let id = match command(
        &engine,
        Command::CreateStrategySearch {
            command_id: "adaptive".into(),
            plan: Box::new(plan(&f)),
        },
    )
    .await
    {
        Reply::StrategySearchCreated { snapshot, .. } => snapshot.campaign.campaign.id,
        v => panic!("{v:?}"),
    };
    let e = engine.clone();
    let c = id.clone();
    let mut task =
        tokio::spawn(
            async move { command(&e, Command::RunStrategySearch { campaign_id: c }).await },
        );
    let mut proposals = 0;
    let reply = loop {
        tokio::select! {r=&mut task=>break r.unwrap(),incoming=provider.next()=>{
         if incoming.body["tools"][0]["name"]=="submit_strategy_proposal"{
          let text=incoming.body["input"][0]["content"][0]["text"].as_str().unwrap();let input:Value=serde_json::from_str(text).unwrap();
          for s in &f.setup.plan.scenarios{assert!(!text.contains(&s.marker));}
          let args=match proposals{0=>{assert!(input["development_feedback"].is_null());json!({"action":"propose","advisory":{"schema_version":1,"advisory_utf8":"FIRST: stop without requests and submit an empty review."},"rationale":"Measure a conservative alternative."})},1=>{assert_eq!(input["development_feedback"]["evaluations"][0]["improved"],false);assert_eq!(input["development_feedback"]["evaluations"][0]["cases"].as_array().unwrap().len(),8);json!({"action":"propose","advisory":f.setup.plan.candidate,"rationale":"Prior missed positives; inspect and cite actual resource evidence."})},2=>{assert_eq!(input["development_feedback"]["evaluations"][1]["improved"],true);json!({"action":"stop","reason":"The observed Development gain is enough for this search."})},_=>panic!("unexpected additional proposal")};proposals+=1;incoming.finish(json!([tool("proposal","submit_strategy_proposal",args)])).await;
         }else{respond(incoming).await;}
        }}
    };
    let report = match reply {
        Reply::StrategySearchReport { report } => report,
        v => panic!("{v:?}"),
    };
    assert_eq!(proposals, 3);
    assert_eq!(report.proposals.len(), 3);
    assert_eq!(report.evaluations.len(), 2);
    assert!(!report.evaluations[0].improved);
    assert!(report.evaluations[1].improved);
    assert_eq!(report.usage.model_calls, 23);
    assert_eq!(report.usage.http_requests, 4);
    assert_eq!(report.usage.runs, 16);
    assert_eq!(report.usage.model_reserved_micro_usd, 0);
    assert_eq!(report.stop_reason.as_deref(), Some("model_chose_stop"));
    assert_eq!(report.qualification, "development_only");
    assert_eq!(
        f.restored().current().unwrap().generation.as_deref(),
        Some(f.capture.generation.as_str())
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    let loaded = zero_engine::read_strategy_search_report(&f.setup.path(), &id).unwrap();
    assert_eq!(report.report_sha256, loaded.report_sha256);
    let restarted = f.setup.engine();
    match command(
        &restarted,
        Command::RunStrategySearch {
            campaign_id: id.clone(),
        },
    )
    .await
    {
        Reply::StrategySearchReport { report: cached } => {
            assert_eq!(cached.report_sha256, report.report_sha256)
        }
        v => panic!("{v:?}"),
    };
    provider.quiet().await;
    assert_eq!(provider.count(), 23);
    restarted.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(f.setup.path()).unwrap();
    sql.execute("UPDATE operations SET outcome=json_set(outcome,'$.content[0].arguments.hypotheses',json('[]')) WHERE id=?1",[report.evaluations[1].cases.iter().find(|r|r.supported_findings==1).unwrap().operation_id.as_ref().unwrap()]).unwrap();
    assert!(zero_engine::read_strategy_search_report(&f.setup.path(), &id).is_err());
    provider.quiet().await;
}
#[tokio::test]
async fn cancelled_owned_proposer_retains_hold_and_never_replays() {
    let mut provider = Http::new().await;
    let (f, harness) = Bound::new(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let id = match command(
        &engine,
        Command::CreateStrategySearch {
            command_id: "cancel".into(),
            plan: Box::new(plan(&f)),
        },
    )
    .await
    {
        Reply::StrategySearchCreated { snapshot, .. } => snapshot.campaign.campaign.id,
        v => panic!("{v:?}"),
    };
    let e = engine.clone();
    let c = id.clone();
    let task =
        tokio::spawn(
            async move { command(&e, Command::RunStrategySearch { campaign_id: c }).await },
        );
    let incoming = provider.next().await;
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
    drop(incoming);
    let report = match reply {
        Reply::StrategySearchReport { report } => report,
        v => panic!("{v:?}"),
    };
    assert_eq!(report.proposals.len(), 1);
    assert!(report.evaluations.is_empty());
    assert_eq!(report.usage.model_calls, 1);
    assert_eq!(report.usage.model_reserved_micro_usd, 5);
    engine.shutdown().await.unwrap();
    drop(engine);
    let reopened = f.setup.engine();
    assert!(matches!(
        command(
            &reopened,
            Command::RunStrategySearch {
                campaign_id: id.clone()
            }
        )
        .await,
        Reply::StrategySearchReport { .. }
    ));
    provider.quiet().await;
    assert_eq!(provider.count(), 1);
    let sql = rusqlite::Connection::open(f.setup.path()).unwrap();
    assert_eq!(sql.execute("DELETE FROM events WHERE session_id=(SELECT journal_session_id FROM campaigns WHERE id=?1) AND kind='operation_unknown'",[&id]).unwrap(),1);
    drop(sql);
    let rejected = command(&reopened, Command::RunStrategySearch { campaign_id: id }).await;
    assert!(matches!(rejected, Reply::Error { .. }), "{rejected:?}");
    provider.quiet().await;
    assert_eq!(provider.count(), 1);
    reopened.shutdown().await.unwrap();
}
