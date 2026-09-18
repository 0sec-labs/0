//! Canonical pin metadata stores decimal prices as strings, never JSON floats.
use crate::{
    CloudError, ExactPrice, InferenceModel, InferencePricing, ModelObject, WireApi, price,
};
use serde::{Deserialize, Serialize};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Model {
    id: String,
    object: ModelObject,
    owned_by: String,
    provider: String,
    upstream_model: String,
    wire_api: WireApi,
    context_length: u64,
    max_output_tokens: u64,
    pricing: Pricing,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pricing {
    input_per_million_usd: String,
    cached_input_per_million_usd: String,
    output_per_million_usd: String,
}
impl Model {
    pub fn normalized(model: &InferenceModel) -> Result<Self, CloudError> {
        Ok(Self {
            id: model.id.clone(),
            object: model.object.clone(),
            owned_by: model.owned_by.clone(),
            provider: model.provider.clone(),
            upstream_model: model.upstream_model.clone(),
            wire_api: model.wire_api.clone(),
            context_length: model.context_length,
            max_output_tokens: model.max_output_tokens,
            pricing: Pricing {
                input_per_million_usd: price::normalized(&model.pricing.input_per_million_usd)?,
                cached_input_per_million_usd: price::normalized(
                    &model.pricing.cached_input_per_million_usd,
                )?,
                output_per_million_usd: price::normalized(&model.pricing.output_per_million_usd)?,
            },
        })
    }
    pub fn into_catalog(self) -> Result<InferenceModel, CloudError> {
        Ok(InferenceModel {
            id: self.id,
            object: self.object,
            owned_by: self.owned_by,
            provider: self.provider,
            upstream_model: self.upstream_model,
            wire_api: self.wire_api,
            context_length: self.context_length,
            max_output_tokens: self.max_output_tokens,
            pricing: InferencePricing {
                input_per_million_usd: ExactPrice::from_decimal(
                    &self.pricing.input_per_million_usd,
                )?,
                cached_input_per_million_usd: ExactPrice::from_decimal(
                    &self.pricing.cached_input_per_million_usd,
                )?,
                output_per_million_usd: ExactPrice::from_decimal(
                    &self.pricing.output_per_million_usd,
                )?,
            },
        })
    }
}
