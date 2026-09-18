//! Actual-agent paired strategy measurements; no eligibility or activation authority.
use super::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use zero_protocol::{
    agent::{AgentRequest, AgentResult, AgentStatus},
    campaign::*,
    strategy::*,
};
mod binding;
mod bridge;
pub use bridge::{
    StrategyEligibilityPreparation, import_strategy_eligibility, prepare_strategy_eligibility,
    read_strategy_eligibility, read_strategy_eligibility_receipt,
};
mod controller;
mod evidence;
pub use evidence::{
    RecomputedStrategyEvidence, VerifiedStrategyEvidence, export_strategy_evidence,
    reassess_strategy_evidence,
};
mod fixture;
mod oracle;
mod provenance;
mod render;
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn hash(v: &impl serde::Serialize) -> Result<String, EngineError> {
    Ok(format!(
        "sha256:{}",
        zero_plugin::sha256(&serde_json::to_vec(v)?)
    ))
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    plan: StrategyPlan,
    provider_context: BTreeMap<String, CampaignProviderContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    registry_binding: Option<zero_protocol::strategy_registry::StrategyRegistryBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    registry_authority: Option<zero_protocol::strategy_registry::StrategyHostAuthority>,
}
fn feedback(store: &Store, campaign: &str) -> Result<StrategyDevelopmentFeedback, EngineError> {
    let report = evidence::snapshot_report(store, campaign)?;
    Ok(StrategyDevelopmentFeedback {
        schema_version: 1,
        campaign_id: campaign.into(),
        plan_sha256: report.plan_sha256,
        baseline_sha256: report.baseline_sha256,
        candidate_sha256: report.candidate_sha256,
        cases: report
            .case_results
            .into_iter()
            .filter(|r| r.lane == CampaignLane::Development)
            .collect(),
    })
}
pub fn read_strategy_report(path: &Path, campaign: &str) -> Result<StrategyReport, EngineError> {
    evidence::snapshot_report(&Store::open_read_only(path)?, campaign)
}
pub fn read_strategy_development_feedback(
    path: &Path,
    campaign: &str,
) -> Result<StrategyDevelopmentFeedback, EngineError> {
    feedback(&Store::open_read_only(path)?, campaign)
}
