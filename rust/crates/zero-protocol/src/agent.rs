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
    /// execute_snapshot uses this pinned offline execution profile. The model
    /// supplies argv only; it cannot choose mounts, image, network or limits.
    /// Explicit plugin tools use the separately configured host launch profile.
    pub execution: AgentExecution,
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
