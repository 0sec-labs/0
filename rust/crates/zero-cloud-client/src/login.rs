//! Legacy hosted browser-session protocol; no OAuth device endpoint is invented here.
use base64::Engine as _;
use reqwest::Url;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub struct LoginOptions {
    pub interval: Duration,
    pub attempts: u32,
    pub deadline: Duration,
    pub request_timeout: Duration,
    pub max_response_bytes: usize,
}
impl Default for LoginOptions {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(2),
            attempts: 150,
            deadline: Duration::from_secs(300),
            request_timeout: Duration::from_secs(10),
            max_response_bytes: 64 * 1024,
        }
    }
}
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LoginError {
    #[error("invalid hosted login configuration")]
    InvalidConfiguration,
    #[error("hosted login session generation failed")]
    SessionGeneration,
    #[error("hosted login cancelled")]
    Cancelled,
    #[error("hosted login deadline or polling budget exceeded")]
    Timeout,
    #[error("hosted login request expired")]
    Expired,
    #[error("hosted login network request failed")]
    Network,
    #[error("hosted login response exceeds byte limit")]
    ResponseLimit,
    #[error("invalid hosted login response")]
    InvalidResponse,
    #[error("hosted login unavailable (HTTP {status})")]
    Http { status: u16 },
}
impl LoginError {
    pub fn recoverable(&self) -> bool {
        matches!(
            self,
            Self::Cancelled
                | Self::Timeout
                | Self::Expired
                | Self::Network
                | Self::Http {
                    status: 429 | 500..=599
                }
        )
    }
}
/// Intentionally neither Debug nor Serialize. Callers explicitly handle the bearer credential.
pub struct LoginCredential {
    host: String,
    token: String,
}
impl LoginCredential {
    pub fn host(&self) -> &str {
        &self.host
    }
    pub fn expose_token(&self) -> &str {
        &self.token
    }
}
/// Client-generated browser session, never Debug/Serialize. No browser or filesystem effects.
/// The URL intentionally reveals the session to the user; do not log it as diagnostic data.
pub struct LoginSession {
    client: reqwest::Client,
    host: String,
    browser_url: String,
    poll_url: String,
    options: LoginOptions,
    started: Instant,
}
impl LoginSession {
    pub fn new(host: &str, options: LoginOptions) -> Result<Self, LoginError> {
        let url = Url::parse(host).map_err(|_| LoginError::InvalidConfiguration)?;
        let loopback = url.host_str().is_some_and(|h| {
            h.eq_ignore_ascii_case("localhost")
                || h.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if url.host_str().is_none()
            || !(url.scheme() == "https" || url.scheme() == "http" && loopback)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || options.interval.is_zero()
            || options.interval > Duration::from_secs(30)
            || options.attempts == 0
            || options.attempts > 150
            || options.deadline.is_zero()
            || options.deadline > Duration::from_secs(300)
            || options.request_timeout.is_zero()
            || options.request_timeout > Duration::from_secs(10)
            || !(1024..=64 * 1024).contains(&options.max_response_bytes)
        {
            return Err(LoginError::InvalidConfiguration);
        }
        let mut random = [0u8; 9];
        getrandom::fill(&mut random).map_err(|_| LoginError::SessionGeneration)?;
        let session = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
        let host = url.as_str().trim_end_matches('/').to_owned();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .user_agent(concat!("0sec-cli/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| LoginError::InvalidConfiguration)?;
        Ok(Self {
            client,
            browser_url: format!("{host}/cli-auth?session={session}"),
            poll_url: format!("{host}/cli-auth/sessions/{session}"),
            host,
            options,
            started: Instant::now(),
        })
    }
    pub fn browser_url(&self) -> &str {
        &self.browser_url
    }
    /// Consumes the session so completed or cancelled polling cannot be restarted accidentally.
    pub async fn wait(self, cancel: CancellationToken) -> Result<LoginCredential, LoginError> {
        let remaining = self
            .options
            .deadline
            .checked_sub(self.started.elapsed())
            .ok_or(LoginError::Timeout)?;
        tokio::select! {biased;
            _=cancel.cancelled()=>Err(LoginError::Cancelled),
            result=tokio::time::timeout(remaining,self.poll())=>result.map_err(|_|LoginError::Timeout)?,
        }
    }
    async fn poll(&self) -> Result<LoginCredential, LoginError> {
        for _ in 0..self.options.attempts {
            tokio::time::sleep(self.options.interval).await;
            match tokio::time::timeout(self.options.request_timeout, self.exchange())
                .await
                .map_err(|_| LoginError::Timeout)??
            {
                Some(token) => {
                    return Ok(LoginCredential {
                        host: self.host.clone(),
                        token,
                    });
                }
                None => continue,
            }
        }
        Err(LoginError::Timeout)
    }
    async fn exchange(&self) -> Result<Option<String>, LoginError> {
        let mut response = self
            .client
            .get(&self.poll_url)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| LoginError::Network)?;
        match response.status().as_u16() {
            202 | 204 | 404 => return Ok(None),
            410 => return Err(LoginError::Expired),
            200 => {}
            status => return Err(LoginError::Http { status }),
        }
        if response
            .content_length()
            .is_some_and(|n| n > self.options.max_response_bytes as u64)
        {
            return Err(LoginError::ResponseLimit);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| LoginError::Network)? {
            if bytes.len().saturating_add(chunk.len()) > self.options.max_response_bytes {
                return Err(LoginError::ResponseLimit);
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| LoginError::InvalidResponse)?;
        let object = value.as_object().ok_or(LoginError::InvalidResponse)?;
        let status = object.get("status");
        let token = ["token", "access_token"].iter().find_map(|key| {
            object
                .get(*key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 8192
                        && !s.chars().any(|c| c.is_whitespace() || c.is_control())
                        && reqwest::header::HeaderValue::from_str(s).is_ok()
                })
        });
        if let Some(token) = token {
            if status.is_some() && status.and_then(|v| v.as_str()) != Some("ready") {
                return Err(LoginError::InvalidResponse);
            }
            return Ok(Some(token.to_owned()));
        }
        match status.and_then(|v| v.as_str()) {
            Some("pending") => Ok(None),
            Some("expired") => Err(LoginError::Expired),
            _ => Err(LoginError::InvalidResponse),
        }
    }
}
