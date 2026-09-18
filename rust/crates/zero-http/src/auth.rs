use crate::{Error, ErrorCode};
use aho_corasick::{AhoCorasick, AhoCorasickKind, MatchKind};
use base64::Engine;
use std::collections::BTreeMap;
use zero_protocol::http::HttpAuthDescriptor;

const MASK: &[u8] = b"<REDACTED-AUTH>";
/// Runtime-only credentials. Deliberately neither Debug nor Serialize.
pub struct StaticAuth {
    pub(crate) descriptor: HttpAuthDescriptor,
    pub(crate) headers: BTreeMap<String, String>,
    pub(crate) secrets: Vec<Vec<u8>>,
}
impl StaticAuth {
    pub fn new(
        revision: String,
        origin: String,
        headers: BTreeMap<String, String>,
    ) -> Result<Self, Error> {
        if revision.is_empty() || revision.len() > 256 || headers.is_empty() || headers.len() > 128
        {
            return Err(ErrorCode::Invalid);
        }
        let origin = crate::policy::origin(&origin)?;
        if headers
            .iter()
            .map(|(k, v)| k.len() + v.len() + 4)
            .sum::<usize>()
            > 65536
        {
            return Err(ErrorCode::Limit);
        }
        let mut normalized = BTreeMap::new();
        let mut secrets = Vec::new();
        for (name, value) in headers {
            let name = crate::policy::header_name(&name)?;
            if value.is_empty()
                || value.len() > 8192
                || http::HeaderValue::from_str(&value).is_err()
                || normalized.insert(name.clone(), value.clone()).is_some()
            {
                return Err(ErrorCode::Invalid);
            }
            add_secret(&mut secrets, value.as_bytes());
            if name == "authorization" || name == "proxy-authorization" {
                if let Some((scheme, token)) = value.split_once(' ') {
                    add_secret(&mut secrets, token.trim().as_bytes());
                    if scheme.eq_ignore_ascii_case("basic") {
                        if let Ok(decoded) =
                            base64::engine::general_purpose::STANDARD.decode(token.trim())
                        {
                            add_secret(&mut secrets, &decoded);
                            if let Some(i) = decoded.iter().position(|b| *b == b':') {
                                add_secret(&mut secrets, &decoded[..i]);
                                add_secret(&mut secrets, &decoded[i + 1..]);
                            }
                        }
                    }
                }
            }
            if name == "cookie" {
                for item in value.split(';') {
                    if let Some((_, v)) = item.trim().split_once('=') {
                        add_secret(&mut secrets, v.as_bytes());
                    }
                }
            }
        }
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        secrets.dedup();
        let descriptor = HttpAuthDescriptor {
            revision,
            origin,
            header_names: normalized.keys().cloned().collect(),
        };
        let public = serde_json::to_vec(&descriptor).map_err(|_| ErrorCode::Invalid)?;
        if contains(&public, &secrets)
            || value_contains(
                &serde_json::to_value(&descriptor).map_err(|_| ErrorCode::Invalid)?,
                &secrets,
            )
        {
            return Err(ErrorCode::Secret);
        }
        Ok(Self {
            descriptor,
            headers: normalized,
            secrets,
        })
    }
    pub fn descriptor(&self) -> &HttpAuthDescriptor {
        &self.descriptor
    }
}
fn add_secret(out: &mut Vec<Vec<u8>>, value: &[u8]) {
    if value.is_empty() {
        return;
    }
    out.push(value.to_vec());
    let mut encoded = Vec::new();
    for &b in value {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            encoded.push(b);
        } else {
            encoded.extend_from_slice(format!("%{b:02X}").as_bytes());
        }
    }
    if encoded != value {
        out.push(encoded);
    }
}
fn matcher(secrets: &[Vec<u8>]) -> Result<AhoCorasick, Error> {
    if secrets.len() > 1024 || secrets.iter().map(Vec::len).sum::<usize>() > 2 * 1024 * 1024 {
        return Err(ErrorCode::Limit);
    }
    AhoCorasick::builder()
        .kind(Some(AhoCorasickKind::ContiguousNFA))
        .match_kind(MatchKind::LeftmostLongest)
        .build(secrets.iter().filter(|s| !s.is_empty()))
        .map_err(|_| ErrorCode::Limit)
}
pub(crate) fn contains(bytes: &[u8], secrets: &[Vec<u8>]) -> bool {
    matcher(secrets).map_or(true, |m| m.is_match(bytes))
}
pub(crate) fn value_contains(value: &serde_json::Value, secrets: &[Vec<u8>]) -> bool {
    fn visit(value: &serde_json::Value, m: &AhoCorasick) -> bool {
        match value {
            serde_json::Value::String(s) => m.is_match(s.as_bytes()),
            serde_json::Value::Array(a) => a.iter().any(|v| visit(v, m)),
            serde_json::Value::Object(o) => o
                .iter()
                .any(|(k, v)| m.is_match(k.as_bytes()) || visit(v, m)),
            _ => false,
        }
    }
    matcher(secrets).map_or(true, |m| visit(value, &m))
}
fn append(out: &mut Vec<u8>, bytes: &[u8], cap: usize) -> Result<(), Error> {
    if out.len().checked_add(bytes.len()).is_none_or(|n| n > cap) {
        return Err(ErrorCode::Limit);
    }
    out.extend_from_slice(bytes);
    Ok(())
}
pub(crate) fn redact(bytes: &[u8], secrets: &[Vec<u8>], cap: usize) -> Result<Vec<u8>, Error> {
    let matcher = matcher(secrets)?;
    let mut out = Vec::with_capacity(bytes.len().min(cap));
    let mut end = 0;
    for found in matcher.find_iter(bytes) {
        append(&mut out, &bytes[end..found.start()], cap)?;
        append(&mut out, MASK, cap)?;
        end = found.end();
    }
    append(&mut out, &bytes[end..], cap)?;
    Ok(out)
}
pub(crate) async fn redact_body(
    bytes: &[u8],
    secrets: &[Vec<u8>],
    cap: usize,
) -> Result<Vec<u8>, Error> {
    let matcher = matcher(secrets)?;
    let mut out = Vec::with_capacity(bytes.len().min(cap));
    let mut end = 0;
    let mut last_yield = 0;
    for found in matcher.find_iter(bytes) {
        append(&mut out, &bytes[end..found.start()], cap)?;
        append(&mut out, MASK, cap)?;
        end = found.end();
        if end - last_yield >= 16384 {
            tokio::task::yield_now().await;
            last_yield = end;
        }
    }
    for chunk in bytes[end..].chunks(16384) {
        append(&mut out, chunk, cap)?;
        tokio::task::yield_now().await;
    }
    Ok(out)
}
pub(crate) fn sensitive(name: &str) -> bool {
    matches!(
        name,
        "authorization"
            | "proxy-authorization"
            | "cookie"
            | "set-cookie"
            | "x-api-key"
            | "x-auth-token"
            | "x-access-token"
            | "x-amz-security-token"
    ) || (name.starts_with("x-")
        && ["apikey", "api-key", "api_key", "auth", "token", "secret"]
            .iter()
            .any(|s| name.ends_with(s)))
}
pub(crate) fn redact_headers(
    headers: &[(String, String)],
    secrets: &[Vec<u8>],
) -> Result<Vec<(String, String)>, Error> {
    let mut total = 2usize;
    headers
        .iter()
        .map(|(k, v)| {
            let value = if sensitive(k) {
                String::from_utf8_lossy(MASK).into_owned()
            } else {
                String::from_utf8(redact(v.as_bytes(), secrets, 65536)?)
                    .map_err(|_| ErrorCode::Protocol)?
            };
            total = total
                .checked_add(k.len() + value.len() + 4)
                .ok_or(ErrorCode::Limit)?;
            if total > 65536 {
                return Err(ErrorCode::Limit);
            }
            Ok((k.clone(), value))
        })
        .collect()
}
