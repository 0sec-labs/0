//! Bounded NDJSON with a single terminal chat frame and explicit final usage.
use crate::{Completion, CompletionStatus, Content, ResponsesRequest, TransportError, Usage};
use serde_json::{Value, json};
#[derive(Default)]
pub(crate) struct Decoder {
    line: Vec<u8>,
}
impl Decoder {
    pub fn has_pending(&self) -> bool {
        !self.line.is_empty()
    }
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, TransportError> {
        let mut frames = vec![];
        for byte in bytes {
            if *byte == b'\n' {
                if self.line.last() == Some(&b'\r') {
                    self.line.pop();
                }
                if self.line.is_empty() {
                    return Err(TransportError::InvalidResponse);
                }
                frames.push(std::mem::take(&mut self.line));
            } else {
                if self.line.len() >= 1024 * 1024 {
                    return Err(TransportError::ResponseLimit);
                }
                self.line.push(*byte);
            }
        }
        Ok(frames)
    }
}
pub(crate) struct Accumulator {
    model: String,
    resolved: Option<String>,
    request_id: String,
    message: Value,
    done: bool,
    reason: Option<String>,
    usage: Option<Usage>,
    poisoned: bool,
    indexes: std::collections::BTreeSet<u64>,
}
impl Accumulator {
    pub fn new(request: &ResponsesRequest) -> Result<Self, TransportError> {
        use sha2::{Digest, Sha256};
        let bytes = serde_json::to_vec(request).map_err(|_| TransportError::InvalidRequest)?;
        Ok(Self {
            model: request.model.clone(),
            resolved: None,
            request_id: format!("{:x}", Sha256::digest(bytes)),
            message: json!({"role":"assistant","content":"","thinking":"","tool_calls":[]}),
            done: false,
            reason: None,
            usage: None,
            poisoned: false,
            indexes: std::collections::BTreeSet::new(),
        })
    }
    pub fn event(&mut self, data: &[u8]) -> Result<(), TransportError> {
        let result = self.apply(data);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn apply(&mut self, data: &[u8]) -> Result<(), TransportError> {
        if self.poisoned || self.done {
            return Err(TransportError::InvalidResponse);
        }
        let event: Value =
            serde_json::from_slice(data).map_err(|_| TransportError::InvalidResponse)?;
        if !event.is_object() || event.get("error").is_some() {
            return Err(TransportError::InvalidResponse);
        }
        let model = event["model"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or(TransportError::InvalidResponse)?;
        if self.resolved.as_ref().is_some_and(|v| v != model) {
            return Err(TransportError::InvalidResponse);
        }
        self.resolved = Some(model.into());
        let done = event["done"]
            .as_bool()
            .ok_or(TransportError::InvalidResponse)?;
        if let Some(message) = event.get("message") {
            crate::anthropic::keys(message, &["role", "content", "thinking", "tool_calls"])?;
            if message["role"] != "assistant" {
                return Err(TransportError::InvalidResponse);
            }
            for key in ["content", "thinking"] {
                if let Some(text) = message.get(key) {
                    let text = text.as_str().ok_or(TransportError::InvalidResponse)?;
                    let Value::String(target) = &mut self.message[key] else {
                        return Err(TransportError::InvalidResponse);
                    };
                    target.push_str(text);
                }
            }
            crate::ollama::assistant(message, &self.request_id)?;
            if let Some(calls) = message.get("tool_calls") {
                let calls = calls.as_array().ok_or(TransportError::InvalidResponse)?;
                for call in calls {
                    if let Some(index) = call["function"].get("index") {
                        if !self
                            .indexes
                            .insert(index.as_u64().ok_or(TransportError::InvalidResponse)?)
                        {
                            return Err(TransportError::InvalidResponse);
                        }
                    }
                }
                let target = self.message["tool_calls"]
                    .as_array_mut()
                    .ok_or(TransportError::InvalidResponse)?;
                if target.len() + calls.len() > 256 {
                    return Err(TransportError::ResponseLimit);
                }
                target.extend(calls.iter().cloned());
            }
        } else if !done {
            return Err(TransportError::InvalidResponse);
        }
        if done {
            self.done = true;
            self.reason = Some(
                event["done_reason"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or(TransportError::InvalidResponse)?
                    .into(),
            );
            let input = event.get("prompt_eval_count").and_then(Value::as_u64);
            let output = event.get("eval_count").and_then(Value::as_u64);
            let cached = match event.get("prompt_eval_cached_count") {
                Some(v) => Some(v.as_u64().ok_or(TransportError::InvalidResponse)?),
                None => Some(0),
            };
            if let (Some(input), Some(output), Some(cached)) = (input, output, cached) {
                if cached > input {
                    return Err(TransportError::InvalidResponse);
                }
                self.usage = Some(Usage {
                    input_tokens: input,
                    output_tokens: output,
                    cached_input_tokens: cached,
                });
            }
        } else if [
            "prompt_eval_count",
            "eval_count",
            "prompt_eval_cached_count",
            "done_reason",
        ]
        .iter()
        .any(|key| event.get(*key).is_some())
        {
            return Err(TransportError::InvalidResponse);
        }
        Ok(())
    }
    pub fn finish(self, interrupted: Option<&str>) -> Completion {
        let validated = crate::ollama::assistant(&self.message, &self.request_id);
        let complete = validated.is_ok()
            && interrupted.is_none()
            && !self.poisoned
            && self.done
            && self.reason.as_deref() == Some("stop")
            && self.usage.is_some();
        let content = if complete {
            validated.unwrap_or_default()
        } else {
            vec![]
        };
        let call_ids: Vec<_> = content
            .iter()
            .filter_map(|c| match c {
                Content::ToolCall { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        Completion {
            status: if complete {
                CompletionStatus::Completed
            } else {
                CompletionStatus::Incomplete
            },
            response_id: None,
            content,
            usage: self.usage,
            usage_is_final: complete,
            replay: vec![
                json!({"type":if complete{"ollama_message"}else{"ollama_incomplete"},"model":self.model,"resolved_model":self.resolved.unwrap_or_default(),"request_id":self.request_id,"message":self.message,"call_ids":call_ids}),
            ],
            error: if complete {
                None
            } else {
                Some(
                    interrupted
                        .unwrap_or("Ollama completion or final usage is incomplete")
                        .into(),
                )
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decoder_preserves_every_utf8_split_and_crlf() {
        let bytes = "{\"text\":\"€漢\"}\r\n{\"done\":true}\n".as_bytes();
        for split in 0..=bytes.len() {
            let mut decoder = Decoder::default();
            let mut frames = decoder.feed(&bytes[..split]).unwrap();
            frames.extend(decoder.feed(&bytes[split..]).unwrap());
            assert!(!decoder.has_pending());
            assert_eq!(frames.len(), 2);
            assert_eq!(
                serde_json::from_slice::<Value>(&frames[0]).unwrap()["text"],
                "€漢"
            );
            assert_eq!(
                serde_json::from_slice::<Value>(&frames[1]).unwrap()["done"],
                true
            );
        }
    }
    #[test]
    fn decoder_bounds_unterminated_lines_and_rejects_empty_frames() {
        let mut decoder = Decoder::default();
        assert!(decoder.feed(&vec![b'a'; 1024 * 1024]).unwrap().is_empty());
        assert!(decoder.has_pending());
        assert!(matches!(
            decoder.feed(b"a"),
            Err(TransportError::ResponseLimit)
        ));
        for bytes in [b"\n".as_slice(), b"\r\n".as_slice()] {
            assert!(Decoder::default().feed(bytes).is_err());
        }
    }
}
