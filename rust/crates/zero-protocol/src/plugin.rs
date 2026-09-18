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
