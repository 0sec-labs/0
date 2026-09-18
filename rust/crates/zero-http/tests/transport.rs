#![allow(clippy::unwrap_used)]
mod common;
use common::*;
use std::{collections::BTreeMap, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use zero_http::*;
use zero_protocol::http::HttpRedirectPolicy;

#[tokio::test]
async fn physical_host_pinning_and_complete_error_status() {
    let (port, job) = server(response(404, "X-Test: hello\r\n", b"\xffbinary")).await;
    let c = client(policy(format!("http://fixture.localhost:{port}")), None);
    let hooks = Hooks::default();
    let out = c
        .execute(
            c.prepare(args("/item")).unwrap(),
            CancellationToken::new(),
            &hooks,
        )
        .await;
    assert_eq!(out.disposition, HttpDisposition::CompleteResponse);
    let r = out.response.unwrap();
    assert_eq!(r.status, 404);
    assert_eq!(r.body, b"\xffbinary");
    let sent = String::from_utf8(job.await.unwrap()).unwrap();
    assert!(sent.contains(&format!("host: fixture.localhost:{port}")));
    assert!(sent.starts_with("POST /item HTTP/1.1"));
    assert!(sent.contains("content-type: application/json"));
    assert_eq!(hooks.admitted.lock().unwrap()[0].host, "fixture.localhost");
    assert!(hooks.settled.lock().unwrap()[0].complete);
}
#[tokio::test]
async fn public_anchor_rejects_any_private_answer_before_connection() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let c = Client::with_runtime(
        policy(format!("http://example.test:{port}")),
        None,
        Arc::new(FixedDns(vec![
            "8.8.8.8".parse().unwrap(),
            "127.0.0.1".parse().unwrap(),
        ])),
        Arc::new(MonotonicClock::default()),
        None,
    )
    .unwrap();
    let h = Hooks::default();
    let out = c
        .execute(c.prepare(args("/")).unwrap(), CancellationToken::new(), &h)
        .await;
    assert_eq!(out.dispatch, DispatchState::NeverDispatched);
    assert_eq!(out.error, Some(ErrorCode::Scope));
    assert!(h.admitted.lock().unwrap().is_empty());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn redirects_strip_custom_auth_and_attribution_and_convert_post() {
    let (p2, j2) = server(response(200, "", b"done")).await;
    let (p1, j1) = server(response(
        302,
        &format!("Location: http://other.localhost:{p2}/next\r\n"),
        b"",
    ))
    .await;
    let mut p = policy(format!("http://fixture.localhost:{p1}"));
    p.redirect = HttpRedirectPolicy::Follow { max_hops: 2 };
    let auth = StaticAuth::new(
        "auth-v1".into(),
        p.base_url.clone(),
        BTreeMap::from([("Authorization".into(), "Bearer fixture-secret-token".into())]),
    )
    .unwrap();
    p.auth = Some(auth.descriptor().clone());
    p.attribution = Some(zero_protocol::http::HttpAttribution {
        headers: BTreeMap::from([("x-attribution".into(), "scanner".into())]),
        user_agent_token: None,
    });
    let c = client(p, Some(auth));
    let mut a = args("/");
    a.headers.insert("x-custom".into(), "custom".into());
    let h = Hooks::default();
    let out = c
        .execute(c.prepare(a).unwrap(), CancellationToken::new(), &h)
        .await;
    assert_eq!(out.disposition, HttpDisposition::CompleteResponse);
    assert_eq!(out.hops.len(), 2);
    let first = String::from_utf8(j1.await.unwrap()).unwrap();
    assert!(first.contains("authorization: Bearer fixture-secret-token"));
    assert!(first.contains("x-attribution: scanner"));
    let second = String::from_utf8(j2.await.unwrap()).unwrap();
    assert!(second.starts_with("GET /next"));
    for forbidden in [
        "authorization",
        "x-custom",
        "x-attribution",
        "content-type",
        "hello",
    ] {
        assert!(!second.contains(forbidden), "{second}");
    }
}
#[tokio::test]
async fn secrets_components_and_unknown_cookies_are_redacted_before_return() {
    let (port, job) = server(response(
        200,
        "Set-Cookie: new-session=not-in-config\r\nX-Echo: fixture-secret-token\r\n",
        b"Bearer fixture-secret-token and fixture-secret-token",
    ))
    .await;
    let mut p = policy(format!("http://localhost:{port}"));
    let a = StaticAuth::new(
        "revision1".into(),
        p.base_url.clone(),
        BTreeMap::from([("authorization".into(), "Bearer fixture-secret-token".into())]),
    )
    .unwrap();
    p.auth = Some(a.descriptor().clone());
    let c = client(p, Some(a));
    assert_eq!(
        c.prepare(args("/?token=fixture-secret-token")).err(),
        Some(ErrorCode::Secret)
    );
    let out = c
        .execute(
            c.prepare(args("/")).unwrap(),
            CancellationToken::new(),
            &Hooks::default(),
        )
        .await;
    job.await.unwrap();
    let json = serde_json::to_string(&out).unwrap();
    assert!(!json.contains("fixture-secret-token"));
    assert!(!json.contains("new-session"));
    let body = out.response.unwrap().body;
    assert!(!String::from_utf8_lossy(&body).contains("fixture-secret-token"));
}
#[tokio::test]
async fn cancelled_held_response_closes_socket_and_retains_uncertain_account() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (notify, received) = tokio::sync::oneshot::channel();
    let job = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        socket.read(&mut buf).await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
            .await
            .unwrap();
        notify.send(()).unwrap();
        loop {
            match socket.read(&mut buf).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
                    ) =>
                {
                    break;
                }
                Err(e) => panic!("{e}"),
            }
        }
    });
    let c = client(policy(format!("http://localhost:{port}")), None);
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let h = Arc::new(Hooks::default());
    let hc = h.clone();
    let run = tokio::spawn(async move {
        c.execute(c.prepare(args("/")).unwrap(), token, hc.as_ref())
            .await
    });
    received.await.unwrap();
    cancel.cancel();
    let out = run.await.unwrap();
    assert_eq!(out.disposition, HttpDisposition::Cancelled);
    assert_eq!(out.dispatch, DispatchState::PossiblyDispatched);
    assert!(!out.hops[0].complete);
    tokio::time::timeout(std::time::Duration::from_secs(1), job)
        .await
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn stacked_decoding_bounds_and_malformed_data_fail_without_success() {
    use async_compression::tokio::write::{GzipEncoder, ZlibEncoder};
    let mut gzip = GzipEncoder::new(Vec::new());
    gzip.write_all(b"compressed evidence").await.unwrap();
    gzip.shutdown().await.unwrap();
    let mut zlib = ZlibEncoder::new(Vec::new());
    zlib.write_all(&gzip.into_inner()).await.unwrap();
    zlib.shutdown().await.unwrap();
    let body = zlib.into_inner();
    let (port, job) = server(response(200, "Content-Encoding: gzip, deflate\r\n", &body)).await;
    let c = client(policy(format!("http://localhost:{port}")), None);
    let out = c
        .execute(
            c.prepare(args("/")).unwrap(),
            CancellationToken::new(),
            &Hooks::default(),
        )
        .await;
    job.await.unwrap();
    assert_eq!(out.response.unwrap().body, b"compressed evidence");
    for (encoding, bytes, limit, error) in [
        ("gzip", vec![1, 2, 3], 100, ErrorCode::Decode),
        ("identity", vec![0; 101], 100, ErrorCode::Limit),
        ("weird", vec![1], 100, ErrorCode::Decode),
    ] {
        let (port, job) = server(response(
            200,
            &format!("Content-Encoding: {encoding}\r\n"),
            &bytes,
        ))
        .await;
        let mut p = policy(format!("http://localhost:{port}"));
        p.limits.max_response_decoded_bytes = limit;
        let c = client(p, None);
        let out = c
            .execute(
                c.prepare(args("/")).unwrap(),
                CancellationToken::new(),
                &Hooks::default(),
            )
            .await;
        job.await.unwrap();
        assert_eq!(out.error, Some(error));
        assert!(out.response.is_none());
        assert_eq!(out.disposition, HttpDisposition::Incomplete);
    }
}
#[tokio::test]
async fn real_tls_checks_original_name_against_pinned_socket() {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    let cert = CertificateDer::from(include_bytes!("fixtures/server.der").to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        include_bytes!("fixtures/server-key.der").to_vec(),
    ));
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![cert], key)
    .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    for valid in [true, false] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let acceptor = acceptor.clone();
        let job = tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let Ok(mut s) = acceptor.accept(s).await else {
                return false;
            };
            let mut buf = [0; 4096];
            let n = s.read(&mut buf).await.unwrap();
            s.write_all(&response(200, "", b"tls")).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).contains("host: fixture.localhost:")
        });
        let hostname = if valid {
            "fixture.localhost"
        } else {
            "wrong.localhost"
        };
        let p = policy(format!("https://{hostname}:{port}"));
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(CertificateDer::from(
                include_bytes!("fixtures/ca.der").to_vec(),
            ))
            .unwrap();
        let c = Client::with_runtime(
            p,
            None,
            Arc::new(FixedDns(vec!["127.0.0.1".parse().unwrap()])),
            Arc::new(MonotonicClock::default()),
            Some(roots),
        )
        .unwrap();
        let out = c
            .execute(
                c.prepare(args("/")).unwrap(),
                CancellationToken::new(),
                &Hooks::default(),
            )
            .await;
        if valid {
            assert_eq!(out.disposition, HttpDisposition::CompleteResponse);
            assert!(job.await.unwrap());
        } else {
            assert_eq!(out.error, Some(ErrorCode::Tls));
            assert!(!job.await.unwrap());
        }
    }
}

