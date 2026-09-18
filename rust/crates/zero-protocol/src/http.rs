//! Host-authored target HTTP authority. Credentials and live clients are not wire values.
use crate::ValidationError;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpProfilePolicy {
    pub schema_version: u32,
    pub base_url: String,
    pub in_scope: Vec<String>,
    pub out_of_scope: Vec<String>,
    pub denied_hosts: Vec<String>,
    pub allowed_path_prefixes: Vec<String>,
    pub denied_path_prefixes: Vec<String>,
    pub allowed_methods: Vec<String>,
    pub allowed_headers: Vec<String>,
    #[serde(default)]
    pub redirect: HttpRedirectPolicy,
    pub limits: HttpLimits,
    pub rate: HttpRatePolicy,
    pub budget: HttpBudget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<HttpAttribution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<HttpAuthDescriptor>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum HttpRedirectPolicy {
    #[default]
    Manual,
    Error,
    Follow {
        max_hops: u32,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpLimits {
    pub timeout_ms: u64,
    pub max_request_body_bytes: u64,
    pub max_response_wire_bytes: u64,
    pub max_response_decoded_bytes: u64,
    pub max_request_header_bytes: u64,
    pub max_request_headers: u32,
    pub max_response_header_bytes: u64,
    pub max_response_headers: u32,
    pub max_dns_answers: u32,
    pub max_dns_cname_depth: u32,
    pub max_dns_queries: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpRateLimit {
    pub requests_per_interval: u32,
    pub interval_ms: u64,
    pub burst: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpRatePolicy {
    pub default: HttpRateLimit,
    #[serde(deserialize_with = "deserialize_rate_overrides")]
    pub per_host: BTreeMap<String, HttpRateLimit>,
    pub jitter_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpBudget {
    /// Shared across root, joined children, and continuations of that account.
    pub max_requests: u64,
    /// Application body bytes, not transport/TLS/IP octets.
    pub max_request_body_bytes: u64,
    pub max_response_decoded_bytes: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpAuthDescriptor {
    /// Host must change this opaque public revision when any credential rotates.
    pub revision: String,
    pub origin: String,
    pub header_names: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpAttribution {
    #[serde(deserialize_with = "deserialize_headers")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent_token: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpRequestArguments {
    pub url: String,
    /// Matches the legacy http_request tool, not fetch's GET default.
    #[serde(default = "post")]
    pub method: String,
    #[serde(default, deserialize_with = "deserialize_headers")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HttpRequestIntent {
    pub profile_sha256: String,
    pub url: String,
    pub method: String,
    #[serde(deserialize_with = "deserialize_headers")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}
fn post() -> String {
    "POST".into()
}
fn invalid(message: &str) -> ValidationError {
    ValidationError(message.into())
}
fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn strings(values: &[String], count: usize, bytes: usize, folded: bool) -> bool {
    values.len() <= count && values.iter().all(|s| bounded(s, bytes)) && {
        let keys = values
            .iter()
            .map(|s| {
                if folded {
                    s.to_ascii_lowercase()
                } else {
                    s.clone()
                }
            })
            .collect::<BTreeSet<_>>();
        keys.len() == values.len()
    }
}
pub fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}
fn headers_valid(headers: &BTreeMap<String, String>) -> bool {
    headers.len() <= 128
        && headers.iter().all(|(name, value)| {
            valid_header_name(name)
                && value.len() <= 65536
                && !value.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n'))
        })
        && headers
            .iter()
            .map(|(k, v)| k.len().saturating_add(v.len()))
            .sum::<usize>()
            <= 65536
        && headers
            .keys()
            .map(|k| k.to_ascii_lowercase())
            .collect::<BTreeSet<_>>()
            .len()
            == headers.len()
}
/// Reject duplicate/case-colliding HTTP fields before a map could silently overwrite them.
pub fn deserialize_headers<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct Headers;
    impl<'de> serde::de::Visitor<'de> for Headers {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a bounded object of unique HTTP header names and string values")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut out = BTreeMap::new();
            let mut names = BTreeSet::new();
            let mut bytes = 0usize;
            while let Some((name, value)) = map.next_entry::<String, String>()? {
                bytes = bytes.saturating_add(name.len()).saturating_add(value.len());
                if out.len() >= 128
                    || bytes > 65536
                    || !valid_header_name(&name)
                    || !names.insert(name.to_ascii_lowercase())
                    || value.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n'))
                {
                    return Err(serde::de::Error::custom(
                        "invalid, duplicate or oversized HTTP header field",
                    ));
                }
                out.insert(name, value);
            }
            Ok(out)
        }
    }
    deserializer.deserialize_map(Headers)
}
fn deserialize_rate_overrides<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, HttpRateLimit>, D::Error> {
    struct Overrides;
    impl<'de> serde::de::Visitor<'de> for Overrides {
        type Value = BTreeMap<String, HttpRateLimit>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("at most 128 unique HTTP rate override hostnames")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut result = BTreeMap::new();
            let mut keys = BTreeSet::new();
            while let Some((host, rate)) = map.next_entry::<String, HttpRateLimit>()? {
                if result.len() >= 128
                    || !bounded(&host, 1024)
                    || !keys.insert(host.to_ascii_lowercase())
                {
                    return Err(serde::de::Error::custom(
                        "invalid or duplicate HTTP rate override",
                    ));
                }
                result.insert(host, rate);
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(Overrides)
}
impl HttpRateLimit {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if !(1..=10000).contains(&self.requests_per_interval)
            || !(1..=3600000).contains(&self.interval_ms)
            || !(1..=1000).contains(&self.burst)
        {
            return Err(invalid("HTTP rate parameters exceed supported bounds"));
        }
        Ok(())
    }
}
impl HttpProfilePolicy {
    /// Structural limits only; zero-http additionally canonicalizes and enforces URL/scope semantics.
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.schema_version != 1 || !bounded(&self.base_url, 8192) {
            return Err(invalid("invalid HTTP policy version or base URL"));
        }
        if !strings(&self.in_scope, 256, 1024, true)
            || !strings(&self.out_of_scope, 256, 1024, true)
            || !strings(&self.denied_hosts, 256, 1024, true)
            || !strings(&self.allowed_path_prefixes, 256, 8192, false)
            || !strings(&self.denied_path_prefixes, 256, 8192, false)
            || !strings(&self.allowed_methods, 9, 16, true)
            || !strings(&self.allowed_headers, 128, 256, true)
            || self.allowed_headers.iter().any(|s| !valid_header_name(s))
        {
            return Err(invalid("invalid or duplicate HTTP policy rules"));
        }
        if self.allowed_methods.is_empty()
            || self.allowed_methods.iter().any(|s| {
                !matches!(
                    s.as_str(),
                    "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
                )
            })
        {
            return Err(invalid(
                "HTTP policy methods must be explicit supported uppercase methods",
            ));
        }
        if matches!(self.redirect,HttpRedirectPolicy::Follow{max_hops} if !(1..=5).contains(&max_hops))
        {
            return Err(invalid("HTTP redirect hop limit must be 1..5"));
        }
        let l = &self.limits;
        if !(1..=120000).contains(&l.timeout_ms)
            || l.max_request_body_bytes > 1024 * 1024
            || l.max_response_wire_bytes > 16 * 1024 * 1024
            || l.max_response_decoded_bytes > 16 * 1024 * 1024
            || !(1..=65536).contains(&l.max_request_header_bytes)
            || !(1..=65536).contains(&l.max_response_header_bytes)
            || !(1..=128).contains(&l.max_request_headers)
            || !(1..=128).contains(&l.max_response_headers)
            || !(1..=64).contains(&l.max_dns_answers)
            || l.max_dns_cname_depth > 8
            || !(1..=16).contains(&l.max_dns_queries)
        {
            return Err(invalid("HTTP limits exceed supported bounds"));
        }
        self.rate.default.validate()?;
        if self.rate.per_host.len() > 128
            || self.rate.jitter_ms > 1000
            || self.rate.per_host.keys().any(|s| !bounded(s, 1024))
        {
            return Err(invalid("HTTP rate overrides exceed supported bounds"));
        }
        for rate in self.rate.per_host.values() {
            rate.validate()?;
        }
        if self.budget.max_requests == 0 {
            return Err(invalid("HTTP request budget must be positive"));
        }
        if let Some(auth) = &self.auth {
            if !bounded(&auth.revision, 128)
                || !bounded(&auth.origin, 8192)
                || auth.header_names.is_empty()
                || !strings(&auth.header_names, 128, 256, true)
                || auth.header_names.iter().any(|s| !valid_header_name(s))
            {
                return Err(invalid("invalid HTTP authentication descriptor"));
            }
        }
        if let Some(attribution) = &self.attribution {
            if !headers_valid(&attribution.headers)
                || attribution
                    .user_agent_token
                    .as_ref()
                    .is_some_and(|s| !bounded(s, 1024))
            {
                return Err(invalid("invalid HTTP attribution"));
            }
        }
        if serde_json::to_vec(self)
            .map_err(|_| invalid("invalid HTTP policy"))?
            .len()
            > 1024 * 1024
        {
            return Err(invalid("HTTP policy exceeds 1 MiB"));
        }
        Ok(())
    }
}
impl HttpRequestArguments {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if !bounded(&self.url, 8192)
            || !bounded(&self.method, 16)
            || !headers_valid(&self.headers)
            || self.body.as_ref().is_some_and(|b| b.len() > 1024 * 1024)
        {
            return Err(invalid("invalid or oversized HTTP request arguments"));
        }
        Ok(())
    }
}
