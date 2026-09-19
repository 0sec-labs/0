#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "plugin_workers/fixture.rs"]
mod fixture;
#[path = "delegation/mod.rs"]
mod support;
#[path = "plugin_workers/http.rs"]
mod target;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, sync::Arc, time::Duration};
use support::*;
use tokio::sync::mpsc;
use zero_plugin::Capability;
use zero_protocol::{
    Command, ExecutionEvent, OperationStatus, Reply, agent::AgentStatus, approvals::*, plugin::*,
};
const WORKER: &str = r#"
import json,sys,os,time,sqlite3
# Test launcher only: this fixture proves lifecycle/authority, not Docker isolation.
db=sqlite3.connect(root/'state.db')
assert db.execute("select count(*) from events where kind='plugin_worker_prepared'").fetchone()[0]==1
assert db.execute("select count(*) from events where kind='plugin_worker_started'").fetchone()[0]==1
mode=(root/'mode').read_text()
def emit(v):print(json.dumps(v),flush=True)
emit({'type':'ready','version':1})
count=0
for line in sys.stdin:
    v=json.loads(line)
    if v['type']=='shutdown':break
    assert v['type']=='invoke'
    count+=1
    result={'count':count,'pid':os.getpid()}
    if mode in ('source','http'):
        op='read_source_lines' if mode=='source' else 'http_request'
        args={'path':'file.txt','start_line':1,'end_line':1} if mode=='source' else {'url':'/item','method':'POST','body':'{}'}
        emit({'type':'capability_request','id':count,'call_id':v['id'],'operation':op,'input':args})
        result['callback']=json.loads(sys.stdin.readline())
    if mode=='hang':
        (root/'worker-held').write_text('yes')
        time.sleep(60)
    emit({'type':'result','id':v['id'],'result':result})
