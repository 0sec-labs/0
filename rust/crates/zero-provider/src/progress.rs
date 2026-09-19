//! Advisory allowlisted deltas, independent of authoritative completion state.
use crate::{MAX_PROGRESS_TEXT_BYTES, ProviderProgress, WireApi};
use serde_json::Value;
use std::collections::BTreeMap;
const MAX_EVENTS: usize = 4096;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_ITEMS: u32 = 256;
pub(super) struct Observer<'a> {
    wire: WireApi,
    sink: &'a mut (dyn FnMut(ProviderProgress) + Send),
    events: usize,
    ollama_calls: u32,
    bytes: usize,
    // Accepted Chat id/name fields are invariant full metadata, not repeated deltas.
    metadata: BTreeMap<u32, (bool, bool)>,
}
#[derive(Clone, Copy)]
enum TextKind {
    Text,
    Reasoning,
    Refusal,
}
impl<'a> Observer<'a> {
    pub fn new(wire: WireApi, sink: &'a mut (dyn FnMut(ProviderProgress) + Send)) -> Self {
        Self {
            wire,
            sink,
            events: 0,
            ollama_calls: 0,
            bytes: 0,
            metadata: BTreeMap::new(),
        }
    }
    fn exhausted(&self) -> bool {
        self.events >= MAX_EVENTS || self.bytes >= MAX_BYTES
    }
    fn emit(&mut self, event: ProviderProgress, bytes: usize) {
        if bytes == 0 || self.exhausted() || self.bytes + bytes > MAX_BYTES {
            return;
        }
        self.bytes += bytes;
        self.events += 1;
        (self.sink)(event);
    }
    fn text(&mut self, kind: TextKind, item_index: u32, content_index: u32, text: &str) {
        let mut rest = text;
        while !rest.is_empty() && !self.exhausted() {
            let (part, left) = chunk(rest);
            rest = left;
            let text = part.to_owned();
            let event = match kind {
                TextKind::Text => ProviderProgress::TextDelta {
                    item_index,
                    content_index,
                    text,
                },
                TextKind::Reasoning => ProviderProgress::ReasoningDelta {
                    item_index,
                    content_index,
                    text,
                },
                TextKind::Refusal => ProviderProgress::RefusalDelta {
                    item_index,
                    content_index,
                    text,
                },
            };
            self.emit(event, part.len());
        }
    }
    fn tool(&mut self, index: u32, id: &str, name: &str, args: &str) {
        let seen = self.metadata.entry(index).or_default();
        let id = if seen.0 { "" } else { id };
        let name = if seen.1 { "" } else { name };
        seen.0 |= !id.is_empty();
        seen.1 |= !name.is_empty();
        // Separate fields into individually bounded fragments; never stringify or
        // publish the provider event/object that supplied them.
        for (field, value) in [(0, id), (1, name), (2, args)] {
            let mut rest = value;
            while !rest.is_empty() && !self.exhausted() {
                let (part, left) = chunk(rest);
                rest = left;
                let mut event = ProviderProgress::ToolCallDelta {
                    item_index: index,
                    id_delta: String::new(),
                    name_delta: String::new(),
                    arguments_delta: String::new(),
                };
                if let ProviderProgress::ToolCallDelta {
                    id_delta,
                    name_delta,
                    arguments_delta,
                    ..
                } = &mut event
                {
                    *match field {
                        0 => id_delta,
                        1 => name_delta,
                        _ => arguments_delta,
                    } = part.into();
                }
                self.emit(event, part.len());
            }
        }
    }
    /// Call only after the authoritative accumulator accepted this exact frame.
    /// Unsupported/malformed advisory fields are ignored without changing its result.
    pub fn event(&mut self, frame: &[u8]) {
        if self.exhausted() || frame == b"[DONE]" {
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(frame) else {
            return;
        };
        match self.wire {
            WireApi::Responses => self.responses(&value),
            WireApi::ChatCompletions => self.chat(&value),
            WireApi::AnthropicMessages => self.anthropic(&value),
            WireApi::GoogleGenerateContent => self.google(&value),
            WireApi::OllamaChat => self.ollama(&value),
        }
    }
    fn ollama(&mut self, event: &Value) {
        for (key, kind) in [
            ("content", TextKind::Text),
            ("thinking", TextKind::Reasoning),
        ] {
            if let Some(text) = event["message"][key].as_str() {
                self.text(kind, 0, 0, text);
            }
        }
        if let Some(calls) = event["message"]["tool_calls"].as_array() {
            for call in calls {
                let name = call["function"]["name"].as_str().unwrap_or("");
                let args = call["function"]["arguments"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| call["function"]["arguments"].to_string());
                self.tool(self.ollama_calls, "", name, &args);
                self.ollama_calls = self.ollama_calls.saturating_add(1);
            }
        }
    }
    fn google(&mut self, event: &Value) {
        if let Some(parts) = event["candidates"][0]["content"]["parts"].as_array() {
            for part in parts {
                if let Some(text) = part["text"].as_str() {
                    self.text(
                        if part["thought"] == true {
                            TextKind::Reasoning
                        } else {
                            TextKind::Text
                        },
                        0,
                        0,
                        text,
                    );
                }
            }
        }
    }
    fn responses(&mut self, event: &Value) {
        let Some(kind) = event["type"].as_str() else {
            return;
        };
        let Some(index) = index(event, "output_index") else {
            return;
        };
        match kind {
            "response.output_text.delta"
            | "response.refusal.delta"
            | "response.reasoning_text.delta"
            | "response.reasoning_summary_text.delta" => {
                let content = if kind == "response.reasoning_summary_text.delta" {
                    index_or(event, "summary_index", 0)
                } else {
                    index_or(event, "content_index", 0)
                };
                let (Some(content), Some(text)) = (content, event["delta"].as_str()) else {
                    return;
                };
                let kind = match kind {
                    "response.output_text.delta" => TextKind::Text,
                    "response.refusal.delta" => TextKind::Refusal,
                    _ => TextKind::Reasoning,
                };
                self.text(kind, index, content, text);
            }
            "response.output_item.added" if event["item"]["type"] == "function_call" => {
                let item = &event["item"];
                self.tool(
                    index,
                    string(item, "call_id"),
                    string(item, "name"),
                    string(item, "arguments"),
                );
            }
            "response.function_call_arguments.delta" => {
                self.tool(index, "", "", string(event, "delta"))
            }
            "response.content_part.added" | "response.reasoning_summary_part.added" => {
                let field = if kind == "response.reasoning_summary_part.added" {
                    "summary_index"
                } else {
                    "content_index"
                };
                let Some(content) = index_or(event, field, 0) else {
                    return;
                };
                let part = &event["part"];
                match part["type"].as_str() {
                    Some("output_text") => {
                        self.text(TextKind::Text, index, content, string(part, "text"))
                    }
                    Some("refusal") => {
                        self.text(TextKind::Refusal, index, content, string(part, "refusal"))
                    }
                    Some("summary_text") => {
                        self.text(TextKind::Reasoning, index, content, string(part, "text"))
                    }
                    _ => (),
                }
            }
            // No terminal snapshot fallback: it could duplicate earlier deltas.
            _ => (),
        }
    }
    fn chat(&mut self, event: &Value) {
        let Some(choices) = event["choices"].as_array() else {
            return;
        };
        if choices.len() != 1 || choices[0]["index"] != 0 {
            return;
        }
        let delta = &choices[0]["delta"];
        for (field, kind) in [
            ("content", TextKind::Text),
            ("refusal", TextKind::Refusal),
            ("reasoning_content", TextKind::Reasoning),
        ] {
            self.text(kind, 0, 0, string(delta, field));
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let Some(index) = index(call, "index") else {
                    continue;
                };
                self.tool(
                    index,
                    string(call, "id"),
                    string(&call["function"], "name"),
                    string(&call["function"], "arguments"),
                );
            }
        }
        // reasoning_details may carry encrypted/opaque provider-specific objects.
    }
    fn anthropic(&mut self, event: &Value) {
        let Some(index) = index(event, "index") else {
            return;
        };
        match event["type"].as_str() {
            Some("content_block_start") => {
                let block = &event["content_block"];
                match block["type"].as_str() {
                    Some("text") => self.text(TextKind::Text, index, 0, string(block, "text")),
                    Some("thinking") => {
                        self.text(TextKind::Reasoning, index, 0, string(block, "thinking"))
                    }
                    Some("tool_use") => {
                        let args = block["input"]
                            .as_object()
                            .filter(|v| !v.is_empty())
                            .and_then(|v| serde_json::to_string(v).ok())
                            .unwrap_or_default();
                        self.tool(index, string(block, "id"), string(block, "name"), &args);
                    }
                    _ => (),
                }
            }
            Some("content_block_delta") => {
                let delta = &event["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        self.text(TextKind::Text, index, 0, string(delta, "text"))
                    }
                    Some("thinking_delta") => {
                        self.text(TextKind::Reasoning, index, 0, string(delta, "thinking"))
                    }
                    Some("input_json_delta") => {
                        self.tool(index, "", "", string(delta, "partial_json"))
                    }
                    _ => (),
                }
            }
            _ => (),
        }
    }
}
fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn index(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)?
        .as_u64()
        .filter(|n| *n < u64::from(MAX_ITEMS))
        .map(|n| n as u32)
}
fn index_or(value: &Value, key: &str, default: u32) -> Option<u32> {
    if value.get(key).is_none() {
        Some(default)
    } else {
        index(value, key)
    }
}
fn chunk(text: &str) -> (&str, &str) {
    let mut end = text.len().min(MAX_PROGRESS_TEXT_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.split_at(end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn utf8_chunks_and_event_and_aggregate_caps_are_independent() {
        let mut events = Vec::new();
        let text = "€".repeat(20_000);
        {
            let mut sink = |p| events.push(p);
            let mut observer = Observer::new(WireApi::Responses, &mut sink);
            observer.event(
                &serde_json::to_vec(
                    &json!({"type":"response.output_text.delta","output_index":0,"delta":text}),
                )
                .unwrap(),
            );
        }
        let mut restored = String::new();
        for event in events {
            if let ProviderProgress::TextDelta { text, .. } = event {
                assert!(text.len() <= MAX_PROGRESS_TEXT_BYTES);
                restored.push_str(&text);
            } else {
                panic!("unexpected event");
            }
        }
        assert_eq!(restored, text);
        let mut count = 0;
        let mut bytes = 0;
        {
            let mut sink = |p| {
                count += 1;
                if let ProviderProgress::TextDelta { text, .. } = p {
                    bytes += text.len();
                }
            };
            let mut observer = Observer::new(WireApi::Responses, &mut sink);
            let frame = serde_json::to_vec(
                &json!({"type":"response.output_text.delta","output_index":0,"delta":"a"}),
            )
            .unwrap();
            for _ in 0..5000 {
                observer.event(&frame);
            }
        }
        assert_eq!(count, 4096);
        assert_eq!(bytes, 4096);
        let mut count = 0;
        let mut bytes = 0;
        {
            let mut sink = |p| {
                count += 1;
                if let ProviderProgress::TextDelta { text, .. } = p {
                    bytes += text.len();
                }
            };
            let mut observer = Observer::new(WireApi::Responses, &mut sink);
            let frame=serde_json::to_vec(&json!({"type":"response.output_text.delta","output_index":0,"delta":"x".repeat(MAX_PROGRESS_TEXT_BYTES)})).unwrap();
            for _ in 0..300 {
                observer.event(&frame);
            }
        }
        assert_eq!(bytes, 4 * 1024 * 1024);
        assert_eq!(count, 256);
    }
    #[test]
    fn malformed_advisory_fields_and_opaque_events_are_ignored() {
        let mut events = Vec::new();
        {
            let mut sink = |p| events.push(p);
            let mut observer = Observer::new(WireApi::Responses, &mut sink);
            for value in [
                json!({"type":"response.output_text.delta","output_index":999,"delta":"secret"}),
                json!({"type":"response.output_text.delta","output_index":0,"delta":{"secret":"raw"}}),
                json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","encrypted_content":"secret"}}),
                json!({"type":"error","message":"secret"}),
            ] {
                observer.event(&serde_json::to_vec(&value).unwrap());
            }
        }
        assert!(events.is_empty());
    }
}
