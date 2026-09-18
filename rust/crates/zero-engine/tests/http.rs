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
    sync::mpsc,
};
use zero_protocol::{
    Command, ExecutionEvent, OperationStatus, Reply, agent::AgentStatus, approvals::*, http::*,
};
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
#[tokio::test]
async fn known_http_error_retains_chunked_binary_evidence_and_exact_restart_is_inert() {
    let f = setup();
    let (l, p) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &p);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([tool(
            "http",
            "http_request",
            json!({"url":"/item","body":"literal body"})
        )]))
        .await;
    let (s, sent) = tokio::select! {received=receive(&l)=>received,next=model.next()=>panic!("HTTP was rejected: {}",next.body)};
    assert!(sent.starts_with(b"POST /item HTTP/1.1"));
    assert!(sent.ends_with(b"literal body"));
    let mut body = vec![b'x'; 4 * 1024 * 1024 + 7];
    body[4 * 1024 * 1024] = 0xff;
    respond(s, 404, "X-Test: observed\r\n", &body).await;
    let next = model.next().await;
    let out = outputs(&next.body);
    assert_eq!(out[0]["response"]["status"], 404);
    assert_eq!(out[0]["response"]["body_display_truncated"], true);
    assert_eq!(
        out[0]["response"]["body_text"].as_str().unwrap().len(),
        10000
    );
    next.answer("observed response only").await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    let ops = effects(&f);
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].status, OperationStatus::Succeeded);
    let db = f.dir.path().join("state.db");
    assert_eq!(
        zero_engine::read_http_evidence(&db, &session, &ops[0].id).unwrap(),
        body
    );
    let meta = zero_engine::read_http_operation(&db, &session, &ops[0].id).unwrap();
    assert_eq!(
        meta["manifest"]["body"]["chunks"].as_array().unwrap().len(),
        2
    );
    assert!(
        serde_json::to_vec(ops[0].outcome.as_ref().unwrap())
            .unwrap()
            .len()
            < 2048
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    std::fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let engine = f.engine();
    model.configure(&engine);
    let (retry, _, duplicate) = agent(call(&engine, f.command(&session)).await);
    assert!(duplicate);
    assert_eq!(retry.outcome, parent.outcome);
    model.quiet().await;
    quiet(&l).await;
    let sql = rusqlite::Connection::open(&db).unwrap();
    let digest = meta["manifest"]["body"]["chunks"][0]["digest"]
        .as_str()
        .unwrap();
    sql.execute("UPDATE artifacts SET bytes=x'00' WHERE digest=?1", [digest])
        .unwrap();
    assert!(zero_engine::read_http_evidence(&db, &session, &ops[0].id).is_err());
    assert!(f.calls().is_empty());
}
#[tokio::test]
async fn exact_http_approval_blocks_socket_until_decision_and_denial_is_not_execution() {
    for approve in [false, true] {
        let mut f = setup();
        f.request.tool_approval_policy = Some(ToolApprovalPolicy {
            require_approval: vec!["http_request".into()],
        });
        let (l, p) = target().await;
        let mut model = Http::new().await;
        let engine = configure(&f, &p);
        model.configure(&engine);
        let session = session(&engine, 100).await;
        let (tx, mut rx) = mpsc::channel(512);
        let e = engine.clone();
        let command = f.command(&session);
        let run = tokio::spawn(async move { e.handle(command, tx).await });
        model
            .next()
            .await
            .finish(json!([tool(
                "http",
                "http_request",
                json!({"url":"/approved"})
            )]))
            .await;
        let key = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let ExecutionEvent::ToolApprovalRequested {
                    approval_operation_id,
                    ..
                } = rx.recv().await.unwrap()
                {
                    break approval_operation_id;
                }
            }
        })
        .await
        .unwrap();
        quiet(&l).await;
        assert!(effects(&f).is_empty());
        let r = zero_engine::read_tool_approval(&f.dir.path().join("state.db"), &session, &key)
            .unwrap();
        let intent =
            zero_engine::read_tool_approval_intent(&f.dir.path().join("state.db"), &session, &key)
                .unwrap();
        assert_eq!(intent["effect_payload"]["request"]["method"], "POST");
        let decision = Command::DecideToolApproval {
            session_id: session.clone(),
            command_id: "decision".into(),
            approval_operation_id: key,
            expected_intent_sha256: r.intent_sha256,
            decision: if approve {
                ToolApprovalDecision::Approve
            } else {
                ToolApprovalDecision::Deny
            },
        };
        assert!(matches!(
            call(&engine, decision.clone()).await,
            Reply::ToolApprovalDecided {
                duplicate: false,
                ..
            }
        ));
        if approve {
            let (s, _) = receive(&l).await;
            respond(s, 200, "", b"approved result").await;
        }
        let next = model.next().await;
        if approve {
            assert!(next.body.to_string().contains("approved result"));
        } else {
            assert!(next.body.to_string().contains("operator denied"));
        }
        next.answer("done").await;
        assert_eq!(agent(run.await.unwrap()).1.status, AgentStatus::Completed);
        assert_eq!(effects(&f).len(), usize::from(approve));
        engine.shutdown().await.unwrap();
        drop(engine);
        let engine = f.engine();
        assert!(matches!(
            call(&engine, decision).await,
            Reply::ToolApprovalDecided {
                duplicate: true,
                ..
            }
        ));
        quiet(&l).await;
        assert!(f.calls().is_empty());
    }
}
#[tokio::test]
async fn cancellation_after_dispatch_is_unknown_holds_budget_and_never_replays() {
    let f = setup();
    let (l, p) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &p);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([tool(
            "http",
            "http_request",
            json!({"url":"/held"})
        )]))
        .await;
    let (mut socket, _) = receive(&l).await;
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
        .await
        .unwrap();
    call(
        &engine,
        Command::Cancel {
            session_id: session.clone(),
            execution_id: "parent-command".into(),
        },
    )
    .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Unknown);
    assert_eq!(parent.status, OperationStatus::Unknown);
    let mut byte = [0];
    let closed = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut byte))
        .await
        .unwrap();
    assert!(
        matches!(closed, Ok(0))
            || matches!(closed,Err(ref error) if error.kind()==std::io::ErrorKind::ConnectionReset)
    );
    let op = &effects(&f)[0];
    assert_eq!(op.status, OperationStatus::Unknown);
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    let ds = store.read_http_dispatches(&session, &op.id).unwrap();
    assert_eq!(ds.len(), 1);
    assert_eq!(
        ds[0]["charged_response_decoded_bytes"],
        ds[0]["reserved_response_decoded_bytes"]
    );
    assert_eq!(budget(&engine, &session).await.reserved, 0);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    model.configure(&engine);
    assert!(agent(call(&engine, f.command(&session)).await).2);
    quiet(&l).await;
    model.quiet().await;
}
#[tokio::test]
async fn joined_children_and_continuation_branches_share_one_persisted_account() {
    let mut f = Setup::new(vec!["http_request"], 2, 2);
    f.request.http_profile = Some("target".into());
    let (l, mut p) = target().await;
    p.budget.max_requests = 1;
    let mut model = Http::new().await;
    let engine = configure(&f, &p);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([delegation(vec![
            ("investigator", "one"),
            ("investigator", "two")
        ])]))
        .await;
    let a = model.next().await;
    let b = model.next().await;
    a.finish(json!([tool(
        "http-a",
        "http_request",
        json!({"url":"/one"})
    )]))
    .await;
    b.finish(json!([tool(
        "http-b",
        "http_request",
        json!({"url":"/two"})
    )]))
    .await;
    let (s, _) = receive(&l).await;
    respond(s, 200, "", b"one shared allowance").await;
    let a = model.next().await;
    let b = model.next().await;
    let combined = format!("{} {}", a.body, b.body);
    assert!(combined.contains("one shared allowance"));
    assert!(combined.contains("accounting"));
    a.answer("child done").await;
    b.answer("child done").await;
    model.next().await.answer("root done").await;
    let (root, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    let ops = effects(&f);
    assert_eq!(ops.len(), 2);
    assert_eq!(
        ops.iter()
            .filter(|o| o.status == OperationStatus::Succeeded)
            .count(),
        1
    );
    assert_eq!(
        ops[0].payload["http_context"]["account_id"],
        ops[1].payload["http_context"]["account_id"]
    );
    quiet(&l).await;
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = configure(&f, &p);
    model.configure(&engine);
    for i in 0..2 {
        let mut request = f.request.clone();
        request.continuation_of = Some(root.id.clone());
        request.prompt = format!("branch {i}");
        let run = start(
            engine.clone(),
            Command::RunAgent {
                session_id: session.clone(),
                command_id: format!("branch-{i}"),
                request,
            },
        );
        model
            .next()
            .await
            .finish(json!([tool(
                "blocked",
                "http_request",
                json!({"url":"/branch"})
            )]))
            .await;
        let next = model.next().await;
        assert!(next.body.to_string().contains("accounting"));
        next.answer("bounded").await;
        assert_eq!(agent(joined(run).await).1.status, AgentStatus::Completed);
    }
    quiet(&l).await;
    let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    assert_eq!(
        sql.query_row("SELECT COUNT(*) FROM http_accounts", [], |r| r
            .get::<_, u64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        sql.query_row("SELECT COUNT(*) FROM http_dispatches", [], |r| r
            .get::<_, u64>(0))
            .unwrap(),
        1
    );
    assert!(f.calls().is_empty());
}
#[tokio::test]
async fn redirects_have_distinct_durable_permits_and_method_body_transforms() {
    let f = setup();
    let (l, mut p) = target().await;
    p.redirect = HttpRedirectPolicy::Follow { max_hops: 2 };
    let mut model = Http::new().await;
    let engine = configure(&f, &p);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([tool(
            "http",
            "http_request",
            json!({"url":"/first","body":"payload"})
        )]))
        .await;
    let (s, first) = receive(&l).await;
    assert!(first.starts_with(b"POST /first"));
    respond(s, 302, "Location: /next\r\n", b"").await;
    let (s, second) = receive(&l).await;
    assert!(second.starts_with(b"GET /next"));
    assert!(!second.ends_with(b"payload"));
    respond(s, 200, "", b"followed").await;
    model.next().await.answer("done").await;
    assert_eq!(agent(joined(run).await).1.status, AgentStatus::Completed);
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    let ds = store
        .read_http_dispatches(&session, &effects(&f)[0].id)
        .unwrap();
    assert_eq!(ds.len(), 2);
    assert_ne!(ds[0]["id"], ds[1]["id"]);
    assert_eq!(ds[0]["request_body_bytes"], 7);
    assert_eq!(ds[1]["request_body_bytes"], 0);
    assert_eq!(ds[0]["observation"]["redirect_url"], ds[1]["intent"]["url"]);
}
#[tokio::test]
async fn static_credentials_are_origin_bound_and_redacted_before_model_and_storage() {
    let f = setup();
    let (l, mut p) = target().await;
    let secret = "private-fixture-bearer-token";
    let auth = zero_http::StaticAuth::new(
        "auth-v1".into(),
        p.base_url.clone(),
        std::collections::BTreeMap::from([("authorization".into(), format!("Bearer {secret}"))]),
    )
    .unwrap();
    p.auth = Some(auth.descriptor().clone());
    let mut model = Http::new().await;
    let engine = f.engine();
    engine
        .configure_http("target", zero_http::Client::new(p, Some(auth)).unwrap())
        .unwrap();
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([tool(
            "http",
            "http_request",
            json!({"url":"/echo"})
        )]))
        .await;
    let (s, sent) = receive(&l).await;
    assert!(String::from_utf8_lossy(&sent).contains(secret));
    respond(
        s,
        200,
        &format!("X-Echo: {secret}\r\nSet-Cookie: new-secret-cookie=value\r\n"),
        format!("echo Bearer {secret}").as_bytes(),
    )
    .await;
    let next = model.next().await;
    assert!(!next.body.to_string().contains(secret));
    assert!(!next.body.to_string().contains("new-secret-cookie"));
    next.answer("redacted observation").await;
    assert_eq!(agent(joined(run).await).1.status, AgentStatus::Completed);
    let db = f.dir.path().join("state.db");
    let body = zero_engine::read_http_evidence(&db, &session, &effects(&f)[0].id).unwrap();
    assert!(!String::from_utf8_lossy(&body).contains(secret));
    let sql = rusqlite::Connection::open(db).unwrap();
    for query in [
        "SELECT CAST(payload AS BLOB) FROM events",
        "SELECT bytes FROM artifacts",
    ] {
        let mut q = sql.prepare(query).unwrap();
        let rows = q.query_map([], |r| r.get::<_, Vec<u8>>(0)).unwrap();
        for row in rows {
            assert!(!String::from_utf8_lossy(&row.unwrap()).contains(secret));
        }
    }
    assert!(f.calls().is_empty());
}
#[tokio::test]
async fn request_artifact_failure_stops_before_target_and_remains_known_failed() {
    let f = setup();
    let (l, p) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &p);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_http_retention BEFORE INSERT ON events WHEN NEW.kind='operation_artifact' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([tool(
            "http",
            "http_request",
            json!({"url":"/never"})
        )]))
        .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Failed);
    assert_eq!(parent.status, OperationStatus::Failed);
    sql.execute_batch("DROP TRIGGER fail_http_retention;")
        .unwrap();
    let op = &effects(&f)[0];
    assert_eq!(op.status, OperationStatus::Failed);
    assert_eq!(
        op.outcome.as_ref().unwrap()["external_effects_started"],
        false
    );
    assert_eq!(
        sql.query_row("SELECT COUNT(*) FROM http_dispatches", [], |r| r
            .get::<_, u64>(0))
            .unwrap(),
        0
    );
    quiet(&l).await;
    model.quiet().await;
}
#[path = "approvals/plugin.rs"]
mod plugin;
#[tokio::test]
async fn historical_http_request_plugin_alias_stays_offline_without_native_profile() {
    let mut f = setup();
    f.request.http_profile = None;
    f.request.plugin_tools = vec![zero_protocol::agent::PluginToolBinding {
        alias: "http_request".into(),
        plugin: "fixture".into(),
        tool: "inspect".into(),
    }];
    let artifact = plugin::register(&f);
    let mut model = Http::new().await;
    let engine = f.engine();
    plugin::configure(&f, &engine, &artifact);
    model.configure(&engine);
    let session = match call(&engine, Command::SessionCreatePinned { budget_limit: 100 }).await {
        Reply::Session { session } => session.id,
        r => panic!("{r:?}"),
    };
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([tool("plugin", "http_request", json!({}))]))
        .await;
    let next = model.next().await;
    assert!(next.body.to_string().contains("historical_plugin"));
    next.answer("plugin observed").await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    assert!(parent.payload.get("http_context").is_none());
    assert!(effects(&f).is_empty());
    let calls = f.calls();
    assert_eq!(calls.iter().filter(|c| c[0] == "create").count(), 1);
    let mut request = f.request.clone();
    request.continuation_of = Some(parent.id);
    request.prompt = "continue plugin".into();
    let run = start(
        engine.clone(),
        Command::RunAgent {
            session_id: session.clone(),
            command_id: "continue".into(),
            request,
        },
    );
    model.next().await.answer("retained").await;
    assert_eq!(agent(joined(run).await).1.status, AgentStatus::Completed);
    assert_eq!(f.calls(), calls);
    let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    assert_eq!(
        sql.query_row("SELECT COUNT(*) FROM http_accounts", [], |r| r
            .get::<_, u64>(0))
            .unwrap(),
        0
    );
}
#[tokio::test]
async fn failed_accounting_settlement_retains_unknown_dispatch_and_full_hold() {
    let f = setup();
    let (l, p) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &p);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_http_settlement BEFORE INSERT ON events WHEN NEW.kind='http_hop_settled' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([tool(
            "http",
            "http_request",
            json!({"url":"/settle"})
        )]))
        .await;
    let (s, _) = receive(&l).await;
    respond(s, 200, "", b"known received but accounting failed").await;
    assert_eq!(agent(joined(run).await).1.status, AgentStatus::Unknown);
    sql.execute_batch("DROP TRIGGER fail_http_settlement;")
        .unwrap();
    let op = &effects(&f)[0];
    assert_eq!(op.status, OperationStatus::Unknown);
    let db = f.dir.path().join("state.db");
    let retained = zero_engine::read_http_operation(&db, &session, &op.id).unwrap();
    assert_eq!(retained["manifest"]["outcome"]["disposition"], "incomplete");
    let store = zero_store::Store::open_read_only(db).unwrap();
    let ds = store.read_http_dispatches(&session, &op.id).unwrap();
    assert!(ds[0]["observation"].is_null());
    assert!(ds[0]["charged_response_decoded_bytes"].is_null());
    assert_eq!(
        ds[0]["reserved_response_decoded_bytes"],
        p.limits.max_response_decoded_bytes
    );
    quiet(&l).await;
    model.quiet().await;
}
