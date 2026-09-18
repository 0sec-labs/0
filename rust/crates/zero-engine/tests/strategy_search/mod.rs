#![allow(dead_code)]
#[path = "../strategy_registry/mod.rs"]
mod bound;
pub use bound::*;
use zero_protocol::{
    campaign::CampaignLane,
    strategy_search::{SearchProposer, StrategySearchPlan},
};
pub fn plan(f: &Bound) -> StrategySearchPlan {
    StrategySearchPlan {
        schema_version: 1,
        objective: "Improve investigation choices, or stop when work is not useful.".into(),
        proposer: SearchProposer {
            provider: "fixture".into(),
            model: "fixture-model".into(),
            instructions: "Choose an advisory or stop from measured Development feedback.".into(),
            reservation_micro_usd: 5,
            max_output_tokens: 1024,
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
        max_candidates: 3,
        limits: f.setup.plan.limits.clone(),
        expires_at_ms: f.setup.plan.expires_at_ms,
        minimum_development_gain: 1,
    }
}
