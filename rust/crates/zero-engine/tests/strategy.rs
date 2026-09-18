#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "strategy/mod.rs"]
mod fixture;
use fixture::*;
use zero_protocol::{
    Command, Reply,
    campaign::{CampaignLane, CampaignRunStatus},
    strategy::StrategyDecision,
};
use zero_store::Store;
#[tokio::test]
async fn paired_real_agents_measure_gains_and_restart_without_reexecution() {
    let setup = Setup::new();
    let engine = setup.engine();
    let mut http = Http::new().await;
    http.configure(&engine);
    let id = create(&engine, &setup.plan).await;
    let development = run(engine.clone(), &mut http, &id, CampaignLane::Development).await;
    let Reply::StrategyCampaignReport { report } = development else {
        panic!("development: {development:?}")
    };
    assert_eq!(report.decision, StrategyDecision::Inconclusive);
    assert_eq!(report.completed_lanes, vec![CampaignLane::Development]);
    assert_eq!(report.case_results.len(), 8);
    assert_eq!(report.usage.runs, 8);
    let feedback = zero_engine::read_strategy_development_feedback(&setup.path(), &id).unwrap();
    assert_eq!(feedback.cases.len(), 8);
    assert!(
        feedback
            .cases
            .iter()
            .all(|r| r.lane == CampaignLane::Development)
    );
    let final_run = run(engine.clone(), &mut http, &id, CampaignLane::Final).await;
    let Reply::StrategyCampaignReport { report } = final_run else {
        panic!("final: {final_run:?}")
    };
    assert_eq!(report.decision, StrategyDecision::ImprovedForFixtureSuite);
    assert_eq!(report.qualification, "qualification_only");
    assert_eq!(report.case_results.len(), 16);
    assert_eq!(report.usage.http_requests, 8);
    assert_eq!(http.count(), 24);
    let hash = report.report_sha256;
    engine.shutdown().await.unwrap();
    drop(engine);
    let reopened = setup.engine();
    let retry = command(
        &reopened,
        Command::RunStrategyCampaign {
            campaign_id: id.clone(),
            lane: CampaignLane::Final,
        },
    )
    .await;
    let Reply::StrategyCampaignReport { report } = retry else {
        panic!("retry: {retry:?}")
    };
    assert_eq!(report.report_sha256, hash);
    assert_eq!(http.count(), 24);
    http.quiet().await;
    let duplicate = command(
        &reopened,
        Command::CreateStrategyCampaign {
            command_id: "strategy-create".into(),
            plan: Box::new(setup.plan.clone()),
        },
    )
    .await;
    assert!(matches!(
        duplicate,
        Reply::StrategyCampaignCreated {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(
        zero_engine::read_strategy_development_feedback(&setup.path(), &id)
            .unwrap()
            .cases
            .len(),
        8
    );
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancellation_drains_actor_and_keeps_unknown_usage_without_replay() {
    let setup = Setup::new();
    let engine = setup.engine();
    let mut http = Http::new().await;
    http.configure(&engine);
    let id = create(&engine, &setup.plan).await;
    let owned = engine.clone();
    let key = id.clone();
    let run = tokio::spawn(async move {
        command(
            &owned,
            Command::RunStrategyCampaign {
                campaign_id: key,
                lane: CampaignLane::Development,
            },
        )
        .await
    });
    let mut request = http.next().await;
    request.progress("owned unfinished request").await;
    let cancelled = command(
        &engine,
        Command::CancelStrategyCampaign {
            campaign_id: id.clone(),
        },
    )
    .await;
    assert!(matches!(cancelled, Reply::StrategyCampaignCancelled { .. }));
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), run)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(reply, Reply::StrategyCampaignReport { .. }),
        "{reply:?}"
    );
    let report = zero_engine::read_strategy_report(&setup.path(), &id).unwrap();
    assert_eq!(report.decision, StrategyDecision::Inconclusive);
    assert_eq!(report.usage.model_reserved_micro_usd, 5);
    assert_eq!(report.usage.active_runs, 0);
    assert_eq!(report.case_results.len(), 1);
    let store = Store::open_read_only(setup.path()).unwrap();
    let page = store.campaign_runs(&id, 0, 32).unwrap();
    assert!(matches!(
        page.runs[0].status,
        CampaignRunStatus::Cancelled | CampaignRunStatus::Unknown
    ));
    drop(store);
    engine.shutdown().await.unwrap();
    drop(engine);
    let reopened = setup.engine();
    let retry = command(
        &reopened,
        Command::RunStrategyCampaign {
            campaign_id: id,
            lane: CampaignLane::Development,
        },
    )
    .await;
    assert!(
        matches!(retry, Reply::StrategyCampaignReport { .. }),
        "{retry:?}"
    );
    assert_eq!(http.count(), 1);
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn recomputation_rejects_forged_matrix_even_with_valid_artifact_hash() {
    let setup = Setup::new();
    let engine = setup.engine();
    let mut http = Http::new().await;
    http.configure(&engine);
    let id = create(&engine, &setup.plan).await;
    let reply = run(engine.clone(), &mut http, &id, CampaignLane::Development).await;
    assert!(
        matches!(reply, Reply::StrategyCampaignReport { .. }),
        "{reply:?}"
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    let store = Store::open_read_only(setup.path()).unwrap();
    let snapshot = store.campaign(&id).unwrap();
    let op = store
        .get_operation_by_command(
            &snapshot.campaign.journal_session_id,
            &format!("strategy-evaluation:{id}:development"),
        )
        .unwrap();
    drop(store);
    let db = rusqlite::Connection::open(setup.path()).unwrap();
    db.execute(
        "UPDATE operations SET outcome=json_set(outcome,'$.matrix_sha256',?2) WHERE id=?1",
        rusqlite::params![op.id, format!("sha256:{}", "a".repeat(64))],
    )
    .unwrap();
    drop(db);
    assert!(zero_engine::read_strategy_report(&setup.path(), &id).is_err());
}

#[tokio::test]
async fn strategy_owner_death_child() {
    let Ok(path) = std::env::var("ZERO_STRATEGY_CHILD_STATE") else {
        return;
    };
    let plan = serde_json::from_slice(
        &std::fs::read(std::env::var("ZERO_STRATEGY_CHILD_PLAN").unwrap()).unwrap(),
    )
    .unwrap();
    let engine = zero_engine::Engine::open(&path, None).unwrap();
    engine
        .configure_provider(
            "fixture",
            zero_provider::ProviderClient::new(
                zero_provider::Endpoint::responses(
                    &std::env::var("ZERO_STRATEGY_CHILD_PROVIDER").unwrap(),
                    None,
                )
                .unwrap(),
                std::time::Duration::from_secs(30),
                262144,
            )
            .unwrap(),
            zero_protocol::model::Rates {
                input: 1_000_000,
                cached_input: 1_000_000,
                output: 1_000_000,
            },
        )
        .unwrap();
    let id = create(&engine, &plan).await;
    std::fs::write(std::env::var("ZERO_STRATEGY_CHILD_ID").unwrap(), &id).unwrap();
    let _ = command(
        &engine,
        Command::RunStrategyCampaign {
            campaign_id: id,
            lane: CampaignLane::Development,
        },
    )
    .await;
    panic!("parent should terminate owner while provider is held");
}
#[tokio::test]
async fn actual_owner_death_preserves_run_exposure_and_unknown_holds() {
    let setup = Setup::new();
    let mut http = Http::new().await;
    let plan = setup.dir.path().join("plan.json");
    let idfile = setup.dir.path().join("id");
    std::fs::write(&plan, serde_json::to_vec(&setup.plan).unwrap()).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "strategy_owner_death_child", "--nocapture"])
        .env("ZERO_STRATEGY_CHILD_STATE", setup.path())
        .env("ZERO_STRATEGY_CHILD_PLAN", &plan)
        .env("ZERO_STRATEGY_CHILD_ID", &idfile)
        .env("ZERO_STRATEGY_CHILD_PROVIDER", &http.url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let incoming = tokio::time::timeout(std::time::Duration::from_secs(8), http.next()).await;
    if incoming.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("child never dispatched");
    }
    let mut incoming = incoming.unwrap();
    incoming.progress("partial before process death").await;
    let id = std::fs::read_to_string(idfile).unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    let engine = setup.engine();
    let report = zero_engine::read_strategy_report(&setup.path(), &id).unwrap();
    assert_eq!(report.decision, StrategyDecision::Inconclusive);
    assert_eq!(report.usage.runs, 1);
    assert_eq!(report.usage.model_reserved_micro_usd, 5);
    assert_eq!(report.usage.unknown_runs, 1);
    let retry = command(
        &engine,
        Command::RunStrategyCampaign {
            campaign_id: id,
            lane: CampaignLane::Development,
        },
    )
    .await;
    assert!(
        matches!(retry, Reply::StrategyCampaignReport { .. }),
        "{retry:?}"
    );
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn private_expectations_cannot_leak_through_renderer_or_development_response() {
    let setup = Setup::new();
    let engine = setup.engine();
    let http = Http::new().await;
    http.configure(&engine);
    for (index, mut plan) in [(0, setup.plan.clone()), (1, setup.plan.clone())] {
        plan.host.instructions = "Use scoped tools.".into();
        plan.baseline.advisory_utf8 = "Stop.".into();
        plan.candidate.advisory_utf8 = "Inspect.".into();
        for scenario in &mut plan.scenarios {
            scenario.public_task = "Check resource.".into();
        }
        if index == 0 {
            plan.scenarios[2].marker = "investigation".into();
        } else {
            plan.scenarios[0].marker = "prefix-protectedTOKEN-suffix".into();
            plan.scenarios[2].marker = "protectedTOKEN".into();
        }
        assert!(
            plan.validate().is_ok(),
            "compiled check must cover what simple supplied-string validation cannot"
        );
        let reply = command(
            &engine,
            Command::CreateStrategyCampaign {
                command_id: format!("bad-{index}"),
                plan: Box::new(plan),
            },
        )
        .await;
        assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
    }
    assert_eq!(http.count(), 0);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn joined_experiments_share_campaign_http_and_experiment_quotas() {
    use serde_json::{Value, json};
    let mut setup = Setup::new();
    setup.plan.limits.experiments = 2;
    setup.plan.limits.http_requests = 8;
    setup.plan.host.web_experiment_policy =
        Some(zero_protocol::web_experiment::WebExperimentPolicy {
            schema_version: 1,
            max_experiments: 4,
            max_cases: 2,
            max_repeats: 2,
        });
    setup.plan.host.delegation_policy=Some(serde_json::from_value(json!({"max_parallel":1,"max_children":1,"roles":[{"name":"investigator","provider":"fixture","model":"child","instructions":"Choose a bounded experiment.","description":"Investigate the fixture","tools":["http_request","run_web_experiment"],"max_turns":2,"reservation_per_turn":5}]})).unwrap());
    let engine = setup.engine();
    let mut http = Http::new().await;
    http.configure(&engine);
    let id = create(&engine, &setup.plan).await;
    let owned = engine.clone();
    let key = id.clone();
    let mut task = tokio::spawn(async move {
        command(
            &owned,
            Command::RunStrategyCampaign {
                campaign_id: key,
                lane: CampaignLane::Development,
            },
        )
        .await
    });
    let mut admitted = 0;
    let mut rejected = 0;
    let reply = loop {
        tokio::select! {reply=&mut task=>break reply.unwrap(),incoming=http.next()=>{
         if incoming.body["model"]=="child"{
          if let Some(raw)=incoming.body["input"].as_array().unwrap().iter().rev().find(|v|v["type"]=="function_call_output").and_then(|v|v["output"].as_str()){
           if raw.starts_with("Tool rejected:"){rejected+=1;incoming.answer("null").await;}else{let value:Value=serde_json::from_str(raw).unwrap();assert_eq!(value["vulnerability_reportable"],false);admitted+=1;let observation=value["observations"][0].clone();incoming.answer(&observation.to_string()).await;}
          }else{
           let digest=|s:&str|format!("sha256:{}",zero_plugin::sha256(s.as_bytes()));let proposal=json!({"hypothesis":{"title":"Resource conjecture","explanation":"Compare resource to control; predictions are provisional"},"purpose":"Measure resource and control","repeats":2,"cases":[{"name":"resource","role":"attack","request":{"url":"/resource","method":"GET"},"expected":{"status":200,"body_sha256":digest("fixture resource: no private data")}},{"name":"control","role":"legitimate_control","request":{"url":"/control","method":"GET"},"expected":{"status":200,"body_sha256":digest("fixture control: public data only")}}]});incoming.finish(json!([tool("experiment","run_web_experiment",proposal)])).await;
          }
         }else if let Some(group)=output(&incoming.body){
          let observation:Value=serde_json::from_str(group["children"][0]["text"].as_str().unwrap()).unwrap();let text=observation["body_preview"].as_str().unwrap_or("");let claims=if text.contains("PRIVATE_FIXTURE_"){json!([{"title":"Fixture disclosure","category":"fixture_disclosure","explanation":"Retained experiment response discloses private data.","claimed_impact":"Fixture data visible.","claimed_severity":"low","citations":[{"operation_id":observation["operation_id"],"response_manifest_sha256":observation["response_manifest_sha256"],"part":{"type":"body","offset":0,"length":text.len()}}]}])}else{json!([])};incoming.finish(json!([tool("submit","submit_web_hypotheses",json!({"hypotheses":claims}))])).await;
         }else if incoming.body["instructions"].as_str().unwrap_or("").contains("CANDIDATE:"){incoming.finish(json!([tool("delegate","delegate_tasks",json!({"tasks":[{"role":"investigator","prompt":"Investigate the resource and control."}]}))])).await;}else{respond(incoming).await;}
        }}
    };
    let Reply::StrategyCampaignReport { report } = reply else {
        panic!("campaign: {reply:?}")
    };
    assert_eq!(report.case_results.len(), 8);
    assert_eq!(admitted, 2);
    assert_eq!(rejected, 2);
    assert_eq!(report.usage.experiments, 2);
    assert_eq!(report.usage.http_requests, 8);
    assert_eq!(report.usage.model_calls, 20);
    assert_eq!(report.usage.model_reserved_micro_usd, 0);
    assert_eq!(report.usage.http_response_reserved_bytes, 0);
    assert!(
        report
            .case_results
            .iter()
            .any(|r| r.supported_findings == 1)
    );
    let rows = Store::open_read_only(setup.path())
        .unwrap()
        .campaign_runs(&id, 0, 32)
        .unwrap();
    assert_eq!(rows.runs.len(), 8);
    assert!(
        rows.runs
            .iter()
            .all(|r| r.status == CampaignRunStatus::Succeeded)
    );
    engine.shutdown().await.unwrap();
}
