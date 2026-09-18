use crate::{
    Client, Error, ErrorCode, ExecutionHooks, HopIntent, HopObservation, HttpResponse, auth,
    client::{State, hop},
    policy,
};
use async_compression::tokio::bufread::{BrotliDecoder, GzipDecoder, ZlibDecoder};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use std::{collections::BTreeMap, pin::Pin};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, BufReader};
use zero_protocol::http::{HttpRedirectPolicy, HttpRequestIntent};

pub(crate) fn request_headers(
    client: &Client,
    intent: &HttpRequestIntent,
) -> Result<BTreeMap<String, String>, Error> {
    let mut headers = intent.headers.clone();
    let u = policy::parse(&intent.url)?;
    if policy::origin(&intent.url)? == policy::origin(&client.policy().base_url)? {
        if let Some(a) = &client.policy().attribution {
            for (k, v) in &a.headers {
                headers.entry(k.clone()).or_insert(v.clone());
            }
            if let Some(token) = &a.user_agent_token {
                headers.entry("user-agent".into()).or_insert(token.clone());
            }
        }
        if let Some(a) = &client.inner.auth {
            for (k, v) in &a.headers {
                if headers.insert(k.clone(), v.clone()).is_some() {
                    return Err(ErrorCode::Invalid);
                }
            }
        }
    }
    headers.insert(
        "host".into(),
        u[url::Position::BeforeHost..url::Position::AfterPort].to_owned(),
    );
    headers.insert("connection".into(), "close".into());
    headers.insert(
        "content-length".into(),
        intent.body.as_ref().map_or(0, |b| b.len()).to_string(),
    );
    let total = headers.iter().try_fold(2usize, |n, (k, v)| {
        if http::HeaderValue::from_str(v).is_err() {
            return Err(ErrorCode::Invalid);
        }
        n.checked_add(k.len() + v.len() + 4).ok_or(ErrorCode::Limit)
    })?;
    if headers.len() > client.policy().limits.max_request_headers as usize
        || total as u64 > client.policy().limits.max_request_header_bytes
    {
        return Err(ErrorCode::Limit);
    }
    Ok(headers)
}
pub(crate) async fn run(
    client: &Client,
    mut intent: HttpRequestIntent,
    hooks: &dyn ExecutionHooks,
    state: &mut State,
) -> Result<HttpResponse, Error> {
    let mut index = 0;
    loop {
        let url = policy::parse(&intent.url)?;
        policy::authorize(client.policy(), &url)?;
        client.check_public(intent.url.as_bytes())?;
        let host = policy::host(&url)?;
        let addresses = client
            .inner
            .resolver
            .resolve(&host, &client.policy().limits)
            .await?;
        policy::authorize_addresses(client.policy(), &addresses)?;
        let hi = hop(client, &intent, index, addresses)?;
        // Validate the exact merged header section before request admission.
        let headers = request_headers(client, &intent)?;
        let permit = hooks.admit(&hi).await.map_err(|_| ErrorCode::Accounting)?;
        state.dispatched = true;
        state.active = Some(HopObservation {
            index,
            permit: permit.clone(),
            status: None,
            redirect_url: None,
            request_body_bytes: hi.request_body_bytes,
            response_wire_bytes: 0,
            response_decoded_bytes: 0,
            complete: false,
            error: None,
        });
        policy::authorize(client.policy(), &url)?;
        policy::authorize_addresses(
            client.policy(),
            &hi.addresses.iter().map(|a| a.ip()).collect::<Vec<_>>(),
        )?;
        let observation = state.active.as_mut().ok_or(ErrorCode::Protocol)?;
        let raw = exchange(client, &intent, &hi, headers, hooks, observation).await?;
        let mut secrets = client.secrets().to_vec();
        for (k, v) in &intent.headers {
            if auth::sensitive(k) {
                secrets.push(v.as_bytes().to_vec());
                if let Some((_, token)) = v.split_once(' ') {
                    if !token.is_empty() {
                        secrets.push(token.as_bytes().to_vec());
                    }
                }
            }
        }
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        let body = auth::redact_body(&raw.body, &secrets, 16 * 1024 * 1024).await?;
        let response = HttpResponse {
            url: intent.url.clone(),
            status: raw.status,
            headers: auth::redact_headers(&raw.headers, &secrets)?,
            wire_bytes: observation.response_wire_bytes,
            decoded_bytes: observation.response_decoded_bytes,
            redacted_bytes: body.len() as u64,
            body,
        };
        let next = redirect(client, &intent, &raw, index);
        observation.redirect_url = next
            .as_ref()
            .ok()
            .and_then(|n| n.as_ref())
            .map(|n| n.url.clone());
        observation.complete = true;
        hooks
            .settle(&permit, observation)
            .await
            .map_err(|_| ErrorCode::Accounting)?;
        state
            .hops
            .push(state.active.take().ok_or(ErrorCode::Protocol)?);
        match next? {
            Some(next) => {
                intent = next;
                index += 1;
            }
            None => return Ok(response),
        }
    }
}
fn redirect(
    client: &Client,
    intent: &HttpRequestIntent,
    raw: &RawResponse,
    index: u32,
) -> Result<Option<HttpRequestIntent>, Error> {
    if !matches!(raw.status, 301 | 302 | 303 | 307 | 308) {
        return Ok(None);
    }
    let locations: Vec<_> = raw
        .headers
        .iter()
        .filter(|(k, _)| k == "location")
        .collect();
    if locations.is_empty() {
        return Ok(None);
    }
    if locations.len() != 1 {
        return Err(ErrorCode::Redirect);
    }
    let limit = match client.policy().redirect {
        HttpRedirectPolicy::Manual => return Ok(None),
        HttpRedirectPolicy::Error => return Err(ErrorCode::Redirect),
        HttpRedirectPolicy::Follow { max_hops } => max_hops,
    };
    if index >= limit {
        return Err(ErrorCode::Redirect);
    }
    let url = policy::parse(&intent.url)?;
    let next = url.join(&locations[0].1).map_err(|_| ErrorCode::Redirect)?;
    let next = policy::parse(next.as_str())?;
    client.check_public(next.as_str().as_bytes())?;
    policy::authorize(client.policy(), &next)?;
    let mut intent = intent.clone();
    if url.origin() != next.origin() {
        intent.headers.clear();
    }
    if (matches!(raw.status, 301 | 302) && intent.method == "POST")
        || (raw.status == 303 && !matches!(intent.method.as_str(), "GET" | "HEAD"))
    {
        intent.method = "GET".into();
        intent.body = None;
        intent.headers.remove("content-type");
    }
    if !client.policy().allowed_methods.contains(&intent.method) {
        return Err(ErrorCode::Scope);
    }
    intent.url = next.to_string();
    Ok(Some(intent))
}
struct RawResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
async fn exchange(
    client: &Client,
    intent: &HttpRequestIntent,
    hop: &HopIntent,
    headers: BTreeMap<String, String>,
    hooks: &dyn ExecutionHooks,
    observation: &mut HopObservation,
) -> Result<RawResponse, Error> {
    let stream = tokio::net::TcpStream::connect(hop.selected_address)
        .await
        .map_err(|_| ErrorCode::Connect)?;
    let url = policy::parse(&intent.url)?;
    let io: Box<dyn Io> = if url.scheme() == "https" {
        let name = rustls::pki_types::ServerName::try_from(hop.host.clone())
            .map_err(|_| ErrorCode::Tls)?;
        let tls = tokio_rustls::TlsConnector::from(client.inner.tls.clone())
            .connect(name, stream)
            .await
            .map_err(|_| ErrorCode::Tls)?;
        Box::new(tls)
    } else {
        Box::new(stream)
    };
    let mut builder = hyper::client::conn::http1::Builder::new();
    builder
        .max_headers(client.policy().limits.max_response_headers as usize)
        .max_buf_size((client.policy().limits.max_response_header_bytes as usize).max(8192));
    let (mut sender, connection) = builder
        .handshake(TokioIo::new(io))
        .await
        .map_err(|_| ErrorCode::Protocol)?;
    let mut request = http::Request::builder()
        .method(intent.method.as_str())
        .uri(&url[url::Position::BeforePath..]);
    for (k, v) in headers {
        request = request.header(k, v);
    }
    let request = request
        .body(Full::new(Bytes::from(
            intent.body.clone().unwrap_or_default(),
        )))
        .map_err(|_| ErrorCode::Invalid)?;
    let exchange = async {
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| ErrorCode::Protocol)?;
        let status = response.status().as_u16();
        observation.status = Some(status);
        // A recognized 429 must park the shared account even if another header
        // is invalid or exceeds the configured retained-header bound. Inspect
        // only bounded, public-safe Retry-After metadata before this hook.
        if status == 429 {
            let retry_after = response
                .headers()
                .get(http::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .filter(|value| {
                    value.len() <= 1024 && !auth::contains(value.as_bytes(), client.secrets())
                });
            hooks
                .observe_headers(&observation.permit, status, retry_after)
                .await
                .map_err(|_| ErrorCode::Accounting)?;
        }
        if status == 101 {
            return Err(ErrorCode::Protocol);
        }
        let mut headers = Vec::new();
        let mut header_bytes = 2usize;
        for (k, v) in response.headers() {
            let v = v.to_str().map_err(|_| ErrorCode::Protocol)?.to_owned();
            header_bytes = header_bytes
                .checked_add(k.as_str().len() + v.len() + 4)
                .ok_or(ErrorCode::Limit)?;
            if headers.len() >= client.policy().limits.max_response_headers as usize
                || header_bytes as u64 > client.policy().limits.max_response_header_bytes
            {
                return Err(ErrorCode::Limit);
            }
            headers.push((k.as_str().to_owned(), v));
        }
        let retry_after = headers
            .iter()
            .find(|(k, _)| k == "retry-after")
            .map(|(_, v)| v.as_str())
            .filter(|v| v.len() <= 1024 && !auth::contains(v.as_bytes(), client.secrets()));
        if status != 429 {
            hooks
                .observe_headers(&observation.permit, status, retry_after)
                .await
                .map_err(|_| ErrorCode::Accounting)?;
        }
        let no_body = intent.method == "HEAD" || matches!(status, 204 | 205 | 304);
        let mut body = response.into_body();
        let mut encoded = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| ErrorCode::Protocol)?;
            if let Ok(data) = frame.into_data() {
                observation.response_wire_bytes = observation
                    .response_wire_bytes
                    .saturating_add(data.len() as u64);
                if observation.response_wire_bytes > client.policy().limits.max_response_wire_bytes
                {
                    return Err(ErrorCode::Limit);
                }
                if no_body && !data.is_empty() {
                    return Err(ErrorCode::Protocol);
                }
                encoded.extend_from_slice(&data);
            }
        }
        let decoded = if no_body {
            Vec::new()
        } else {
            decode(
                encoded,
                &headers,
                client.policy().limits.max_response_decoded_bytes as usize,
            )
            .await?
        };
        observation.response_decoded_bytes = decoded.len() as u64;
        Ok(RawResponse {
            status,
            headers,
            body: decoded,
        })
    };
    tokio::pin!(exchange, connection);
    tokio::select! {result=&mut exchange=>result,result=&mut connection=>{result.map_err(|_|ErrorCode::Protocol)?;exchange.await}}
}
async fn decode(
    mut bytes: Vec<u8>,
    headers: &[(String, String)],
    limit: usize,
) -> Result<Vec<u8>, Error> {
    let encodings: Vec<_> = headers
        .iter()
        .filter(|(k, _)| k == "content-encoding")
        .flat_map(|(_, v)| v.split(','))
        .map(|s| s.trim().to_ascii_lowercase())
        .collect();
    if encodings.len() > 4 {
        return Err(ErrorCode::Decode);
    }
    for encoding in encodings.iter().rev() {
        if encoding == "identity" {
            if bytes.len() > limit {
                return Err(ErrorCode::Limit);
            }
            continue;
        }
        let input = BufReader::new(std::io::Cursor::new(bytes));
        let mut reader: Pin<Box<dyn AsyncRead + Send>> = match encoding.as_str() {
            "gzip" | "x-gzip" => {
                let mut decoder = GzipDecoder::new(input);
                decoder.multiple_members(true);
                Box::pin(decoder)
            }
            "deflate" => {
                let mut decoder = ZlibDecoder::new(input);
                decoder.multiple_members(true);
                Box::pin(decoder)
            }
            "br" => {
                let mut decoder = BrotliDecoder::new(input);
                decoder.multiple_members(true);
                Box::pin(decoder)
            }
            _ => return Err(ErrorCode::Decode),
        };
        bytes = Vec::new();
        let mut chunk = [0; 16384];
        loop {
            let n = reader
                .read(&mut chunk)
                .await
                .map_err(|_| ErrorCode::Decode)?;
            if n == 0 {
                break;
            }
            if bytes.len() + n > limit {
                return Err(ErrorCode::Limit);
            }
            bytes.extend_from_slice(&chunk[..n]);
            tokio::task::yield_now().await;
        }
    }
    if bytes.len() > limit {
        return Err(ErrorCode::Limit);
    }
    Ok(bytes)
}
