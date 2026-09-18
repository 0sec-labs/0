//! Durable native session values. Budget quantities use caller-defined integer units.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Session {
    pub id: String,
    pub generation: String,
    pub created_at_ms: u64,
    pub budget_limit: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Admitted,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Operation {
    pub id: String,
    pub session_id: String,
    pub command_id: String,
    pub payload: Value,
    pub status: OperationStatus,
    pub owner: Option<String>,
    pub outcome: Option<Value>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Admission {
    pub operation: Operation,
    pub duplicate: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionEvent {
    pub session_id: String,
    pub sequence: u64,
    pub kind: String,
    pub payload: Value,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BudgetSnapshot {
    pub limit: u64,
    pub reserved: u64,
    pub charged: u64,
}
