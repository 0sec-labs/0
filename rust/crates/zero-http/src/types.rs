use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use zero_protocol::http::HttpRequestIntent;

/// Host accounting is durable before a permit is returned. Hooks must be
/// cancellation-safe: dropping a waiter never undoes an already committed permit.
pub trait ExecutionHooks: Send + Sync {
    fn admit<'a>(
        &'a self,
        intent: &'a HopIntent,
    ) -> BoxFuture<'a, Result<DispatchPermit, HookError>>;
    fn observe_headers<'a>(
        &'a self,
        permit: &'a DispatchPermit,
        status: u16,
        retry_after: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), HookError>>;
    fn settle<'a>(
        &'a self,
        permit: &'a DispatchPermit,
        observation: &'a HopObservation,
    ) -> BoxFuture<'a, Result<(), HookError>>;
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HopIntent {
    pub index: u32,
    pub profile_sha256: String,
    pub url: String,
    pub host: String,
    pub method: String,
    pub addresses: Vec<SocketAddr>,
    pub selected_address: SocketAddr,
    pub request_body_bytes: u64,
    pub response_decoded_limit: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DispatchPermit {
    pub id: String,
}
#[derive(Clone, Copy, Debug, thiserror::Error)]
pub enum HookError {
    #[error("HTTP accounting rejected the request")]
    Rejected,
    #[error("HTTP accounting is unavailable")]
    Unavailable,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DispatchState {
    NeverDispatched,
    PossiblyDispatched,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HttpDisposition {
    CompleteResponse,
    Rejected,
    Incomplete,
    Cancelled,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HopObservation {
    pub index: u32,
    pub permit: DispatchPermit,
    pub status: Option<u16>,
    pub redirect_url: Option<String>,
    pub request_body_bytes: u64,
    pub response_wire_bytes: u64,
    pub response_decoded_bytes: u64,
    pub complete: bool,
    pub error: Option<ErrorCode>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HttpResponse {
    pub url: String,
    pub status: u16,
    /// Ordered pairs preserve repeated headers. Values are already redacted.
    pub headers: Vec<(String, String)>,
    /// Already redacted exact bytes; callers may retain these in bounded chunks.
    pub body: Vec<u8>,
    pub wire_bytes: u64,
    pub decoded_bytes: u64,
    pub redacted_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HttpOutcome {
    pub dispatch: DispatchState,
    pub disposition: HttpDisposition,
    pub response: Option<HttpResponse>,
    pub hops: Vec<HopObservation>,
    pub error: Option<ErrorCode>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    #[error("invalid HTTP profile or request")]
    Invalid,
    #[error("HTTP scope denies this request")]
    Scope,
    #[error("known credentials cannot appear in public HTTP intent")]
    Secret,
    #[error("DNS resolution failed or exceeded its bounds")]
    Dns,
    #[error("HTTP operation deadline exceeded")]
    Deadline,
    #[error("HTTP operation cancelled")]
    Cancelled,
    #[error("target connection failed")]
    Connect,
    #[error("target TLS authentication failed")]
    Tls,
    #[error("target HTTP protocol failed")]
    Protocol,
    #[error("target HTTP response exceeded its bounds")]
    Limit,
    #[error("target response decoding failed")]
    Decode,
    #[error("HTTP redirect was rejected")]
    Redirect,
    #[error("HTTP durable accounting failed")]
    Accounting,
}
pub type Error = ErrorCode;

/// Can only be produced by the credential-bearing client's pure preparation.
#[derive(Clone)]
pub struct PreparedRequest {
    pub(crate) intent: HttpRequestIntent,
}
impl PreparedRequest {
    pub fn intent(&self) -> &HttpRequestIntent {
        &self.intent
    }
}
