//! Durable operator messages for a later model boundary of one running actor.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentSteeringStatus {
    Pending,
    /// Included in a durable inference request; not proof of provider receipt.
    Captured,
    Undelivered,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SteeringInput {
    pub id: String,
    pub sequence: u64,
    pub prompt: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentSteeringMessage {
    pub id: String,
    pub session_id: String,
    pub operation_id: String,
    pub sequence: u64,
    pub command_id: String,
    pub prompt: String,
    pub status: AgentSteeringStatus,
    pub inference_operation_id: Option<String>,
}
