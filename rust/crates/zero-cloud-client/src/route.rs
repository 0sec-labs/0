//! Explicit hosted catalog selection. No upstream routing, credentials, or effects.
use crate::{CloudClient, CloudError, InferenceModel, InferenceModelsResponse, ListObject, price};
use reqwest::Url;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use zero_protocol::model::{CatalogCurrency, HostedCatalogPin, Rates, WireApi};

#[derive(Debug, Clone, Serialize)]
pub struct HostedRoute {
    pub endpoint: String,
    pub model: String,
    pub wire_api: WireApi,
    pub max_output_tokens: u32,
    pub rates: Rates,
    pub provenance: HostedCatalogPin,
}

pub(crate) fn host_url(host: &str) -> Result<Url, CloudError> {
    if host.len() > 4096 || host.chars().any(char::is_control) {
        return Err(CloudError::InvalidConfiguration);
    }
    let url = Url::parse(host).map_err(|_| CloudError::InvalidConfiguration)?;
    let loopback = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if url.host_str().is_none()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CloudError::InvalidConfiguration);
    }
    Ok(url)
}
fn valid_identifier(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn rates(model: &InferenceModel) -> Result<Rates, CloudError> {
    Ok(Rates {
        input: price::micros(&model.pricing.input_per_million_usd)?,
        cached_input: price::micros(&model.pricing.cached_input_per_million_usd)?,
        output: price::micros(&model.pricing.output_per_million_usd)?,
    })
}
fn compile(
    host: &Url,
    catalog: &InferenceModelsResponse,
    model: &str,
) -> Result<HostedRoute, CloudError> {
    if !valid_identifier(model) {
        return Err(CloudError::InvalidConfiguration);
    }
    catalog.validate()?;
    if catalog.data.len() > 1024 {
        return Err(CloudError::InvalidResponse);
    }
    // An invalid unselected row still makes this quote unusable. A selected row
    // cannot conceal duplicate identities or unrepresentable catalog prices.
    for item in &catalog.data {
        if [
            &item.id,
            &item.owned_by,
            &item.provider,
            &item.upstream_model,
        ]
        .iter()
        .any(|s| !valid_identifier(s))
            || item.max_output_tokens > u64::from(u32::MAX)
        {
            return Err(CloudError::InvalidResponse);
        }
        rates(item)?;
    }
    let selected = catalog
        .data
        .iter()
        .find(|item| item.id == model)
        .ok_or(CloudError::ModelUnavailable)?;
    let rates = rates(selected)?;
    let wire_api = match selected.wire_api {
        crate::WireApi::Responses => WireApi::Responses,
        crate::WireApi::ChatCompletions => WireApi::ChatCompletions,
    };
    let suffix = match wire_api {
        WireApi::Responses => "/api/inference/v1/responses",
        WireApi::ChatCompletions => "/api/inference/v1/chat/completions",
        WireApi::AnthropicMessages | WireApi::GoogleGenerateContent | WireApi::OllamaChat => {
            return Err(CloudError::InvalidResponse);
        }
    };
    let host = host.as_str().trim_end_matches('/').to_owned();
    let endpoint = format!("{host}{suffix}");
    let max_output_tokens =
        u32::try_from(selected.max_output_tokens).map_err(|_| CloudError::InvalidResponse)?;
    let normalized = crate::route_model::Model::normalized(selected)?;
    let catalog_model =
        serde_json::to_value(normalized).map_err(|_| CloudError::InvalidResponse)?;
    let encoded = serde_json::to_vec(&catalog_model).map_err(|_| CloudError::InvalidResponse)?;
    let provenance = HostedCatalogPin {
        schema_version: 1,
        currency: CatalogCurrency::Usd,
        host,
        endpoint: endpoint.clone(),
        model: selected.id.clone(),
        wire_api,
        max_output_tokens,
        rates,
        catalog_model,
        catalog_model_sha256: format!("sha256:{:x}", Sha256::digest(encoded)),
    };
    Ok(HostedRoute {
        endpoint,
        model: selected.id.clone(),
        wire_api,
        max_output_tokens,
        rates,
        provenance,
    })
}

/// Validate a portable credential-free quote by deriving every field again.
/// This checks consistency, not server authenticity or freshness; the caller
/// remains responsible for obtaining this quote from its explicitly trusted host.
pub fn validate_hosted_pin(pin: &HostedCatalogPin) -> Result<(), CloudError> {
    let host = host_url(&pin.host)?;
    let normalized: crate::route_model::Model = serde_json::from_value(pin.catalog_model.clone())
        .map_err(|_| CloudError::InvalidResponse)?;
    let model = normalized.into_catalog()?;
    let expected = compile(
        &host,
        &InferenceModelsResponse {
            object: ListObject::List,
            data: vec![model],
        },
        &pin.model,
    )?;
    if serde_json::to_value(&expected.provenance).map_err(|_| CloudError::InvalidResponse)?
        != serde_json::to_value(pin).map_err(|_| CloudError::InvalidResponse)?
    {
        return Err(CloudError::InvalidResponse);
    }
    Ok(())
}
impl CloudClient {
    /// Fetch exactly one catalog and select only the explicit hosted model ID.
    /// Does not dispatch inference or attach credentials to the returned route.
    pub async fn hosted_route(
        &self,
        model: &str,
        cancel: CancellationToken,
    ) -> Result<HostedRoute, CloudError> {
        if !valid_identifier(model) {
            return Err(CloudError::InvalidConfiguration);
        }
        let catalog = self.inference_models(cancel.clone()).await?;
        if cancel.is_cancelled() {
            return Err(CloudError::Cancelled);
        }
        self.select_hosted_route(&catalog, model)
    }
    /// Compile an already fetched catalog using this client's validated host.
    pub fn select_hosted_route(
        &self,
        catalog: &InferenceModelsResponse,
        model: &str,
    ) -> Result<HostedRoute, CloudError> {
        compile(&self.host, catalog, model)
    }
}
