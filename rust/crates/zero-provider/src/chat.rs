//! Strict text/function Chat Completions codec. No retries or model execution.
//! Wire reference: https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions
//! Reasoning extensions are replay data, never visible text or tool authority.
use crate::{Completion, CompletionStatus, Content, ResponsesRequest, TransportError, Usage};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};

pub(crate) fn encode(request: &ResponsesRequest) -> Result<Value, TransportError> {
    crate::request_body(request)?;
    let mut messages = vec![json!({"role":"system","content":request.instructions})];
    for (position, item) in request.input.iter().enumerate() {
        match item.get("type").and_then(Value::as_str) {
            Some("chat_completion_message") => {
                keys(item, &["type", "model", "message"])?;
                if item.get("model").and_then(Value::as_str) != Some(&request.model) {
                    return Err(TransportError::InvalidRequest);
                }
                let message = item.get("message").ok_or(TransportError::InvalidRequest)?;
                validate_assistant(message).map_err(|_| TransportError::InvalidRequest)?;
                messages.push(message.clone());
            }
            Some("function_call") => {
                keys(item, &["type", "call_id", "name", "arguments"])?;
                let id = string(item, "call_id")?;
                let name = string(item, "name")?;
                let arguments = string(item, "arguments")?;
                if id.is_empty() || name.is_empty() {
                    return Err(TransportError::InvalidRequest);
                }
                valid_arguments(arguments).map_err(|_| TransportError::InvalidRequest)?;
                let call = json!({"id":id,"type":"function","function":{"name":name,"arguments":arguments}});
                // Responses consecutive function items form ONE assistant turn.
                if let Some(last) = messages.last_mut().filter(|_| {
                    position > 0 && request.input[position - 1]["type"] == "function_call"
                }) {
                    let object = last.as_object_mut().ok_or(TransportError::InvalidRequest)?;
                    object
                        .entry("tool_calls")
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .ok_or(TransportError::InvalidRequest)?
                        .push(call);
                } else {
                    messages.push(json!({"role":"assistant","content":null,"tool_calls":[call]}));
                }
            }
            Some("function_call_output") => {
                keys(item, &["type", "call_id", "output"])?;
                messages.push(json!({"role":"tool","tool_call_id":string(item,"call_id")?,"content":string(item,"output")?}));
            }
            None | Some("message") => {
                keys(item, &["type", "role", "content"])?;
                let role = string(item, "role")?;
                if role != "user" && role != "assistant" {
                    return Err(TransportError::InvalidRequest);
                }
                let value = item.get("content").ok_or(TransportError::InvalidRequest)?;
                let content = if value.is_string() {
                    value.clone()
                } else {
                    let mut parts = vec![];
                    for block in value.as_array().ok_or(TransportError::InvalidRequest)? {
                        keys(block, &["type", "text"])?;
                        let kind = string(block, "type")?;
                        if !(kind == "text"
                            || (role == "user" && kind == "input_text")
                            || (role == "assistant" && kind == "output_text"))
                        {
                            return Err(TransportError::InvalidRequest);
                        }
                        parts.push(json!({"type":"text","text":string(block,"text")?}));
                    }
                    Value::Array(parts)
                };
                messages.push(json!({"role":role,"content":content}));
            }
            _ => return Err(TransportError::InvalidRequest),
        }
    }
    // Chat requires every outstanding call answered exactly once before a new turn.
    let mut pending = HashSet::new();
    let mut ids = HashSet::new();
    for message in &messages {
        if message["role"] == "tool" {
            if !pending.remove(string(message, "tool_call_id")?) {
                return Err(TransportError::InvalidRequest);
            }
        } else {
            if !pending.is_empty() {
                return Err(TransportError::InvalidRequest);
            }
            if message["role"] == "assistant" {
                for call in message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let id = string(call, "id")?;
                    if id.is_empty() || !ids.insert(id.to_owned()) {
                        return Err(TransportError::InvalidRequest);
                    }
                    pending.insert(id.to_owned());
                }
            }
        }
    }
    if !pending.is_empty() {
        return Err(TransportError::InvalidRequest);
    }
    let tools:Vec<_> = request.tools.iter().map(|t|json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.parameters,"strict":false}})).collect();
    let body = json!({"model":request.model,"messages":messages,"tools":tools,"max_completion_tokens":request.max_output_tokens,"stream":true,"stream_options":{"include_usage":true},"n":1});
    if serde_json::to_vec(&body)
        .map_err(|_| TransportError::InvalidRequest)?
        .len()
        > 16 * 1024 * 1024
    {
        return Err(TransportError::InvalidRequest);
    }
    Ok(body)
}
fn keys(value: &Value, allowed: &[&str]) -> Result<(), TransportError> {
    if value
        .as_object()
        .ok_or(TransportError::InvalidRequest)?
        .keys()
        .any(|k| !allowed.contains(&k.as_str()))
    {
        return Err(TransportError::InvalidRequest);
    }
    Ok(())
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, TransportError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(TransportError::InvalidRequest)
}
fn valid_arguments(arguments: &str) -> Result<Value, TransportError> {
    let value: Value =
        serde_json::from_str(arguments).map_err(|_| TransportError::InvalidResponse)?;
    if !value.is_object() {
        return Err(TransportError::InvalidResponse);
    }
    Ok(value)
}
fn validate_assistant(message: &Value) -> Result<Vec<Content>, TransportError> {
    keys(
        message,
        &[
            "role",
            "content",
            "refusal",
            "tool_calls",
            "reasoning_content",
            "reasoning_details",
        ],
    )?;
    if message["role"] != "assistant" {
        return Err(TransportError::InvalidResponse);
    }
    let mut content = vec![];
    for (field, refusal) in [("content", false), ("refusal", true)] {
        if let Some(value) = message.get(field).filter(|v| !v.is_null()) {
            if field == "content" && value.is_array() {
                for part in value.as_array().ok_or(TransportError::InvalidResponse)? {
                    keys(part, &["type", "text"])?;
                    if part["type"] != "text" {
                        return Err(TransportError::InvalidResponse);
                    }
                    content.push(Content::Text {
                        text: string(part, "text")?.into(),
                    });
                }
            } else {
                let text = value
                    .as_str()
                    .ok_or(TransportError::InvalidResponse)?
                    .to_owned();
                content.push(if refusal {
                    Content::Refusal { text }
                } else {
                    Content::Text { text }
                });
            }
        }
    }
    if message
        .get("reasoning_content")
        .is_some_and(|v| !v.is_null() && !v.is_string())
        || message
            .get("reasoning_details")
            .is_some_and(|v| !v.is_array())
    {
        return Err(TransportError::InvalidResponse);
    }
    let mut ids = HashSet::new();
    if let Some(calls) = message.get("tool_calls") {
        for call in calls.as_array().ok_or(TransportError::InvalidResponse)? {
            keys(call, &["id", "type", "function"])?;
            if call["type"] != "function" {
                return Err(TransportError::InvalidResponse);
            }
            let id = string(call, "id")?;
            let function = &call["function"];
            keys(function, &["name", "arguments"])?;
            let name = string(function, "name")?;
            if id.is_empty() || name.is_empty() || !ids.insert(id) {
                return Err(TransportError::InvalidResponse);
            }
            content.push(Content::ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: valid_arguments(string(function, "arguments")?)?,
            });
        }
    }
    Ok(content)
}

