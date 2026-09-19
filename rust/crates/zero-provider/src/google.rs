//! Gemini native contents. Raw thought signatures remain on their original parts.
use crate::anthropic::{keys, string};
use crate::{Content, ResponsesRequest, TransportError};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn validate_route(url: &reqwest::Url, model: &str) -> Result<(), TransportError> {
    if model.is_empty()
        || model.len() > 256
        || !model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        || !url
            .path()
            .ends_with(&format!("/models/{model}:streamGenerateContent"))
    {
        return Err(TransportError::InvalidRequest);
    }
    Ok(())
}

pub(super) fn call_id(
    call: &Value,
    response: &str,
    index: usize,
) -> Result<String, TransportError> {
    if let Some(id) = call.get("id") {
        let id = id
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 1024)
            .ok_or(TransportError::InvalidResponse)?;
        return Ok(id.to_owned());
    }
    if response.is_empty() || response.len() > 512 {
        return Err(TransportError::InvalidResponse);
    }
    Ok(format!("google:{response}:{index}"))
}

/// The returned IDs are local correlation values; synthesized IDs are never
/// injected into a signed upstream functionCall.
pub(super) fn assistant(parts: &[Value], response: &str) -> Result<Vec<Content>, TransportError> {
    assistant_from(parts, response, 0)
}

pub(super) fn assistant_from(
    parts: &[Value],
    response: &str,
    call_offset: usize,
) -> Result<Vec<Content>, TransportError> {
    if parts.len() > 4096 {
        return Err(TransportError::InvalidResponse);
    }
    let mut content = Vec::new();
    let mut ids = BTreeSet::new();
    for part in parts {
        keys(
            part,
            &["text", "thought", "thoughtSignature", "functionCall"],
        )?;
        if let Some(signature) = part.get("thoughtSignature") {
            if signature.as_str().is_none_or(|s| s.is_empty()) {
                return Err(TransportError::InvalidResponse);
            }
        }
        if part.get("thought").is_some_and(|v| !v.is_boolean()) {
            return Err(TransportError::InvalidResponse);
        }
        match (part.get("text"), part.get("functionCall")) {
            (Some(text), None) => {
                let text = text.as_str().ok_or(TransportError::InvalidResponse)?;
                if part["thought"] != true {
                    content.push(Content::Text { text: text.into() });
                }
            }
            (None, Some(call)) => {
                if part["thought"] == true || ids.len().saturating_add(call_offset) >= 256 {
                    return Err(TransportError::InvalidResponse);
                }
                keys(call, &["id", "name", "args"])?;
                let name = string(call, "name")?;
                if name.is_empty()
                    || name.len() > 64
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    || !call["args"].is_object()
                {
                    return Err(TransportError::InvalidResponse);
                }
                let id = call_id(call, response, call_offset + ids.len())?;
                if !ids.insert(id.clone()) {
                    return Err(TransportError::InvalidResponse);
                }
                content.push(Content::ToolCall {
                    id,
                    name: name.into(),
                    arguments: call["args"].clone(),
                });
            }
            (None, None) if part.get("thoughtSignature").is_some() => (),
            _ => return Err(TransportError::InvalidResponse),
        }
    }
    Ok(content)
}

