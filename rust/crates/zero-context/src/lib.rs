//! Pure explicit projection. Original spans are retained; no effects or token claims.
mod replay;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
pub use zero_protocol::context::ContextPolicy;
use zero_protocol::model::{Completion, CompletionStatus, Content};
pub const MAX_STATE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_INPUT_ITEMS: usize = 10_000;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid context: {0}")]
    Invalid(String),
    #[error("context exceeds retained state bounds")]
    StateLimit,
    #[error("protected context and mandatory recent rounds exceed the input byte budget")]
    MandatoryOverflow,
    #[error("context receipt does not match recomputed projection")]
    ReceiptMismatch,
    #[error("context JSON: {0}")]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextState {
    schema_version: u32,
    spans: Vec<Span>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Span {
    Protected {
        items: Vec<Value>,
    },
    User {
        prompt: String,
    },
    Round {
        inference_operation_id: String,
        replay: Vec<Value>,
        call_ids: Vec<String>,
        tool_outputs: Vec<Value>,
    },
}
impl Span {
    fn items(&self) -> Vec<Value> {
        match self {
            Self::Protected { items } => items.clone(),
            Self::User { prompt } => vec![json!({"role":"user","content":prompt})],
            Self::Round {
                replay,
                tool_outputs,
                ..
            } => replay.iter().chain(tool_outputs).cloned().collect(),
        }
    }
    fn operation(&self) -> Option<&str> {
        match self {
            Self::Round {
                inference_operation_id,
                ..
            } => Some(inference_operation_id),
            _ => None,
        }
    }
}
/// Borrowed immutable round provenance, with offsets into the full input.
/// Call `validate` after deserializing state before trusting these witnesses.
#[derive(Debug, Clone, Copy)]
pub struct RoundWitness<'a> {
    pub span_index: usize,
    pub input_start: usize,
    pub inference_operation_id: &'a str,
    pub replay: &'a [Value],
    pub call_ids: &'a [String],
    pub tool_outputs: &'a [Value],
}
impl ContextState {
    pub fn round_witnesses(&self) -> impl Iterator<Item = RoundWitness<'_>> {
        self.spans
            .iter()
            .enumerate()
            .scan(0usize, |offset, (span_index, span)| {
                let start = *offset;
                let witness = match span {
                    Span::Protected { items } => {
                        *offset += items.len();
                        None
                    }
                    Span::User { .. } => {
                        *offset += 1;
                        None
                    }
                    Span::Round {
                        inference_operation_id,
                        replay,
                        call_ids,
                        tool_outputs,
                    } => {
                        *offset += replay.len() + tool_outputs.len();
                        Some(RoundWitness {
                            span_index,
                            input_start: start,
                            inference_operation_id,
                            replay,
                            call_ids,
                            tool_outputs,
                        })
                    }
                };
                Some(witness)
            })
            .flatten()
    }
    pub fn protected(input: Vec<Value>) -> Result<Self> {
        let state = Self {
            schema_version: 1,
            spans: vec![Span::Protected { items: input }],
        };
        state.validate()?;
        Ok(state)
    }
    pub fn append_user(&mut self, prompt: &str) -> Result<()> {
        self.append(Span::User {
            prompt: prompt.into(),
        })
    }
    pub fn append_round(
        &mut self,
        inference_operation_id: &str,
        completion: &Completion,
        tool_outputs: Vec<Value>,
    ) -> Result<()> {
        if completion.status != CompletionStatus::Completed {
            return Err(Error::Invalid(
                "round requires completed provider replay".into(),
            ));
        }
        let call_ids = completion
            .content
            .iter()
            .filter_map(|item| match item {
                Content::ToolCall { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        self.append(Span::Round {
            inference_operation_id: inference_operation_id.into(),
            replay: completion.replay.clone(),
            call_ids,
            tool_outputs,
        })
    }
    fn append(&mut self, span: Span) -> Result<()> {
        self.spans.push(span);
        if let Err(error) = self.validate() {
            self.spans.pop();
            return Err(error);
        }
        Ok(())
    }
    pub fn input(&self) -> Vec<Value> {
        self.spans.iter().flat_map(Span::items).collect()
    }
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 || self.spans.len() > MAX_INPUT_ITEMS {
            return Err(Error::StateLimit);
        }
        self.spans.iter().try_fold(0usize, |total, span| {
            let count = match span {
                Span::Protected { items } => items.len(),
                Span::User { .. } => 1,
                Span::Round {
                    replay,
                    tool_outputs,
                    ..
                } => replay.len().saturating_add(tool_outputs.len()),
            };
            total
                .checked_add(count)
                .filter(|n| *n <= MAX_INPUT_ITEMS)
                .ok_or(Error::StateLimit)
        })?;
        bounded_serialized_len(self)?;
        let mut operations = BTreeSet::new();
        for span in &self.spans {
            if let Span::Round {
                inference_operation_id,
                replay,
                call_ids,
                tool_outputs,
            } = span
            {
                if inference_operation_id.is_empty()
                    || inference_operation_id.len() > 256
                    || !operations.insert(inference_operation_id)
                {
                    return Err(Error::Invalid(
                        "round operation identity must be unique and bounded".into(),
                    ));
                }
                replay::validate(replay, call_ids, tool_outputs)?;
            }
        }
        let input = self.input();
        bounded_serialized_len(&input)?;
        Ok(())
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_STATE_BYTES {
            return Err(Error::StateLimit);
        }
        let state: Self = serde_json::from_slice(bytes)?;
        state.validate()?;
        Ok(state)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        Ok(serde_json::to_vec(self)?)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpanReference {
    pub span_id: String,
    pub inference_operation_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectionReceipt {
    pub schema_version: u32,
    pub policy: ContextPolicy,
    pub state_sha256: String,
    pub input_sha256: String,
    pub input_bytes: u64,
    pub input_count: u32,
    pub projected_sha256: String,
    pub projected_bytes: u64,
    pub projected_count: u32,
    pub retained: Vec<SpanReference>,
    pub omitted: Vec<SpanReference>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Projection {
    pub input: Vec<Value>,
    pub receipt: ProjectionReceipt,
}
// Count before materializing a large serialization or cloning retained values.
fn bounded_serialized_len(value: &impl Serialize) -> Result<usize> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            if self.0 > MAX_STATE_BYTES {
                return Err(std::io::Error::other("context state limit"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).map_err(|_| Error::StateLimit)?;
    Ok(counter.0)
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub fn project(state: &ContextState, policy: &ContextPolicy) -> Result<Projection> {
    policy
        .validate()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    state.validate()?;
    let full = state.input();
    let input_bytes = serde_json::to_vec(&full)?;
    let rounds: Vec<usize> = state
        .spans
        .iter()
        .enumerate()
        .filter_map(|(i, s)| s.operation().map(|_| i))
        .collect();
    let eligible = rounds
        .len()
        .saturating_sub(policy.keep_recent_rounds as usize);
    let mut retained = vec![true; state.spans.len()];
    let parts: Vec<Vec<Value>> = state.spans.iter().map(Span::items).collect();
    // Each span's JSON array contributes its interior bytes and separators to
    // the complete array. Track exact byte changes without repeated cloning.
    let sizes: Vec<usize> = parts
        .iter()
        .map(|p| serde_json::to_vec(p).map(|b| b.len().saturating_sub(2)))
        .collect::<std::result::Result<_, _>>()?;
    let mut nonempty = parts.iter().filter(|p| !p.is_empty()).count();
    let mut bytes = input_bytes.len();
    for &index in &rounds[..eligible] {
        if bytes <= policy.max_input_bytes as usize {
            break;
        }
        retained[index] = false;
        bytes -= sizes[index] + usize::from(nonempty > 1);
        nonempty -= 1;
    }
    if bytes > policy.max_input_bytes as usize {
        return Err(Error::MandatoryOverflow);
    }
    let input: Vec<Value> = parts
        .into_iter()
        .enumerate()
        .filter(|(i, _)| retained[*i])
        .flat_map(|(_, p)| p)
        .collect();
    let projected = serde_json::to_vec(&input)?;
    let mut kept = Vec::new();
    let mut omitted = Vec::new();
    for (index, span) in state.spans.iter().enumerate() {
        let reference = SpanReference {
            span_id: format!("{index}:{}", digest(&serde_json::to_vec(span)?)),
            inference_operation_id: span.operation().map(str::to_owned),
        };
        if retained[index] {
            kept.push(reference);
        } else {
            omitted.push(reference);
        }
    }
    let receipt = ProjectionReceipt {
        schema_version: 1,
        policy: policy.clone(),
        state_sha256: digest(&serde_json::to_vec(state)?),
        input_sha256: digest(&input_bytes),
        input_bytes: input_bytes.len() as u64,
        input_count: full.len() as u32,
        projected_sha256: digest(&projected),
        projected_bytes: projected.len() as u64,
        projected_count: input.len() as u32,
        retained: kept,
        omitted,
    };
    Ok(Projection { input, receipt })
}
pub fn validate_receipt(
    state: &ContextState,
    policy: &ContextPolicy,
    receipt: &ProjectionReceipt,
) -> Result<()> {
    if project(state, policy)?.receipt != *receipt {
        return Err(Error::ReceiptMismatch);
    }
    Ok(())
}
