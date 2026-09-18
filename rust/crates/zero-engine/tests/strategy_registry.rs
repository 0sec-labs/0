#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "strategy_registry/mod.rs"]
mod fixture;
use fixture::*;
use serde_json::json;
use zero_protocol::{
    Command, Reply, campaign::CampaignLane, strategy_registry::StrategyImportRequest,
};
#[tokio::test]
async fn bound_real_measurement_exports_imports_reassesses_and_retries_without_source() {
    let mut provider = Http::new().await;
    let (f, harness) = Bound::new(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let id = f.create(&engine).await;
    assert!(zero_engine::export_strategy_evidence(&f.setup.path(), &id).is_err());
    run(
        engine.clone(),
        &mut provider,
        &id,
        CampaignLane::Development,
    )
    .await;
    assert!(zero_engine::export_strategy_evidence(&f.setup.path(), &id).is_err());
    let result = run(engine.clone(), &mut provider, &id, CampaignLane::Final).await;
    assert!(
        matches!(result, Reply::StrategyCampaignReport { .. }),
        "{result:?}"
    );
    let evidence = zero_engine::export_strategy_evidence(&f.setup.path(), &id).unwrap();
    assert_eq!(evidence.report().usage.http_requests, 8);
    let rechecked = zero_engine::reassess_strategy_evidence(evidence.manifest_bytes(), |sha| {
        Ok(evidence.blobs()[sha].clone())
    })
    .unwrap();
    assert_eq!(rechecked.evidence_sha256(), evidence.evidence_sha256());
    let prepared =
        zero_engine::prepare_strategy_eligibility(&f.setup.path(), &f.registry, &id).unwrap();
    assert_eq!(prepared.evidence_sha256, evidence.evidence_sha256());
    let request = StrategyImportRequest {
        command_id: "measured-import".into(),
        campaign_id: id,
        expected_evidence_sha256: prepared.evidence_sha256,
    };
    let imported =
        zero_engine::import_strategy_eligibility(&f.setup.path(), &f.registry, &request).unwrap();
    assert!(!imported.duplicate);
    assert_eq!(imported.receipt.candidate_generation, f.candidate);
    let registry = zero_evolution::Registry::open_read_only(&f.registry).unwrap();
    assert_eq!(
        registry.current().unwrap().generation.as_deref(),
        Some(f.capture.generation.as_str())
    );
    drop(registry);
    engine.shutdown().await.unwrap();
    drop(engine);
    std::fs::remove_file(f.setup.path()).unwrap();
    let retry =
        zero_engine::import_strategy_eligibility(&f.setup.path(), &f.registry, &request).unwrap();
    assert!(retry.duplicate);
    assert_eq!(canonical(&retry.receipt), canonical(&imported.receipt));
    let receipt_hash = digest(&imported.receipt);
    let shown = zero_engine::read_strategy_eligibility_receipt(&f.registry, &receipt_hash).unwrap();
    assert_eq!(shown.receipt.evidence_sha256, evidence.evidence_sha256());
    provider.quiet().await;
    assert_eq!(provider.count(), 24);
}
#[tokio::test]
async fn explicit_session_uses_real_advisory_and_inert_retry_without_configuration() {
    let mut provider = Http::new().await;
    let (f, harness) = Bound::new(&provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let session = engine.create_strategy_session(100).unwrap();
    let captured = zero_engine::read_strategy_session(&f.setup.path(), &session.id).unwrap();
    assert_eq!(captured.advisory_sha256, f.capture.advisory_sha256);
    let command_value = Command::RunStrategyAgent {
        session_id: session.id.clone(),
        command_id: "advisory-run".into(),
        prompt: "Investigate using captured host advice".into(),
        continuation_of: None,
    };
    let e = engine.clone();
    let c = command_value.clone();
    let task = tokio::spawn(async move { command(&e, c).await });
    let incoming = provider.next().await;
    assert!(
        incoming.body["instructions"]
            .as_str()
            .unwrap()
            .contains(&f.setup.plan.baseline.advisory_utf8)
    );
    assert!(
        !incoming.body["instructions"]
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
    let first = task.await.unwrap();
    assert!(
        matches!(
            first,
            Reply::Agent {
                duplicate: false,
                ..
            }
        ),
        "{first:?}"
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    let reopened = f.setup.engine();
    let retry = command(&reopened, command_value).await;
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
    provider.quiet().await;
    assert_eq!(provider.count(), 1);
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn delegated_strategy_actor_keeps_parent_capture_and_exact_role_authority() {
    let mut provider = Http::new().await;
    let mut setup = Setup::new();
    setup.plan.host.delegation_policy=Some(serde_json::from_value(json!({"max_parallel":1,"max_children":1,"roles":[{"name":"investigator","provider":"fixture","model":"fixture-model","description":"Inspect scoped observations","instructions":"Consider useful observations independently.","tools":["http_request"],"max_turns":1,"reservation_per_turn":5}]})).unwrap());
    let (f, harness) = Bound::with_setup(setup, &provider);
    let engine = f.setup.engine();
    f.configure(&engine, &provider, harness);
    let session = engine.create_strategy_session(100).unwrap();
    let e = engine.clone();
    let id = session.id.clone();
    let task = tokio::spawn(async move {
        command(
            &e,
            Command::RunStrategyAgent {
                session_id: id,
                command_id: "joined".into(),
                prompt: "Decide whether another investigator would help".into(),
                continuation_of: None,
            },
        )
        .await
    });
    provider.next().await.finish(json!([tool("delegate","delegate_tasks",json!({"tasks":[{"role":"investigator","prompt":"Inspect independently within captured scope"}]}))])).await;
    let child = provider.next().await;
    assert!(
        child.body["instructions"]
            .as_str()
            .unwrap()
            .contains(&f.setup.plan.baseline.advisory_utf8)
    );
    assert!(
        child.body["instructions"]
            .as_str()
            .unwrap()
            .contains("Host-defined delegated role investigator")
    );
    child.finish(json!([{"type":"message","role":"assistant","content":[{"type":"output_text","text":"No claim is supported by available observations."}]}])).await;
    let parent = provider.next().await;
    assert!(
        parent.body["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["type"] == "function_call_output")
    );
    parent
        .finish(json!([tool(
            "submit",
            "submit_web_hypotheses",
            json!({"hypotheses":[]})
        )]))
        .await;
    let result = task.await.unwrap();
    assert!(
        matches!(
            result,
            Reply::Agent {
                duplicate: false,
                ..
            }
        ),
        "{result:?}"
    );
    let store = zero_store::Store::open_read_only(f.setup.path()).unwrap();
    let events = store.events(&session.id, 0, 100).unwrap();
    let actors: Vec<_> = events
        .iter()
        .filter(|e| {
            e.kind == "command_admitted" && e.payload["payload"]["kind"] == "scoped_web_agent"
        })
        .collect();
    assert_eq!(actors.len(), 2);
    assert_eq!(
        actors[0].payload["payload"]["strategy_context"],
        actors[1].payload["payload"]["strategy_context"]
    );
    assert_eq!(provider.count(), 3);
    engine.shutdown().await.unwrap();
}
