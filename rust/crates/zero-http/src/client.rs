use crate::{
    Clock, DispatchState, Error, ErrorCode, ExecutionHooks, HopIntent, HopObservation,
    HttpDisposition, HttpOutcome, HttpResponse, MonotonicClock, OwnedDns, PreparedRequest,
    Resolver, StaticAuth, auth, policy,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use zero_protocol::http::{HttpProfilePolicy, HttpRequestArguments, HttpRequestIntent};

#[derive(Clone)]
pub struct Client {
    pub(crate) inner: Arc<Inner>,
}
pub(crate) struct Inner {
    pub policy: HttpProfilePolicy,
    pub hash: String,
    pub auth: Option<StaticAuth>,
    pub resolver: Arc<dyn Resolver>,
    pub clock: Arc<dyn Clock>,
    pub tls: Arc<rustls::ClientConfig>,
}
pub fn canonical_origin(value: &str) -> Result<String, Error> {
    policy::origin(value)
}
pub fn normalize_policy(policy: HttpProfilePolicy) -> Result<HttpProfilePolicy, Error> {
    policy::normalize(policy)
}
pub fn profile_sha256(policy: &HttpProfilePolicy) -> Result<String, Error> {
    let value = serde_json::to_value(policy).map_err(|_| ErrorCode::Invalid)?;
    let bytes = serde_json::to_vec(&value).map_err(|_| ErrorCode::Invalid)?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}
/// Normalize a target without inventing an HTTP method or performing DNS/network IO.
pub fn normalize_target(policy: &HttpProfilePolicy, target: &str) -> Result<String, Error> {
    if target.len() > 8192 {
        return Err(ErrorCode::Invalid);
    }
    let policy = normalize_policy(policy.clone())?;
    let url = policy::parse(target)?;
    policy::authorize(&policy, &url)?;
    Ok(url.to_string())
}
pub fn normalize_intent(
    policy: &HttpProfilePolicy,
    args: HttpRequestArguments,
) -> Result<HttpRequestIntent, Error> {
    let p = normalize_policy(policy.clone())?;
    args.validate().map_err(|_| ErrorCode::Invalid)?;
    policy::prepare(&p, &profile_sha256(&p)?, args)
}
impl Client {
    pub fn new(policy: HttpProfilePolicy, auth: Option<StaticAuth>) -> Result<Self, Error> {
        Self::with_runtime(
            policy,
            auth,
            Arc::new(OwnedDns::system()?),
            Arc::new(MonotonicClock::default()),
            None,
        )
    }
    /// Resolver, clock and additional trust roots are host authority, never tool arguments.
    pub fn with_runtime(
        policy: HttpProfilePolicy,
        auth: Option<StaticAuth>,
        resolver: Arc<dyn Resolver>,
        clock: Arc<dyn Clock>,
        additional_roots: Option<rustls::RootCertStore>,
    ) -> Result<Self, Error> {
        let policy = normalize_policy(policy)?;
        if policy.auth.as_ref() != auth.as_ref().map(StaticAuth::descriptor) {
            return Err(ErrorCode::Invalid);
        }
        if let Some(a) = &auth {
            let bytes = serde_json::to_vec(&policy).map_err(|_| ErrorCode::Invalid)?;
            if auth::contains(&bytes, &a.secrets)
                || auth::value_contains(
                    &serde_json::to_value(&policy).map_err(|_| ErrorCode::Invalid)?,
                    &a.secrets,
                )
            {
                return Err(ErrorCode::Secret);
            }
        }
        let hash = profile_sha256(&policy)?;
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if let Some(extra) = additional_roots {
            roots.roots.extend(extra.roots);
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|_| ErrorCode::Tls)?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self {
            inner: Arc::new(Inner {
                policy,
                hash,
                auth,
                resolver,
                clock,
                tls: Arc::new(tls),
            }),
        })
    }
    pub fn policy(&self) -> &HttpProfilePolicy {
        &self.inner.policy
    }
    pub fn policy_sha256(&self) -> &str {
        &self.inner.hash
    }
    /// Apply the captured target policy and private credential reflection checks.
    pub fn normalize_target(&self, target: &str) -> Result<String, Error> {
        let normalized = normalize_target(self.policy(), target)?;
        self.check_public(target.as_bytes())?;
        self.check_public(normalized.as_bytes())?;
        // A URL may encode a credential before reflecting it into public intent.
        let mut decoded = normalized.as_bytes().to_vec();
        for _ in 0..8 {
            let mut next = Vec::with_capacity(decoded.len());
            let mut i = 0;
            while i < decoded.len() {
                let pair = if decoded[i] == b'%' && i + 2 < decoded.len() {
                    (decoded[i + 1] as char)
                        .to_digit(16)
                        .zip((decoded[i + 2] as char).to_digit(16))
                } else {
                    None
                };
                if let Some((a, b)) = pair {
                    next.push((a * 16 + b) as u8);
                    i += 3;
                } else {
                    next.push(decoded[i]);
                    i += 1;
                }
            }
            if next == decoded {
                break;
            }
            decoded = next;
        }
        self.check_public(&decoded)?;
        let url = policy::parse(&normalized)?;
        for (key, value) in url.query_pairs() {
            self.check_public(key.as_bytes())?;
            self.check_public(value.as_bytes())?;
        }

        if auth::value_contains(&serde_json::json!([target, normalized]), self.secrets()) {
            return Err(ErrorCode::Secret);
        }
        Ok(normalized)
    }
    pub fn prepare(&self, args: HttpRequestArguments) -> Result<PreparedRequest, Error> {
        let intent = normalize_intent(self.policy(), args)?;
        self.check_public(&serde_json::to_vec(&intent).map_err(|_| ErrorCode::Invalid)?)?;
        if auth::value_contains(
            &serde_json::to_value(&intent).map_err(|_| ErrorCode::Invalid)?,
            self.secrets(),
        ) {
            return Err(ErrorCode::Secret);
        }
        // Include injected auth/attribution in the bound before any durable admission.
        crate::transport::request_headers(self, &intent)?;
        Ok(PreparedRequest { intent })
    }
    pub(crate) fn secrets(&self) -> &[Vec<u8>] {
        self.inner
            .auth
            .as_ref()
            .map_or(&[], |a| a.secrets.as_slice())
    }
    pub(crate) fn check_public(&self, bytes: &[u8]) -> Result<(), Error> {
        if auth::contains(bytes, self.secrets()) {
            Err(ErrorCode::Secret)
        } else {
            Ok(())
        }
    }
    pub async fn execute(
        &self,
        prepared: PreparedRequest,
        cancel: CancellationToken,
        hooks: &dyn ExecutionHooks,
    ) -> HttpOutcome {
        let mut state = State::default();
        if prepared.intent.profile_sha256 != self.inner.hash {
            return state.finish(Err(ErrorCode::Invalid));
        }
        let deadline = self
            .inner
            .clock
            .now_ms()
            .saturating_add(self.policy().limits.timeout_ms);
        let result = {
            let run = crate::transport::run(self, prepared.intent, hooks, &mut state);
            tokio::pin!(run);
            tokio::select! {biased;_ = cancel.cancelled()=>Err(ErrorCode::Cancelled),_ = self.inner.clock.sleep_until(deadline)=>Err(ErrorCode::Deadline),r=&mut run=>r}
        };
        // All DNS/TLS/HTTP futures and sockets above are dropped before settlement.
        // This bounded store-only drain never restarts network work.
        if let Some(mut active) = state.active.take() {
            active.error = result.as_ref().err().copied();
            active.complete = false;
            let settled = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                hooks.settle(&active.permit, &active),
            )
            .await;
            state.hops.push(active);
            if !matches!(settled, Ok(Ok(()))) {
                return state.finish(Err(ErrorCode::Accounting));
            }
        }
        state.finish(result)
    }
}
#[derive(Default)]
pub(crate) struct State {
    pub dispatched: bool,
    pub active: Option<HopObservation>,
    pub hops: Vec<HopObservation>,
}
impl State {
    fn finish(self, result: Result<HttpResponse, Error>) -> HttpOutcome {
        let error = result.as_ref().err().copied();
        let disposition = match error {
            None => HttpDisposition::CompleteResponse,
            Some(ErrorCode::Cancelled) => HttpDisposition::Cancelled,
            Some(_) if self.dispatched => HttpDisposition::Incomplete,
            Some(_) => HttpDisposition::Rejected,
        };
        HttpOutcome {
            dispatch: if self.dispatched {
                DispatchState::PossiblyDispatched
            } else {
                DispatchState::NeverDispatched
            },
            disposition,
            response: result.ok(),
            hops: self.hops,
            error,
        }
    }
}
pub(crate) fn hop(
    client: &Client,
    intent: &HttpRequestIntent,
    index: u32,
    ips: Vec<std::net::IpAddr>,
) -> Result<HopIntent, Error> {
    let url = policy::parse(&intent.url)?;
    let host = policy::host(&url)?;
    let port = url.port_or_known_default().ok_or(ErrorCode::Invalid)?;
    let addresses: Vec<_> = ips
        .into_iter()
        .map(|ip| std::net::SocketAddr::new(ip, port))
        .collect();
    let selected_address = *addresses.first().ok_or(ErrorCode::Dns)?;
    Ok(HopIntent {
        index,
        profile_sha256: client.inner.hash.clone(),
        url: intent.url.clone(),
        host,
        method: intent.method.clone(),
        addresses,
        selected_address,
        request_body_bytes: intent.body.as_ref().map_or(0, |b| b.len() as u64),
        response_decoded_limit: client.policy().limits.max_response_decoded_bytes,
    })
}
