//! Credential-free provider request, result and accounting values.
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum WireApi {
    #[default]
    Responses,
    ChatCompletions,
    AnthropicMessages,
    GoogleGenerateContent,
    OllamaChat,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionStatus {
    Completed,
    Incomplete,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Subset of input_tokens, never an additional input charge.
    pub cached_input_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Content {
    Text {
        text: String,
    },
    Refusal {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Completion {
    pub status: CompletionStatus,
    pub response_id: Option<String>,
    pub content: Vec<Content>,
    /// Missing usage is unknown usage, not zero cost.
    pub usage: Option<Usage>,
    /// True only when a terminal response explicitly reported this usage.
    #[serde(default)]
    pub usage_is_final: bool,
    /// Preserve provider output items, including opaque reasoning, for replay.
    pub replay: Vec<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResponsesRequest {
    pub model: String,
    pub instructions: String,
    pub input: Vec<Value>,
    pub tools: Vec<ToolDefinition>,
    pub max_output_tokens: u32,
}

/// Integer microcurrency units per million tokens, supplied by the operator.
/// Rates are captured with a request; this crate does not invent current prices.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Rates {
    pub input: u64,
    pub cached_input: u64,
    pub output: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
pub enum CatalogCurrency {
    Usd,
}

/// Credential-free normalized catalog quote and the route it configures.
/// The digest identifies supplied catalog data; it is not a billing attestation.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HostedCatalogPin {
    pub schema_version: u32,
    pub currency: CatalogCurrency,
    pub host: String,
    pub endpoint: String,
    pub model: String,
    pub wire_api: WireApi,
    pub max_output_tokens: u32,
    pub rates: Rates,
    /// Canonical model metadata; price decimals are strings to preserve exactness
    /// through journals and generic JSON consumers. Gateway wire prices remain numbers.
    pub catalog_model: Value,
    pub catalog_model_sha256: String,
}
impl Rates {
    pub fn charge(&self, usage: &Usage) -> Option<u64> {
        let uncached = usage.input_tokens.checked_sub(usage.cached_input_tokens)?;
        let numerator = u128::from(uncached)
            .checked_mul(u128::from(self.input))?
            .checked_add(
                u128::from(usage.cached_input_tokens).checked_mul(u128::from(self.cached_input))?,
            )?
            .checked_add(u128::from(usage.output_tokens).checked_mul(u128::from(self.output))?)?;
        u64::try_from(numerator.checked_add(999_999)? / 1_000_000).ok()
    }
}

/// Maximum total UTF-8 bytes across string fragments in one live progress item.
/// JSON escaping and the surrounding event envelope add transport overhead.
pub const MAX_PROGRESS_TEXT_BYTES: usize = 16 * 1024;

/// Advisory, potentially incomplete display data. Never tool authority, usage,
/// a durable event cursor, or a substitute for the terminal Completion receipt.
/// Indices identify provider output/block positions within one inference.
/// Opaque replay, signatures and provider error bodies are intentionally absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProviderProgress {
    TextDelta {
        item_index: u32,
        content_index: u32,
        text: String,
    },
    ReasoningDelta {
        item_index: u32,
        content_index: u32,
        text: String,
    },
    RefusalDelta {
        item_index: u32,
        content_index: u32,
        text: String,
    },
    /// Each field is a fragment, not a complete authorized call. Arguments may
    /// be incomplete JSON; consumers must never dispatch from progress events.
    ToolCallDelta {
        item_index: u32,
        id_delta: String,
        name_delta: String,
        arguments_delta: String,
    },
}
