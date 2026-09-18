//! Bounded display projections. These are not replay inputs or execution authority.
use crate::{
    agent::AgentStatus,
    session::{OperationStatus, Session},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const MAX_HISTORY_PAGE_BYTES: usize = 512 * 1024;
pub const MAX_DISPLAY_TEXT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionCursor {
    pub created_at_ms: u64,
    pub id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionListPage {
    pub sessions: Vec<Session>,
    pub next_cursor: Option<SessionCursor>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DisplayText {
    pub text: String,
    pub truncated: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConversationEntry {
    pub sequence: u64,
    pub operation_id: String,
    pub command_id: String,
    pub status: OperationStatus,
    pub agent_status: Option<AgentStatus>,
    /// Display eligibility only. Dispatch still validates profile authority,
    /// retained inference provenance and any checkpoint contents.
    pub continuable: bool,
    pub prompt: DisplayText,
    pub reply_text: Option<DisplayText>,
    pub error: Option<DisplayText>,
    pub tool_calls: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionHistoryPage {
    pub entries: Vec<ConversationEntry>,
    /// Resume before this last returned admission sequence. Entries are newest first.
    /// None means exhausted
    /// at this read snapshot; later admissions can still appear.
    pub next_before_sequence: Option<u64>,
}
