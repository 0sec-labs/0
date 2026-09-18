#![allow(dead_code)]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "../delegation/mod.rs"]
mod support;
use serde_json::json;
use std::{sync::Arc, time::Duration};
pub use support::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use zero_protocol::http::*;
pub fn policy(base: String) -> HttpProfilePolicy {
    serde_json::from_value(json!({"schema_version":1,"base_url":base,"in_scope":["127.0.0.1"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["GET","POST"],"allowed_headers":["content-type","x-test"],"limits":{"timeout_ms":5000,"max_request_body_bytes":1048576,"max_response_wire_bytes":16777216,"max_response_decoded_bytes":16777216,"max_request_header_bytes":65536,"max_request_headers":128,"max_response_header_bytes":65536,"max_response_headers":128,"max_dns_answers":64,"max_dns_cname_depth":8,"max_dns_queries":16},"rate":{"default":{"requests_per_interval":100,"interval_ms":1000,"burst":20},"per_host":{},"jitter_ms":0},"budget":{"max_requests":20,"max_request_body_bytes":1048576,"max_response_decoded_bytes":67108864}})).unwrap()
}
pub fn setup() -> Setup {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    f.request.http_profile = Some("target".into());
    f.request.execution = None;
    f.request.web_submission_max_hypotheses = Some(4);
    std::fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    std::fs::remove_file(f.dir.path().join("docker")).unwrap();
    f
}
pub async fn target() -> (TcpListener, HttpProfilePolicy) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p = policy(format!("http://{}", l.local_addr().unwrap()));
    (l, p)
}
pub fn configure(f: &Setup, p: &HttpProfilePolicy) -> Arc<zero_engine::Engine> {
    let e = f.engine();
    e.configure_http("target", zero_http::Client::new(p.clone(), None).unwrap())
        .unwrap();
    e
}
pub async fn receive(l: &TcpListener) -> (TcpStream, Vec<u8>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let (mut s, _) = l.accept().await.unwrap();
        let mut all = vec![];
        loop {
            let mut b = [0; 4096];
            let n = s.read(&mut b).await.unwrap();
            assert!(n > 0);
            all.extend(&b[..n]);
            if let Some(i) = all.windows(4).position(|w| w == b"\r\n\r\n") {
                let length = String::from_utf8_lossy(&all[..i])
                    .lines()
                    .find_map(|line| {
                        let (k, v) = line.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if all.len() >= i + 4 + length {
                    break;
                }
            }
        }
        (s, all)
    })
    .await
    .unwrap()
}
pub async fn respond(mut s: TcpStream, status: u16, headers: &str, body: &[u8]) {
    s.write_all(
        format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
            body.len()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    s.write_all(body).await.unwrap();
    s.shutdown().await.unwrap();
}
pub async fn quiet(l: &TcpListener) {
    assert!(
        tokio::time::timeout(Duration::from_millis(50), l.accept())
            .await
            .is_err()
    );
}
pub fn effects(f: &Setup) -> Vec<zero_protocol::Operation> {
    let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    let mut q=sql.prepare("SELECT id FROM operations WHERE json_extract(payload,'$.kind')='agent_http' ORDER BY rowid").unwrap();
    let ids = q
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    ids.iter()
        .map(|id| store.get_operation(id).unwrap())
        .collect()
}
