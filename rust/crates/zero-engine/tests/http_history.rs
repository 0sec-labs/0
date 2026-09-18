#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "delegation/mod.rs"]
mod support;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use support::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use zero_protocol::{Command, OperationStatus, Reply, agent::AgentStatus, http::*};
fn policy(base: String) -> HttpProfilePolicy {
    serde_json::from_value(json!({"schema_version":1,"base_url":base,"in_scope":["127.0.0.1"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["GET","POST"],"allowed_headers":["content-type","x-test"],"limits":{"timeout_ms":5000,"max_request_body_bytes":1048576,"max_response_wire_bytes":16777216,"max_response_decoded_bytes":16777216,"max_request_header_bytes":65536,"max_request_headers":128,"max_response_header_bytes":65536,"max_response_headers":128,"max_dns_answers":64,"max_dns_cname_depth":8,"max_dns_queries":16},"rate":{"default":{"requests_per_interval":100,"interval_ms":1000,"burst":20},"per_host":{},"jitter_ms":0},"budget":{"max_requests":20,"max_request_body_bytes":1048576,"max_response_decoded_bytes":67108864}})).unwrap()
}
fn setup() -> Setup {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    f.request.http_profile = Some("target".into());
    f
}
async fn target() -> (TcpListener, HttpProfilePolicy) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p = policy(format!("http://{}", l.local_addr().unwrap()));
    (l, p)
}
fn configure(f: &Setup, p: &HttpProfilePolicy) -> Arc<zero_engine::Engine> {
    let e = f.engine();
    e.configure_http("target", zero_http::Client::new(p.clone(), None).unwrap())
        .unwrap();
    e
}
async fn receive(l: &TcpListener) -> (TcpStream, Vec<u8>) {
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
async fn respond(mut s: TcpStream, status: u16, headers: &str, body: &[u8]) {
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
async fn quiet(l: &TcpListener) {
    assert!(
        tokio::time::timeout(Duration::from_millis(50), l.accept())
            .await
            .is_err()
    );
}
fn effects(f: &Setup) -> Vec<zero_protocol::Operation> {
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

async fn exercise(projected: bool, corrupt_checkpoint: bool) {
    let mut f = setup();
    f.request.max_turns = 1;
    if projected {
        f.request.context_policy = Some(
            serde_json::from_value(
                json!({"schema_version":1,"max_input_bytes":32768,"keep_recent_rounds":1}),
            )
            .unwrap(),
        );
    }
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    let first = model.next().await;
    let tools = first.body["tools"].clone();
    first
        .finish(json!([tool(
            "http",
            "http_request",
            json!({"url":"/receipt"})
        )]))
        .await;
    let (socket, _) = receive(&listener).await;
    respond(socket, 200, "", b"retained HTTP evidence").await;
    let (root, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::TurnLimit);
    let ops = effects(&f);
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].status, OperationStatus::Succeeded);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = configure(&f, &policy);
    model.configure(&engine);
    assert!(agent(call(&engine, f.command(&session)).await).2);
    let mut request = f.request.clone();
    request.max_turns = 2;
    request.continuation_of = Some(root.id.clone());
    request.prompt = "continue retained HTTP observation".into();
    let mut weakened = request.clone();
    weakened.http_profile = None;
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "removed-profile".into(),
                request: weakened
            }
        )
        .await,
        Reply::Error { .. }
    ));
    model.quiet().await;
    quiet(&listener).await;
    if !corrupt_checkpoint {
        let run = start(
            engine.clone(),
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "continue".into(),
                request: request.clone(),
            },
        );
        let continued = model.next().await;
        assert_eq!(continued.body["tools"], tools);
        assert!(
            continued
                .body
                .to_string()
                .contains("retained HTTP evidence")
        );
        continued
            .answer("finished using verified retained evidence")
            .await;
        let (parent, result, _) = agent(joined(run).await);
        assert_eq!(result.status, AgentStatus::Completed);
        request.continuation_of = Some(parent.id);
    }
    let before = budget(&engine, &session).await;
    engine.shutdown().await.unwrap();
    drop(engine);
    let db = f.dir.path().join("state.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    // Change the projection while leaving its immutable journal witness intact.
    conn.execute("UPDATE http_dispatches SET headers=json_set(headers,'$.status',201) WHERE effect_operation_id=?1",[&ops[0].id]).unwrap();
    drop(conn);
    assert!(zero_engine::read_http_evidence(&db, &session, &ops[0].id).is_err());
    let engine = configure(&f, &policy);
    model.configure(&engine);
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "forged-history".into(),
                request
            }
        )
        .await,
        Reply::Error { .. }
    ));
    model.quiet().await;
    quiet(&listener).await;
    let after = budget(&engine, &session).await;
    assert_eq!(
        (before.charged, before.reserved),
        (after.charged, after.reserved)
    );
    assert_eq!(model.count(), if corrupt_checkpoint { 1 } else { 2 });
    assert_eq!(effects(&f).len(), 1);
    assert!(f.calls().is_empty());
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn plain_checkpoint_rejects_changed_http_projection() {
    exercise(false, true).await;
}
#[tokio::test]
async fn projected_checkpoint_rejects_changed_http_projection() {
    exercise(true, true).await;
}
#[tokio::test]
async fn plain_completed_ancestor_rejects_changed_http_projection() {
    exercise(false, false).await;
}
#[tokio::test]
async fn projected_completed_ancestor_rejects_changed_http_projection() {
    exercise(true, false).await;
}
