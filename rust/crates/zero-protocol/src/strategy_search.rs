//! Host-owned advisory proposal search; Development measurements never grant eligibility.
use crate::{
    ValidationError,
    campaign::*,
    model::ResponsesRequest,
    session::OperationStatus,
    strategy::*,
    strategy_registry::{StrategyCapture, StrategyRegistryBinding},
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protected_final: Option<SearchFinalPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protected_canary: Option<SearchFinalPolicy>,
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
        if !matches!(
            (
                self.schema_version,
                self.protected_final.is_some(),
                self.protected_canary.is_some()
            ),
            (1, false, false) | (2, true, false) | (3, true, true)
        ) || !text(&self.objective, 16384)
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
        if let Some(final_policy) = &self.protected_final {
            let mut final_plan = self.clone();
            final_plan.schema_version = 1;
            final_plan.protected_final = None;
            final_plan.protected_canary = None;
            final_plan.scenarios = final_policy.scenarios.clone();
            final_plan.repeats = final_policy.repeats;
            final_plan.minimum_development_gain = final_policy.minimum_gain;
            for s in &mut final_plan.scenarios {
                if s.lane != CampaignLane::Final {
                    return Err(invalid("protected search scenarios must be Final"));
                }
                s.lane = CampaignLane::Development;
            }
            final_plan.validate()?;
            if self.scenarios.len() as u32 * self.repeats * 2
                + final_policy.scenarios.len() as u32 * final_policy.repeats * 2
                > self.limits.runs
            {
                return Err(invalid(
                    "one Development and Final pair must fit aggregate slots",
                ));
            }
            for f in &final_policy.scenarios {
                if self.scenarios.iter().any(|d| {
                    d.id == f.id
                        || d.family == f.family
                        || d.marker == f.marker
                        || d.public_task.contains(&f.marker)
                        || d.resource_path.contains(&f.marker)
                        || d.control_path.contains(&f.marker)
                }) {
                    return Err(invalid(
                        "protected corpus overlaps Development or public inputs",
                    ));
                }
            }
        }
        if let Some(canary) = &self.protected_canary {
            let mut check = self.clone();
            check.schema_version = 1;
            check.protected_final = None;
            check.protected_canary = None;
            check.scenarios = canary.scenarios.clone();
            check.repeats = canary.repeats;
            check.minimum_development_gain = canary.minimum_gain;
            for s in &mut check.scenarios {
                if s.lane != CampaignLane::Canary {
                    return Err(invalid("canary scenarios must have Canary lane"));
                }
                s.lane = CampaignLane::Development;
            }
            check.validate()?;
            let prior: Vec<_> = self
                .scenarios
                .iter()
                .chain(self.protected_final.iter().flat_map(|p| &p.scenarios))
                .collect();
            let slots = self.scenarios.len() as u32 * self.repeats * 2
                + self
                    .protected_final
                    .as_ref()
                    .map_or(0, |p| p.scenarios.len() as u32 * p.repeats * 2)
                + canary.scenarios.len() as u32 * canary.repeats * 2;
            if slots > self.limits.runs
                || canary.scenarios.iter().any(|c| {
                    prior.iter().any(|p| {
                        p.id == c.id
                            || p.family == c.family
                            || p.marker.contains(&c.marker)
                            || c.marker.contains(&p.marker)
                    })
                })
            {
                return Err(invalid(
                    "canary corpus must be independent and fit original aggregate slots",
                ));
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchFinalPolicy {
    pub scenarios: Vec<StrategyScenario>,
    pub repeats: u32,
    pub minimum_gain: u32,
}
pub fn search_final_suite_value(policy: &SearchFinalPolicy) -> serde_json::Value {
    let mut scenarios: Vec<_> = policy.scenarios.iter().collect();
    scenarios.sort_by(|a, b| a.id.cmp(&b.id));
    serde_json::json!({"version":STRATEGY_ORACLE,"scenarios":scenarios})
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
    SelectFinal {
        evaluation_id: String,
        rationale: String,
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
            Self::SelectFinal {
                evaluation_id,
                rationale,
            } => {
                if !text(evaluation_id, 256) || !text(rationale, 4096) {
                    return Err(invalid("Final selection identity or rationale bound"));
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<SearchFinalSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_measurement: Option<SearchFinalReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canary_measurement: Option<SearchFinalReport>,
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
    let mut request = ResponsesRequest {
        model: config.plan.proposer.model.clone(),
        instructions: format!(
            "{}\n\nCall submit_strategy_proposal exactly once with arguments: {{\"action\":\"propose\",\"advisory\":{{\"schema_version\":1,\"advisory_utf8\":\"...\"}},\"rationale\":\"...\"}} or {{\"action\":\"stop\",\"reason\":\"...\"}}. Advisory cannot change host authority or certify success.",
            config.plan.proposer.instructions
        ),
        input: vec![
            serde_json::json!({"role":"user","content":[{"type":"input_text","text":serde_json::to_string(&serde_json::json!({"objective":config.plan.objective,"baseline":config.capture.advisory,"attempt_index":attempt,"development_feedback":feedback})).map_err(|e|invalid(&e.to_string()))?}]}),
        ],
        tools: vec![if config.plan.schema_version == 1 {
            search_proposal_tool()
        } else {
            search_proposal_tool_v2()
        }],
        max_output_tokens: config.plan.proposer.max_output_tokens,
    };
    if config.plan.schema_version >= 2 {
        request.instructions.push_str("\nYou may instead select one independently measured Development candidate by calling {\"action\":\"select_final\",\"evaluation_id\":\"...\",\"rationale\":\"...\"}. This irreversibly ends proposal and Development work and spends one protected Final exposure; stop does not select a candidate. Selection cannot certify success.");
    }
    if config.plan.schema_version == 3 {
        request.instructions.push_str("\nSelection also commits a distinct host-owned canary corpus. Only an independently improved Final proceeds to fresh canary actors, under the same original account. Stop authorizes neither stage.");
    }
    Ok(request)
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchFinalSelection {
    pub schema_version: u32,
    pub id: String,
    pub campaign_id: String,
    pub proposal_id: String,
    pub evaluation_id: String,
    pub candidate_generation: String,
    pub candidate_sha256: String,
    pub baseline_sha256: String,
    pub config_sha256: String,
    pub development_matrix_sha256: String,
    pub binding: StrategyRegistryBinding,
    pub suite_sha256: String,
    pub final_pair_sha256: String,
    pub schedule_start: u32,
    pub run_count: u32,
    pub exposure_id: String,
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canary: Option<SearchCanaryCommitment>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchCanaryCommitment {
    pub suite_sha256: String,
    pub pair_sha256: String,
    pub schedule_start: u32,
    pub run_count: u32,
    pub exposure_id: String,
}
impl SearchFinalSelection {
    pub fn canary_selection(&self) -> Option<Self> {
        let c = self.canary.as_ref()?;
        let mut s = self.clone();
        s.suite_sha256 = c.suite_sha256.clone();
        s.final_pair_sha256 = c.pair_sha256.clone();
        s.schedule_start = c.schedule_start;
        s.run_count = c.run_count;
        s.exposure_id = c.exposure_id.clone();
        s.canary = None;
        Some(s)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchFinalReport {
    pub cases: Vec<StrategyCaseResult>,
    pub decision: StrategyDecision,
    pub reasons: Vec<String>,
    pub matrix_sha256: Option<String>,
}
pub fn search_proposal_tool_v2() -> crate::model::ToolDefinition {
    let mut tool = search_proposal_tool();
    tool.description="Submit advisory, stop without exposure, or select one measured candidate for an irreversible protected Final evaluation. No action certifies success or changes authority.".into();
    if let Some(items) = tool.parameters["oneOf"].as_array_mut() {
        items.push(serde_json::json!({"type":"object","additionalProperties":false,"required":["action","evaluation_id","rationale"],"properties":{"action":{"const":"select_final"},"evaluation_id":{"type":"string","minLength":1,"maxLength":256},"rationale":{"type":"string","minLength":1,"maxLength":4096}}}));
    }
    tool
}
