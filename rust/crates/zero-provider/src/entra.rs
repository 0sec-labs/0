//! Explicit Microsoft Entra public-client refresh. No login or credential discovery.
use crate::TransportError;
use reqwest::{Client, Url, header::HeaderValue};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

mod file;
const LIMIT: usize = 64 * 1024;
const SCOPE: &str = "https://cognitiveservices.azure.com/.default";
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
fn bad() -> TransportError {
    TransportError::CredentialUnavailable
}
fn now() -> Result<u64, TransportError> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| bad())?
            .as_millis(),
    )
    .map_err(|_| bad())
}
fn guid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
fn secret(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 16 * 1024 && !value.chars().any(char::is_control)
}
fn bearer(token: &str) -> Result<HeaderValue, TransportError> {
    if !secret(token) {
        return Err(bad());
    }
    let mut header = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| bad())?;
    header.set_sensitive(true);
    Ok(header)
}
fn loopback(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        })
}

// Intentionally no Debug: even parser errors are replaced with fixed messages.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    schema_version: u32,
    session_id: String,
    tenant_id: String,
    client_id: String,
    account_id: String,
    endpoint: String,
    scope: String,
    revision: u64,
    refresh_token: String,
    access_token: Option<String>,
    expires_at_ms: Option<u64>,
}
impl Snapshot {
    fn validate(&self) -> Result<(), TransportError> {
        if self.schema_version != 1
            || !guid(&self.session_id)
            || !guid(&self.tenant_id)
            || !guid(&self.client_id)
            || self.account_id.trim().is_empty()
            || self.account_id.len() > 256
            || self.account_id.chars().any(char::is_control)
            || self.endpoint.len() > 4096
            || self.scope != SCOPE
            || self.revision >= SAFE_INTEGER
            || !secret(&self.refresh_token)
            || self.access_token.is_some() != self.expires_at_ms.is_some()
            || self.expires_at_ms.is_some_and(|x| x > SAFE_INTEGER)
        {
            return Err(bad());
        }
        if let Some(token) = &self.access_token {
            bearer(token)?;
        }
        Ok(())
    }
    fn same_identity(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.session_id == other.session_id
            && self.tenant_id == other.tenant_id
            && self.client_id == other.client_id
            && self.account_id == other.account_id
            && self.endpoint == other.endpoint
            && self.scope == other.scope
    }
    fn current(&self) -> Result<Option<HeaderValue>, TransportError> {
        let usable_after = now()?.saturating_add(60_000);
        if self
            .expires_at_ms
            .is_some_and(|expires| expires > usable_after)
        {
            return self.access_token.as_deref().map(bearer).transpose();
        }
        Ok(None)
    }
}
struct State {
    snapshot: Snapshot,
    poisoned: bool,
}
pub(crate) struct Credential {
    source: Arc<file::Source>,
    token_url: Url,
    state: Mutex<State>,
}
impl Credential {
    pub(crate) async fn open(
        endpoint: &Url,
        path: &Path,
        token_endpoint: Option<&str>,
    ) -> Result<Self, TransportError> {
        let path = path.to_owned();
        let (source, snapshot) = tokio::task::spawn_blocking(move || {
            let source = file::Source::open(&path)?;
            let snapshot = source.read()?;
            Ok::<_, TransportError>((source, snapshot))
        })
        .await
        .map_err(|_| bad())??;
        if snapshot.endpoint != endpoint.as_str() {
            return Err(bad());
        }
        let token_url = if let Some(url) = token_endpoint {
            let url = Url::parse(url).map_err(|_| bad())?;
            if !loopback(endpoint)
                || !loopback(&url)
                || endpoint.host_str() != url.host_str()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
                || url.query().is_some()
            {
                return Err(bad());
            }
            url
        } else {
            if endpoint.scheme() != "https"
                || endpoint.port().is_some()
                || !endpoint
                    .host_str()
                    .is_some_and(|host| host.ends_with(".openai.azure.com"))
            {
                return Err(bad());
            }
            Url::parse(&format!(
                "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
                snapshot.tenant_id
            ))
            .map_err(|_| bad())?
        };
        if !matches!(
            endpoint.path(),
            "/openai/v1/responses" | "/openai/v1/chat/completions"
        ) && !loopback(endpoint)
        {
            return Err(bad());
        }
        Ok(Self {
            source: Arc::new(source),
            token_url,
            state: Mutex::new(State {
                snapshot,
                poisoned: false,
            }),
        })
    }
    pub(crate) async fn authorization(
        &self,
        client: &Client,
        deadline: tokio::time::Instant,
        cancel: &CancellationToken,
    ) -> Result<HeaderValue, TransportError> {
        let mut state = tokio::select! { biased;
            _=cancel.cancelled()=>return Err(TransportError::Cancelled),
            _=tokio::time::sleep_until(deadline)=>return Err(TransportError::Timeout),
            guard=self.state.lock()=>guard,
        };
        if state.poisoned {
            return Err(bad());
        }
        self.authorize_locked(client, deadline, cancel, &mut state)
            .await
    }
    async fn authorize_locked(
        &self,
        client: &Client,
        deadline: tokio::time::Instant,
        cancel: &CancellationToken,
        state: &mut State,
    ) -> Result<HeaderValue, TransportError> {
        let State { snapshot, poisoned } = state;
        // Cross-process locking protects rotations across separately configured
        // clients. Lock waits consume the same deadline as the model request.
        let lock = loop {
            if cancel.is_cancelled() {
                return Err(TransportError::Cancelled);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(TransportError::Timeout);
            }
            if let Some(lock) = self.source.try_lock()? {
                break lock;
            }
            tokio::select! { biased;
                _=cancel.cancelled()=>return Err(TransportError::Cancelled),
                _=tokio::time::sleep_until(deadline)=>return Err(TransportError::Timeout),
                _=tokio::time::sleep(std::time::Duration::from_millis(25))=>{},
            }
        };
        let current = self.source.read()?;
        if !snapshot.same_identity(&current)
            || current.revision < snapshot.revision
            || (current.revision == snapshot.revision && current != *snapshot)
        {
            return Err(bad());
        }
        *snapshot = current;
        if let Some(header) = snapshot.current()? {
            return Ok(header);
        }
        if snapshot.revision >= SAFE_INTEGER - 1 {
            return Err(bad());
        }
        let started = now()?;
        let refresh = async {
            // Only a polled exchange can consume a refresh token. Waiting for
            // the local lock or a predispatch cancellation leaves it reusable.
            *poisoned = true;
            let mut response = client
                .post(self.token_url.clone())
                .form(&[
                    ("client_id", snapshot.client_id.as_str()),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", snapshot.refresh_token.as_str()),
                    ("scope", SCOPE),
                ])
                .send()
                .await
                .map_err(|_| bad())?;
            if !response.status().is_success()
                || response
                    .content_length()
                    .is_some_and(|size| size > LIMIT as u64)
                || !response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|value| {
                        value.split(';').next().is_some_and(|kind| {
                            kind.trim().eq_ignore_ascii_case("application/json")
                        })
                    })
            {
                return Err(bad());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| bad())? {
                if chunk.len() > LIMIT.saturating_sub(bytes.len()) {
                    return Err(bad());
                }
                bytes.extend_from_slice(&chunk);
            }
            let token: Token = serde_json::from_slice(&bytes).map_err(|_| bad())?;
            if !token.token_type.eq_ignore_ascii_case("Bearer")
                || !(61..=86400).contains(&token.expires_in)
                || token.error.is_some()
            {
                return Err(bad());
            }
            bearer(&token.access_token)?;
            if token
                .refresh_token
                .as_deref()
                .is_some_and(|token| !secret(token))
            {
                return Err(bad());
            }
            Ok(token)
        };
        let token = tokio::select! { biased;
            _=cancel.cancelled()=>return Err(TransportError::Cancelled),
            _=tokio::time::sleep_until(deadline)=>return Err(TransportError::Timeout),
            result=refresh=>result?,
        };
        let mut updated = snapshot.clone();
        updated.revision = updated.revision.checked_add(1).ok_or_else(bad)?;
        updated.access_token = Some(token.access_token);
        updated.expires_at_ms = Some(
            started
                .checked_add(token.expires_in.checked_mul(1000).ok_or_else(bad)?)
                .ok_or_else(bad)?,
        );
        if let Some(refresh) = token.refresh_token {
            updated.refresh_token = refresh;
        }
        updated.validate()?;
        let source = self.source.clone();
        let expected = snapshot.clone();
        let replacement = updated.clone();
        // Once the server rotates a token, finish durable replacement even if
        // cancellation arrives. This task is joined; no detached credential write.
        tokio::task::spawn_blocking(move || source.replace(&lock, &expected, &replacement))
            .await
            .map_err(|_| bad())??;
        *snapshot = updated;
        // Cancellation after a durable rotation cannot make that token unknown.
        *poisoned = false;
        if cancel.is_cancelled() {
            return Err(TransportError::Cancelled);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(TransportError::Timeout);
        }
        snapshot.current()?.ok_or_else(bad)
    }
}
#[derive(Deserialize)]
struct Token {
    token_type: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    error: Option<serde_json::Value>,
}
