#![allow(dead_code)]
#[path = "../strategy/mod.rs"]
mod campaign;
pub use campaign::*;
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf};
use zero_evolution::{Manifest, Registry};
use zero_harness::{Harness, HostGrants};
use zero_protocol::{campaign::CampaignLane, strategy_registry::*};
pub fn canonical(v: &impl serde::Serialize) -> Vec<u8> {
    serde_json::to_vec(&serde_json::to_value(v).unwrap()).unwrap()
}
pub fn digest(v: &impl serde::Serialize) -> String {
    format!("sha256:{}", zero_plugin::sha256(&canonical(v)))
}
pub struct Bound {
    pub setup: Setup,
    pub registry: PathBuf,
    pub grants: HostGrants,
    pub authority: StrategyHostAuthority,
    pub manifest: Manifest,
    pub candidate: String,
    pub capture: StrategyCapture,
}
impl Bound {
    pub fn new(http: &Http) -> (Self, Harness) {
        Self::with_setup(Setup::new(), http)
    }
    pub fn with_setup(setup: Setup, http: &Http) -> (Self, Harness) {
        let mut finals: Vec<_> = setup
            .plan
            .scenarios
            .iter()
            .filter(|s| s.lane == CampaignLane::Final)
            .collect();
        finals.sort_by(|a, b| a.id.cmp(&b.id));
        let suite = digest(&json!({"version":"local_web_marker_v1","scenarios":finals}));
        let policy=zero_http::normalize_policy(serde_json::from_value(json!({"schema_version":1,"base_url":"http://127.0.0.1:1/","in_scope":["127.0.0.1"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["GET","POST"],"allowed_headers":[],"limits":{"timeout_ms":5000,"max_request_body_bytes":1048576,"max_response_wire_bytes":16777216,"max_response_decoded_bytes":16777216,"max_request_header_bytes":65536,"max_request_headers":128,"max_response_header_bytes":65536,"max_response_headers":128,"max_dns_answers":64,"max_dns_cname_depth":8,"max_dns_queries":16},"rate":{"default":{"requests_per_interval":100,"interval_ms":1000,"burst":20},"per_host":{},"jitter_ms":0},"budget":{"max_requests":20,"max_request_body_bytes":1048576,"max_response_decoded_bytes":67108864}})).unwrap()).unwrap();
        let authority:StrategyHostAuthority=serde_json::from_value(json!({"schema_version":1,"host":setup.plan.host,"provider_context":{"fixture":{"endpoint":http.url,"wire_api":"responses","rates":{"input":1000000,"cached_input":1000000,"output":1000000}}},"http_profile_name":"runtime","http_policy":policy,"campaign_limits":setup.plan.limits,"accepted_suite_sha256":[suite],"minimum_development_gain":1,"minimum_final_gain":1,"canary_required":false})).unwrap();
        let grants = HostGrants::with_strategy(BTreeMap::new(), authority.clone()).unwrap();
        let registry = setup.dir.path().join("registry.db");
        let mut r = Registry::open(&registry, "v1", &json!({"host_state":1})).unwrap();
        let engine = r.put_artifact(b"native-engine-strategy-fixture").unwrap();
        let policy = r.put_artifact(&grants.artifact_bytes().unwrap()).unwrap();
        let advice = r.put_artifact(&canonical(&setup.plan.baseline)).unwrap();
        let manifest = Manifest {
            engine_artifact: engine.clone(),
            components: BTreeMap::from([("strategy:advisory".into(), advice)]),
            protocol_version: 1,
            state_schema: "v1".into(),
            compatible_state_schemas: vec![],
            configuration: strategy_configuration(),
            policy_artifact: policy,
        };
        let mut harness = Harness::new(r, engine);
        harness
            .bootstrap_strategy("bootstrap", &manifest, &grants, "explicit fixture baseline")
            .unwrap();
        let candidate = harness
            .register_strategy_candidate(
                &harness.current().unwrap().generation.unwrap(),
                &setup.plan.candidate,
            )
            .unwrap()
            .candidate_generation;
        let capture = harness.strategy_capture().unwrap();
        (
            Self {
                setup,
                registry,
                grants,
                authority,
                manifest,
                candidate,
                capture,
            },
            harness,
        )
    }
    pub fn restored(&self) -> Harness {
        let mut h = Harness::new(
            Registry::open(&self.registry, "ignored", &json!({})).unwrap(),
            self.manifest.engine_artifact.clone(),
        );
        h.restore_current(&self.grants).unwrap();
        h
    }
    pub fn configure(&self, engine: &zero_engine::Engine, http: &Http, harness: Harness) {
        http.configure(engine);
        engine
            .configure_http(
                "runtime",
                zero_http::Client::new(self.authority.http_policy.clone(), None).unwrap(),
            )
            .unwrap();
        engine.configure_strategy(harness).unwrap();
    }
    pub async fn create(&self, engine: &zero_engine::Engine) -> String {
        match command(
            engine,
            zero_protocol::Command::CreateBoundStrategyCampaign {
                command_id: "bound-create".into(),
                plan: Box::new(self.setup.plan.clone()),
                candidate_generation: self.candidate.clone(),
            },
        )
        .await
        {
            zero_protocol::Reply::StrategyCampaignCreated { campaign, .. } => campaign.campaign.id,
            r => panic!("bound create: {r:?}"),
        }
    }
}
