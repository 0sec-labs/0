//! Bounded by transport byte/frame caps; no partial tool call is executable.
//! https://platform.claude.com/docs/en/build-with-claude/streaming
use crate::{
    Completion, CompletionStatus, Content, TransportError, Usage,
    anthropic::{assistant, keys, string},
};
use serde_json::{Map, Value, json};
struct Block {
    value: Value,
    json: String,
    closed: bool,
}
pub(crate) struct Accumulator {
    model: String,
    id: Option<String>,
    blocks: Vec<Block>,
    usage: Map<String, Value>,
    reason: Option<String>,
    done: bool,
    poisoned: bool,
    final_usage: bool,
}
impl Accumulator {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.into(),
            id: None,
            blocks: vec![],
            usage: Map::new(),
            reason: None,
            done: false,
            poisoned: false,
            final_usage: false,
        }
    }
    pub fn event(&mut self, data: &[u8]) -> Result<(), TransportError> {
        let result = self.apply(data);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn apply(&mut self, data: &[u8]) -> Result<(), TransportError> {
        if self.done || self.poisoned {
            return Err(TransportError::InvalidResponse);
        }
        let event: Value =
            serde_json::from_slice(data).map_err(|_| TransportError::InvalidResponse)?;
        match string(&event, "type")? {
            "ping" => {}
            "error" => return Err(TransportError::InvalidResponse), // Never retain server error text/secrets.
            "message_start" => {
                if self.id.is_some() {
                    return Err(TransportError::InvalidResponse);
                }
                let message = &event["message"];
                if message["type"] != "message"
                    || message["role"] != "assistant"
                    || message["content"].as_array().is_none_or(|v| !v.is_empty())
                    || !message["stop_reason"].is_null()
                {
                    return Err(TransportError::InvalidResponse);
                }
                let id = string(message, "id")?;
                if id.is_empty() {
                    return Err(TransportError::InvalidResponse);
                }
                string(message, "model")?;
                self.id = Some(id.into());
                if let Some(usage) = message.get("usage") {
                    self.merge_usage(usage)?;
                }
            }
            "content_block_start" => {
                if self.id.is_none()
                    || self.reason.is_some()
                    || self.blocks.len() >= 256
                    || event["index"].as_u64() != Some(self.blocks.len() as u64)
                {
                    return Err(TransportError::InvalidResponse);
                }
                let block = event["content_block"].clone();
                assistant(&json!([block]), false)?;
                self.blocks.push(Block {
                    value: block,
                    json: String::new(),
                    closed: false,
                });
            }
            "content_block_delta" => {
                if self.reason.is_some() {
                    return Err(TransportError::InvalidResponse);
                }
                let block = self.block(&event)?;
                if block.closed {
                    return Err(TransportError::InvalidResponse);
                }
                let delta = &event["delta"];
                let field = match (string(&block.value, "type")?, string(delta, "type")?) {
                    ("text", "text_delta") => "text",
                    ("thinking", "thinking_delta") => "thinking",
                    ("thinking", "signature_delta") => "signature",
                    ("tool_use", "input_json_delta") => {
                        keys(delta, &["type", "partial_json"])?;
                        block.json.push_str(string(delta, "partial_json")?);
                        return Ok(());
                    }
                    _ => return Err(TransportError::InvalidResponse),
                };
                keys(delta, &["type", field])?;
                let mut value = string(&block.value, field)?.to_owned();
                value.push_str(string(delta, field)?);
                block.value[field] = json!(value);
            }
            "content_block_stop" => {
                let block = self.block(&event)?;
                if block.closed {
                    return Err(TransportError::InvalidResponse);
                }
                if block.value["type"] == "tool_use" && !block.json.is_empty() {
                    // A nonempty initial input plus deltas is ambiguous; never overwrite it.
                    if block.value["input"]
                        .as_object()
                        .is_none_or(|v| !v.is_empty())
                    {
                        return Err(TransportError::InvalidResponse);
                    }
                    block.value["input"] = serde_json::from_str(&block.json)
                        .map_err(|_| TransportError::InvalidResponse)?;
                }
                assistant(&json!([block.value]), true)?;
                block.closed = true;
            }
            "message_delta" => {
                if self.id.is_none() || self.blocks.iter().any(|b| !b.closed) {
                    return Err(TransportError::InvalidResponse);
                }
                let delta = &event["delta"];
                keys(delta, &["stop_reason", "stop_sequence"])?;
                if let Some(reason) = delta.get("stop_reason").filter(|v| !v.is_null()) {
                    let reason = reason.as_str().ok_or(TransportError::InvalidResponse)?;
                    if self.reason.as_ref().is_some_and(|old| old != reason) {
                        return Err(TransportError::InvalidResponse);
                    }
                    self.reason = Some(reason.into());
                }
                if let Some(usage) = event.get("usage") {
                    self.merge_usage(usage)?;
                    self.final_usage |= usage.get("output_tokens").is_some()
                        && self.usage.get("input_tokens").is_some();
                }
            }
            "message_stop" => {
                if self.id.is_none()
                    || self.reason.is_none()
                    || self.blocks.iter().any(|b| !b.closed)
                {
                    return Err(TransportError::InvalidResponse);
                }
                self.done = true;
            }
            _ => return Err(TransportError::InvalidResponse),
        }
        Ok(())
    }
    fn block(&mut self, event: &Value) -> Result<&mut Block, TransportError> {
        let index = event["index"]
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .ok_or(TransportError::InvalidResponse)?;
        self.blocks
            .get_mut(index)
            .ok_or(TransportError::InvalidResponse)
    }
    fn merge_usage(&mut self, usage: &Value) -> Result<(), TransportError> {
        for (key, value) in usage.as_object().ok_or(TransportError::InvalidResponse)? {
            if [
                "input_tokens",
                "output_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            ]
            .contains(&key.as_str())
            {
                let count = value.as_u64().ok_or(TransportError::InvalidResponse)?;
                if self
                    .usage
                    .get(key)
                    .and_then(Value::as_u64)
                    .is_some_and(|old| count < old)
                {
                    return Err(TransportError::InvalidResponse);
                }
            }
            self.usage.insert(key.clone(), value.clone());
        }
        Ok(())
    }
    pub fn finish(self, interrupted: Option<&str>) -> Completion {
        let terminal = self.done && !self.poisoned && interrupted.is_none();
        let blocks: Vec<_> = self.blocks.iter().map(|b| b.value.clone()).collect();
        let parsed = assistant(&json!(blocks), true);
        let has_tools = parsed
            .as_ref()
            .is_ok_and(|v| v.iter().any(|b| matches!(b, Content::ToolCall { .. })));
        let mut status = CompletionStatus::Incomplete;
        let mut error = interrupted.map(str::to_owned);
        if self.poisoned {
            status = CompletionStatus::Failed;
            error = Some("invalid or unsupported Anthropic stream".into());
        } else if terminal {
            match self.reason.as_deref() {
                Some("end_turn" | "stop_sequence" | "refusal") if !has_tools => {
                    status = CompletionStatus::Completed
                }
                Some("tool_use") if has_tools => status = CompletionStatus::Completed,
                Some("max_tokens" | "pause_turn" | "model_context_window_exceeded") => {
                    error = Some("Anthropic completion is incomplete".into())
                }
                _ => {
                    status = CompletionStatus::Failed;
                    error = Some("contradictory Anthropic stop reason".into());
                }
            }
        } else if error.is_none() {
            error = Some("Anthropic stream ended without message_stop".into());
        }
        let mut content = Vec::new();
        if status == CompletionStatus::Completed {
            match parsed {
                Ok(items) => content = items,
                Err(_) => {
                    status = CompletionStatus::Failed;
                    error = Some("invalid completed Anthropic content".into());
                }
            }
            if self.reason.as_deref() == Some("refusal") {
                content = content
                    .into_iter()
                    .map(|b| match b {
                        Content::Text { text } => Content::Refusal { text },
                        other => other,
                    })
                    .collect();
            }
        }
        // Anthropic input excludes cache read/write. Normalized input includes
        // both, while cached_input is only reads. Cache-write premiums cannot
        // be represented by current Rates, so they NEVER receive final billing.
        let cache_read = self
            .usage
            .get("cache_read_input_tokens")
            .map_or(Some(0), Value::as_u64);
        let cache_write = self
            .usage
            .get("cache_creation_input_tokens")
            .map_or(Some(0), Value::as_u64);
        let usage = (|| {
            Some(Usage {
                input_tokens: self
                    .usage
                    .get("input_tokens")?
                    .as_u64()?
                    .checked_add(cache_read?)?
                    .checked_add(cache_write?)?,
                output_tokens: self.usage.get("output_tokens")?.as_u64()?,
                cached_input_tokens: cache_read?,
            })
        })();
        let known_cost_dimensions = self.usage.iter().all(|(key, value)| match key.as_str() {
            "input_tokens"
            | "output_tokens"
            | "cache_read_input_tokens"
            | "cache_creation_input_tokens" => true,
            "cache_creation" => zero_counts(
                value,
                &["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
            ),
            "server_tool_use" => zero_counts(value, &["web_fetch_requests", "web_search_requests"]),
            "service_tier" => value.is_null() || value == "standard",
            "inference_geo" => value.is_null() || value == "global" || value == "not_available",
            "output_tokens_details" => {
                value.is_null()
                    || value.as_object().is_some_and(|details| {
                        details.iter().all(|(name, count)| {
                            name == "thinking_tokens"
                                && count
                                    .as_u64()
                                    .zip(self.usage.get("output_tokens").and_then(Value::as_u64))
                                    .is_some_and(|(thinking, total)| thinking <= total)
                        })
                    })
            }
            _ => false,
        });
        let representable = cache_write == Some(0) && known_cost_dimensions;
        if terminal && self.final_usage && !representable && error.is_none() {
            error=Some("final provider usage includes unsupported billing dimensions; reservation requires reconciliation".into());
        }
        let replay = if status == CompletionStatus::Completed {
            vec![
                json!({"type":"anthropic_message","model":self.model,"message":{"role":"assistant","content":blocks},"usage":self.usage}),
            ]
        } else {
            vec![
                json!({"type":"anthropic_incomplete","model":self.model,"blocks":self.blocks.iter().enumerate().map(|(index,b)|json!({"index":index,"block":b.value,"partial_json":b.json,"closed":b.closed})).collect::<Vec<_>>(),"usage":self.usage}),
            ]
        };
        Completion {
            status,
            response_id: self.id,
            content,
            usage_is_final: terminal && self.final_usage && representable && usage.is_some(),
            usage,
            replay,
            error,
        }
    }
}

fn zero_counts(value: &Value, names: &[&str]) -> bool {
    value.is_null()
        || value.as_object().is_some_and(|counts| {
            counts
                .iter()
                .all(|(name, count)| names.contains(&name.as_str()) && count.as_u64() == Some(0))
        })
}