pub(crate) fn encode(request: &ResponsesRequest) -> Result<Value, TransportError> {
    crate::request_body(request)?;
    let mut contents = Vec::<Value>::new();
    let mut pending = BTreeMap::<String, (String, Option<String>)>::new();
    let mut seen = BTreeSet::new();
    for item in &request.input {
        if item["type"] == "function_call_output" {
            keys(item, &["type", "call_id", "output"])?;
            let id = string(item, "call_id")?;
            let (name, upstream) = pending.remove(id).ok_or(TransportError::InvalidRequest)?;
            let mut result = json!({"name":name,"response":{"content":string(item,"output")?}});
            if let Some(id) = upstream {
                result["id"] = json!(id);
            }
            let part = json!({"functionResponse":result});
            if contents.last().is_some_and(|v| {
                v["role"] == "user" && v["parts"][0].get("functionResponse").is_some()
            }) {
                contents
                    .last_mut()
                    .and_then(|v| v["parts"].as_array_mut())
                    .ok_or(TransportError::InvalidRequest)?
                    .push(part);
            } else {
                contents.push(json!({"role":"user","parts":[part]}));
            }
            continue;
        }
        if !pending.is_empty() {
            return Err(TransportError::InvalidRequest);
        }
        match item.get("type").and_then(Value::as_str) {
            Some("google_content") => {
                keys(
                    item,
                    &["type", "model", "response_id", "content", "call_ids"],
                )?;
                if item["model"] != request.model || item["content"]["role"] != "model" {
                    return Err(TransportError::InvalidRequest);
                }
                keys(&item["content"], &["role", "parts"])?;
                let parts = item["content"]["parts"]
                    .as_array()
                    .ok_or(TransportError::InvalidRequest)?;
                let response = string(item, "response_id")?;
                let parsed = assistant(parts, response)?;
                let ids: Vec<_> = parsed
                    .iter()
                    .filter_map(|c| {
                        if let Content::ToolCall { id, .. } = c {
                            Some(id)
                        } else {
                            None
                        }
                    })
                    .collect();
                if serde_json::to_value(&ids).map_err(|_| TransportError::InvalidRequest)?
                    != item["call_ids"]
                {
                    return Err(TransportError::InvalidRequest);
                }
                let mut index = 0;
                for part in parts {
                    if let Some(call) = part.get("functionCall") {
                        let id = call_id(call, response, index)?;
                        index += 1;
                        if !seen.insert(id.clone()) {
                            return Err(TransportError::InvalidRequest);
                        }
                        pending.insert(
                            id,
                            (
                                string(call, "name")?.into(),
                                call.get("id").and_then(Value::as_str).map(str::to_owned),
                            ),
                        );
                    }
                }
                contents.push(item["content"].clone());
            }
            None | Some("message") => {
                keys(item, &["type", "role", "content"])?;
                let role = match string(item, "role")? {
                    "user" => "user",
                    "assistant" => "model",
                    _ => return Err(TransportError::InvalidRequest),
                };
                let mut parts = Vec::new();
                if let Some(text) = item["content"].as_str() {
                    parts.push(json!({"text":text}));
                } else {
                    for block in item["content"]
                        .as_array()
                        .ok_or(TransportError::InvalidRequest)?
                    {
                        keys(block, &["type", "text"])?;
                        if ![
                            "text",
                            if role == "user" {
                                "input_text"
                            } else {
                                "output_text"
                            },
                        ]
                        .contains(&string(block, "type")?)
                        {
                            return Err(TransportError::InvalidRequest);
                        }
                        parts.push(json!({"text":string(block,"text")?}));
                    }
                }
                if parts.is_empty() {
                    return Err(TransportError::InvalidRequest);
                }
                contents.push(json!({"role":role,"parts":parts}));
            }
            // No lossy fallback from another provider's signed replay or a
            // fabricated bare tool call. Completed native replies supply replay.
            _ => return Err(TransportError::InvalidRequest),
        }
    }
    if !pending.is_empty()
        || contents.is_empty()
        || contents.last().is_none_or(|v| v["role"] != "user")
    {
        return Err(TransportError::InvalidRequest);
    }
    let mut body = json!({"contents":contents,"systemInstruction":{"parts":[{"text":request.instructions}]},"generationConfig":{"maxOutputTokens":request.max_output_tokens,"candidateCount":1}});
    if !request.tools.is_empty() {
        body["tools"] = json!([{"functionDeclarations":request.tools.iter().map(|t|json!({"name":t.name,"description":t.description,"parametersJsonSchema":t.parameters})).collect::<Vec<_>>()}]);
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
