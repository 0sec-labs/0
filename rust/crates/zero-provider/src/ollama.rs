//! Native text/function Ollama /api/chat codec; replay carries local correlation IDs.
use crate::anthropic::{keys, string};
use crate::{Content, ResponsesRequest, TransportError};
use serde_json::{Value, json};
use std::collections::{BTreeSet, VecDeque};
pub(super) fn call_id(request: &str, index: usize) -> String {
    format!("ollama:{request}:{index}")
}
pub(super) fn assistant(message: &Value, request: &str) -> Result<Vec<Content>, TransportError> {
    keys(message, &["role", "content", "thinking", "tool_calls"])?;
    if message["role"] != "assistant"
        || request.len() != 64
        || !request
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(TransportError::InvalidResponse);
    }
    let mut content = vec![];
    if let Some(text) = message.get("content") {
        let text = text.as_str().ok_or(TransportError::InvalidResponse)?;
        if !text.is_empty() {
            content.push(Content::Text { text: text.into() });
        }
    }
    if message.get("thinking").is_some_and(|v| !v.is_string()) {
        return Err(TransportError::InvalidResponse);
    }
    let mut indexes = BTreeSet::new();
    if let Some(calls) = message.get("tool_calls") {
        let calls = calls.as_array().ok_or(TransportError::InvalidResponse)?;
        if calls.len() > 256 {
            return Err(TransportError::ResponseLimit);
        }
        for (index, call) in calls.iter().enumerate() {
            keys(call, &["type", "function"])?;
            if call.get("type").is_some_and(|v| v != "function") {
                return Err(TransportError::InvalidResponse);
            }
            let function = &call["function"];
            keys(function, &["index", "name", "arguments", "description"])?;
            if function
                .get("description")
                .is_some_and(|v| v.as_str().is_none_or(|s| s.len() > 4096))
            {
                return Err(TransportError::InvalidResponse);
            }
            if let Some(i) = function.get("index") {
                if !indexes.insert(i.as_u64().ok_or(TransportError::InvalidResponse)?) {
                    return Err(TransportError::InvalidResponse);
                }
            }
            let name = string(function, "name")?;
            if name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err(TransportError::InvalidResponse);
            }
            let arguments = if let Some(raw) = function["arguments"].as_str() {
                serde_json::from_str(raw).map_err(|_| TransportError::InvalidResponse)?
            } else {
                function["arguments"].clone()
            };
            if !arguments.is_object() {
                return Err(TransportError::InvalidResponse);
            }
            content.push(Content::ToolCall {
                id: call_id(request, index),
                name: name.into(),
                arguments,
            });
        }
    }
    Ok(content)
}
pub(crate) fn encode(request: &ResponsesRequest) -> Result<Value, TransportError> {
    crate::request_body(request)?;
    let mut messages = vec![json!({"role":"system","content":request.instructions})];
    let mut pending = VecDeque::<(String, String)>::new();
    let mut seen = BTreeSet::new();
    for item in &request.input {
        if item["type"] == "function_call_output" {
            keys(item, &["type", "call_id", "output"])?;
            let (id, name) = pending.pop_front().ok_or(TransportError::InvalidRequest)?;
            if string(item, "call_id")? != id {
                return Err(TransportError::InvalidRequest);
            }
            messages.push(json!({"role":"tool","tool_name":name,"content":string(item,"output")?}));
            continue;
        }
        if !pending.is_empty() {
            return Err(TransportError::InvalidRequest);
        }
        match item.get("type").and_then(Value::as_str) {
            Some("ollama_message") => {
                keys(
                    item,
                    &[
                        "type",
                        "model",
                        "resolved_model",
                        "request_id",
                        "message",
                        "call_ids",
                    ],
                )?;
                if item["model"] != request.model || string(item, "resolved_model")?.is_empty() {
                    return Err(TransportError::InvalidRequest);
                }
                let parsed = assistant(&item["message"], string(item, "request_id")?)
                    .map_err(|_| TransportError::InvalidRequest)?;
                let mut ids = vec![];
                for block in parsed {
                    if let Content::ToolCall { id, name, .. } = block {
                        if !seen.insert(id.clone()) {
                            return Err(TransportError::InvalidRequest);
                        }
                        ids.push(id.clone());
                        pending.push_back((id, name));
                    }
                }
                if serde_json::to_value(ids).map_err(|_| TransportError::InvalidRequest)?
                    != item["call_ids"]
                {
                    return Err(TransportError::InvalidRequest);
                }
                let mut message = item["message"].clone();
                if let Some(calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
                    for call in calls {
                        if let Some(raw) = call["function"]["arguments"].as_str() {
                            call["function"]["arguments"] = serde_json::from_str(raw)
                                .map_err(|_| TransportError::InvalidRequest)?;
                        }
                    }
                }
                messages.push(message);
            }
            None | Some("message") => {
                keys(item, &["type", "role", "content"])?;
                let role = string(item, "role")?;
                if role != "user" && role != "assistant" {
                    return Err(TransportError::InvalidRequest);
                }
                let content = if let Some(text) = item["content"].as_str() {
                    text.to_owned()
                } else {
                    let mut text = String::new();
                    for part in item["content"]
                        .as_array()
                        .ok_or(TransportError::InvalidRequest)?
                    {
                        keys(part, &["type", "text"])?;
                        let kind = string(part, "type")?;
                        if !(kind == "text"
                            || role == "user" && kind == "input_text"
                            || role == "assistant" && kind == "output_text")
                        {
                            return Err(TransportError::InvalidRequest);
                        }
                        text.push_str(string(part, "text")?);
                    }
                    text
                };
                messages.push(json!({"role":role,"content":content}));
            }
            _ => return Err(TransportError::InvalidRequest),
        }
    }
    if !pending.is_empty() {
        return Err(TransportError::InvalidRequest);
    }
    let tools:Vec<_>=request.tools.iter().map(|t|json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.parameters}})).collect();
    let body = json!({"model":request.model,"messages":messages,"tools":tools,"stream":true,"options":{"num_predict":request.max_output_tokens}});
    if serde_json::to_vec(&body)
        .map_err(|_| TransportError::InvalidRequest)?
        .len()
        > 16 * 1024 * 1024
    {
        return Err(TransportError::InvalidRequest);
    }
    Ok(body)
}
