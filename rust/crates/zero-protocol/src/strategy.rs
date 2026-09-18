//! Host-owned strategy experiments. Advisory text never grants authority or certifies improvement.
use crate::{
    ValidationError, campaign::*, context::ContextPolicy, delegation::DelegationPolicy,
    web_experiment::WebExperimentPolicy,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
pub const STRATEGY_RENDERER: &str = "strategy_advisory_v1";
pub const STRATEGY_ORACLE: &str = "local_web_marker_v1";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyArtifact {
    pub schema_version: u32,
    pub advisory_utf8: String,
}
impl StrategyArtifact {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.schema_version != 1 || !text(&self.advisory_utf8, 32 * 1024) {
            return Err(invalid(
                "strategy requires version1 and1..32768 UTF8 advisory bytes without NUL",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyHost {
    pub provider: String,
    pub model: String,
    pub instructions: String,
    pub max_turns: u32,
    pub reservation_per_turn: u64,
    pub max_hypotheses: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_experiment_policy: Option<WebExperimentPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_policy: Option<DelegationPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_policy: Option<ContextPolicy>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyScenario {
    pub id: String,
    pub family: String,
    pub lane: CampaignLane,
    pub public_task: String,
    pub resource_path: String,
    pub control_path: String,
    /// Private evaluator value. Never rendered into actor input or public feedback.
    pub marker: String,
    pub positive: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyPlan {
    pub schema_version: u32,
    pub renderer_version: String,
    pub oracle_version: String,
    pub baseline: StrategyArtifact,
    pub candidate: StrategyArtifact,
    pub host: StrategyHost,
    pub scenarios: Vec<StrategyScenario>,
    pub repeats: u32,
    pub limits: CampaignLimits,
    pub expires_at_ms: u64,
    pub minimum_development_gain: u32,
    pub minimum_final_gain: u32,
}
fn invalid(s: &str) -> ValidationError {
    ValidationError(s.into())
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.contains('\0')
}
fn id(s: &str) -> bool {
    text(s, 128)
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn path(s: &str) -> bool {
    s.starts_with('/')
        && s != "/"
        && s.len() <= 256
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'/' || b == b'_' || b == b'-')
        && !s.contains("//")
}
impl StrategyPlan {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.baseline.validate()?;
        self.candidate.validate()?;
        let h = &self.host;
        if self.schema_version != 1
            || self.renderer_version != STRATEGY_RENDERER
            || self.oracle_version != STRATEGY_ORACLE
            || self.baseline == self.candidate
            || !(4..=16).contains(&self.scenarios.len())
            || !(2..=3).contains(&self.repeats)
            || self.scenarios.len() * self.repeats as usize * 2 > self.limits.runs as usize
            || self.limits.max_parallel_runs != 1
            || !(1..=16).contains(&self.minimum_development_gain)
            || !(1..=16).contains(&self.minimum_final_gain)
            || !text(&h.provider, 128)
            || !text(&h.model, 256)
            || !text(&h.instructions, 32768)
            || !(1..=16).contains(&h.max_turns)
            || h.reservation_per_turn == 0
            || h.reservation_per_turn > self.limits.model_micro_usd
            || !(1..=8).contains(&h.max_hypotheses)
        {
            return Err(invalid(
                "unsupported strategy plan identity, authority or schedule bounds",
            ));
        }
        if let Some(p) = &h.web_experiment_policy {
            p.validate()?;
        }
        if let Some(p) = &h.context_policy {
            p.validate()?;
        }
        if let Some(p) = &h.delegation_policy {
            p.validate()?;
            for role in &p.roles {
                if role
                    .tools
                    .iter()
                    .any(|t| !matches!(t.as_str(), "http_request" | "run_web_experiment"))
                    || !role.tools.iter().any(|t| t == "http_request")
                    || role.reservation_per_turn > self.limits.model_micro_usd
                    || (role.tools.iter().any(|t| t == "run_web_experiment")
                        && h.web_experiment_policy.is_none())
                {
                    return Err(invalid(
                        "strategy roles permit scoped HTTP and authorized experiments only",
                    ));
                }
            }
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
        let mut public_text = vec![
            "fixture resource: no private data",
            "fixture control: public data only",
            "fixture route not found",
            "fixture method not allowed",
            "resources",
            h.instructions.as_str(),
            h.provider.as_str(),
            h.model.as_str(),
            self.baseline.advisory_utf8.as_str(),
            self.candidate.advisory_utf8.as_str(),
        ];
        for c in &self.scenarios {
            public_text.extend([
                c.public_task.as_str(),
                c.resource_path.as_str(),
                c.control_path.as_str(),
            ]);
        }
        if let Some(p) = &h.delegation_policy {
            for role in &p.roles {
                public_text.extend([
                    role.name.as_str(),
                    role.instructions.as_str(),
                    role.description.as_str(),
                    role.provider.as_str(),
                    role.model.as_str(),
                ]);
            }
        }
        if self
            .scenarios
            .iter()
            .any(|c| public_text.iter().any(|s| s.contains(&c.marker)))
        {
            return Err(invalid(
                "private fixture marker appears in a public request field",
            ));
        }
        let mut ids = BTreeSet::new();
        let mut families = BTreeMap::new();
        let mut markers = BTreeMap::new();
        let mut kinds = [[0usize; 2]; 2];
        for c in &self.scenarios {
            if !id(&c.id)
                || !id(&c.family)
                || !ids.insert(&c.id)
                || !text(&c.public_task, 8192)
                || !path(&c.resource_path)
                || !path(&c.control_path)
                || c.resource_path == c.control_path
                || !text(&c.marker, 256)
                || c.marker.len() < 8
                || c.marker.chars().any(char::is_control)
                || c.public_task.contains(&c.marker)
                || h.instructions.contains(&c.marker)
                || self.baseline.advisory_utf8.contains(&c.marker)
                || self.candidate.advisory_utf8.contains(&c.marker)
            {
                return Err(invalid(
                    "invalid private fixture scenario or marker exposed in instructions",
                ));
            }
            if families
                .insert(&c.family, c.lane)
                .is_some_and(|lane| lane != c.lane)
            {
                return Err(invalid(
                    "scenario family appears in development and final lanes",
                ));
            }
            if markers
                .insert(&c.marker, c.lane)
                .is_some_and(|lane| lane != c.lane)
            {
                return Err(invalid(
                    "private marker is reused across development and final lanes",
                ));
            }
            kinds[usize::from(c.lane == CampaignLane::Final)][usize::from(c.positive)] += 1;
        }
        if kinds.iter().flatten().any(|n| *n == 0)
            || self.minimum_development_gain as usize > kinds[0][1]
            || self.minimum_final_gain as usize > kinds[1][1]
            || serde_json::to_vec(self)
                .map_err(|e| invalid(&e.to_string()))?
                .len()
                > 1024 * 1024
        {
            return Err(invalid(
                "strategy suite lacks bounded positive/negative split or possible gain",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StrategyDecision {
    ImprovedForFixtureSuite,
    NotImproved,
    Inconclusive,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StrategyCaseDisposition {
    Observed,
    Incomplete,
    Cancelled,
    Unknown,
    InvalidEvidence,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyObservation {
    pub operation_id: String,
    pub response_manifest_sha256: String,
    pub retained_body_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyCaseResult {
    pub schedule_index: u32,
    pub run_id: String,
    pub session_id: String,
    pub operation_id: Option<String>,
    pub scenario_id: String,
    pub family: String,
    pub lane: CampaignLane,
    pub variant: CampaignVariant,
    pub repeat_index: u32,
    pub disposition: StrategyCaseDisposition,
    pub matched: bool,
    pub supported_findings: u32,
    pub unsupported_claims: u32,
    pub observations: Vec<StrategyObservation>,
    pub model_charged_micro_usd: u64,
    pub model_reserved_micro_usd: u64,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyReport {
    pub schema_version: u32,
    pub qualification: String,
    pub campaign_id: String,
    pub plan_sha256: String,
    pub baseline_sha256: String,
    pub candidate_sha256: String,
    pub evaluator_version: String,
    pub renderer_version: String,
    pub suite_sha256: String,
    pub completed_lanes: Vec<CampaignLane>,
    pub decision: StrategyDecision,
    pub reasons: Vec<String>,
    pub case_results: Vec<StrategyCaseResult>,
    pub usage: CampaignUsage,
    pub evidence_sha256: String,
    pub report_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyDevelopmentFeedback {
    pub schema_version: u32,
    pub campaign_id: String,
    pub plan_sha256: String,
    pub baseline_sha256: String,
    pub candidate_sha256: String,
    pub cases: Vec<StrategyCaseResult>,
}
