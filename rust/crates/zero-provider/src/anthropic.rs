//! Exact ordered Anthropic replay. Unsupported media/server tools fail closed.
use crate::{Content, ResponsesRequest, TransportError};
use serde_json::{Value, json};
use std::collections::HashSet;
pub(super) fn keys(value: &Value, allowed: &[&str]) -> Result<(), TransportError> {
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
pub(super) fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, TransportError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(TransportError::InvalidRequest)
}
pub(super) fn assistant(content: &Value, complete: bool) -> Result<Vec<Content>, TransportError> {
    let blocks = content.as_array().ok_or(TransportError::InvalidResponse)?;
    if blocks.len() > 256 {
        return Err(TransportError::InvalidResponse);
    }
    let mut output = Vec::new();
    let mut ids = HashSet::new();
    for block in blocks {
        match string(block, "type")? {
            "text" => {
                keys(block, &["type", "text", "citations"])?;
                if block
                    .get("citations")
                    .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty()))
                {
                    return Err(TransportError::InvalidRequest);
                }
                output.push(Content::Text {
                    text: string(block, "text")?.into(),
                });
            }
            "tool_use" => {
                keys(block, &["type", "id", "name", "input"])?;
                let id = string(block, "id")?;
                let name = string(block, "name")?;
                if id.is_empty()
                    || name.is_empty()
                    || !ids.insert(id)
                    || !block["input"].is_object()
                {
                    return Err(TransportError::InvalidRequest);
                }
                output.push(Content::ToolCall {
                    id: id.into(),
                    name: name.into(),
                    arguments: block["input"].clone(),
                });
            }
            "thinking" => {
                keys(block, &["type", "thinking", "signature"])?;
                string(block, "thinking")?;
                if complete && string(block, "signature")?.is_empty() {
                    return Err(TransportError::InvalidRequest);
                }
                string(block, "signature")?;
            }
            "redacted_thinking" => {
                keys(block, &["type", "data"])?;
                if string(block, "data")?.is_empty() {
                    return Err(TransportError::InvalidRequest);
                }
            }
            _ => return Err(TransportError::InvalidRequest),
        }
    }
    Ok(output)
}
pub(crate) fn encode(request: &ResponsesRequest) -> Result<Value, TransportError> {
    crate::request_body(request)?;
    let mut messages: Vec<Value> = Vec::new();
    for (position, item) in request.input.iter().enumerate() {
        match item.get("type").and_then(Value::as_str) {
            Some("anthropic_message") => {
                keys(item, &["type", "model", "message", "usage"])?;
                if item["model"] != request.model {
                    return Err(TransportError::InvalidRequest);
                }
                let message = &item["message"];
                keys(message, &["role", "content"])?;
                if message["role"] != "assistant" {
                    return Err(TransportError::InvalidRequest);
                }
                assistant(&message["content"], true)?;
                messages.push(message.clone());
            }
            Some("function_call") => {
                keys(item, &["type", "call_id", "name", "arguments"])?;
                let arguments: Value = serde_json::from_str(string(item, "arguments")?)
                    .map_err(|_| TransportError::InvalidRequest)?;
                let block = json!({"type":"tool_use","id":string(item,"call_id")?,"name":string(item,"name")?,"input":arguments});
                assistant(&json!([block]), true)?;
                if position > 0 && request.input[position - 1]["type"] == "function_call" {
                    messages
                        .last_mut()
                        .and_then(|v| v["content"].as_array_mut())
                        .ok_or(TransportError::InvalidRequest)?
                        .push(block);
                } else {
                    messages.push(json!({"role":"assistant","content":[block]}));
                }
            }
            Some("function_call_output") => {
                keys(item, &["type", "call_id", "output"])?;
                let block = json!({"type":"tool_result","tool_use_id":string(item,"call_id")?,"content":string(item,"output")?});
                if position > 0 && request.input[position - 1]["type"] == "function_call_output" {
                    messages
                        .last_mut()
                        .and_then(|v| v["content"].as_array_mut())
                        .ok_or(TransportError::InvalidRequest)?
                        .push(block);
                } else {
                    messages.push(json!({"role":"user","content":[block]}));
                }
            }
            None | Some("message") => {
                keys(item, &["type", "role", "content"])?;
                let role = string(item, "role")?;
                if !["user", "assistant"].contains(&role) {
                    return Err(TransportError::InvalidRequest);
                }
                let content = if let Some(text) = item["content"].as_str() {
                    json!([{"type":"text","text":text}])
                } else {
                    let mut converted = Vec::new();
                    for block in item["content"]
                        .as_array()
                        .ok_or(TransportError::InvalidRequest)?
                    {
                        keys(block, &["type", "text"])?;
                        let kind = string(block, "type")?;
                        if kind != "text"
                            && !(role == "user" && kind == "input_text")
                            && !(role == "assistant" && kind == "output_text")
                        {
                            return Err(TransportError::InvalidRequest);
                        }
                        converted.push(json!({"type":"text","text":string(block,"text")?}));
                    }
                    Value::Array(converted)
                };
                messages.push(json!({"role":role,"content":content}));
            }
            _ => return Err(TransportError::InvalidRequest),
        }
    }
    // Results must immediately follow their assistant turn, precede user text,
    // and match every outstanding call exactly once. Never drop opaque blocks.
    let mut pending = HashSet::new();
    let mut seen = HashSet::new();
    for message in &messages {
        let blocks = message["content"]
            .as_array()
            .ok_or(TransportError::InvalidRequest)?;
        if blocks.is_empty() {
            return Err(TransportError::InvalidRequest);
        }
        if message["role"] == "assistant" {
            if !pending.is_empty() {
                return Err(TransportError::InvalidRequest);
            }
            for block in blocks {
                if block["type"] == "tool_use" {
                    let id = string(block, "id")?;
                    if !seen.insert(id) {
                        return Err(TransportError::InvalidRequest);
                    }
                    pending.insert(id);
                }
            }
        } else {
            for block in blocks {
                if block["type"] == "tool_result" {
                    if !pending.remove(string(block, "tool_use_id")?) {
                        return Err(TransportError::InvalidRequest);
                    }
                } else if !pending.is_empty() {
                    return Err(TransportError::InvalidRequest);
                }
            }
            if !pending.is_empty() {
                return Err(TransportError::InvalidRequest);
            }
        }
    }
    if !pending.is_empty()
        || messages.first().is_none_or(|v| v["role"] != "user")
        || messages.last().is_none_or(|v| v["role"] != "user")
    {
        return Err(TransportError::InvalidRequest);
    }
    let tools: Vec<_> = request
        .tools
        .iter()
        .map(|t| json!({"name":t.name,"description":t.description,"input_schema":t.parameters}))
        .collect();
    let mut body = json!({"model":request.model,"system":request.instructions,"messages":messages,"max_tokens":request.max_output_tokens,"stream":true});
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    if serde_json::to_vec(&body)
        .map_err(|_| TransportError::InvalidRequest)?
        .len()
        > 16 * 1024 * 1024
    {
        return Err(TransportError::InvalidRequest);
    }
    Ok(body)
}
