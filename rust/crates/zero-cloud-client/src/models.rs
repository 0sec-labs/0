use crate::CloudError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudHealthResponse {
    pub status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WireApi {
    Responses,
    ChatCompletions,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ModelObject {
    #[serde(rename = "model")]
    Model,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ListObject {
    #[serde(rename = "list")]
    List,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferencePricing {
    pub input_per_million_usd: Number,
    pub output_per_million_usd: Number,
    pub cached_input_per_million_usd: Number,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceModel {
    pub id: String,
    pub object: ModelObject,
    pub owned_by: String,
    pub provider: String,
    pub upstream_model: String,
    pub wire_api: WireApi,
    pub context_length: u64,
    pub max_output_tokens: u64,
    pub pricing: InferencePricing,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceModelsResponse {
    pub object: ListObject,
    pub data: Vec<InferenceModel>,
}
fn nonnegative(number: &Number) -> bool {
    number.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
}
impl InferenceModelsResponse {
    pub(crate) fn validate(&self) -> Result<(), CloudError> {
        let mut ids = std::collections::HashSet::new();
        for model in &self.data {
            if [
                &model.id,
                &model.owned_by,
                &model.provider,
                &model.upstream_model,
            ]
            .iter()
            .any(|s| s.trim().is_empty())
                || !ids.insert(&model.id)
                || model.context_length == 0
                || model.max_output_tokens == 0
                || model.max_output_tokens > model.context_length
                || [
                    &model.pricing.input_per_million_usd,
                    &model.pricing.output_per_million_usd,
                    &model.pricing.cached_input_per_million_usd,
                ]
                .iter()
                .any(|n| !nonnegative(n))
            {
                return Err(CloudError::InvalidResponse);
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Currency {
    USD,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceCreditBalance {
    pub feature_id: String,
    pub granted: Option<Number>,
    pub remaining: Number,
    pub remaining_percent: Option<Number>,
    pub next_reset_at: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceAccountResponse {
    pub remaining_usd: Number,
    pub currency: Currency,
    pub credits: Option<InferenceCreditBalance>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceUsageResponse {
    pub requests: Vec<Map<String, Value>>,
}

fn credits(value: &Value) -> Option<InferenceCreditBalance> {
    let feature = value.get("featureId")?.as_str()?;
    if feature.trim().is_empty() {
        return None;
    }
    let remaining = value.get("remaining")?.as_number()?.clone();
    if !nonnegative(&remaining) {
        return None;
    }
    let granted = match value.get("granted")? {
        Value::Null => None,
        Value::Number(n) if nonnegative(n) => Some(n.clone()),
        _ => return None,
    };
    let percent=value.get("remainingPercent").and_then(Value::as_number).filter(|p|{
        matches!((p.as_f64(),granted.as_ref().and_then(Number::as_f64),remaining.as_f64()),(Some(p),Some(g),Some(r)) if p.is_finite()&&(0.0..=100.0).contains(&p)&&g>0.0&&r<=g)
    }).cloned();
    let next_reset_at = value
        .get("nextResetAt")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= 8.64e15)
        .map(|n| n as u64);
    Some(InferenceCreditBalance {
        feature_id: feature.into(),
        granted,
        remaining,
        remaining_percent: percent,
        next_reset_at,
    })
}
pub(crate) fn normalize_account(value: Value) -> Result<InferenceAccountResponse, CloudError> {
    let remaining = value
        .get("remainingUsd")
        .and_then(Value::as_number)
        .filter(|n| nonnegative(n))
        .ok_or(CloudError::InvalidResponse)?
        .clone();
    if value.get("currency").and_then(Value::as_str) != Some("USD") {
        return Err(CloudError::InvalidResponse);
    }
    Ok(InferenceAccountResponse {
        remaining_usd: remaining,
        currency: Currency::USD,
        credits: value.get("credits").and_then(credits),
    })
}
