//! Bounded actual-provider proposals and actual-agent Development measurements.
use super::*;
use zero_protocol::{
    model::{Completion, CompletionStatus, Content},
    session::{Operation, OperationStatus},
    strategy_search::*,
};
mod bridge;
mod controller;
mod evidence;
mod final_selection;
mod provenance;
pub use bridge::{
    StrategySearchEligibilityPreparation, import_strategy_search_eligibility,
    prepare_strategy_search_eligibility, read_strategy_search_eligibility,
    read_strategy_search_eligibility_receipt,
};
pub use evidence::{
    RecomputedStrategySearchEvidence, VerifiedStrategySearchEvidence,
    export_strategy_search_evidence, reassess_strategy_search_evidence,
};
fn command(id: &str) -> String {
    format!("strategy-search:{id}")
}
fn payload(c: &CampaignSnapshot) -> Value {
    json!({"kind":"strategy_search","campaign_id":c.campaign.id,"controller_plan_sha256":c.campaign.plan.controller_plan_sha256})
}
fn profile_name(id: &str, index: u32) -> String {
    format!("strategy_search_{id}_{index}")
}
fn request(
    c: &StrategySearchConfiguration,
    a: &StrategyArtifact,
    s: &StrategyScenario,
    name: &str,
) -> Result<AgentRequest, EngineError> {
    zero_protocol::strategy_registry::render_strategy_request(
        &c.capture.authority.host,
        a,
        &s.public_task,
        name,
        None,
    )
    .map_err(error)
}
fn validate(c: &StrategySearchConfiguration) -> Result<(), EngineError> {
    c.plan.validate().map_err(error)?;
    c.capture.authority.validate().map_err(error)?;
    validate_advisory(c, &c.capture.advisory)?;
    let model = serde_json::to_value(render_search_proposal(c, 0, None).map_err(error)?)?;
    if scenarios(c)
        .iter()
        .any(|s| render::has_marker(&model, &s.marker))
    {
        return Err(error("private marker appears in proposer template"));
    }
    final_selection::validate_policy(c)?;
    Ok(())
}
fn scenarios(c: &StrategySearchConfiguration) -> Vec<StrategyScenario> {
    let mut all = c.plan.scenarios.clone();
    if let Some(p) = &c.plan.protected_final {
        all.extend(p.scenarios.clone());
    }
    all
}
fn validate_advisory(
    c: &StrategySearchConfiguration,
    a: &StrategyArtifact,
) -> Result<(), EngineError> {
    render::validate_templates(&c.capture.authority.host, &[a], &scenarios(c))
}
fn parsed(
    c: &StrategySearchConfiguration,
    op: &Operation,
) -> Result<SearchProposalOutput, &'static str> {
    if op.status != OperationStatus::Succeeded {
        return Err("proposal_not_completed");
    }
    let result: Completion =
        serde_json::from_value(op.outcome.clone().ok_or("proposal_outcome_absent")?)
            .map_err(|_| "proposal_outcome_invalid")?;
    if result.status != CompletionStatus::Completed || result.error.is_some() {
        return Err("proposal_not_completed");
    }
    let calls: Vec<_> = result
        .content
        .iter()
        .filter_map(|v| {
            if let Content::ToolCall {
                name, arguments, ..
            } = v
            {
                Some((name, arguments))
            } else {
                None
            }
        })
        .collect();
    if calls.len() != 1 || calls[0].0 != "submit_strategy_proposal" {
        return Err("proposal_requires_single_native_call");
    }
    let output: SearchProposalOutput =
        serde_json::from_value(calls[0].1.clone()).map_err(|_| "proposal_arguments_invalid")?;
    output
        .validate()
        .map_err(|_| "proposal_arguments_invalid")?;
    if let SearchProposalOutput::Propose { advisory, .. } = &output {
        validate_advisory(c, advisory)
            .map_err(|_| "proposal_private_marker_or_template_invalid")?;
    }
    if matches!(&output, SearchProposalOutput::SelectFinal { .. })
        && c.plan.protected_final.is_none()
    {
        return Err("final_selection_not_authorized");
    }
    if scenarios(c).iter().any(|s| {
        render::has_marker(
            &serde_json::to_value(&output).unwrap_or(Value::Null),
            &s.marker,
        )
    }) {
        return Err("private_marker_in_proposal");
    }
    Ok(output)
}
pub fn read_strategy_search_status(path: &Path, id: &str) -> Result<SearchSnapshot, EngineError> {
    Ok(Store::open_read_only(path)?.search_snapshot(id)?)
}
pub fn read_strategy_search_candidates(
    path: &Path,
    id: &str,
    after: u64,
    limit: u32,
) -> Result<SearchCandidatePage, EngineError> {
    Ok(Store::open_read_only(path)?.search_candidates(id, after, limit)?)
}
pub fn read_strategy_search_report(
    path: &Path,
    id: &str,
) -> Result<StrategySearchReport, EngineError> {
    provenance::report(&Store::open_read_only(path)?, id)
}
pub fn read_strategy_search_candidate(
    path: &Path,
    id: &str,
    candidate: &str,
) -> Result<SearchEvaluationReport, EngineError> {
    provenance::report(&Store::open_read_only(path)?, id)?
        .evaluations
        .into_iter()
        .find(|e| e.evaluation.id == candidate)
        .ok_or_else(|| error("search candidate absent"))
}