#[tokio::test]
async fn full_sixteen_mebibyte_body_is_retained_and_redaction_growth_is_bounded() {
    let payload = vec![b'z'; 16 * 1024 * 1024];
    let (port, job) = server(response(200, "", &payload)).await;
    let mut p = policy(format!("http://localhost:{port}"));
    p.limits.timeout_ms = 10000;
    let c = client(p, None);
    let out = c
        .execute(
            c.prepare(args("/")).unwrap(),
            CancellationToken::new(),
            &Hooks::default(),
        )
        .await;
    job.await.unwrap();
    let r = out.response.unwrap();
    assert_eq!(r.body, payload);
    assert_eq!(r.decoded_bytes, 16 * 1024 * 1024);
    let body = vec![b'@'; 3 * 1024 * 1024];
    let (port, job) = server(response(200, "", &body)).await;
    let mut p = policy(format!("http://localhost:{port}"));
    p.limits.timeout_ms = 10000;
    let a = StaticAuth::new(
        "revision".into(),
        p.base_url.clone(),
        BTreeMap::from([("x-api-key".into(), "@@".into())]),
    )
    .unwrap();
    p.auth = Some(a.descriptor().clone());
    let c = client(p, Some(a));
    let out = c
        .execute(
            c.prepare(args("/")).unwrap(),
            CancellationToken::new(),
            &Hooks::default(),
        )
        .await;
    job.await.unwrap();
    assert_eq!(out.error, Some(ErrorCode::Limit));
    assert_eq!(out.disposition, HttpDisposition::Incomplete);
    assert!(out.response.is_none());
}
#[tokio::test]
async fn cancelled_before_work_does_not_resolve_or_admit() {
    struct NoDns;
    impl Resolver for NoDns {
        fn resolve<'a>(
            &'a self,
            _: &'a str,
            _: &'a zero_protocol::http::HttpLimits,
        ) -> futures_util::future::BoxFuture<'a, Result<Vec<std::net::IpAddr>, Error>> {
            panic!("cancelled execution performed DNS")
        }
    }
    let c = Client::with_runtime(
        policy("http://localhost".into()),
        None,
        Arc::new(NoDns),
        Arc::new(MonotonicClock::default()),
        None,
    )
    .unwrap();
    let token = CancellationToken::new();
    token.cancel();
    let h = Hooks::default();
    let out = c.execute(c.prepare(args("/")).unwrap(), token, &h).await;
    assert_eq!(out.dispatch, DispatchState::NeverDispatched);
    assert_eq!(out.error, Some(ErrorCode::Cancelled));
    assert!(h.admitted.lock().unwrap().is_empty());
}
#[tokio::test]
async fn manual_error_redirect_and_307_body_preservation() {
    for mode in [HttpRedirectPolicy::Manual, HttpRedirectPolicy::Error] {
        let (port, job) = server(response(
            302,
            "Location: http://denied.invalid/\r\n",
            b"redirect",
        ))
        .await;
        let mut p = policy(format!("http://localhost:{port}"));
        p.redirect = mode.clone();
        let c = client(p, None);
        let h = Hooks::default();
        let out = c
            .execute(c.prepare(args("/")).unwrap(), CancellationToken::new(), &h)
            .await;
        job.await.unwrap();
        assert_eq!(h.admitted.lock().unwrap().len(), 1);
        assert!(out.hops[0].complete);
        assert!(out.hops[0].redirect_url.is_none());
        match mode {
            HttpRedirectPolicy::Manual => assert_eq!(out.response.unwrap().status, 302),
            _ => assert_eq!(out.error, Some(ErrorCode::Redirect)),
        }
    }
    let (p2, j2) = server(response(200, "", b"done")).await;
    let (p1, j1) = server(response(
        307,
        &format!("Location: http://localhost:{p2}/next\r\n"),
        b"redirect-body",
    ))
    .await;
    let mut p = policy(format!("http://localhost:{p1}"));
    p.redirect = HttpRedirectPolicy::Follow { max_hops: 1 };
    let c = client(p, None);
    let out = c
        .execute(
            c.prepare(args("/")).unwrap(),
            CancellationToken::new(),
            &Hooks::default(),
        )
        .await;
    j1.await.unwrap();
    let sent = String::from_utf8(j2.await.unwrap()).unwrap();
    assert!(sent.starts_with("POST /next"));
    assert!(sent.ends_with("hello"));
    assert_eq!(
        out.hops[0].redirect_url.as_deref(),
        Some(format!("http://localhost:{p2}/next").as_str())
    );
    assert_eq!(out.hops[0].response_decoded_bytes, 13);
}
#[tokio::test]
async fn brotli_concatenated_gzip_and_compressed_expansion_are_bounded() {
    use async_compression::tokio::write::{BrotliEncoder, GzipEncoder};
    let mut br = BrotliEncoder::new(Vec::new());
    br.write_all(b"brotli evidence").await.unwrap();
    br.shutdown().await.unwrap();
    let brotli = br.into_inner();
    let mut gz = GzipEncoder::new(Vec::new());
    gz.write_all(b"member").await.unwrap();
    gz.shutdown().await.unwrap();
    let one = gz.into_inner();
    let mut two = one.clone();
    two.extend_from_slice(&one);
    let mut garbage = one;
    garbage.extend_from_slice(b"trailing garbage");
    for (encoding, bytes, expected) in [
        ("br", brotli, Some(b"brotli evidence".to_vec())),
        ("gzip", two, Some(b"membermember".to_vec())),
        ("gzip", garbage, None),
    ] {
        let (port, job) = server(response(
            200,
            &format!("Content-Encoding: {encoding}\r\n"),
            &bytes,
        ))
        .await;
        let c = client(policy(format!("http://localhost:{port}")), None);
        let out = c
            .execute(
                c.prepare(args("/")).unwrap(),
                CancellationToken::new(),
                &Hooks::default(),
            )
            .await;
        job.await.unwrap();
        match expected {
            Some(body) => assert_eq!(out.response.unwrap().body, body),
            None => assert_eq!(out.error, Some(ErrorCode::Decode)),
        }
    }
    let mut gz = GzipEncoder::new(Vec::new());
    gz.write_all(&vec![b'x'; 10000]).await.unwrap();
    gz.shutdown().await.unwrap();
    let (port, job) = server(response(
        200,
        "Content-Encoding: gzip\r\n",
        &gz.into_inner(),
    ))
    .await;
    let mut p = policy(format!("http://localhost:{port}"));
    p.limits.max_response_decoded_bytes = 100;
    let c = client(p, None);
    let out = c
        .execute(
            c.prepare(args("/")).unwrap(),
            CancellationToken::new(),
            &Hooks::default(),
        )
        .await;
    job.await.unwrap();
    assert_eq!(out.error, Some(ErrorCode::Limit));
    assert!(out.response.is_none());
}
#[tokio::test]
async fn request_and_response_header_limits_and_upgrade_rejection() {
    let mut p = policy("http://localhost".into());
    p.limits.max_request_headers = 2;
    let c = client(p, None);
    assert_eq!(c.prepare(args("/")).err(), Some(ErrorCode::Limit));
    for (headers, status, limit) in [
        ("X-Large: excessive-header\r\n", 200, 32),
        ("Upgrade: websocket\r\n", 101, 65536),
    ] {
        let (port, job) = server(response(status, headers, b"")).await;
        let mut p = policy(format!("http://localhost:{port}"));
        p.limits.max_response_header_bytes = limit;
        let c = client(p, None);
        let out = c
            .execute(
                c.prepare(args("/")).unwrap(),
                CancellationToken::new(),
                &Hooks::default(),
            )
            .await;
        job.await.unwrap();
        assert_eq!(out.disposition, HttpDisposition::Incomplete);
        assert!(out.response.is_none());
    }
}
#[tokio::test]
async fn empty_sensitive_caller_header_cannot_create_an_empty_redaction_match() {
    let (port, job) = server(response(200, "", b"public body")).await;
    let c = client(policy(format!("http://localhost:{port}")), None);
    let mut a = args("/");
    a.headers.insert("authorization".into(), String::new());
    let out = c
        .execute(
            c.prepare(a).unwrap(),
            CancellationToken::new(),
            &Hooks::default(),
        )
        .await;
    job.await.unwrap();
    assert_eq!(out.response.unwrap().body, b"public body");
}

