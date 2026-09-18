//! Explicit cloud metadata and hosted login transport. No credential discovery or writes.
mod login;
pub use login::{LoginCredential, LoginError, LoginOptions, LoginSession};
mod models;
pub use models::*;
mod price;
pub use price::ExactPrice;
mod route;
mod route_model;
use reqwest::{
    Url,
    header::{AUTHORIZATION, HeaderValue},
};
pub use route::{HostedRoute, validate_hosted_pin};
use serde::de::DeserializeOwned;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayCode {
    InferenceDisabled,
    ProviderUnavailable,
    BillingUnavailable,
    InsufficientFunds,
}
impl GatewayCode {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "inference_disabled" => Some(Self::InferenceDisabled),
            "provider_unavailable" => Some(Self::ProviderUnavailable),
            "billing_unavailable" => Some(Self::BillingUnavailable),
            "insufficient_funds" => Some(Self::InsufficientFunds),
            _ => None,
        }
    }
}
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CloudError {
    #[error("invalid cloud configuration")]
    InvalidConfiguration,
    #[error("cloud authentication rejected (HTTP 401)")]
    Unauthorized,
    #[error("cloud access forbidden (HTTP 403)")]
    Forbidden,
    #[error("cloud request failed (HTTP {status}, gateway code {code:?})")]
    Http {
        status: u16,
        code: Option<GatewayCode>,
    },
    #[error("cloud network request failed")]
    Network,
    #[error("cloud request deadline exceeded")]
    Timeout,
    #[error("cloud request cancelled")]
    Cancelled,
    #[error("cloud response exceeds byte limit")]
    ResponseLimit,
    #[error("invalid cloud response")]
    InvalidResponse,
    #[error("explicit model is not available in the hosted catalog")]
    ModelUnavailable,
}

/// Intentionally implements neither Debug nor Serialize. Authorization lives in
/// a sensitive header in memory and never enters returned errors.
pub struct CloudClient {
    client: reqwest::Client,
    host: Url,
    authorization: HeaderValue,
    timeout: Duration,
    max_bytes: usize,
}
impl CloudClient {
    pub fn new(
        host: &str,
        token: &str,
        timeout: Duration,
        max_bytes: usize,
    ) -> Result<Self, CloudError> {
        let url = route::host_url(host)?;
        if token.trim().is_empty()
            || timeout.is_zero()
            || timeout > Duration::from_secs(3600)
            || !(1024..=16 * 1024 * 1024).contains(&max_bytes)
        {
            return Err(CloudError::InvalidConfiguration);
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| CloudError::InvalidConfiguration)?;
        authorization.set_sensitive(true);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .user_agent(concat!("0sec-cli/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| CloudError::InvalidConfiguration)?;
        Ok(Self {
            client,
            host: url,
            authorization,
            timeout,
            max_bytes,
        })
    }
    pub fn health_path(&self) -> &'static str {
        match self.host.host_str() {
            Some("cloud.0sec.ai" | "cloud.0.security") => "/api/health",
            _ => "/health",
        }
    }
    pub async fn ping_health(
        &self,
        cancel: CancellationToken,
    ) -> Result<CloudHealthResponse, CloudError> {
        let result: CloudHealthResponse = self.get(self.health_path(), cancel).await?;
        if result.status.trim().is_empty() {
            return Err(CloudError::InvalidResponse);
        }
        Ok(result)
    }
    pub async fn inference_models(
        &self,
        cancel: CancellationToken,
    ) -> Result<InferenceModelsResponse, CloudError> {
        let result: InferenceModelsResponse = self.get("/api/inference/v1/models", cancel).await?;
        result.validate()?;
        Ok(result)
    }
    pub async fn inference_account(
        &self,
        cancel: CancellationToken,
    ) -> Result<InferenceAccountResponse, CloudError> {
        let value: serde_json::Value = self.get("/api/inference/account", cancel).await?;
        models::normalize_account(value)
    }
    pub async fn inference_usage(
        &self,
        cancel: CancellationToken,
    ) -> Result<InferenceUsageResponse, CloudError> {
        self.get("/api/inference/usage", cancel).await
    }
    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        cancel: CancellationToken,
    ) -> Result<T, CloudError> {
        tokio::select! {biased;
            _=cancel.cancelled()=>Err(CloudError::Cancelled),
            result=tokio::time::timeout(self.timeout,self.exchange(path))=>result.map_err(|_|CloudError::Timeout)?,
        }
    }
    async fn exchange<T: DeserializeOwned>(&self, path: &str) -> Result<T, CloudError> {
        let url = format!("{}{}", self.host.as_str().trim_end_matches('/'), path);
        let mut response = self
            .client
            .get(url)
            .header(AUTHORIZATION, self.authorization.clone())
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| CloudError::Network)?;
        let status = response.status();
        if status.as_u16() == 401 {
            return Err(CloudError::Unauthorized);
        }
        if status.as_u16() == 403 {
            return Err(CloudError::Forbidden);
        }
        let mut body = Vec::new();
        if response
            .content_length()
            .is_some_and(|n| n > self.max_bytes as u64)
        {
            return Err(CloudError::ResponseLimit);
        }
        while let Some(chunk) = response.chunk().await.map_err(|_| CloudError::Network)? {
            if body
                .len()
                .checked_add(chunk.len())
                .is_none_or(|len| len > self.max_bytes)
            {
                return Err(CloudError::ResponseLimit);
            }
            body.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let code = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/code")
                        .and_then(serde_json::Value::as_str)
                        .and_then(GatewayCode::parse)
                });
            return Err(CloudError::Http {
                status: status.as_u16(),
                code,
            });
        }
        serde_json::from_slice(&body).map_err(|_| CloudError::InvalidResponse)
    }
}
