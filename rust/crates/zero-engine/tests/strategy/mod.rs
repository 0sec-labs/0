#![allow(dead_code)]
#[path = "../delegation/mod.rs"]
mod provider;
pub use provider::{Http, Incoming, tool};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::mpsc;
use zero_engine::Engine;
use zero_protocol::{
    Command, ExecutionEvent, Reply, campaign::CampaignLane, strategy::StrategyPlan,
};
pub struct Setup {
    pub dir: tempfile::TempDir,
    pub plan: StrategyPlan,
}
impl Setup {
    pub fn new() -> Self {
        let scenarios:Vec<_>=[("dev-positive","dev-p","development",true),("dev-negative","dev-n","development",false),("final-positive","final-p","final",true),("final-negative","final-n","final",false)].into_iter().map(|(id,family,lane,positive)|json!({"id":id,"family":family,"lane":lane,"public_task":"Investigate the resource and control. Submit supported fixture_disclosure claims or an empty review when none is supported.","resource_path":"/resource","control_path":"/control","marker":format!("PRIVATE_FIXTURE_{id}_VALUE"),"positive":positive})).collect();
        let plan=serde_json::from_value(json!({"schema_version":1,"renderer_version":"strategy_advisory_v1","oracle_version":"local_web_marker_v1","baseline":{"schema_version":1,"advisory_utf8":"BASELINE: stop without requests and submit no hypotheses."},"candidate":{"schema_version":1,"advisory_utf8":"CANDIDATE: inspect the resource and cite retained evidence when it discloses a private fixture value."},"host":{"provider":"fixture","model":"fixture-model","instructions":"Use only the offered tools within host authority.","max_turns":3,"reservation_per_turn":5,"max_hypotheses":2},"scenarios":scenarios,"repeats":2,"limits":{"model_micro_usd":1000,"model_calls":128,"http_requests":128,"http_request_body_bytes":1048576,"http_response_decoded_bytes":16777216,"experiments":16,"runs":16,"max_parallel_runs":1},"expires_at_ms":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64+120000,"minimum_development_gain":1,"minimum_final_gain":1})).unwrap();
        Self {
            dir: tempfile::tempdir().unwrap(),
            plan,
        }
    }
    pub fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("state.db")
    }
    pub fn engine(&self) -> Arc<Engine> {
        Arc::new(Engine::open(self.path(), None).unwrap())
    }
}
pub async fn command(engine: &Engine, command: Command) -> Reply {
    let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(1024);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let reply = engine.handle(command, tx).await;
    drain.await.unwrap();
    reply
}
pub async fn create(engine: &Engine, plan: &StrategyPlan) -> String {
    match command(
        engine,
        Command::CreateStrategyCampaign {
            command_id: "strategy-create".into(),
            plan: Box::new(plan.clone()),
        },
    )
    .await
    {
        Reply::StrategyCampaignCreated { campaign, .. } => campaign.campaign.id,
        r => panic!("create: {r:?}"),
    }
}
pub fn output(body: &Value) -> Option<Value> {
    body["input"]
        .as_array()?
        .iter()
        .rev()
        .find(|v| v["type"] == "function_call_output")
        .and_then(|v| serde_json::from_str(v["output"].as_str()?).ok())
}
pub async fn respond(request: Incoming) {
    if let Some(o) = output(&request.body) {
        let text = o["response"]["body_text"].as_str().expect("HTTP response");
        let claims = if text.contains("PRIVATE_FIXTURE_") {
            json!([{"title":"Fixture disclosure","category":"fixture_disclosure","explanation":"The retained resource contains a private fixture value.","claimed_impact":"Private fixture data is visible.","claimed_severity":"low","citations":[{"operation_id":o["observation"]["operation_id"],"response_manifest_sha256":o["observation"]["response_manifest_sha256"],"part":{"type":"body","offset":0,"length":text.len()}}]}])
        } else {
            json!([])
        };
        request
            .finish(json!([tool(
                "submit",
                "submit_web_hypotheses",
                json!({"hypotheses":claims})
            )]))
            .await;
    } else if request.body["instructions"]
        .as_str()
        .unwrap_or("")
        .contains("CANDIDATE:")
    {
        request
            .finish(json!([tool(
                "inspect",
                "http_request",
                json!({"url":"/resource","method":"GET"})
            )]))
            .await;
    } else {
        request
            .finish(json!([tool(
                "submit",
                "submit_web_hypotheses",
                json!({"hypotheses":[]})
            )]))
            .await;
    }
}
pub async fn run(engine: Arc<Engine>, http: &mut Http, id: &str, lane: CampaignLane) -> Reply {
    let id = id.to_owned();
    let mut task = tokio::spawn(async move {
        command(
            &engine,
            Command::RunStrategyCampaign {
                campaign_id: id,
                lane,
            },
        )
        .await
    });
    loop {
        tokio::select! {r=&mut task=>return r.unwrap(),q=http.next()=>respond(q).await}
    }
}
