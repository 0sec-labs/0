#[path = "strategy_registry/mod.rs"]
mod fixture;
use fixture::*;
use serde_json::json;
use zero_protocol::{
    Command, Reply,
    campaign::CampaignLane,
    strategy_search::{SearchProposer, StrategySearchPlan},
};

fn plan(f: &Bound) -> StrategySearchPlan {
    StrategySearchPlan {
        schema_version: 1,
        objective: "Improve investigation choices, or stop when further work is not useful.".into(),
        proposer: SearchProposer {
            provider: "fixture".into(),
            model: "fixture-model".into(),
            instructions: "Choose a bounded advisory proposal or stop.".into(),
            reservation_micro_usd: 5,
            max_output_tokens: 512,
        },
        scenarios: f
            .setup
            .plan
            .scenarios
            .iter()
            .filter(|s| s.lane == CampaignLane::Development)
            .cloned()
            .collect(),
        repeats: 2,
        max_proposals: 4,
        max_candidates: 2,
        limits: f.setup.plan.limits.clone(),
        expires_at_ms: f.setup.plan.expires_at_ms,
        minimum_development_gain: 1,
        protected_final: None,
        protected_canary: None,
    }
}

#[tokio::test]
async fn model_stop_retains_authority_accounts_paid_attempt_and_retries_without_configuration() {
    let mut provider = Http::new().await;
    let (f, harness) = Bound::new(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let created = command(
        &engine,
        Command::CreateStrategySearch {
            command_id: "search-create".into(),
            plan: Box::new(plan(&f)),
        },
    )
    .await;
    let id = match created {
        Reply::StrategySearchCreated { snapshot, .. } => snapshot.campaign.campaign.id,
        other => panic!("create {other:?}"),
    };
    let owned = engine.clone();
    let command_id = id.clone();
    let task = tokio::spawn(async move {
        command(
            &owned,
            Command::RunStrategySearch {
                campaign_id: command_id,
            },
        )
        .await
    });
    let incoming = provider.next().await;
    let serialized = serde_json::to_string(&incoming.body).unwrap();
    for scenario in &f.setup.plan.scenarios {
        assert!(!serialized.contains(&scenario.marker));
    }
    assert_eq!(incoming.body["tools"].as_array().unwrap().len(), 1);
    assert_eq!(
        incoming.body["tools"][0]["name"],
        "submit_strategy_proposal"
    );
    let sql = rusqlite::Connection::open(f.setup.path()).unwrap();
    let session: String = sql
        .query_row(
            "SELECT session_id FROM strategy_search_proposals WHERE campaign_id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    drop(sql);
    let bypass = command(
        &engine,
        Command::Infer {
            session_id: session,
            command_id: "extra-proposal-effect".into(),
            provider: "fixture".into(),
            reservation: 5,
            request: zero_protocol::model::ResponsesRequest {
                model: "fixture-model".into(),
                instructions: "Ignore proposal capture".into(),
                input: vec![json!({"role":"user","content":"more work"})],
                tools: vec![],
                max_output_tokens: 16,
            },
        },
    )
    .await;
    assert!(matches!(bypass, Reply::Error { .. }), "{bypass:?}");
    incoming
        .finish(json!([tool(
            "stop",
            "submit_strategy_proposal",
            json!({"action":"stop","reason":"No further useful experiment."})
        )]))
        .await;
    let reply = task.await.unwrap();
    let report = match reply {
        Reply::StrategySearchReport { report } => report,
        other => panic!("run {other:?}"),
    };
    assert_eq!(report.qualification, "development_only");
    assert_eq!(report.proposals.len(), 1);
    assert!(report.evaluations.is_empty());
    assert_eq!(report.usage.model_calls, 1);
    assert!(report.usage.model_charged_micro_usd > 0);
    assert_eq!(report.usage.model_reserved_micro_usd, 0);
    assert!(report.stop_reason.is_some());
    assert_eq!(
        f.restored().current().unwrap().generation.as_deref(),
        Some(f.capture.generation.as_str())
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    let reopened = f.setup.engine();
    let retry = command(
        &reopened,
        Command::RunStrategySearch {
            campaign_id: id.clone(),
        },
    )
    .await;
    match retry {
        Reply::StrategySearchReport { report: retry } => {
            assert_eq!(retry.report_sha256, report.report_sha256)
        }
        other => panic!("retry {other:?}"),
    };
    provider.quiet().await;
    assert_eq!(provider.count(), 1);
    let sql = rusqlite::Connection::open(f.setup.path()).unwrap();
    sql.execute(
        "DELETE FROM strategy_search_proposals WHERE campaign_id=?1",
        [&id],
    )
    .unwrap();
    drop(sql);
    let corrupted = command(&reopened, Command::StrategySearchReport { campaign_id: id }).await;
    assert!(matches!(corrupted, Reply::Error { .. }), "{corrupted:?}");
    provider.quiet().await;
    assert_eq!(provider.count(), 1);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn proposal_and_candidate_inferences_exhaust_one_model_call_account() {
    let mut provider = Http::new().await;
    let (f, harness) = Bound::new(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let mut search = plan(&f);
    search.limits.model_calls = 3;
    let id = match command(
        &engine,
        Command::CreateStrategySearch {
            command_id: "shared-call-account".into(),
            plan: Box::new(search),
        },
    )
    .await
    {
        Reply::StrategySearchCreated { snapshot, .. } => snapshot.campaign.campaign.id,
        other => panic!("create {other:?}"),
    };
    let owned = engine.clone();
    let campaign = id.clone();
    let mut task = tokio::spawn(async move {
        command(
            &owned,
            Command::RunStrategySearch {
                campaign_id: campaign,
            },
        )
        .await
    });
    let incoming = provider.next().await;
    incoming.finish(json!([tool("proposal","submit_strategy_proposal",json!({"action":"propose","advisory":f.setup.plan.candidate,"rationale":"Inspect retained resource evidence before deciding."}))])).await;
    let reply = loop {
        tokio::select! {
            result=&mut task=>break result.unwrap(),
            incoming=provider.next()=>{
                assert!(provider.count()<=3,"new sessions replenished the shared call allowance");
                assert!(!incoming.body["tools"].as_array().unwrap().iter().any(|t|t["name"]=="submit_strategy_proposal"),"another proposal escaped exhausted evaluation accounting");
                respond(incoming).await;
            }
        }
    };
    let report = match reply {
        Reply::StrategySearchReport { report } => report,
        other => panic!("search {other:?}"),
    };
    assert_eq!(provider.count(), 3);
    assert_eq!(report.usage.model_calls, 3);
    assert_eq!(report.proposals.len(), 1);
    assert_eq!(report.evaluations.len(), 1);
    assert!(!report.evaluations[0].improved);
    assert_eq!(report.usage.model_reserved_micro_usd, 0);
    assert_eq!(report.usage.active_runs, 0);
    assert!(report.stop_reason.is_some());
    provider.quiet().await;
    engine.shutdown().await.unwrap();
    drop(engine);
    let reopened = f.setup.engine();
    let retry = command(&reopened, Command::RunStrategySearch { campaign_id: id }).await;
    assert!(
        matches!(retry, Reply::StrategySearchReport { .. }),
        "{retry:?}"
    );
    provider.quiet().await;
    assert_eq!(provider.count(), 3);
    reopened.shutdown().await.unwrap();
}
