use crate::{Error, Result};
use serde_json::Value;
use std::collections::BTreeSet;
fn invalid() -> Error {
    Error::Invalid("round replay or tool result correlation is invalid".into())
}
fn id(value: &Value) -> Result<String> {
    let id = value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or_else(invalid)?;
    Ok(id.into())
}
pub(super) fn validate(replay: &[Value], call_ids: &[String], outputs: &[Value]) -> Result<()> {
    if replay.is_empty() || call_ids.len() > 32 || call_ids.len() != outputs.len() {
        return Err(invalid());
    }
    let mut found = Vec::new();
    for item in replay {
        match item["type"].as_str() {
            Some("reasoning") => {
                if item.get("role").is_some() {
                    return Err(invalid());
                }
            }
            Some("message") => {
                if item.get("role").is_some_and(|role| role != "assistant") {
                    return Err(invalid());
                }
            }
            Some("function_call") => {
                if item.get("role").is_some() {
                    return Err(invalid());
                }
                found.push(id(&item["call_id"])?);
            }
            Some("chat_completion_message") => {
                if item["message"]["role"] != "assistant" {
                    return Err(invalid());
                }
                if let Some(calls) = item["message"].get("tool_calls").filter(|v| !v.is_null()) {
                    for call in calls.as_array().ok_or_else(invalid)? {
                        found.push(id(&call["id"])?);
                    }
                }
            }
            Some("google_content") => {
                if item["content"]["role"] != "model" {
                    return Err(invalid());
                }
                let parts = item["content"]["parts"].as_array().ok_or_else(invalid)?;
                let ids = item["call_ids"].as_array().ok_or_else(invalid)?;
                if parts
                    .iter()
                    .filter(|p| p.get("functionCall").is_some())
                    .count()
                    != ids.len()
                {
                    return Err(invalid());
                }
                for call in ids {
                    found.push(id(call)?);
                }
            }
            Some("anthropic_message") => {
                if item["message"]["role"] != "assistant" {
                    return Err(invalid());
                }
                for block in item["message"]["content"].as_array().ok_or_else(invalid)? {
                    match block["type"].as_str() {
                        Some("tool_use") => found.push(id(&block["id"])?),
                        Some("text" | "thinking" | "redacted_thinking") => (),
                        _ => return Err(invalid()),
                    }
                }
            }
            _ => return Err(invalid()),
        }
    }
    if found != call_ids || found.iter().collect::<BTreeSet<_>>().len() != found.len() {
        return Err(invalid());
    }
    for (expected, output) in call_ids.iter().zip(outputs) {
        if output.as_object().map(|v| v.len()) != Some(3)
            || output["type"] != "function_call_output"
            || output["call_id"] != *expected
            || !output["output"].is_string()
        {
            return Err(invalid());
        }
    }
    Ok(())
}
