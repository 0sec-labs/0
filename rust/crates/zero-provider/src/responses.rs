use crate::{Completion, CompletionStatus, Content, TransportError, Usage};
use serde_json::Value;

#[derive(Default)]
pub(crate) struct Accumulator {
    response: Option<Value>,
    terminal: bool,
    failure: Option<String>,
    usage: Option<Usage>,
    usage_is_final: bool,
}
impl Accumulator {
    pub fn event(&mut self, data: &[u8]) -> Result<(), TransportError> {
        if data == b"[DONE]" {
            return Ok(());
        }
        let event: Value =
            serde_json::from_slice(data).map_err(|_| TransportError::InvalidResponse)?;
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or(TransportError::InvalidResponse)?;
        if self.terminal {
            return Err(TransportError::InvalidResponse);
        }
        if let Some(response) = event.get("response") {
            if let Some(usage) = response.get("usage").filter(|v| !v.is_null()) {
                self.usage = Some(parse_usage(usage)?);
            }
            if let Some(id) = response.get("id").and_then(Value::as_str) {
                if self
                    .response
                    .as_ref()
                    .and_then(|r| r.get("id"))
                    .and_then(Value::as_str)
                    .is_some_and(|prior| prior != id)
                {
                    return Err(TransportError::InvalidResponse);
                }
            }
        }
        match kind {
            "response.completed" | "response.failed" | "response.incomplete" => {
                let response = event
                    .get("response")
                    .filter(|r| r.is_object())
                    .ok_or(TransportError::InvalidResponse)?;
                let expected = kind.strip_prefix("response.").unwrap_or_default();
                if response.get("status").and_then(Value::as_str) != Some(expected) {
                    return Err(TransportError::InvalidResponse);
                }
                self.usage_is_final = response.get("usage").is_some_and(|usage| !usage.is_null());
                self.response = Some(response.clone());
                self.terminal = true;
            }
            "error" | "response.error" => {
                self.failure = Some("provider stream reported an error".into());
                self.terminal = true;
            }
            "response.created" | "response.in_progress" => {
                self.response = event.get("response").cloned();
            }
            // Text and argument deltas are provisional. Only a terminal response
            // authorizes returning tool calls for subsequent validation.
            _ => {}
        }
        Ok(())
    }
    pub fn finish(self, interrupted: Option<&str>) -> Completion {
        let response = self.response.unwrap_or(Value::Null);
        let mut status = match response.get("status").and_then(Value::as_str) {
            Some("completed")
                if self.terminal && interrupted.is_none() && self.failure.is_none() =>
            {
                CompletionStatus::Completed
            }
            Some("failed") => CompletionStatus::Failed,
            _ => CompletionStatus::Incomplete,
        };
        let mut error = interrupted.map(str::to_owned).or(self.failure);
        if !self.terminal && error.is_none() {
            error = Some("stream ended without a terminal response".into());
        }
        let replay = response
            .get("output")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut content = Vec::new();
        if status == CompletionStatus::Completed
            && response.get("output").and_then(Value::as_array).is_none()
        {
            status = CompletionStatus::Failed;
            error = Some("completed response is missing output items".into());
        }
        if status == CompletionStatus::Completed {
            match parse_output(&replay) {
                Ok(parsed) => content = parsed,
                Err(_) => {
                    status = CompletionStatus::Failed;
                    error = Some("invalid completed provider output".into());
                }
            }
        }
        Completion {
            status,
            response_id: response
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            content,
            usage: self.usage,
            usage_is_final: self.usage_is_final,
            replay,
            error,
        }
    }
}
fn parse_usage(value: &Value) -> Result<Usage, TransportError> {
    let input_tokens = value
        .get("input_tokens")
        .and_then(Value::as_u64)
        .ok_or(TransportError::InvalidResponse)?;
    let output_tokens = value
        .get("output_tokens")
        .and_then(Value::as_u64)
        .ok_or(TransportError::InvalidResponse)?;
    let cached_input_tokens = match value.pointer("/input_tokens_details/cached_tokens") {
        Some(v) => v.as_u64().ok_or(TransportError::InvalidResponse)?,
        None => 0,
    };
    if cached_input_tokens > input_tokens {
        return Err(TransportError::InvalidResponse);
    }
    Ok(Usage {
        input_tokens,
        output_tokens,
        cached_input_tokens,
    })
}
fn parse_output(items: &[Value]) -> Result<Vec<Content>, TransportError> {
    let mut output = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for item in items {
        match item
            .get("type")
            .and_then(Value::as_str)
            .ok_or(TransportError::InvalidResponse)?
        {
            "message" => {
                for block in item
                    .get("content")
                    .and_then(Value::as_array)
                    .ok_or(TransportError::InvalidResponse)?
                {
                    match block.get("type").and_then(Value::as_str) {
                        Some("output_text") => output.push(Content::Text {
                            text: string(block, "text")?,
                        }),
                        Some("refusal") => output.push(Content::Refusal {
                            text: string(block, "refusal")?,
                        }),
                        _ => return Err(TransportError::InvalidResponse),
                    }
                }
            }
            "function_call" => {
                if item
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s != "completed")
                {
                    return Err(TransportError::InvalidResponse);
                }
                let id = string(item, "call_id")?;
                let name = string(item, "name")?;
                if id.is_empty() || name.is_empty() || !ids.insert(id.clone()) {
                    return Err(TransportError::InvalidResponse);
                }
                let arguments: Value = serde_json::from_str(&string(item, "arguments")?)
                    .map_err(|_| TransportError::InvalidResponse)?;
                if !arguments.is_object() {
                    return Err(TransportError::InvalidResponse);
                }
                output.push(Content::ToolCall {
                    id,
                    name,
                    arguments,
                });
            }
            "reasoning" => {} // Kept verbatim in replay.
            _ => return Err(TransportError::InvalidResponse),
        }
    }
    Ok(output)
}
fn string(value: &Value, key: &str) -> Result<String, TransportError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(TransportError::InvalidResponse)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn terminal(status: &str, output: Value) -> Value {
        serde_json::json!({"type":format!("response.{status}"),"response":{"id":"r1","status":status,"output":output,"usage":{"input_tokens":10,"output_tokens":3,"input_tokens_details":{"cached_tokens":4}}}})
    }
    #[test]
    fn incomplete_and_truncated_streams_cannot_promote_tools_but_retain_usage() {
        let tool = serde_json::json!({"type":"function_call","call_id":"c1","name":"inspect","arguments":"{}"});
        let mut accumulator = Accumulator::default();
        accumulator
            .event(&serde_json::to_vec(&terminal("incomplete", serde_json::json!([tool]))).unwrap())
            .unwrap();
        let result = accumulator.finish(None);
        assert_eq!(result.status, CompletionStatus::Incomplete);
        assert!(result.content.is_empty());
        assert_eq!(result.usage.unwrap().input_tokens, 10);
        let mut accumulator = Accumulator::default();
        accumulator.event(br#"{"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"inspect","arguments":"{}"}}"#).unwrap();
        assert!(accumulator.finish(None).content.is_empty());
    }
    #[test]
    fn completed_output_keeps_reasoning_and_rejects_malformed_arguments() {
        let reasoning =
            serde_json::json!({"type":"reasoning","encrypted_content":"opaque","summary":[]});
        let tool = serde_json::json!({"type":"function_call","call_id":"c1","name":"inspect","arguments":"{\"path\":\"README\"}"});
        let mut accumulator = Accumulator::default();
        accumulator
            .event(
                &serde_json::to_vec(&terminal("completed", serde_json::json!([reasoning, tool])))
                    .unwrap(),
            )
            .unwrap();
        let result = accumulator.finish(None);
        assert_eq!(result.status, CompletionStatus::Completed);
        assert_eq!(result.replay[0], reasoning);
        assert_eq!(result.content.len(), 1);
        for arguments in ["{", "[]", "null"] {
            let mut bad = tool.clone();
            bad["arguments"] = Value::String(arguments.into());
            let mut accumulator = Accumulator::default();
            accumulator
                .event(
                    &serde_json::to_vec(&terminal("completed", serde_json::json!([bad]))).unwrap(),
                )
                .unwrap();
            let result = accumulator.finish(None);
            assert_eq!(result.status, CompletionStatus::Failed);
            assert!(result.content.is_empty());
            assert!(result.usage.is_some());
        }
    }
}
