#[path = "strategy/mod.rs"]
mod fixture;
use fixture::*;
use zero_protocol::{Command, Reply, campaign::CampaignLane};

#[tokio::test]
async fn final_cannot_precede_development_or_be_reopened_by_changing_development() {
    let setup = Setup::new();
    let engine = setup.engine();
    let mut http = Http::new().await;
    http.configure(&engine);
    let id = create(&engine, &setup.plan).await;
    let early = command(
        &engine,
        Command::RunStrategyCampaign {
            campaign_id: id.clone(),
            lane: CampaignLane::Final,
        },
    )
    .await;
    assert!(matches!(early, Reply::Error { .. }), "{early:?}");
    assert_eq!(http.count(), 0);
    let development = run(engine.clone(), &mut http, &id, CampaignLane::Development).await;
    assert!(
        matches!(development, Reply::StrategyCampaignReport { .. }),
        "{development:?}"
    );
    let feedback = zero_engine::read_strategy_development_feedback(&setup.path(), &id).unwrap();
    let encoded = serde_json::to_string(&feedback).unwrap();
    assert!(!encoded.contains("final-positive"));
    assert!(!encoded.contains("PRIVATE_FIXTURE_"));
    assert!(
        feedback
            .cases
            .iter()
            .all(|case| case.lane == CampaignLane::Development)
    );
    let final_reply = run(engine.clone(), &mut http, &id, CampaignLane::Final).await;
    assert!(
        matches!(final_reply, Reply::StrategyCampaignReport { .. }),
        "{final_reply:?}"
    );
    let mut changed = setup.plan.clone();
    changed
        .candidate
        .advisory_utf8
        .push_str(" Different candidate.");
    changed.scenarios.reverse();
    for scenario in &mut changed.scenarios {
        if scenario.lane == CampaignLane::Development {
            scenario.public_task.push_str(" Revised development task.");
        }
    }
    let created = command(
        &engine,
        Command::CreateStrategyCampaign {
            command_id: "different-campaign".into(),
            plan: Box::new(changed),
        },
    )
    .await;
    let Reply::StrategyCampaignCreated { campaign, .. } = created else {
        panic!("{created:?}")
    };
    let other = campaign.campaign.id;
    let development = run(engine.clone(), &mut http, &other, CampaignLane::Development).await;
    assert!(
        matches!(development, Reply::StrategyCampaignReport { .. }),
        "{development:?}"
    );
    let before = http.count();
    let rejected = command(
        &engine,
        Command::RunStrategyCampaign {
            campaign_id: other,
            lane: CampaignLane::Final,
        },
    )
    .await;
    // Rejection can be a durable inconclusive report; neither path may dispatch an actor.
    assert!(
        matches!(
            rejected,
            Reply::Error { .. } | Reply::StrategyCampaignReport { .. }
        ),
        "{rejected:?}"
    );
    if let Reply::StrategyCampaignReport { report } = &rejected {
        assert_eq!(
            report.decision,
            zero_protocol::strategy::StrategyDecision::Inconclusive
        );
        assert!(!report.completed_lanes.contains(&CampaignLane::Final));
    }
    let database = rusqlite::Connection::open(setup.path()).unwrap();
    let exposures: u64 = database
        .query_row("SELECT count(*) FROM campaign_exposures", [], |r| r.get(0))
        .unwrap();
    assert_eq!(exposures, 1);
    drop(database);
    assert_eq!(http.count(), before);
    http.quiet().await;
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn changed_provider_price_is_rejected_before_any_actor_dispatch() {
    let setup = Setup::new();
    let engine = setup.engine();
    let mut http = Http::new().await;
    http.configure(&engine);
    let id = create(&engine, &setup.plan).await;
    engine.shutdown().await.unwrap();
    drop(engine);
    let reopened = setup.engine();
    http.configure_rates(&reopened, 2_000_000);
    let reply = command(
        &reopened,
        Command::RunStrategyCampaign {
            campaign_id: id.clone(),
            lane: CampaignLane::Development,
        },
    )
    .await;
    assert!(
        matches!(&reply, Reply::Error { message, .. } if message.contains("price changed")),
        "{reply:?}"
    );
    assert_eq!(http.count(), 0);
    assert_eq!(
        zero_engine::read_campaign_status(&setup.path(), &id)
            .unwrap()
            .usage
            .runs,
        0
    );
    http.quiet().await;
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn public_inference_cannot_escape_campaign_session_or_controller_accounting() {
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
    let store = zero_store::Store::open_read_only(setup.path()).unwrap();
    let snapshot = store.campaign(&id).unwrap();
    let page = store.campaign_runs(&id, 0, 32).unwrap();
    let sessions = [
        snapshot.campaign.journal_session_id,
        page.runs[0].session_id.clone(),
    ];
    drop(store);
    let before = http.count();
    for session_id in sessions {
        let reply = command(
            &engine,
            Command::Infer {
                session_id,
                command_id: "unauthorized-extra-inference".into(),
                provider: "fixture".into(),
                request: zero_protocol::model::ResponsesRequest {
                    model: "fixture-model".into(),
                    instructions: "Extra work".into(),
                    input: vec![serde_json::json!({"role":"user","content":"Continue"})],
                    tools: vec![],
                    max_output_tokens: 16,
                },
                reservation: 1,
            },
        )
        .await;
        assert!(
            matches!(&reply, Reply::Error { message, .. } if message.contains("campaign")),
            "{reply:?}"
        );
    }
    assert_eq!(http.count(), before);
    http.quiet().await;
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn actor_cannot_dispatch_to_another_port_on_the_fixture_host() {
    let setup = Setup::new();
    let engine = setup.engine();
    let mut http = Http::new().await;
    http.configure(&engine);
    let sentinel = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let outside = format!("http://{}/resource", sentinel.local_addr().unwrap());
    let id = create(&engine, &setup.plan).await;
    let owned = engine.clone();
    let key = id.clone();
    let task = tokio::spawn(async move {
        command(
            &owned,
            Command::RunStrategyCampaign {
                campaign_id: key,
                lane: CampaignLane::Development,
            },
        )
        .await
    });
    http.next()
        .await
        .finish(serde_json::json!([tool(
            "outside",
            "http_request",
            serde_json::json!({"url":outside,"method":"GET"})
        )]))
        .await;
    let held = http.next().await;
    let response = output(&held.body).expect("rejected tool output");
    assert_eq!(response["disposition"], "rejected", "{response}");
    assert_eq!(response["error"], "accounting", "{response}");
    let cancelled = command(
        &engine,
        Command::CancelStrategyCampaign {
            campaign_id: id.clone(),
        },
    )
    .await;
    assert!(
        matches!(cancelled, Reply::StrategyCampaignCancelled { .. }),
        "{cancelled:?}"
    );
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(reply, Reply::StrategyCampaignReport { .. }),
        "{reply:?}"
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(80), sentinel.accept())
            .await
            .is_err()
    );
    assert_eq!(
        zero_engine::read_campaign_status(&setup.path(), &id)
            .unwrap()
            .usage
            .http_requests,
        0
    );
    drop(held);
    engine.shutdown().await.unwrap();
}
