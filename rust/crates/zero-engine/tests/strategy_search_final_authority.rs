#[path = "strategy_search_final/mod.rs"]
mod fixture;
use fixture::*;
use serde_json::{Value, json};
use zero_protocol::{Command, Reply};

#[tokio::test]
async fn unknown_or_unimproved_selection_cannot_expose_final_or_certify_itself() {
    for unknown in [true, false] {
        let mut provider = Http::new().await;
        let (f, harness) = setup(&provider);
        let engine = f.setup.engine();
        f.configure(&engine, &provider, harness);
        let id = match command(
            &engine,
            Command::CreateStrategySearch {
                command_id: "invalid-selector".into(),
                plan: Box::new(final_plan(&f)),
            },
        )
        .await
        {
            Reply::StrategySearchCreated { snapshot, .. } => snapshot.campaign.campaign.id,
            other => panic!("{other:?}"),
        };
        let owned = engine.clone();
        let run_id = id.clone();
        let mut task = tokio::spawn(async move {
            command(
                &owned,
                Command::RunStrategySearch {
                    campaign_id: run_id,
                },
            )
            .await
        });
        let mut attempts = 0;
        let reply = loop {
            tokio::select! {
                reply = &mut task => break reply.unwrap(),
                incoming = provider.next() => {
                    if incoming.body["tools"][0]["name"] == "submit_strategy_proposal" {
                        let input: Value = serde_json::from_str(incoming.body["input"][0]["content"][0]["text"].as_str().unwrap()).unwrap();
                        let action = match attempts {
                            0 => json!({"action":"propose","advisory":{"schema_version":1,"advisory_utf8":"FIRST: stop and submit empty hypotheses."},"rationale":"Measure conservative behavior."}),
                            1 => {
                                let evaluation = &input["development_feedback"]["evaluations"][0];
                                assert_eq!(evaluation["improved"], false);
                                let chosen = if unknown { json!("unregistered-evaluation") } else { evaluation["evaluation_id"].clone() };
                                json!({"action":"select_final","evaluation_id":chosen,"rationale":"I declare this successful."})
                            },
                            2 => json!({"action":"stop","reason":"No eligible candidate."}),
                            _ => panic!("unexpected proposal"),
                        };
                        attempts += 1;
                        incoming.finish(json!([tool("choice","submit_strategy_proposal",action)])).await;
                    } else { respond(incoming).await; }
                }
            }
        };
        let report = match reply {
            Reply::StrategySearchReport { report } => report,
            other => panic!("{other:?}"),
        };
        assert_eq!(attempts, 3);
        assert_eq!(report.evaluations.len(), 1);
        assert!(!report.evaluations[0].improved);
        assert!(report.selection.is_none());
        assert!(report.final_measurement.is_none());
        assert_eq!(report.usage.model_calls, 11);
        assert_eq!(report.usage.runs, 8);
        assert_eq!(report.usage.http_requests, 0);
        assert_eq!(report.usage.model_reserved_micro_usd, 0);
        let sql = rusqlite::Connection::open(f.setup.path()).unwrap();
        let exposures: u64 = sql
            .query_row("SELECT count(*) FROM campaign_exposures", [], |r| r.get(0))
            .unwrap();
        assert_eq!(exposures, 0);
        drop(sql);
        assert!(zero_engine::export_strategy_search_evidence(&f.setup.path(), &id).is_err());
        assert_eq!(
            f.restored().current().unwrap().generation.as_deref(),
            Some(f.capture.generation.as_str())
        );
        engine.shutdown().await.unwrap();
        provider.quiet().await;
    }
}
