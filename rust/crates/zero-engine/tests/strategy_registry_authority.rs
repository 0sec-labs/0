#[path = "strategy_registry/mod.rs"]
mod fixture;
use fixture::*;
use serde_json::json;
use zero_protocol::{
    Command, Reply,
    campaign::CampaignLane,
    strategy_registry::{StrategyImportRequest, render_strategy_request},
};

#[tokio::test]
async fn captured_session_rejects_raw_inference_changed_instructions_queue_and_deleted_binding() {
    let mut provider = Http::new().await;
    let (f, harness) = Bound::new(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let session = engine.create_strategy_session(100).unwrap();
    let request = render_strategy_request(
        &f.authority.host,
        &f.capture.advisory,
        "Investigate",
        &f.authority.http_profile_name,
        None,
    )
    .unwrap();
    let mut changed = request.clone();
    changed.instructions = "Use different instructions".into();
    for attempt in [
        Command::RunAgent {
            session_id: session.id.clone(),
            command_id: "changed".into(),
            request: changed,
        },
        Command::Infer {
            session_id: session.id.clone(),
            command_id: "raw".into(),
            provider: "fixture".into(),
            reservation: 5,
            request: zero_protocol::model::ResponsesRequest {
                model: "fixture-model".into(),
                instructions: "extra work".into(),
                input: vec![json!({"role":"user","content":"Continue"})],
                tools: vec![],
                max_output_tokens: 16,
            },
        },
        Command::QueueAgent {
            session_id: session.id.clone(),
            command_id: "queue".into(),
            request,
            after_input: None,
        },
    ] {
        let reply = command(&engine, attempt).await;
        assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
    }
    let sql = rusqlite::Connection::open(f.setup.path()).unwrap();
    sql.execute(
        "DELETE FROM strategy_sessions WHERE session_id=?1",
        [&session.id],
    )
    .unwrap();
    drop(sql);
    let rejected = command(
        &engine,
        Command::RunStrategyAgent {
            session_id: session.id.clone(),
            command_id: "after-deletion".into(),
            prompt: "Investigate".into(),
            continuation_of: None,
        },
    )
    .await;
    assert!(
        matches!(&rejected,Reply::Error {message,..} if message.contains("projection missing")),
        "{rejected:?}"
    );
    assert!(zero_engine::read_strategy_session(&f.setup.path(), &session.id).is_err());
    provider.quiet().await;
    assert_eq!(provider.count(), 0);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn measured_switch_preserves_owned_actor_but_rejects_stale_fresh_work_and_captures_new_advice()
 {
    let mut provider = Http::new().await;
    let (f, harness) = Bound::new(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let campaign = f.create(&engine).await;
    for lane in [CampaignLane::Development, CampaignLane::Final] {
        let reply = run(engine.clone(), &mut provider, &campaign, lane).await;
        assert!(
            matches!(reply, Reply::StrategyCampaignReport { .. }),
            "{reply:?}"
        );
    }
    let prepared =
        zero_engine::prepare_strategy_eligibility(&f.setup.path(), &f.registry, &campaign).unwrap();
    let imported = zero_engine::import_strategy_eligibility(
        &f.setup.path(),
        &f.registry,
        &StrategyImportRequest {
            command_id: "grant".into(),
            campaign_id: campaign,
            expected_evidence_sha256: prepared.evidence_sha256,
        },
    )
    .unwrap();
    let session = engine.create_strategy_session(100).unwrap();
    let initial = Command::RunStrategyAgent {
        session_id: session.id.clone(),
        command_id: "owned-before-switch".into(),
        prompt: "Investigate then stop".into(),
        continuation_of: None,
    };
    let owned = engine.clone();
    let task_command = initial.clone();
    let task = tokio::spawn(async move { command(&owned, task_command).await });
    let incoming = provider.next().await;
    assert!(
        incoming.body["instructions"]
            .as_str()
            .unwrap()
            .contains(&f.setup.plan.baseline.advisory_utf8)
    );
    let mut host = f.restored();
    let state = host.current().unwrap();
    let prepared = host
        .prepare_activation(
            &f.candidate,
            &imported.receipt.eligibility_sha256,
            &state,
            &f.grants,
            |_, state| {
                Ok(zero_evolution::PreparedState {
                    state_schema: state.state_schema.clone(),
                    state: state.state.clone(),
                })
            },
        )
        .unwrap();
    host.commit(prepared).unwrap();
    incoming
        .finish(json!([tool(
            "submit",
            "submit_web_hypotheses",
            json!({"hypotheses":[]})
        )]))
        .await;
    let reply = task.await.unwrap();
    assert!(
        matches!(&reply, Reply::Agent { result: Some(result), .. } if result.status == zero_protocol::agent::AgentStatus::Completed),
        "{reply:?}"
    );
    let old = zero_engine::read_strategy_session(&f.setup.path(), &session.id).unwrap();
    assert_eq!(old.advisory_sha256, f.capture.advisory_sha256);
    let calls = provider.count();
    let rejected = command(
        &engine,
        Command::RunStrategyAgent {
            session_id: session.id,
            command_id: "new-stale-work".into(),
            prompt: "More work".into(),
            continuation_of: None,
        },
    )
    .await;
    assert!(matches!(rejected, Reply::Error { .. }), "{rejected:?}");
    assert_eq!(provider.count(), calls);
    let retry = command(&engine, initial).await;
    assert!(
        matches!(
            retry,
            Reply::Agent {
                duplicate: true,
                ..
            }
        ),
        "{retry:?}"
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    let fresh = f.setup.engine();
    f.configure(&fresh, &provider, f.restored());
    let next = fresh.create_strategy_session(100).unwrap();
    let next_capture = zero_engine::read_strategy_session(&f.setup.path(), &next.id).unwrap();
    assert_eq!(next_capture.generation, f.candidate);
    assert_ne!(next_capture.epoch, f.capture.epoch);
    let owned = fresh.clone();
    let task = tokio::spawn(async move {
        command(
            &owned,
            Command::RunStrategyAgent {
                session_id: next.id,
                command_id: "new-advice".into(),
                prompt: "Stop after inspection planning".into(),
                continuation_of: None,
            },
        )
        .await
    });
    let incoming = provider.next().await;
    assert!(
        incoming.body["instructions"]
            .as_str()
            .unwrap()
            .contains(&f.setup.plan.candidate.advisory_utf8)
    );
    incoming
        .finish(json!([tool(
            "submit",
            "submit_web_hypotheses",
            json!({"hypotheses":[]})
        )]))
        .await;
    let reply = task.await.unwrap();
    assert!(
        matches!(&reply, Reply::Agent { result: Some(result), .. } if result.status == zero_protocol::agent::AgentStatus::Completed),
        "{reply:?}"
    );
    provider.quiet().await;
    fresh.shutdown().await.unwrap();
}
