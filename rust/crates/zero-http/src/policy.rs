use crate::{Error, ErrorCode};
use ipnet::Ipv4Net;
use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr},
};
use url::Url;
use zero_protocol::http::{HttpProfilePolicy, HttpRequestArguments, HttpRequestIntent};

pub(crate) fn origin(value: &str) -> Result<String, Error> {
    let u = parse(value)?;
    Ok(u.origin().ascii_serialization())
}
pub(crate) fn parse(value: &str) -> Result<Url, Error> {
    if value.len() > 16384 || value.contains('\\') || value.chars().any(|c| c.is_control()) {
        return Err(ErrorCode::Invalid);
    }
    let mut u = Url::parse(value).map_err(|_| ErrorCode::Invalid)?;
    if !matches!(u.scheme(), "http" | "https")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.host_str().is_none()
    {
        return Err(ErrorCode::Invalid);
    }
    let host = u
        .host_str()
        .ok_or(ErrorCode::Invalid)?
        .trim_end_matches('.')
        .to_owned();
    u.set_host(Some(&host)).map_err(|_| ErrorCode::Invalid)?;
    Ok(u)
}
pub(crate) fn host(u: &Url) -> Result<String, Error> {
    Ok(u.host_str()
        .ok_or(ErrorCode::Invalid)?
        .trim_matches(['[', ']'])
        .to_lowercase())
}
fn normalize_rule(value: &str) -> Result<String, Error> {
    if value.contains('/') {
        return value
            .parse::<Ipv4Net>()
            .map(|n| n.trunc().to_string())
            .map_err(|_| ErrorCode::Invalid);
    }
    let (prefix, rest) = value.strip_prefix("*.").map_or(("", value), |s| ("*.", s));
    if rest.is_empty()
        || rest.contains('*')
        || rest.contains('@')
        || rest.contains('?')
        || rest.contains('#')
    {
        return Err(ErrorCode::Invalid);
    }
    let h = if let Ok(ip) = rest.trim_matches(['[', ']']).parse::<IpAddr>() {
        ip.to_string()
    } else {
        if rest.contains(':') {
            return Err(ErrorCode::Invalid);
        }
        host(&parse(&format!("http://{rest}"))?)?
    };
    Ok(format!("{prefix}{h}"))
}
fn matches(rule: &str, name: &str) -> bool {
    if let Ok(net) = rule.parse::<Ipv4Net>() {
        return name
            .parse::<IpAddr>()
            .ok()
            .and_then(mapped)
            .is_some_and(|ip| net.contains(&ip));
    }
    if let Some(tail) = rule.strip_prefix("*.") {
        return name.len() > tail.len() + 1 && name.ends_with(&format!(".{tail}"));
    }
    if let (Ok(a), Ok(b)) = (rule.parse::<IpAddr>(), name.parse::<IpAddr>()) {
        return a == b || mapped(a).zip(mapped(b)).is_some_and(|(a, b)| a == b);
    }
    rule == name
}
fn mapped(ip: IpAddr) -> Option<Ipv4Addr> {
    match ip {
        IpAddr::V4(v) => Some(v),
        IpAddr::V6(v) => v.to_ipv4_mapped(),
    }
}
pub(crate) fn private(ip: IpAddr) -> bool {
    if let Some(v) = mapped(ip) {
        let [a, b, _, _] = v.octets();
        return a == 0
            || a == 10
            || a == 127
            || (a == 100 && (64..=127).contains(&b))
            || (a == 169 && b == 254)
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168);
    }
    match ip {
        IpAddr::V6(v) => {
            v.is_unspecified()
                || v.is_loopback()
                || (v.segments()[0] & 0xfe00) == 0xfc00
                || (v.segments()[0] & 0xffc0) == 0xfe80
        }
        _ => false,
    }
}
fn local_name(name: &str) -> bool {
    name == "localhost" || name.ends_with(".localhost")
}
fn private_anchor(p: &HttpProfilePolicy) -> Result<bool, Error> {
    let h = host(&parse(&p.base_url)?)?;
    Ok(local_name(&h) || h.parse().is_ok_and(private))
}
fn decoded_path(path: &str) -> Result<String, Error> {
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let mut b = bytes[i];
        if b == b'%' {
            let h = *bytes.get(i + 1).ok_or(ErrorCode::Scope)?;
            let l = *bytes.get(i + 2).ok_or(ErrorCode::Scope)?;
            b = hex(h)
                .zip(hex(l))
                .map(|(h, l)| h * 16 + l)
                .ok_or(ErrorCode::Scope)?;
            if matches!(b, b'/' | b'\\' | b'%') {
                return Err(ErrorCode::Scope);
            }
            i += 2;
        }
        if b.is_ascii_control() || b == b'\\' {
            return Err(ErrorCode::Scope);
        }
        decoded.push(b);
        i += 1;
    }
    String::from_utf8(decoded).map_err(|_| ErrorCode::Scope)
}
fn path_match(prefix: &str, path: &str) -> bool {
    prefix == "/"
        || path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|s| s.starts_with('/'))
}
pub(crate) fn authorize(p: &HttpProfilePolicy, u: &Url) -> Result<(), Error> {
    let h = host(u)?;
    if p.denied_hosts
        .iter()
        .chain(&p.out_of_scope)
        .any(|r| matches(r, &h))
        || !p.in_scope.iter().any(|r| matches(r, &h))
    {
        return Err(ErrorCode::Scope);
    }
    if !private_anchor(p)? && (local_name(&h) || h.parse().is_ok_and(private)) {
        return Err(ErrorCode::Scope);
    }
    let path = decoded_path(u.path())?;
    if p.denied_path_prefixes.iter().any(|r| path_match(r, &path))
        || (!p.allowed_path_prefixes.is_empty()
            && !p.allowed_path_prefixes.iter().any(|r| path_match(r, &path)))
    {
        return Err(ErrorCode::Scope);
    }
    Ok(())
}
pub(crate) fn authorize_addresses(
    p: &HttpProfilePolicy,
    addresses: &[IpAddr],
) -> Result<(), Error> {
    if addresses.is_empty() || addresses.len() > p.limits.max_dns_answers as usize {
        return Err(ErrorCode::Dns);
    }
    let private_ok = private_anchor(p)?;
    for ip in addresses {
        if (!private_ok && private(*ip))
            || p.denied_hosts
                .iter()
                .chain(&p.out_of_scope)
                .any(|r| matches(r, &ip.to_string()))
        {
            return Err(ErrorCode::Scope);
        }
    }
    Ok(())
}
pub(crate) fn header_name(name: &str) -> Result<String, Error> {
    let n = http::HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| ErrorCode::Invalid)?
        .as_str()
        .to_owned();
    if matches!(
        n.as_str(),
        "host"
            | "connection"
            | "proxy-connection"
            | "proxy-authorization"
            | "proxy-authenticate"
            | "transfer-encoding"
            | "content-length"
            | "upgrade"
            | "keep-alive"
            | "te"
            | "trailer"
            | "expect"
    ) {
        return Err(ErrorCode::Invalid);
    }
    Ok(n)
}
pub(crate) fn normalize(mut p: HttpProfilePolicy) -> Result<HttpProfilePolicy, Error> {
    p.validate().map_err(|_| ErrorCode::Invalid)?;
    p.base_url = parse(&p.base_url)?.to_string();
    for rules in [&mut p.in_scope, &mut p.out_of_scope, &mut p.denied_hosts] {
        for rule in rules.iter_mut() {
            *rule = normalize_rule(rule)?;
        }
        rules.sort();
        rules.dedup();
    }
    for paths in [&mut p.allowed_path_prefixes, &mut p.denied_path_prefixes] {
        for path in paths.iter_mut() {
            if !path.starts_with('/') || path.contains(['?', '#', '\\']) {
                return Err(ErrorCode::Invalid);
            }
            let parsed = parse(&format!("http://policy.invalid{path}"))?;
            *path = decoded_path(parsed.path())?
                .trim_end_matches('/')
                .to_owned();
            if path.contains(['?', '#']) {
                return Err(ErrorCode::Invalid);
            }
            if path.is_empty() {
                *path = "/".into();
            }
        }
        paths.sort();
        paths.dedup();
    }
    let mut per_host = BTreeMap::new();
    for (name, rate) in p.rate.per_host {
        let name = normalize_rule(&name)?;
        if name.starts_with("*.") || name.contains('/') || per_host.insert(name, rate).is_some() {
            return Err(ErrorCode::Invalid);
        }
    }
    p.rate.per_host = per_host;
    p.allowed_methods = p
        .allowed_methods
        .iter()
        .map(|s| s.to_ascii_uppercase())
        .collect();
    for m in &p.allowed_methods {
        if !matches!(
            m.as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
        ) {
            return Err(ErrorCode::Invalid);
        }
    }
    p.allowed_methods.sort();
    p.allowed_methods.dedup();
    p.allowed_headers = p
        .allowed_headers
        .iter()
        .map(|n| header_name(n))
        .collect::<Result<_, _>>()?;
    p.allowed_headers.sort();
    p.allowed_headers.dedup();
    if let Some(a) = &mut p.auth {
        a.origin = origin(&a.origin)?;
        if a.origin != origin(&p.base_url)? {
            return Err(ErrorCode::Invalid);
        }
        for n in &mut a.header_names {
            *n = header_name(n)?;
        }
        a.header_names.sort();
        a.header_names.dedup();
    }
    if let Some(a) = &mut p.attribution {
        let mut hs = BTreeMap::new();
        for (k, v) in &a.headers {
            let k = header_name(k)?;
            if http::HeaderValue::from_str(v).is_err() || hs.insert(k, v.clone()).is_some() {
                return Err(ErrorCode::Invalid);
            }
        }
        a.headers = hs;
    }
    Ok(p)
}
pub(crate) fn prepare(
    p: &HttpProfilePolicy,
    hash: &str,
    args: HttpRequestArguments,
) -> Result<HttpRequestIntent, Error> {
    if args.url.contains('\\') || args.url.chars().any(|c| c.is_control()) {
        return Err(ErrorCode::Invalid);
    }
    let joined = parse(&p.base_url)?
        .join(&args.url)
        .map_err(|_| ErrorCode::Invalid)?;
    let u = parse(joined.as_str())?;
    authorize(p, &u)?;
    let method = args.method.to_ascii_uppercase();
    if !p.allowed_methods.contains(&method) {
        return Err(ErrorCode::Scope);
    }
    if args
        .body
        .as_ref()
        .is_some_and(|b| b.len() as u64 > p.limits.max_request_body_bytes)
    {
        return Err(ErrorCode::Limit);
    }
    let mut headers = BTreeMap::new();
    for (k, v) in args.headers {
        let k = header_name(&k)?;
        if !p.allowed_headers.contains(&k)
            || p.auth.as_ref().is_some_and(|a| a.header_names.contains(&k))
        {
            return Err(ErrorCode::Scope);
        }
        if http::HeaderValue::from_str(&v).is_err() || headers.insert(k, v).is_some() {
            return Err(ErrorCode::Invalid);
        }
    }
    headers
        .entry("content-type".into())
        .or_insert("application/json".into());
    Ok(HttpRequestIntent {
        profile_sha256: hash.to_owned(),
        url: u.to_string(),
        method,
        headers,
        body: args.body,
    })
}