"#;
fn setup(mode: &str) -> (Setup, String, Capability) {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    f.request.max_turns = 4;
    f.request.plugin_tools = vec![zero_protocol::agent::PluginToolBinding {
        alias: "inspect_plugin".into(),
        plugin: "fixture".into(),
        tool: "inspect".into(),
    }];
    let cap = match mode {
        "source" => {
            f.request.source_snapshot_tools = true;
            Capability::FilesystemRead
        }
        "http" => {
            f.request.http_profile = Some("target".into());
            Capability::Network
        }
        _ => Capability::Compute,
    };
    let artifact = fixture::register(&f, cap);
    let fake = include_str!("../../zero-executor/tests/fixtures/fake-docker.py")
        .replace(
            "sys.stdout.buffer.write(sys.stdin.buffer.read())",
            "exec((root / 'worker.py').read_text())",
        )
        .replace(
            "(\"hang\", \"cancel\", \"cleanup-fail\")",
            "(\"hang\", \"cancel\")",
        );
    fs::write(f.dir.path().join("docker"), fake).unwrap();
    fs::write(f.dir.path().join("worker.py"), WORKER).unwrap();
    fs::write(f.dir.path().join("mode"), mode).unwrap();
    (f, artifact, cap)
}
fn configure(f: &Setup, artifact: &str, cap: Capability) -> Arc<zero_engine::Engine> {
    configure_timeout(f, artifact, cap, 5000)
}
fn configure_timeout(
    f: &Setup,
    artifact: &str,
    cap: Capability,
    timeout: u64,
) -> Arc<zero_engine::Engine> {
    let e = f.engine();
    fixture::configure(f, &e, artifact, cap, timeout);
    let operations = match cap {
        Capability::FilesystemRead => vec![PluginHostOperation::ReadSourceLines],
        Capability::Network => vec![PluginHostOperation::HttpRequest],
        _ => vec![],
    };
    e.configure_plugin_workers(BTreeMap::from([(
        "fixture".into(),
        PluginWorkerPolicy {
            schema_version: 1,
            operations,
            max_calls: 4,
            max_callbacks: 8,
        },
    )]))
    .unwrap();
    e
}
async fn pinned(e: &zero_engine::Engine) -> String {
    match call(e, Command::SessionCreatePinned { budget_limit: 100 }).await {
        Reply::Session { session } => session.id,
        r => panic!("{r:?}"),
    }
}
fn operations(f: &Setup, kind: &str) -> Vec<zero_protocol::Operation> {
    let c = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    let mut q = c
        .prepare("SELECT id FROM operations WHERE json_extract(payload,'$.kind')=?1 ORDER BY rowid")
        .unwrap();
    let ids = q
        .query_map([kind], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    ids.iter()
        .map(|id| store.get_operation(id).unwrap())
        .collect()
}
fn leases(f: &Setup) -> u64 {
    rusqlite::Connection::open(f.dir.path().join("evo.sqlite"))
        .unwrap()
        .query_row("SELECT count(*) FROM leases WHERE released=0", [], |r| {
            r.get(0)
        })
        .unwrap()
}
fn last_plugin(request: &Value) -> Value {
    let v = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|v| v["type"] == "function_call_output")
        .unwrap();
    serde_json::from_str(v["output"].as_str().unwrap()).unwrap()
}
async fn next_model(model: &mut Http, run: &mut tokio::task::JoinHandle<Reply>) -> Incoming {
    tokio::select! {v=model.next()=>v,r=run=>panic!("actor ended before model request: {r:?}")}
}
#[tokio::test]
async fn actor_reuses_worker_and_source_authority_until_joined_drain() {
    for mode in ["plain", "source"] {
        let (f, artifact, cap) = setup(mode);
        let e = configure(&f, &artifact, cap);
        let mut model = Http::new().await;
        model.configure(&e);
        let session = pinned(&e).await;
        let mut run = start(e.clone(), f.command(&session));
        next_model(&mut model, &mut run.result)
            .await
            .finish(json!([tool("one", "inspect_plugin", json!({}))]))
            .await;
        let second = next_model(&mut model, &mut run.result).await;
        let first = last_plugin(&second.body);
        assert_eq!(first["provisional"], true, "{first}");
        assert_eq!(
            first["untrusted_plugin_data"]["value"]["count"], 1,
            "{first}"
        );
        assert_eq!(leases(&f), 1);
        assert_eq!(
            operations(&f, "agent_plugin")[0].status,
            OperationStatus::Running
        );
        second
            .finish(json!([tool("two", "inspect_plugin", json!({}))]))
            .await;
        let third = next_model(&mut model, &mut run.result).await;
        let next = last_plugin(&third.body);
        assert_eq!(next["untrusted_plugin_data"]["value"]["count"], 2, "{next}");
        assert_eq!(
            next["untrusted_plugin_data"]["value"]["pid"],
            first["untrusted_plugin_data"]["value"]["pid"]
        );
        if mode == "source" {
            assert_eq!(
                next["untrusted_plugin_data"]["value"]["callback"]["type"], "capability_result",
                "{next}"
            );
            assert!(next.to_string().contains("pinned fixture"));
        }
        assert_eq!(leases(&f), 2);
        third.answer("untrusted observations only").await;
        let (_, result, _) = agent(joined(run).await);
        assert_eq!(result.status, AgentStatus::Completed, "{result:?}");
        assert_eq!(leases(&f), 0);
        assert_eq!(operations(&f, "agent_plugin_worker").len(), 1);
        assert!(
            operations(&f, "agent_plugin")
                .iter()
                .all(|op| op.status == OperationStatus::Succeeded)
        );
        for op in operations(&f, "agent_plugin") {
            assert!(
                zero_engine::read_plugin_worker_call(
                    &f.dir.path().join("state.db"),
                    &session,
                    &op.id
                )
                .unwrap()
                .is_some()
            );
        }
        assert_eq!(f.calls().iter().filter(|v| v[0] == "create").count(), 1);
        e.shutdown().await.unwrap();
        drop(e);
        let e = configure(&f, &artifact, cap);
        model.configure(&e);
        let cached = call(&e, f.command(&session)).await;
        let (_, cached, _) = agent(cached);
        assert_eq!(
            serde_json::to_value(cached).unwrap(),
            serde_json::to_value(result).unwrap()
        );
        e.shutdown().await.unwrap();
    }
}
async fn pending(f: &Setup, rx: &mut mpsc::Receiver<ExecutionEvent>) -> ToolApprovalRecord {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let ExecutionEvent::ToolApprovalRequested {
                session_id,
                approval_operation_id,
                ..
            } = rx.recv().await.unwrap_or_else(|| {
                panic!(
                    "approval owner ended: {:?}",
                    operations(f, "offline_snapshot_agent")
                )
            }) {
                return zero_engine::read_tool_approval(
                    &f.dir.path().join("state.db"),
                    &session_id,
                    &approval_operation_id,
                )
                .unwrap();
            }
        }
    })
    .await
    .unwrap()
}
async fn approve(e: &zero_engine::Engine, r: &ToolApprovalRecord, decision: ToolApprovalDecision) {
    let response = call(
        e,
        Command::DecideToolApproval {
            session_id: r.session_id.clone(),
            command_id: format!("decide-{}", r.operation_id),
            approval_operation_id: r.operation_id.clone(),
            expected_intent_sha256: r.intent_sha256.clone(),
            decision,
        },
    )
    .await;
    assert!(!matches!(response, Reply::Error { .. }), "{response:?}");
}
#[tokio::test]
async fn plugin_permission_never_waives_callback_http_permission_and_original_account() {
    for allow in [false, true] {
        let (mut f, artifact, cap) = setup("http");
        f.request.tool_approval_policy = Some(ToolApprovalPolicy {
            require_approval: vec!["inspect_plugin".into(), "http_request".into()],
        });
        let e = configure(&f, &artifact, cap);
        let (listener, policy) = target::target().await;
        e.configure_http("target", zero_http::Client::new(policy, None).unwrap())
            .unwrap();
        let mut model = Http::new().await;
        model.configure(&e);
        let session = pinned(&e).await;
        let (tx, mut rx) = mpsc::channel(512);
        let cloned = e.clone();
        let command = f.command(&session);
        let mut run = tokio::spawn(async move { cloned.handle(command, tx).await });
        next_model(&mut model, &mut run)
            .await
            .finish(json!([tool("one", "inspect_plugin", json!({}))]))
            .await;
        let plugin = pending(&f, &mut rx).await;
        assert_eq!(leases(&f), 0);
        target::quiet(&listener).await;
        approve(&e, &plugin, ToolApprovalDecision::Approve).await;
        let http = pending(&f, &mut rx).await;
        assert_ne!(plugin.operation_id, http.operation_id);
        assert_eq!(leases(&f), 1);
        target::quiet(&listener).await;
        approve(
            &e,
            &http,
            if allow {
                ToolApprovalDecision::Approve
            } else {
                ToolApprovalDecision::Deny
            },
        )
        .await;
        if allow {
            let (socket, bytes) = target::receive(&listener).await;
            assert!(bytes.starts_with(b"POST /item"));
            target::respond(socket, 200, "", b"observed").await;
        }
        let next = tokio::select! {v=model.next()=>v,r=&mut run=>panic!("HTTP callback ended allow={allow}: {r:?}; callbacks={:?}; http={:?}",operations(&f,"agent_plugin_callback"),operations(&f,"agent_http"))};
        let value = last_plugin(&next.body);
        assert_eq!(
            value["untrusted_plugin_data"]["value"]["callback"]["type"],
            if allow {
                "capability_result"
            } else {
                "capability_error"
            },
            "{value}"
        );
        next.answer("done").await;
        let (_, result, _) = agent(
            tokio::time::timeout(Duration::from_secs(12), run)
                .await
                .unwrap()
                .unwrap(),
        );
        assert_eq!(result.status, AgentStatus::Completed, "{result:?}");
        assert_eq!(leases(&f), 0);
        let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
        for record in store.tool_approvals(&session, None, 0, 16).unwrap() {
            zero_engine::read_tool_approval_intent(
                &f.dir.path().join("state.db"),
                &session,
                &record.operation_id,
            )
            .unwrap();
        }
        assert_eq!(operations(&f, "agent_http").len(), usize::from(allow));
        for op in operations(&f, "agent_http") {
            let retained =
                zero_engine::read_http_operation(&f.dir.path().join("state.db"), &session, &op.id)
                    .unwrap();
            assert_eq!(retained["operation_status"], "succeeded");
            assert_eq!(
                zero_engine::read_http_evidence(&f.dir.path().join("state.db"), &session, &op.id)
                    .unwrap(),
                b"observed"
            );
        }
        target::quiet(&listener).await;
        e.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn uncertain_cleanup_keeps_both_call_leases_and_root_unknown() {
    let (f, artifact, cap) = setup("plain");
    fs::write(f.dir.path().join("scenario.txt"), "cleanup-fail").unwrap();
    let e = configure(&f, &artifact, cap);
    let mut model = Http::new().await;
    model.configure(&e);
    let session = pinned(&e).await;
    let mut run = start(e.clone(), f.command(&session));
    next_model(&mut model, &mut run.result)
        .await
        .finish(json!([tool("one", "inspect_plugin", json!({}))]))
        .await;
    next_model(&mut model, &mut run.result)
        .await
        .finish(json!([tool("two", "inspect_plugin", json!({}))]))
        .await;
    next_model(&mut model, &mut run.result)
        .await
        .answer("done")
        .await;
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Unknown, "{result:?}");
    assert_eq!(leases(&f), 2);
    assert!(
        operations(&f, "agent_plugin")
            .iter()
            .all(|op| op.status == OperationStatus::Unknown)
    );
    e.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancellation_drains_inflight_http_and_preserves_original_hold_without_replay() {
    let (f, artifact, cap) = setup("http");
    let e = configure(&f, &artifact, cap);
    let (listener, policy) = target::target().await;
    e.configure_http("target", zero_http::Client::new(policy, None).unwrap())
        .unwrap();
    let mut model = Http::new().await;
    model.configure(&e);
    let session = pinned(&e).await;
    let mut run = start(e.clone(), f.command(&session));
    next_model(&mut model, &mut run.result)
        .await
        .finish(json!([tool("one", "inspect_plugin", json!({}))]))
        .await;
    let (socket, _) = target::receive(&listener).await;
    let response = call(
        &e,
        Command::Cancel {
            session_id: session.clone(),
            execution_id: "parent-command".into(),
        },
    )
    .await;
    assert!(!matches!(response, Reply::Error { .. }), "{response:?}");
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Unknown, "{result:?}");
    assert_eq!(leases(&f), 1);
    drop(socket);
    let effects = operations(&f, "agent_http");
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0].status, OperationStatus::Unknown);
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    let hops = store
        .read_http_dispatches(&session, &effects[0].id)
        .unwrap();
    assert_eq!(hops.len(), 1);
    assert_ne!(hops[0]["observation"]["complete"], true);
    assert_eq!(model.count(), 1);
    target::quiet(&listener).await;
    let (_, cached, _) = agent(call(&e, f.command(&session)).await);
    assert_eq!(
        serde_json::to_value(cached).unwrap(),
        serde_json::to_value(result).unwrap()
    );
    assert_eq!(model.count(), 1);
    e.shutdown().await.unwrap();
}
#[tokio::test]
async fn original_worker_deadline_stops_hung_guest_and_releases_only_confirmed_teardown() {
    let (f, artifact, cap) = setup("hang");
    let e = configure_timeout(&f, &artifact, cap, 500);
    let mut model = Http::new().await;
    model.configure(&e);
    let session = pinned(&e).await;
    let mut run = start(e.clone(), f.command(&session));
    next_model(&mut model, &mut run.result)
        .await
        .finish(json!([tool("one", "inspect_plugin", json!({}))]))
        .await;
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Failed, "{result:?}");
    assert_eq!(leases(&f), 0);
    assert_eq!(model.count(), 1);
    assert!(f.calls().iter().any(|v| v[0] == "rm"));
    e.shutdown().await.unwrap();
}
#[tokio::test]
async fn retained_call_reader_rejects_missing_request_artifact_after_offline_success() {
    let (f, artifact, cap) = setup("plain");
    let e = configure(&f, &artifact, cap);
    let mut model = Http::new().await;
    model.configure(&e);
    let session = pinned(&e).await;
    let mut run = start(e.clone(), f.command(&session));
    next_model(&mut model, &mut run.result)
        .await
        .finish(json!([tool("one", "inspect_plugin", json!({}))]))
        .await;
    next_model(&mut model, &mut run.result)
        .await
        .answer("done")
        .await;
    assert_eq!(agent(joined(run).await).1.status, AgentStatus::Completed);
    e.shutdown().await.unwrap();
    drop(e);
    let op = operations(&f, "agent_plugin").remove(0);
    assert!(
        zero_engine::read_plugin_worker_call(&f.dir.path().join("state.db"), &session, &op.id)
            .unwrap()
            .is_some()
    );
    let c = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    c.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    c.execute("DELETE FROM artifacts WHERE digest IN (SELECT digest FROM operation_artifacts WHERE name='plugin.worker_request')",[]).unwrap();
    assert!(
        zero_engine::read_plugin_worker_call(&f.dir.path().join("state.db"), &session, &op.id)
            .is_err()
    );
}
#[tokio::test]
async fn persistent_provisional_output_is_exactly_receipted_at_checkpoint_and_continuation() {
    for approved in [false, true] {
        let (mut f, artifact, cap) = setup("plain");
        f.request.max_turns = 1;
        f.request.context_policy = Some(
            serde_json::from_value(
                json!({"schema_version":1,"max_input_bytes":32768,"keep_recent_rounds":1}),
            )
            .unwrap(),
        );
        if approved {
            f.request.tool_approval_policy = Some(ToolApprovalPolicy {
                require_approval: vec!["inspect_plugin".into()],
            });
        }
        let e = configure(&f, &artifact, cap);
        let mut model = Http::new().await;
        model.configure(&e);
        let session = pinned(&e).await;
        let (tx, mut events) = mpsc::channel(512);
        let engine = e.clone();
        let command = f.command(&session);
        let mut run = tokio::spawn(async move { engine.handle(command, tx).await });
        next_model(&mut model, &mut run)
            .await
            .finish(json!([tool("one", "inspect_plugin", json!({}))]))
            .await;
        if approved {
            let gate = pending(&f, &mut events).await;
            approve(&e, &gate, ToolApprovalDecision::Approve).await;
        }
        let (root, result, _) = agent(
            tokio::time::timeout(Duration::from_secs(10), run)
                .await
                .unwrap()
                .unwrap(),
        );
        assert_eq!(result.status, AgentStatus::TurnLimit, "{result:?}");
        assert!(result.continuation_artifact.is_some());
        assert_eq!(leases(&f), 0);
        let mut continuation = f.request.clone();
        continuation.continuation_of = Some(root.id);
        continuation.prompt = "continue with retained observations".into();
        let mut run = start(
            e.clone(),
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "continuation".into(),
                request: continuation,
            },
        );
        let next = next_model(&mut model, &mut run.result).await;
        assert!(next.body.to_string().contains("provisional"));
        next.answer("done").await;
        assert_eq!(agent(joined(run).await).1.status, AgentStatus::Completed);
        assert_eq!(f.calls().iter().filter(|v| v[0] == "create").count(), 1);
        e.shutdown().await.unwrap();
    }
}
