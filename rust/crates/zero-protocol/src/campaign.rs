//! Host-owned aggregate accounting. None of these receipts establishes eligibility.
use crate::{ValidationError, agent::AgentRequest, is_sha256};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignLimits {
    pub model_micro_usd: u64,
    pub model_calls: u32,
    pub http_requests: u64,
    pub http_request_body_bytes: u64,
    pub http_response_decoded_bytes: u64,
    pub experiments: u32,
    pub runs: u32,
    pub max_parallel_runs: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignPlan {
    pub schema_version: u32,
    pub controller_plan_sha256: String,
    pub baseline_sha256: String,
    pub limits: CampaignLimits,
    pub expires_at_ms: u64,
}
impl CampaignPlan {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let l = &self.limits;
        if self.schema_version != 1
            || !is_sha256(&self.controller_plan_sha256)
            || !is_sha256(&self.baseline_sha256)
            || self.expires_at_ms == 0
            || self.expires_at_ms > i64::MAX as u64
            || l.model_micro_usd == 0
            || l.model_micro_usd > i64::MAX as u64
            || !(1..=4096).contains(&l.model_calls)
            || l.http_requests > 8192
            || l.http_request_body_bytes > i64::MAX as u64
            || l.http_response_decoded_bytes > i64::MAX as u64
            || l.experiments > 512
            || !(1..=128).contains(&l.runs)
            || !(1..=8).contains(&l.max_parallel_runs)
            || l.max_parallel_runs > l.runs
        {
            return Err(ValidationError(
                "campaign identity or accounting bounds invalid".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CampaignLane {
    Development,
    Final,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CampaignVariant {
    Baseline,
    Candidate,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignProviderContext {
    pub endpoint: String,
    pub wire_api: crate::model::WireApi,
    pub rates: crate::model::Rates,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosted_catalog: Option<crate::model::HostedCatalogPin>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignRunSpec {
    pub candidate_sha256: String,
    pub suite_sha256: String,
    pub evaluation_pair_sha256: String,
    pub schedule_index: u32,
    pub lane: CampaignLane,
    pub scenario_id: String,
    pub repeat_index: u32,
    pub variant: CampaignVariant,
    pub fixture_origin: String,
    pub request: AgentRequest,
    pub provider_context: BTreeMap<String, CampaignProviderContext>,
    pub http_policy: crate::http::HttpProfilePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exposure_id: Option<String>,
}
impl CampaignRunSpec {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let r = &self.request;
        self.http_policy.validate()?;
        if self.provider_context.is_empty()
            || self.provider_context.len() > 9
            || self.provider_context.iter().any(|(k, v)| {
                k.trim().is_empty()
                    || k.len() > 256
                    || v.endpoint.is_empty()
                    || v.endpoint.len() > 8192
            })
            || !self.provider_context.contains_key(&r.provider)
            || r.delegation_policy.as_ref().is_some_and(|p| {
                p.roles
                    .iter()
                    .any(|role| !self.provider_context.contains_key(&role.provider))
            })
        {
            return Err(ValidationError(
                "campaign provider identity missing or unbounded".into(),
            ));
        }
        if !is_sha256(&self.candidate_sha256)
            || !is_sha256(&self.suite_sha256)
            || !is_sha256(&self.evaluation_pair_sha256)
            || self.schedule_index >= 128
            || self.scenario_id.trim().is_empty()
            || self.scenario_id.len() > 256
            || self.scenario_id.contains('\0')
            || self.repeat_index > 7
            || self.fixture_origin.is_empty()
            || self.fixture_origin.len() > 8192
            || r.execution.is_some()
            || r.http_profile.is_none()
            || !r.plugin_tools.is_empty()
            || r.continuation_of.is_some()
            || r.operator_questions
            || r.tool_approval_policy.is_some()
            || r.source_review_operation_id.is_some()
            || r.source_snapshot_tools
            || r.source_submission_max_hypotheses.is_some()
            || self
                .exposure_id
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 256)
            || (self.lane == CampaignLane::Development && self.exposure_id.is_some())
            || (self.lane == CampaignLane::Final && self.exposure_id.is_none())
        {
            return Err(ValidationError(
                "unsupported campaign run authority or identity".into(),
            ));
        }
        if let Some(p) = &r.delegation_policy {
            p.validate()?;
            if p.roles.iter().any(|role| {
                role.tools
                    .iter()
                    .any(|t| !matches!(t.as_str(), "http_request" | "run_web_experiment"))
            }) {
                return Err(ValidationError(
                    "campaign roles support HTTP and experiments only".into(),
                ));
            }
        }
        r.validate_capabilities()?;
        if serde_json::to_vec(self)
            .map_err(|e| ValidationError(e.to_string()))?
            .len()
            > 512 * 1024
        {
            return Err(ValidationError("campaign run exceeds 512 KiB".into()));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CampaignStatus {
    Open,
    Cancelled,
    Expired,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Campaign {
    pub id: String,
    pub command_id: String,
    pub journal_session_id: String,
    pub plan: CampaignPlan,
    pub plan_sha256: String,
    pub created_at_ms: u64,
    pub status: CampaignStatus,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignExposure {
    pub id: String,
    pub campaign_id: String,
    pub command_id: String,
    pub suite_sha256: String,
    pub evaluation_pair_sha256: String,
    pub finalist_sha256: String,
    pub sequence: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CampaignRunStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignRun {
    pub id: String,
    pub campaign_id: String,
    pub command_id: String,
    pub session_id: String,
    pub run_command_id: String,
    pub spec: CampaignRunSpec,
    pub request_sha256: String,
    pub owner: String,
    pub sequence: u64,
    pub status: CampaignRunStatus,
    pub operation_id: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignUsage {
    pub model_reserved_micro_usd: u64,
    pub model_charged_micro_usd: u64,
    pub model_calls: u64,
    pub http_requests: u64,
    pub http_request_body_bytes: u64,
    pub http_response_reserved_bytes: u64,
    pub http_response_charged_bytes: u64,
    pub experiments: u64,
    pub runs: u64,
    pub active_runs: u64,
    pub unknown_runs: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignSnapshot {
    pub campaign: Campaign,
    pub usage: CampaignUsage,
    pub as_of_sequence: u64,
    pub as_of_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignRunSummary {
    pub id: String,
    pub session_id: String,
    pub operation_id: Option<String>,
    pub sequence: u64,
    pub status: CampaignRunStatus,
    pub lane: CampaignLane,
    pub variant: CampaignVariant,
    pub scenario_id: String,
    pub repeat_index: u32,
    pub schedule_index: u32,
    pub candidate_sha256: String,
    pub suite_sha256: String,
    pub evaluation_pair_sha256: String,
    pub request_sha256: String,
}
impl From<CampaignRun> for CampaignRunSummary {
    fn from(r: CampaignRun) -> Self {
        Self {
            id: r.id,
            session_id: r.session_id,
            operation_id: r.operation_id,
            sequence: r.sequence,
            status: r.status,
            lane: r.spec.lane,
            variant: r.spec.variant,
            scenario_id: r.spec.scenario_id,
            repeat_index: r.spec.repeat_index,
            schedule_index: r.spec.schedule_index,
            candidate_sha256: r.spec.candidate_sha256,
            suite_sha256: r.spec.suite_sha256,
            evaluation_pair_sha256: r.spec.evaluation_pair_sha256,
            request_sha256: r.request_sha256,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignRunPage {
    pub runs: Vec<CampaignRunSummary>,
    pub next_after_sequence: Option<u64>,
}
