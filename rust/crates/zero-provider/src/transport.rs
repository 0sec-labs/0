use crate::{Completion, ResponsesRequest, responses::Accumulator, sse::Decoder};
use reqwest::{
    Client, Url,
    header::{AUTHORIZATION, HeaderValue},
};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error(
        "invalid provider endpoint; use HTTPS or explicit loopback HTTP without URL credentials"
    )]
    InvalidEndpoint,
    #[error("invalid provider request")]
    InvalidRequest,
    #[error("invalid provider response")]
    InvalidResponse,
    #[error("provider response exceeded configured limit")]
    ResponseLimit,
    #[error("provider request cancelled; remote completion may be unknown")]
    Cancelled,
    #[error("provider request deadline exceeded; remote completion may be unknown")]
    Timeout,
    #[error("provider transport failed; remote completion may be unknown")]
    Network,
    #[error("provider rejected request with HTTP status {0}")]
    Http(u16),
}

/// Credentials are never serializable or printable, and are bound to one URL.
pub struct Endpoint {
    url: Url,
    authorization: Option<HeaderValue>,
    api_key: Option<HeaderValue>,
}
impl Endpoint {
    /// Exact provider URL, including its complete gateway prefix. The historical
    /// constructor name does not select the wire; ProviderClient does.
    pub fn responses(url: &str, api_key: Option<&str>) -> Result<Self, TransportError> {
        let url = Url::parse(url).map_err(|_| TransportError::InvalidEndpoint)?;
        let loopback = url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.query().is_some()
            || url.host_str().is_none()
        {
            return Err(TransportError::InvalidEndpoint);
        }
        let authorization = api_key
            .map(|key| {
                if key.is_empty() {
                    return Err(TransportError::InvalidEndpoint);
                }
                let mut value = HeaderValue::from_str(&format!("Bearer {key}"))
                    .map_err(|_| TransportError::InvalidEndpoint)?;
                value.set_sensitive(true);
                Ok(value)
            })
            .transpose()?;
        let api_key = api_key
            .map(|key| {
                let mut value =
                    HeaderValue::from_str(key).map_err(|_| TransportError::InvalidEndpoint)?;
                value.set_sensitive(true);
                Ok(value)
            })
            .transpose()?;
        Ok(Self {
            url,
            authorization,
            api_key,
        })
    }
}