pub(crate) struct Accumulator {
    model: String,
    response_id: Option<String>,
    message: Map<String, Value>,
    tools: BTreeMap<u64, Value>,
    finish_reason: Option<String>,
    done: bool,
    usage: Option<Usage>,
    final_usage: bool,
    poisoned: bool,
    raw: Vec<Value>,
}
impl Accumulator {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.into(),
            response_id: None,
            message: Map::from_iter([
                ("role".into(), json!("assistant")),
                ("content".into(), Value::Null),
            ]),
            tools: BTreeMap::new(),
            finish_reason: None,
            done: false,
            usage: None,
            final_usage: false,
            poisoned: false,
            raw: vec![],
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
        if data == b"[DONE]" {
            self.done = true;
            return Ok(());
        }
        let chunk: Value =
            serde_json::from_slice(data).map_err(|_| TransportError::InvalidResponse)?;
        // Error bodies can echo credentials or gateway internals. Do not replay them.
        if chunk.get("error").is_some() {
            return Err(TransportError::InvalidResponse);
        }
        self.raw.push(chunk.clone());
        let id = string(&chunk, "id")?;
        if id.is_empty() || self.response_id.as_ref().is_some_and(|v| v != id) {
            return Err(TransportError::InvalidResponse);
        }
        self.response_id = Some(id.into());
        let choices = chunk["choices"]
            .as_array()
            .ok_or(TransportError::InvalidResponse)?;
        if let Some(usage) = chunk.get("usage").filter(|v| !v.is_null()) {
            let input_tokens = usage["prompt_tokens"]
                .as_u64()
                .ok_or(TransportError::InvalidResponse)?;
            let output_tokens = usage["completion_tokens"]
                .as_u64()
                .ok_or(TransportError::InvalidResponse)?;
            let cached_input_tokens = match usage.pointer("/prompt_tokens_details/cached_tokens") {
                Some(v) => v.as_u64().ok_or(TransportError::InvalidResponse)?,
                None => 0,
            };
            if cached_input_tokens > input_tokens {
                return Err(TransportError::InvalidResponse);
            }
            if self.final_usage {
                return Err(TransportError::InvalidResponse);
            }
            self.usage = Some(Usage {
                input_tokens,
                output_tokens,
                cached_input_tokens,
            });
            self.final_usage = choices.is_empty() && self.finish_reason.is_some();
        }
        if choices.is_empty() {
            return Ok(());
        }
        if choices.len() != 1 || choices[0]["index"] != 0 || self.finish_reason.is_some() {
            return Err(TransportError::InvalidResponse);
        }
        let choice = &choices[0];
        let delta = &choice["delta"];
        keys(
            delta,
            &[
                "role",
                "content",
                "refusal",
                "tool_calls",
                "reasoning_content",
                "reasoning_details",
            ],
        )?;
        if delta.get("role").is_some_and(|v| v != "assistant") {
            return Err(TransportError::InvalidResponse);
        }
        for field in ["content", "refusal", "reasoning_content"] {
            if let Some(value) = delta.get(field).filter(|v| !v.is_null()) {
                let fragment = value.as_str().ok_or(TransportError::InvalidResponse)?;
                let prior = self.message.entry(field).or_insert(Value::Null);
                if prior.is_null() {
                    *prior = Value::String(String::new());
                }
                prior.as_str().ok_or(TransportError::InvalidResponse)?;
                let mut text = prior
                    .as_str()
                    .ok_or(TransportError::InvalidResponse)?
                    .to_owned();
                text.push_str(fragment);
                *prior = Value::String(text);
            }
        }
        if let Some(details) = delta.get("reasoning_details").filter(|v| !v.is_null()) {
            if !details.is_array() || self.message.contains_key("reasoning_details") {
                return Err(TransportError::InvalidResponse);
            }
            self.message
                .insert("reasoning_details".into(), details.clone());
        }
        if let Some(calls) = delta.get("tool_calls").filter(|v| !v.is_null()) {
            for call in calls.as_array().ok_or(TransportError::InvalidResponse)? {
                keys(call, &["index", "id", "type", "function"])?;
                let index = call["index"]
                    .as_u64()
                    .filter(|v| *v < 256)
                    .ok_or(TransportError::InvalidResponse)?;
                let target = self
                    .tools
                    .entry(index)
                    .or_insert_with(|| json!({"function":{"arguments":""}}));
                for field in ["id", "type"] {
                    if let Some(value) = call.get(field) {
                        if !value.is_string() || target.get(field).is_some_and(|v| v != value) {
                            return Err(TransportError::InvalidResponse);
                        }
                        target[field] = value.clone();
                    }
                }
                if let Some(function) = call.get("function") {
                    keys(function, &["name", "arguments"])?;
                    if let Some(name) = function.get("name") {
                        if !name.is_string()
                            || target["function"].get("name").is_some_and(|v| v != name)
                        {
                            return Err(TransportError::InvalidResponse);
                        }
                        target["function"]["name"] = name.clone();
                    }
                    if let Some(args) = function.get("arguments") {
                        let mut text = target["function"]["arguments"]
                            .as_str()
                            .ok_or(TransportError::InvalidResponse)?
                            .to_owned();
                        text.push_str(args.as_str().ok_or(TransportError::InvalidResponse)?);
                        target["function"]["arguments"] = Value::String(text);
                    }
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").filter(|v| !v.is_null()) {
            self.finish_reason = Some(
                reason
                    .as_str()
                    .ok_or(TransportError::InvalidResponse)?
                    .into(),
            );
        }
        Ok(())
    }
    pub fn finish(mut self, interrupted: Option<&str>) -> Completion {
        if !self.tools.is_empty() {
            self.message.insert(
                "tool_calls".into(),
                Value::Array(self.tools.into_values().collect()),
            );
        }
        let mut status = CompletionStatus::Incomplete;
        let mut error = interrupted.map(str::to_owned);
        let mut content = vec![];
        if self.poisoned {
            status = CompletionStatus::Failed;
            error = Some("invalid or unsupported Chat Completions stream".into());
        } else if interrupted.is_none() && self.done {
            let has_tools = self.message.get("tool_calls").is_some();
            match self.finish_reason.as_deref() {
                Some("stop") if !has_tools => status = CompletionStatus::Completed,
                Some("tool_calls") if has_tools => status = CompletionStatus::Completed,
                Some("length" | "content_filter") => {
                    error = Some("provider completion was incomplete".into())
                }
                _ => {
                    status = CompletionStatus::Failed;
                    error = Some("missing or contradictory Chat finish reason".into());
                }
            }
        } else if error.is_none() {
            error = Some("Chat stream ended without DONE".into());
        }
        let message = Value::Object(self.message);
        if status == CompletionStatus::Completed {
            match validate_assistant(&message) {
                Ok(parsed) => content = parsed,
                Err(_) => {
                    status = CompletionStatus::Failed;
                    error = Some("invalid completed Chat output".into());
                }
            }
        }
        let replay = if status == CompletionStatus::Completed {
            vec![json!({"type":"chat_completion_message","model":self.model,"message":message})]
        } else {
            // Diagnostic only: deliberately rejected by encode, never executable replay.
            vec![json!({"type":"chat_completion_incomplete","model":self.model,"chunks":self.raw})]
        };
        Completion {
            status,
            response_id: self.response_id,
            content,
            usage: self.usage,
            usage_is_final: self.final_usage
                && self.done
                && !self.poisoned
                && interrupted.is_none(),
            replay,
            error,
        }
    }
}

#[cfg(test)]
#[path = "chat_tests.rs"]
mod tests;
