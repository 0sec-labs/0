#![allow(dead_code)]
use futures_util::future::BoxFuture;
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use zero_http::*;
use zero_protocol::http::*;
pub fn policy(base: String) -> HttpProfilePolicy {
    serde_json::from_value(serde_json::json!({"schema_version":1,"base_url":base,"in_scope":["localhost","*.localhost","127.0.0.1","example.test"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["GET","POST","HEAD","PUT"],"allowed_headers":["content-type","x-custom","user-agent","authorization"],"limits":{"timeout_ms":1000,"max_request_body_bytes":1048576,"max_response_wire_bytes":16777216,"max_response_decoded_bytes":16777216,"max_request_header_bytes":65536,"max_request_headers":128,"max_response_header_bytes":65536,"max_response_headers":128,"max_dns_answers":64,"max_dns_cname_depth":8,"max_dns_queries":16},"rate":{"default":{"requests_per_interval":5,"interval_ms":1000,"burst":5},"per_host":{},"jitter_ms":0},"budget":{"max_requests":100,"max_request_body_bytes":104857600,"max_response_decoded_bytes":1677721600}})).unwrap()
}
pub fn args(url: &str) -> HttpRequestArguments {
    HttpRequestArguments {
        url: url.into(),
        method: "POST".into(),
        headers: Default::default(),
        body: Some("hello".into()),
    }
}
pub struct FixedDns(pub Vec<IpAddr>);
impl Resolver for FixedDns {
    fn resolve<'a>(
        &'a self,
        _: &'a str,
        _: &'a HttpLimits,
    ) -> BoxFuture<'a, Result<Vec<IpAddr>, Error>> {
        Box::pin(async { Ok(self.0.clone()) })
    }
}
pub fn client(p: HttpProfilePolicy, auth: Option<StaticAuth>) -> Client {
    Client::with_runtime(
        p,
        auth,
        Arc::new(FixedDns(vec!["127.0.0.1".parse().unwrap()])),
        Arc::new(MonotonicClock::default()),
        None,
    )
    .unwrap()
}
#[derive(Default)]
pub struct Hooks {
    pub admitted: Mutex<Vec<HopIntent>>,
    pub settled: Mutex<Vec<HopObservation>>,
    pub statuses: Mutex<Vec<(u16, Option<String>)>>,
}
impl ExecutionHooks for Hooks {
    fn admit<'a>(&'a self, i: &'a HopIntent) -> BoxFuture<'a, Result<DispatchPermit, HookError>> {
        Box::pin(async move {
            self.admitted.lock().unwrap().push(i.clone());
            Ok(DispatchPermit {
                id: format!("hop-{}", i.index),
            })
        })
    }
    fn observe_headers<'a>(
        &'a self,
        _: &'a DispatchPermit,
        s: u16,
        r: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), HookError>> {
        Box::pin(async move {
            self.statuses
                .lock()
                .unwrap()
                .push((s, r.map(str::to_owned)));
            Ok(())
        })
    }
    fn settle<'a>(
        &'a self,
        _: &'a DispatchPermit,
        o: &'a HopObservation,
    ) -> BoxFuture<'a, Result<(), HookError>> {
        Box::pin(async move {
            self.settled.lock().unwrap().push(o.clone());
            Ok(())
        })
    }
}
pub async fn server(response: Vec<u8>) -> (u16, tokio::task::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let job = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            let n = socket.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..n]);
            if let Some(i) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&request[..i]);
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|v| v.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if request.len() >= i + 4 + length {
                    break;
                }
            }
        }
        socket.write_all(&response).await.unwrap();
        request
    });
    (port, job)
}
pub fn response(code: u16, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut b = format!(
        "HTTP/1.1 {code} Test\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
        body.len()
    )
    .into_bytes();
    b.extend_from_slice(body);
    b
}
