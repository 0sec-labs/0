#![allow(dead_code)]
#[path = "../strategy_search/mod.rs"]
mod search;
pub use search::*;
use zero_protocol::{
    campaign::CampaignLane,
    strategy_search::{SearchFinalPolicy, StrategySearchPlan},
};
pub fn setup(provider: &Http) -> (Bound, zero_harness::Harness) {
    let mut setup = Setup::new();
    setup.plan.limits.runs = 24;
    Bound::with_setup(setup, provider)
}
pub fn final_plan(f: &Bound) -> StrategySearchPlan {
    let mut p = plan(f);
    p.schema_version = 2;
    p.max_candidates = 2;
    p.max_proposals = 3;
    p.protected_final = Some(SearchFinalPolicy {
        scenarios: f
            .setup
            .plan
            .scenarios
            .iter()
            .filter(|s| s.lane == CampaignLane::Final)
            .cloned()
            .collect(),
        repeats: 2,
        minimum_gain: 1,
    });
    p
}
