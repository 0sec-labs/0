//! Host-owned advisory proposal search; Development measurements never grant eligibility.
use crate::{
    ValidationError, campaign::*, model::ResponsesRequest, session::OperationStatus, strategy::*,
    strategy_registry::StrategyCapture,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchProposer {
    pub provider: String,
    pub model: String,
    pub instructions: String,
    pub reservation_micro_usd: u64,
    pub max_output_tokens: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategySearchPlan {
    pub schema_version: u32,
    pub objective: String,
    pub proposer: SearchProposer,
    pub scenarios: Vec<StrategyScenario>,
    pub repeats: u32,
    pub max_proposals: u32,
    pub max_candidates: u32,
    pub limits: CampaignLimits,
    pub expires_at_ms: u64,
    pub minimum_development_gain: u32,
}
fn invalid(s: &str) -> ValidationError {
    ValidationError(s.into())
}
fn text(s: &str, n: usize) -> bool {
    !s.trim().is_empty() && s.len() <= n && !s.contains('\0')
}
impl StrategySearchPlan {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let p = &self.proposer;
        if self.schema_version != 1
            || !text(&self.objective, 16384)
            || !text(&p.provider, 128)
            || !text(&p.model, 256)
            || !text(&p.instructions, 32768)
            || p.reservation_micro_usd == 0
            || p.reservation_micro_usd > self.limits.model_micro_usd
            || !(1..=32768).contains(&p.max_output_tokens)
            || !(2..=8).contains(&self.scenarios.len())
            || !(2..=3).contains(&self.repeats)
            || !(1..=16).contains(&self.max_proposals)
            || self.max_candidates == 0
            || self.max_candidates > self.max_proposals
            || self.limits.max_parallel_runs != 1
            || !(1..=16).contains(&self.minimum_development_gain)
            || self.scenarios.len() as u64 * u64::from(self.repeats) * 2
                > u64::from(self.limits.runs)
        {
            return Err(invalid("unsupported bounded Development search plan"));
        }
        let placeholder = format!("sha256:{}", "0".repeat(64));
        CampaignPlan {
            schema_version: 1,
            controller_plan_sha256: placeholder.clone(),
            baseline_sha256: placeholder,
            limits: self.limits.clone(),
            expires_at_ms: self.expires_at_ms,
        }
        .validate()?;
        let mut names = BTreeSet::new();
        let mut positive = false;
        let mut negative = false;
        for s in &self.scenarios {
            if s.lane != CampaignLane::Development
                || !text(&s.id, 128)
                || !names.insert(&s.id)
                || !text(&s.family, 128)
                || !text(&s.public_task, 16384)
                || !text(&s.marker, 256)
                || s.marker.len() < 16
                || s.resource_path == s.control_path
                || [&s.resource_path, &s.control_path].iter().any(|p| {
                    !p.starts_with('/')
                        || p.len() > 256
                        || p.contains("//")
                        || !p
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-'))
                })
            {
                return Err(invalid(
                    "search scenarios require bounded Development fixture identities",
                ));
            }
            positive |= s.positive;
            negative |= !s.positive;
            if self.objective.contains(&s.marker)
                || p.instructions.contains(&s.marker)
                || self.scenarios.iter().any(|x| {
                    x.public_task.contains(&s.marker)
                        || x.resource_path.contains(&s.marker)
                        || x.control_path.contains(&s.marker)
                })
            {
                return Err(invalid(
                    "private search fixture marker appears in public input",
                ));
            }
        }
        if !positive || !negative {
            return Err(invalid(
                "search requires positive and negative Development controls",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategySearchConfiguration {
    pub kind: String,
    pub schema_version: u32,
    pub plan: StrategySearchPlan,
    pub capture: StrategyCapture,
    pub proposer_context: CampaignProviderContext,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum SearchProposalOutput {
    Propose {
        advisory: StrategyArtifact,
        rationale: String,
    },
    Stop {
        reason: String,
    },
}
impl SearchProposalOutput {
    pub fn validate(&self) -> Result<(), ValidationError> {
        match self {
            Self::Propose {
                advisory,
                rationale,
            } => {
                advisory.validate()?;
                if !text(rationale, 4096) {
                    return Err(invalid("proposal rationale exceeds bound"));
                }
            }
            Self::Stop { reason } => {
                if !text(reason, 4096) {
                    return Err(invalid("proposal stop reason exceeds bound"));
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchProposal {
    pub id: String,
    pub campaign_id: String,
    pub command_id: String,
    pub session_id: String,
    pub operation_id: String,
    pub attempt_index: u32,
    pub owner: String,
    pub request_sha256: String,
    pub feedback_sha256: Option<String>,
    pub sequence: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchEvaluation {
    pub id: String,
    pub campaign_id: String,
    pub command_id: String,
    pub proposal_id: String,
    pub candidate_generation: String,
    pub candidate_sha256: String,
    pub baseline_sha256: String,
    pub evaluation_pair_sha256: String,
    pub config_sha256: String,
    pub schedule_start: u32,
    pub run_count: u32,
    pub sequence: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchSnapshot {
    pub campaign: CampaignSnapshot,
    pub proposal_attempts: u32,
    pub candidates: u32,
    pub active_proposals: u32,
    pub unknown_proposals: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchCandidatePage {
    pub candidates: Vec<SearchEvaluation>,
    pub next_after_sequence: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchProposalResult {
    pub proposal: SearchProposal,
    pub operation_status: OperationStatus,
    pub output: Option<SearchProposalOutput>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchEvaluationReport {
    pub evaluation: SearchEvaluation,
    pub cases: Vec<StrategyCaseResult>,
    pub improved: bool,
    pub reasons: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategySearchReport {
    pub schema_version: u32,
    pub campaign_id: String,
    pub config_sha256: String,
    pub qualification: String,
    pub proposals: Vec<SearchProposalResult>,
    pub evaluations: Vec<SearchEvaluationReport>,
    pub usage: CampaignUsage,
    pub stop_reason: Option<String>,
    pub report_sha256: String,
}
/// Fixed renderer exposes public objective/advisory and authenticated Development feedback only.
pub fn render_search_proposal(
    config: &StrategySearchConfiguration,
    attempt: u32,
    feedback: Option<serde_json::Value>,
) -> Result<ResponsesRequest, ValidationError> {
    config.plan.validate()?;
    if attempt >= config.plan.max_proposals {
        return Err(invalid("proposal attempt exceeds frozen limit"));
    }
    Ok(ResponsesRequest {
        model: config.plan.proposer.model.clone(),
        instructions: format!(
            "{}\n\nCall submit_strategy_proposal exactly once with arguments: {{\"action\":\"propose\",\"advisory\":{{\"schema_version\":1,\"advisory_utf8\":\"...\"}},\"rationale\":\"...\"}} or {{\"action\":\"stop\",\"reason\":\"...\"}}. Advisory cannot change host authority or certify success.",
            config.plan.proposer.instructions
        ),
        input: vec![
            serde_json::json!({"role":"user","content":[{"type":"input_text","text":serde_json::to_string(&serde_json::json!({"objective":config.plan.objective,"baseline":config.capture.advisory,"attempt_index":attempt,"development_feedback":feedback})).map_err(|e|invalid(&e.to_string()))?}]}),
        ],
        tools: vec![search_proposal_tool()],
        max_output_tokens: config.plan.proposer.max_output_tokens,
    })
}

pub fn search_proposal_tool() -> crate::model::ToolDefinition {
    crate::model::ToolDefinition{name:"submit_strategy_proposal".into(),description:"Submit one advisory proposal or stop; this never certifies measured improvement or changes authority.".into(),parameters:serde_json::json!({"type":"object","oneOf":[{"type":"object","additionalProperties":false,"required":["action","advisory","rationale"],"properties":{"action":{"const":"propose"},"advisory":{"type":"object","additionalProperties":false,"required":["schema_version","advisory_utf8"],"properties":{"schema_version":{"const":1},"advisory_utf8":{"type":"string","minLength":1,"maxLength":32768}}},"rationale":{"type":"string","minLength":1,"maxLength":4096}}},{"type":"object","additionalProperties":false,"required":["action","reason"],"properties":{"action":{"const":"stop"},"reason":{"type":"string","minLength":1,"maxLength":4096}}}]})}
}

pub fn search_fixture_profile(
    origin: &str,
    limits: &CampaignLimits,
) -> Result<crate::http::HttpProfilePolicy, ValidationError> {
    serde_json::from_value(serde_json::json!({"schema_version":1,"base_url":origin,"in_scope":["127.0.0.1"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["GET","POST"],"allowed_headers":["content-type"],"redirect":{"mode":"manual"},"limits":{"timeout_ms":3000,"max_request_body_bytes":16384,"max_response_wire_bytes":65536,"max_response_decoded_bytes":32768,"max_request_header_bytes":16384,"max_request_headers":32,"max_response_header_bytes":16384,"max_response_headers":32,"max_dns_answers":8,"max_dns_cname_depth":4,"max_dns_queries":4},"rate":{"default":{"requests_per_interval":100,"interval_ms":1000,"burst":32},"per_host":{},"jitter_ms":0},"budget":{"max_requests":limits.http_requests.min(128),"max_request_body_bytes":limits.http_request_body_bytes.min(1048576),"max_response_decoded_bytes":limits.http_response_decoded_bytes.min(4194304)}})).map_err(|e|invalid(&e.to_string()))
}
