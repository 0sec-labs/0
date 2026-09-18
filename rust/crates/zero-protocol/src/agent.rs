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
    /// Every tool call uses this pinned offline execution profile. The model
    /// supplies argv only; it cannot choose mounts, image, network or limits.
    pub execution: ExecutionRequest,
    pub max_turns: u32,
    pub reservation_per_turn: u64,
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
}