#[tokio::test]
async fn recognized_429_is_observed_once_before_invalid_or_oversized_headers() {
    let cases = [
        (
            response(429, &format!("Retry-After: 61\r\nX-Large: {}\r\n", "x".repeat(512)), b""),
            128,
            Some("61"),
            Some(ErrorCode::Limit),
        ),
        (
            b"HTTP/1.1 429 Test\r\nContent-Length: 0\r\nConnection: close\r\nRetry-After: \xff\r\nX-Bad: \xfe\r\n\r\n".to_vec(),
            65536,
            None,
            Some(ErrorCode::Protocol),
        ),
        (
            response(429, &format!("Retry-After: {}\r\n", "9".repeat(1025)), b""),
            65536,
            None,
            None,
        ),
    ];
    for (wire, header_limit, expected_retry, expected_error) in cases {
        let (port, job) = server(wire).await;
        let mut p = policy(format!("http://localhost:{port}"));
        p.limits.max_response_header_bytes = header_limit;
        let c = client(p, None);
        let hooks = Hooks::default();
        let out = c
            .execute(
                c.prepare(args("/")).unwrap(),
                CancellationToken::new(),
                &hooks,
            )
            .await;
        job.await.unwrap();
        assert_eq!(out.error, expected_error);
        assert_eq!(
            *hooks.statuses.lock().unwrap(),
            vec![(429, expected_retry.map(str::to_owned))]
        );
        assert_eq!(out.hops[0].status, Some(429));
        assert_eq!(out.hops[0].complete, expected_error.is_none());
        if expected_error.is_some() {
            assert_eq!(out.disposition, HttpDisposition::Incomplete);
            assert!(out.response.is_none());
        }
    }
}
