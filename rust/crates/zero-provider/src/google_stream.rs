//! Single-candidate Gemini SSE. Terminal usage counts thoughts once, separately
//! from candidatesTokenCount, per the GenerateContent UsageMetadata contract.
use crate::{Completion, CompletionStatus, Content, TransportError, Usage};
use serde_json::{Value, json};

pub(crate) struct Accumulator {
    model: String,
    response: Option<String>,
    version: Option<String>,
    parts: Vec<Value>,
    call_ids: std::collections::BTreeSet<String>,
    reason: Option<String>,
    usage: Option<Usage>,
    poisoned: bool,
    final_usage: bool,
}
impl Accumulator {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.into(),
            response: None,
            version: None,
            parts: vec![],
            call_ids: std::collections::BTreeSet::new(),
            reason: None,
            usage: None,
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
        if self.poisoned || self.final_usage {
            return Err(TransportError::InvalidResponse);
        }
        let event: Value =
            serde_json::from_slice(data).map_err(|_| TransportError::InvalidResponse)?;
        if !event.is_object() || event.get("error").is_some() {
            return Err(TransportError::InvalidResponse);
        }
        for (key, slot) in [
            ("responseId", &mut self.response),
            ("modelVersion", &mut self.version),
        ] {
            if let Some(value) = event.get(key) {
                let text = value
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 512)
                    .ok_or(TransportError::InvalidResponse)?;
                if slot.as_ref().is_some_and(|old| old != text) {
                    return Err(TransportError::InvalidResponse);
                }
                *slot = Some(text.into());
            }
        }
        let candidates = match event.get("candidates") {
            Some(v) => v
                .as_array()
                .ok_or(TransportError::InvalidResponse)?
                .as_slice(),
            None => &[],
        };
        if candidates.len() > 1 {
            return Err(TransportError::InvalidResponse);
        }
        if let Some(candidate) = candidates.first() {
            if self.reason.is_some()
                || !candidate.is_object()
                || candidate
                    .get("index")
                    .is_some_and(|v| v.as_u64() != Some(0))
            {
                return Err(TransportError::InvalidResponse);
            }
            // Server tools and their extra cost dimensions are never requested.
            if [
                "groundingMetadata",
                "groundingAttributions",
                "urlContextMetadata",
            ]
            .iter()
            .any(|k| candidate.get(*k).is_some_and(|v| !v.is_null()))
            {
                return Err(TransportError::InvalidResponse);
            }
            if let Some(content) = candidate.get("content") {
                crate::anthropic::keys(content, &["role", "parts"])?;
                if content.get("role").is_some_and(|v| v != "model") {
                    return Err(TransportError::InvalidResponse);
                }
                if let Some(parts) = content.get("parts") {
                    let parts = parts.as_array().ok_or(TransportError::InvalidResponse)?;
                    if self.parts.len().saturating_add(parts.len()) > 4096 {
                        return Err(TransportError::ResponseLimit);
                    }
                    // Check shape now. A response ID is mandatory when generating
                    // local IDs for calls; never use a clock/random replay identity.
                    for content in crate::google::assistant_from(
                        parts,
                        self.response.as_deref().unwrap_or(""),
                        self.call_ids.len(),
                    )? {
                        if let Content::ToolCall { id, .. } = content {
                            if !self.call_ids.insert(id) {
                                return Err(TransportError::InvalidResponse);
                            }
                        }
                    }
                    self.parts.extend(parts.iter().cloned());
                }
            }
            if let Some(reason) = candidate.get("finishReason") {
                let reason = reason
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 64)
                    .ok_or(TransportError::InvalidResponse)?;
                self.reason = Some(reason.into());
            }
        }
        if let Some(feedback) = event.get("promptFeedback") {
            if let Some(block) = feedback.get("blockReason") {
                if self.reason.is_some()
                    || !self.parts.is_empty()
                    || !candidates.is_empty()
                    || block
                        .as_str()
                        .is_none_or(|s| s.is_empty() || s == "BLOCK_REASON_UNSPECIFIED")
                {
                    return Err(TransportError::InvalidResponse);
                }
                self.reason = Some("PROMPT_BLOCKED".into());
            }
        }
        if let Some(raw) = event.get("usageMetadata") {
            let usage = usage(raw)?;
            if self.usage.as_ref().is_some_and(|old| {
                old.input_tokens > usage.input_tokens
                    || old.output_tokens > usage.output_tokens
                    || old.cached_input_tokens > usage.cached_input_tokens
            }) {
                return Err(TransportError::InvalidResponse);
            }
            self.usage = Some(usage);
            self.final_usage = self.reason.is_some();
        }
        if candidates.is_empty() && event.get("usageMetadata").is_none() && self.reason.is_none() {
            return Err(TransportError::InvalidResponse);
        }
        Ok(())
    }
    pub fn finish(self, interrupted: Option<&str>) -> Completion {
        let terminal = self.reason.is_some() && !self.poisoned && interrupted.is_none();
        let status = if self.poisoned {
            CompletionStatus::Failed
        } else if terminal && self.reason.as_deref() == Some("STOP") && self.final_usage {
            CompletionStatus::Completed
        } else if terminal && !matches!(self.reason.as_deref(), Some("STOP" | "MAX_TOKENS")) {
            CompletionStatus::Failed
        } else {
            CompletionStatus::Incomplete
        };
        let error = if status != CompletionStatus::Completed {
            Some(
                interrupted
                    .unwrap_or("incomplete, blocked or invalid Google completion")
                    .to_owned(),
            )
        } else if !self.final_usage {
            Some("Google final usage is missing; reservation requires reconciliation".into())
        } else {
            None
        };
        let parsed = crate::google::assistant(&self.parts, self.response.as_deref().unwrap_or(""));
        let content = if status == CompletionStatus::Completed {
            parsed.unwrap_or_default()
        } else {
            vec![]
        };
        let call_ids: Vec<_> = content
            .iter()
            .filter_map(|c| {
                if let Content::ToolCall { id, .. } = c {
                    Some(id)
                } else {
                    None
                }
            })
            .collect();
        let replay = vec![
            json!({"type":if status==CompletionStatus::Completed {"google_content"} else {"google_incomplete"},"model":self.model,"response_id":self.response.as_deref().unwrap_or(""),"content":{"role":"model","parts":self.parts},"call_ids":call_ids}),
        ];
        Completion {
            status,
            response_id: self.response,
            content,
            usage: self.usage,
            usage_is_final: terminal && self.final_usage,
            replay,
            error,
        }
    }
}
fn usage(raw: &Value) -> Result<Usage, TransportError> {
    let values = raw.as_object().ok_or(TransportError::InvalidResponse)?;
    // Multimodal/service-tier/server-tool pricing is not representable by Rates.
    for (key, value) in values {
        match key.as_str() {
            "promptTokenCount"
            | "candidatesTokenCount"
            | "thoughtsTokenCount"
            | "cachedContentTokenCount"
            | "totalTokenCount" => {
                if value.as_u64().is_none() {
                    return Err(TransportError::InvalidResponse);
                }
            }
            "toolUsePromptTokenCount" => {
                if value.as_u64() != Some(0) {
                    return Err(TransportError::InvalidResponse);
                }
            }
            "promptTokensDetails"
            | "cacheTokensDetails"
            | "candidatesTokensDetails"
            | "toolUsePromptTokensDetails" => {
                for detail in value.as_array().ok_or(TransportError::InvalidResponse)? {
                    crate::anthropic::keys(detail, &["modality", "tokenCount"])?;
                    if detail["modality"] != "TEXT" || detail["tokenCount"].as_u64().is_none() {
                        return Err(TransportError::InvalidResponse);
                    }
                }
            }
            "serviceTier" if value == "STANDARD" => (),
            _ => return Err(TransportError::InvalidResponse),
        }
    }
    let count = |key: &str| raw[key].as_u64().ok_or(TransportError::InvalidResponse);
    let input = count("promptTokenCount")?;
    let output = count("candidatesTokenCount")?
        .checked_add(
            raw.get("thoughtsTokenCount")
                .map_or(Some(0), Value::as_u64)
                .ok_or(TransportError::InvalidResponse)?,
        )
        .ok_or(TransportError::InvalidResponse)?;
    let cached = raw
        .get("cachedContentTokenCount")
        .map_or(Some(0), Value::as_u64)
        .ok_or(TransportError::InvalidResponse)?;
    if cached > input || input.checked_add(output) != Some(count("totalTokenCount")?) {
        return Err(TransportError::InvalidResponse);
    }
    Ok(Usage {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cached,
    })
}
