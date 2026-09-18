//! Persisted prompts, dispatched only by an explicit host command.
use crate::agent::AgentRequest;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueuedAgentStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QueuedAgent {
    pub id: String,
    pub session_id: String,
    pub sequence: u64,
    pub command_id: String,
    pub request: AgentRequest,
    pub after_input: Option<String>,
    pub run_command_id: String,
    pub resolved_request: Option<AgentRequest>,
    pub status: QueuedAgentStatus,
    pub operation_id: Option<String>,
}
