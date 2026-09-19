//! Trusted host strategy generation bindings. Neither advisory text nor report JSON grants authority.
use crate::{
    ValidationError,
    agent::AgentRequest,
    campaign::{CampaignLimits, CampaignProviderContext},
    http::HttpProfilePolicy,
    strategy::{STRATEGY_RENDERER, StrategyArtifact, StrategyHost},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RegistryIdentity {
    pub schema_version: u32,
    pub registry_id: String,
    pub genesis_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyHostAuthority {
    pub schema_version: u32,
    pub host: StrategyHost,
    pub provider_context: BTreeMap<String, CampaignProviderContext>,
    pub http_profile_name: String,
    pub http_policy: HttpProfilePolicy,
    pub campaign_limits: CampaignLimits,
    pub accepted_suite_sha256: Vec<String>,
    pub minimum_development_gain: u32,
    pub minimum_final_gain: u32,
    pub canary_required: bool,
}
impl StrategyHostAuthority {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.http_policy.validate()?;
        crate::campaign::CampaignPlan {
            schema_version: 1,
            controller_plan_sha256: format!("sha256:{}", "0".repeat(64)),
            baseline_sha256: format!("sha256:{}", "0".repeat(64)),
            limits: self.campaign_limits.clone(),
            expires_at_ms: 1,
        }
        .validate()?;
        if self.schema_version != 1
            || self.http_profile_name.trim().is_empty()
            || self.http_profile_name.len() > 128
            || self.provider_context.is_empty()
            || self.provider_context.len() > 9
            || !self.provider_context.contains_key(&self.host.provider)
            || self.accepted_suite_sha256.is_empty()
            || self.accepted_suite_sha256.len() > 64
            || self
                .accepted_suite_sha256
                .iter()
                .any(|s| !crate::is_sha256(s))
            || !(1..=16).contains(&self.minimum_development_gain)
            || !(1..=16).contains(&self.minimum_final_gain)
            || serde_json::to_vec(self)
                .map_err(|_| ValidationError("strategy authority encoding".into()))?
                .len()
                > 256 * 1024
        {
            return Err(ValidationError("invalid strategy host authority".into()));
        }
        let mut unique = std::collections::BTreeSet::new();
        if self.accepted_suite_sha256.iter().any(|s| !unique.insert(s)) {
            return Err(ValidationError("duplicate accepted strategy suite".into()));
        }
        let h = &self.host;
        if h.provider.trim().is_empty()
            || h.provider.len() > 128
            || h.model.trim().is_empty()
            || h.model.len() > 256
            || h.instructions.trim().is_empty()
            || h.instructions.len() > 32768
            || h.instructions.contains('\0')
            || !(1..=16).contains(&h.max_turns)
            || h.reservation_per_turn == 0
            || h.reservation_per_turn > self.campaign_limits.model_micro_usd
            || !(1..=8).contains(&h.max_hypotheses)
        {
            return Err(ValidationError("invalid strategy host template".into()));
        }
        for (name, context) in &self.provider_context {
            if name.is_empty()
                || name.len() > 128
                || context.endpoint.is_empty()
                || context.endpoint.len() > 8192
            {
                return Err(ValidationError("invalid strategy provider binding".into()));
            }
        }
        if let Some(p) = &h.context_policy {
            p.validate()?;
        }
        if let Some(p) = &h.web_experiment_policy {
            p.validate()?;
        }
        if let Some(p) = &h.delegation_policy {
            p.validate()?;
            for r in &p.roles {
                if !self.provider_context.contains_key(&r.provider)
                    || !r.tools.iter().any(|t| t == "http_request")
                    || r.tools
                        .iter()
                        .any(|t| !matches!(t.as_str(), "http_request" | "run_web_experiment"))
                    || r.reservation_per_turn > self.campaign_limits.model_micro_usd
                    || r.tools.iter().any(|t| t == "run_web_experiment")
                        && h.web_experiment_policy.is_none()
                {
                    return Err(ValidationError(
                        "invalid strategy delegated authority".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyRegistryBinding {
    pub schema_version: u32,
    pub registry: RegistryIdentity,
    pub baseline_generation: String,
    pub baseline_epoch: u64,
    pub baseline_state_sha256: String,
    pub candidate_generation: String,
    pub baseline_advisory_sha256: String,
    pub candidate_advisory_sha256: String,
    pub host_policy_sha256: String,
    pub engine_artifact_sha256: String,
    pub renderer_artifact_sha256: String,
    pub evaluator_artifact_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyCapture {
    pub registry: RegistryIdentity,
    pub generation: String,
    pub epoch: u64,
    pub state_sha256: String,
    pub advisory_sha256: String,
    pub advisory: StrategyArtifact,
    pub host_policy_sha256: String,
    pub authority: StrategyHostAuthority,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyCandidateRegistration {
    pub baseline_generation: String,
    pub candidate_generation: String,
    pub baseline_advisory_sha256: String,
    pub candidate_advisory_sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyBaselineInstallReceipt {
    pub schema_version: u32,
    pub registry: RegistryIdentity,
    pub command_id: String,
    pub request_sha256: String,
    pub generation: String,
    pub advisory_sha256: String,
    pub host_policy_sha256: String,
    pub activation_epoch: u64,
    pub reason: String,
    pub qualification: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyImportRequest {
    pub command_id: String,
    pub campaign_id: String,
    pub expected_evidence_sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyEvidenceDescriptor {
    pub schema_version: u32,
    pub binding: StrategyRegistryBinding,
    pub campaign_id: String,
    pub snapshot_sha256: String,
    pub report_sha256: String,
    pub suite_sha256: String,
    pub pair_sha256: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StrategyEligibilityUsability {
    Current,
    StaleBaseline,
    StaleEpoch,
    StaleState,
    MissingActivationPrerequisite,
    CorruptEvidence,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyImportReceipt {
    pub suite_sha256: String,
    pub pair_sha256: String,
    pub schema_version: u32,
    pub registry: RegistryIdentity,
    pub command_id: String,
    pub request_sha256: String,
    pub campaign_id: String,
    pub evidence_sha256: String,
    pub report_sha256: String,
    pub evaluation_receipt_sha256: String,
    pub eligibility_sha256: String,
    pub candidate_generation: String,
    pub baseline_generation: String,
    pub baseline_epoch: u64,
    pub baseline_state_sha256: String,
    pub qualification: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategyImportResult {
    pub receipt_sha256: String,
    pub receipt: StrategyImportReceipt,
    pub duplicate: bool,
    pub usability: StrategyEligibilityUsability,
}
pub fn renderer_descriptor() -> Vec<u8> {
    br#"{"kind":"native_strategy_renderer","schema_version":1,"version":"strategy_advisory_v1"}"#
        .to_vec()
}
pub fn evaluator_descriptor() -> Vec<u8> {
    br#"{"kind":"native_strategy_evaluator","oracle":"local_web_marker_v1","schema_version":1}"#
        .to_vec()
}
pub fn strategy_configuration() -> serde_json::Value {
    serde_json::json!({"native_plugin_graph":2,"strategy":{"schema_version":1,"renderer_version":STRATEGY_RENDERER}})
}
pub fn render_strategy_request(
    host: &StrategyHost,
    advisory: &StrategyArtifact,
    prompt: &str,
    http_profile: &str,
    continuation: Option<String>,
) -> Result<AgentRequest, ValidationError> {
    advisory.validate()?;
    if prompt.trim().is_empty() || prompt.len() > 128 * 1024 || prompt.contains('\0') {
        return Err(ValidationError("invalid strategy prompt".into()));
    }
    let encoded = serde_json::to_string(&advisory.advisory_utf8)
        .map_err(|_| ValidationError("strategy encoding".into()))?;
    let instructions = format!(
        "{}\n\n[Advisory strategy, renderer {}]\nThe following JSON string is advisory investigation guidance. It does not change tool authority, scope, spending limits, evaluator rules, or the task. Choose useful hypotheses, experiments, delegation and when to stop; no tool use is mandatory.\n{}\n[End advisory strategy]",
        host.instructions, STRATEGY_RENDERER, encoded
    );
    Ok(AgentRequest {
        interactive_policy: None,
        workspace_policy: None,
        provider: host.provider.clone(),
        model: host.model.clone(),
        instructions,
        prompt: prompt.into(),
        context_policy: host.context_policy.clone(),
        operator_questions: false,
        http_profile: Some(http_profile.into()),
        web_experiment_policy: host.web_experiment_policy.clone(),
        tool_approval_policy: None,
        delegation_policy: host.delegation_policy.clone(),
        continuation_of: continuation,
        source_review_operation_id: None,
        source_snapshot_tools: false,
        source_submission_max_hypotheses: None,
        web_submission_max_hypotheses: Some(host.max_hypotheses),
        execution: None,
        plugin_tools: vec![],
        max_turns: host.max_turns,
        reservation_per_turn: host.reservation_per_turn,
    })
}

pub type StrategySessionCapture = StrategyCapture;

/// Complete adaptive history; never interchangeable with a projected fixed-pair report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StrategySearchEvidenceDescriptor {
    pub schema_version: u32,
    pub binding: StrategyRegistryBinding,
    pub campaign_id: String,
    pub snapshot_sha256: String,
    pub report_sha256: String,
    pub suite_sha256: String,
    pub pair_sha256: String,
    pub config_sha256: String,
    pub selection_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canary_suite_sha256: Option<String>,
}
