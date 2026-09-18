//! An explicit bounded agent workflow; output remains a model assessment.
use crate::ExecutionRequest;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentRequest {
    pub provider: String,
    pub model: String,
    pub instructions: String,
    pub prompt: String,
    /// Opt-in, receipted omission of older complete assistant/tool rounds.
    /// User prompts and protected legacy context remain verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_policy: Option<crate::context::ContextPolicy>,
    /// Explicitly offer informational operator questions; answers grant no authority.
    #[serde(default, skip_serializing_if = "is_false")]
    pub operator_questions: bool,
    /// Named host-configured target HTTP authority; omitted profiles offer no native HTTP tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_profile: Option<String>,
    /// Allow model-selected experiments within the captured HTTP authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_experiment_policy: Option<crate::web_experiment::WebExperimentPolicy>,
    /// Explicit one-invocation approval for selected existing executable tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_approval_policy: Option<crate::approvals::ToolApprovalPolicy>,
    /// Host-authored roles for bounded joined tasks; omitted requests retain their identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_policy: Option<crate::delegation::DelegationPolicy>,
    /// Explicitly continue a completed or checkpointed turn-limit agent operation in this session. Its
    /// persisted final provider request and replay supply immutable history;
    /// previous effects are never executed again. Omission starts fresh.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation_of: Option<String>,
    /// Opt into read-only tools over this same-session review's retained bundle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_review_operation_id: Option<String>,
    /// Explicit read-only tools over a newly verified private copy of the full snapshot.
    #[serde(default, skip_serializing_if = "is_false")]
    pub source_snapshot_tools: bool,
    /// Require a terminal structured source submission after snapshot investigation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_submission_max_hypotheses: Option<u32>,
    /// Terminal unverified claims over this web workflow's retained observations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_submission_max_hypotheses: Option<u32>,
    /// execute_snapshot uses this pinned offline execution profile. The model
    /// supplies argv only; it cannot choose mounts, image, network or limits.
    /// Explicit plugin tools use the separately configured host launch profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<AgentExecution>,
    /// Explicit aliases for a curated subset of host-authorized pinned plugins.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugin_tools: Vec<PluginToolBinding>,
    pub max_turns: u32,
    pub reservation_per_turn: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginToolBinding {
    pub alias: String,
    pub plugin: String,
    pub tool: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Completed,
    TurnLimit,
    Cancelled,
    Failed,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AgentResult {
    pub status: AgentStatus,
    pub text: String,
    pub turns: u32,
    pub tool_calls: u32,
    pub error: Option<String>,
    /// Complete post-tool replay retained only at a safe turn-limit boundary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation_artifact: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_recovery_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_review: Option<crate::source::SourceReviewOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_review: Option<crate::web::WebReviewOutcome>,
}

/// Legacy Docker-shaped requests retain their serialized retry identity. New
/// requests can select either backend through the explicit sandbox shape.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum AgentExecution {
    Docker(ExecutionRequest),
    Sandbox(crate::sandbox::SandboxRequest),
}
impl AgentExecution {
    pub fn validate(&self) -> Result<(), crate::ValidationError> {
        match self {
            Self::Docker(r) => r.validate(),
            Self::Sandbox(r) => r.validate(),
        }
    }
    pub fn sandbox_request(&self) -> crate::sandbox::SandboxRequest {
        match self {
            Self::Docker(r) => r.clone().into(),
            Self::Sandbox(r) => r.clone(),
        }
    }
}
impl From<ExecutionRequest> for AgentExecution {
    fn from(request: ExecutionRequest) -> Self {
        Self::Docker(request)
    }
}
impl From<crate::sandbox::SandboxRequest> for AgentExecution {
    fn from(request: crate::sandbox::SandboxRequest) -> Self {
        Self::Sandbox(request)
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Existing execution-enabled actors retain their historical serialized kind.
pub fn actor_kind(request: &AgentRequest) -> &'static str {
    if request.execution.is_some() {
        "offline_snapshot_agent"
    } else {
        "scoped_web_agent"
    }
}
impl AgentRequest {
    pub fn execution_identity(&self) -> Option<crate::sandbox::SandboxRequest> {
        self.execution.as_ref().map(AgentExecution::sandbox_request)
    }
    pub fn snapshot_request(
        &self,
    ) -> Result<crate::sandbox::SandboxRequest, crate::ValidationError> {
        self.execution_identity()
            .ok_or_else(|| crate::ValidationError("snapshot execution is not authorized".into()))
    }
    pub fn validate_capabilities(&self) -> Result<(), crate::ValidationError> {
        if let Some(execution) = &self.execution {
            execution.validate()?;
        } else if self
            .http_profile
            .as_ref()
            .is_none_or(|name| name.is_empty())
            || self.source_snapshot_tools
            || self.source_review_operation_id.is_some()
            || self.source_submission_max_hypotheses.is_some()
        {
            return Err(crate::ValidationError(
                "snapshot-free actors require an HTTP profile and cannot use source snapshot modes"
                    .into(),
            ));
        }
        if let Some(policy) = &self.web_experiment_policy {
            policy.validate()?;
            if self.http_profile.is_none() || self.source_submission_max_hypotheses.is_some() {
                return Err(crate::ValidationError(
                    "web experiments require HTTP authority and no source terminal submission"
                        .into(),
                ));
            }
        }
        if let Some(max) = self.web_submission_max_hypotheses {
            if !(1..=32).contains(&max)
                || self.http_profile.is_none()
                || self.source_submission_max_hypotheses.is_some()
            {
                return Err(crate::ValidationError("web submission requires HTTP authority,1..32 hypotheses and no source terminal submission".into()));
            }
        }
        Ok(())
    }
}
/// A tag alone never grants actor authority. Validate its strict captured request.
pub fn validate_actor_payload(
    payload: &serde_json::Value,
) -> Result<AgentRequest, crate::ValidationError> {
    let request: AgentRequest = serde_json::from_value(
        payload
            .get("request")
            .cloned()
            .ok_or_else(|| crate::ValidationError("actor request absent".into()))?,
    )
    .map_err(|_| crate::ValidationError("invalid captured actor request".into()))?;
    request.validate_capabilities()?;
    if payload["kind"] != actor_kind(&request) {
        return Err(crate::ValidationError(
            "actor kind and capabilities differ".into(),
        ));
    }
    if payload.get("parent_operation").is_some() && request.web_submission_max_hypotheses.is_some()
    {
        return Err(crate::ValidationError(
            "joined children cannot terminal-submit web hypotheses".into(),
        ));
    }
    Ok(request)
}