pub struct ProviderClient {
    client: Client,
    endpoint: Endpoint,
    timeout: Duration,
    max_bytes: usize,
    wire: crate::WireApi,
    hosted_catalog: Option<crate::HostedCatalogPin>,
}
impl ProviderClient {
    /// Endpoint identity excludes credentials and query strings.
    pub fn endpoint_identity(&self) -> &str {
        self.endpoint.url.as_str()
    }
    pub fn new(
        endpoint: Endpoint,
        timeout: Duration,
        max_bytes: usize,
    ) -> Result<Self, TransportError> {
        Self::with_wire(endpoint, crate::WireApi::Responses, timeout, max_bytes)
    }
    pub fn with_wire(
        endpoint: Endpoint,
        wire: crate::WireApi,
        timeout: Duration,
        max_bytes: usize,
    ) -> Result<Self, TransportError> {
        if timeout.is_zero()
            || timeout > Duration::from_secs(3600)
            || !(1024..=64 * 1024 * 1024).contains(&max_bytes)
        {
            return Err(TransportError::InvalidRequest);
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| TransportError::Network)?;
        Ok(Self {
            client,
            endpoint,
            timeout,
            max_bytes,
            wire,
            hosted_catalog: None,
        })
    }
    /// Bind a validated catalog quote to this exact route. Credentials remain in
    /// Endpoint; the pin is safe to retain as durable policy/accounting metadata.
    pub fn bind_hosted(mut self, pin: crate::HostedCatalogPin) -> Result<Self, TransportError> {
        crate::validate_hosted_pin(&pin).map_err(|_| TransportError::InvalidRequest)?;
        if self.hosted_catalog.is_some()
            || self.endpoint_identity() != pin.endpoint
            || self.wire != pin.wire_api
        {
            return Err(TransportError::InvalidRequest);
        }
        self.hosted_catalog = Some(pin);
        Ok(self)
    }
    pub fn hosted_catalog(&self) -> Option<&crate::HostedCatalogPin> {
        self.hosted_catalog.as_ref()
    }
    /// Reject mismatched authority rather than rewriting model or output limits.
    pub fn validate_policy(
        &self,
        model: &str,
        max_output_tokens: u32,
    ) -> Result<(), TransportError> {
        if let Some(pin) = &self.hosted_catalog {
            if model != pin.model
                || max_output_tokens == 0
                || max_output_tokens > pin.max_output_tokens
            {
                return Err(TransportError::InvalidRequest);
            }
        }
        Ok(())
    }
    pub fn wire_api(&self) -> crate::WireApi {
        self.wire
    }
    pub fn validate(&self, request: &ResponsesRequest) -> Result<(), TransportError> {
        self.encode(request).map(|_| ())
    }
    fn encode(&self, request: &ResponsesRequest) -> Result<serde_json::Value, TransportError> {
        self.validate_policy(&request.model, request.max_output_tokens)?;
        match self.wire {
            crate::WireApi::Responses => {
                if request.input.iter().any(|item| {
                    item.get("type")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|kind| {
                            kind.starts_with("chat_completion_") || kind.starts_with("anthropic_")
                        })
                }) {
                    return Err(TransportError::InvalidRequest);
                }
                crate::request_body(request)
            }
            crate::WireApi::ChatCompletions => crate::chat::encode(request),
            crate::WireApi::AnthropicMessages => crate::anthropic::encode(request),
        }
    }
    /// Compatibility entry point for an explicitly configured Responses route.
    pub async fn responses(
        &self,
        request: &ResponsesRequest,
        cancel: CancellationToken,
    ) -> Result<Completion, TransportError> {
        if self.wire != crate::WireApi::Responses {
            return Err(TransportError::InvalidRequest);
        }
        self.complete(request, cancel).await
    }
    /// No implicit retries: a lost reply may still have consumed provider budget.
    pub async fn complete(
        &self,
        request: &ResponsesRequest,
        cancel: CancellationToken,
    ) -> Result<Completion, TransportError> {
        let body = self.encode(request)?;
        if cancel.is_cancelled() {
            return Err(TransportError::Cancelled);
        }
        let deadline = tokio::time::Instant::now() + self.timeout;
        let mut post = self
            .client
            .post(self.endpoint.url.clone())
            .json(&body)
            .header("Accept", "text/event-stream");
        if self.wire == crate::WireApi::AnthropicMessages {
            post = post.header("anthropic-version", "2023-06-01");
            if let Some(key) = &self.endpoint.api_key {
                post = post.header("x-api-key", key.clone());
            }
        } else if let Some(auth) = &self.endpoint.authorization {
            post = post.header(AUTHORIZATION, auth.clone());
        }
        let mut response = tokio::select! {
            biased;
            _=cancel.cancelled()=>return Err(TransportError::Cancelled),
            _=tokio::time::sleep_until(deadline)=>return Err(TransportError::Timeout),
            result=post.send()=>result.map_err(|_|TransportError::Network)?,
        };
        if !response.status().is_success() {
            return Err(TransportError::Http(response.status().as_u16()));
        }
        if !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .is_some_and(|v| v.trim().eq_ignore_ascii_case("text/event-stream"))
            })
        {
            return Err(TransportError::InvalidResponse);
        }
        let mut decoder = Decoder::default();
        let mut accumulator = match self.wire {
            crate::WireApi::Responses => StreamAccumulator::Responses(Accumulator::default()),
            crate::WireApi::AnthropicMessages => StreamAccumulator::Anthropic(
                crate::anthropic_stream::Accumulator::new(&request.model),
            ),
            crate::WireApi::ChatCompletions => {
                StreamAccumulator::Chat(crate::chat::Accumulator::new(&request.model))
            }
        };
        let mut received = 0usize;
        loop {
            let chunk = tokio::select! {
                biased;
                _=cancel.cancelled()=>return Ok(accumulator.finish(Some("provider request cancelled; usage may be incomplete"))),
                _=tokio::time::sleep_until(deadline)=>return Ok(accumulator.finish(Some("provider request deadline exceeded; usage may be incomplete"))),
                chunk=response.chunk()=>chunk,
            };
            let chunk = match chunk {
                Ok(Some(chunk)) => chunk,
                Ok(None) => return Ok(accumulator.finish(None)),
                Err(_) => {
                    return Ok(accumulator.finish(Some(
                        "provider stream transport failed; usage may be incomplete",
                    )));
                }
            };
            received = match received.checked_add(chunk.len()) {
                Some(n) if n <= self.max_bytes => n,
                _ => {
                    return Ok(
                        accumulator.finish(Some("provider response exceeded configured limit"))
                    );
                }
            };
            let frames = match decoder.feed(&chunk) {
                Ok(frames) => frames,
                Err(_) => {
                    return Ok(
                        accumulator.finish(Some("invalid or oversized provider stream frame"))
                    );
                }
            };
            for frame in frames {
                if accumulator.event(&frame).is_err() {
                    return Ok(accumulator.finish(Some("invalid provider stream event")));
                }
            }
        }
    }
}
enum StreamAccumulator {
    Responses(Accumulator),
    Chat(crate::chat::Accumulator),
    Anthropic(crate::anthropic_stream::Accumulator),
}
impl StreamAccumulator {
    fn event(&mut self, data: &[u8]) -> Result<(), TransportError> {
        match self {
            Self::Responses(a) => a.event(data),
            Self::Chat(a) => a.event(data),
            Self::Anthropic(a) => a.event(data),
        }
    }
    fn finish(self, interrupted: Option<&str>) -> Completion {
        match self {
            Self::Responses(a) => a.finish(interrupted),
            Self::Chat(a) => a.finish(interrupted),
            Self::Anthropic(a) => a.finish(interrupted),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    async fn server(body: String, status: &str) -> (Endpoint, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/custom/v1/responses",
            listener.local_addr().unwrap()
        );
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0u8; 1024];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buf[..n]);
                if let Some(start) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..start]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|v| v.parse().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= start + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (
            Endpoint::responses(&url, Some("fixture-key")).unwrap(),
            task,
        )
    }
    fn request() -> ResponsesRequest {
        ResponsesRequest {
            model: "fixture-model".into(),
            instructions: "inspect".into(),
            input: vec![serde_json::json!({"role":"user","content":"hello"})],
            tools: vec![],
            max_output_tokens: 32,
        }
    }
    #[tokio::test]
    async fn real_http_transport_preserves_custom_path_auth_and_final_usage() {
        let event = serde_json::json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":2,"output_tokens":1}}});
        let (endpoint, server) = server(format!("data: {event}\n\n"), "200 OK").await;
        let client = ProviderClient::new(endpoint, Duration::from_secs(2), 8192).unwrap();
        let result = client
            .responses(&request(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.status, crate::CompletionStatus::Completed);
        assert_eq!(result.usage.unwrap().input_tokens, 2);
        let wire = server.await.unwrap();
        assert!(wire.starts_with("POST /custom/v1/responses "));
        assert!(wire.contains("authorization: Bearer fixture-key"));
        assert!(wire.contains("\"max_output_tokens\":32"));
    }
    #[tokio::test]
    async fn redirect_is_never_followed_and_truncation_is_not_success() {
        let (endpoint, server) = server("".into(), "302 Found").await;
        let client = ProviderClient::new(endpoint, Duration::from_secs(2), 8192).unwrap();
        assert!(matches!(
            client.responses(&request(), CancellationToken::new()).await,
            Err(TransportError::Http(302))
        ));
        server.await.unwrap();
        let (endpoint,server)=self::server("data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"status\":\"in_progress\"}}\n\n".into(),"200 OK").await;
        let result = ProviderClient::new(endpoint, Duration::from_secs(2), 8192)
            .unwrap()
            .responses(&request(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.status, crate::CompletionStatus::Incomplete);
        assert!(result.content.is_empty());
        assert!(result.usage.is_none());
        server.await.unwrap();
    }
    #[test]
    fn rejects_credential_urls_plaintext_remote_and_header_injection() {
        for url in [
            "http://remote.example/responses",
            "https://user:pass@example.test/responses",
            "https://example.test/responses?api_key=secret",
        ] {
            assert!(Endpoint::responses(url, None).is_err());
        }
        assert!(
            Endpoint::responses(
                "https://example.test/responses",
                Some("key\r\ninjected: value")
            )
            .is_err()
        );
    }
}

#[cfg(test)]
mod endpoint_tests {
    use super::Endpoint;
    #[test]
    fn http_allows_ipv4_and_ipv6_loopback_but_not_other_literal_addresses() {
        assert!(Endpoint::responses("http://127.0.0.1:8080/responses", None).is_ok());
        assert!(Endpoint::responses("http://[::1]:8080/responses", None).is_ok());
        assert!(Endpoint::responses("http://[::2]:8080/responses", None).is_err());
        assert!(Endpoint::responses("http://192.0.2.1:8080/responses", None).is_err());
    }
}
