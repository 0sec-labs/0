//! Plugin results are untrusted data, never host authority or oracle evidence.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginPin {
    pub generation: String,
    pub epoch: u64,
    pub lease_id: String,
    pub lease_owner: String,
    pub plugin_manifest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UntrustedPluginReply {
    Result { value: serde_json::Value },
    Error { code: i32, message: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PluginOutcome {
    /// False proves dispatch never began; true means dispatch was attempted, not that it succeeded.
    pub external_effects_started: bool,
    pub pin: Option<PluginPin>,
    pub sandbox: Option<crate::sandbox::SandboxResult>,
    pub untrusted_reply: Option<UntrustedPluginReply>,
    pub error: Option<String>,
    pub staging_recovery: Option<String>,
    /// Lease release is journaled AFTER this immutable operation outcome.
    /// The outcome alone never asserts that a separate registry was settled.
    pub lease_release_journaled_separately: bool,
}

/// Explicit host opt-in; absent policies preserve the original one-shot route.
/// This policy grants no provider, target, credentials or independent account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginWorkerPolicy {
    pub schema_version: u32,
    pub operations: Vec<PluginHostOperation>,
    pub max_calls: u32,
    pub max_callbacks: u32,
}
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum PluginHostOperation {
    ListSourceFiles,
    ReadSourceLines,
    SearchSourceText,
    HttpRequest,
}
impl PluginHostOperation {
    pub fn name(self) -> &'static str {
        match self {
            Self::ListSourceFiles => "list_source_files",
            Self::ReadSourceLines => "read_source_lines",
            Self::SearchSourceText => "search_source_text",
            Self::HttpRequest => "http_request",
        }
    }
    pub fn capability(self) -> &'static str {
        match self {
            Self::HttpRequest => "network",
            _ => "filesystem-read",
        }
    }
}
impl PluginWorkerPolicy {
    pub fn validate(&self) -> Result<(), crate::ValidationError> {
        if self.schema_version != 1
            || self.operations.len() > 4
            || !(1..=32).contains(&self.max_calls)
            || !(1..=128).contains(&self.max_callbacks)
            || self
                .operations
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.operations.len()
        {
            return Err(crate::ValidationError(
                "invalid plugin worker policy".into(),
            ));
        }
        Ok(())
    }
}
