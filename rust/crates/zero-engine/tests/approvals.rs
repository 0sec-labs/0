#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "approvals/plugin.rs"]
mod plugin;
#[path = "delegation/mod.rs"]
mod support;
use serde_json::json;
use std::{fs, sync::Arc, time::Duration};
use support::*;
use tokio::{sync::mpsc, task::JoinHandle};
use zero_engine::Engine;
use zero_protocol::{
    Command, ExecutionEvent, OperationStatus, Reply, agent::AgentStatus, approvals::*,
};
fn setup() -> Setup {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    f.request.tool_approval_policy = Some(ToolApprovalPolicy {
        require_approval: vec!["execute_snapshot".into()],
    });
    match f.request.execution.as_mut().unwrap() {
        zero_protocol::agent::AgentExecution::Docker(r) => {
            r.image = format!("sha256:{}", "a".repeat(64))
        }
        _ => unreachable!(),
    };
    f
}
fn decide(r: &ToolApprovalRecord, command: &str, decision: ToolApprovalDecision) -> Command {
    Command::DecideToolApproval {
        session_id: r.session_id.clone(),
        command_id: command.into(),
        approval_operation_id: r.operation_id.clone(),
        expected_intent_sha256: r.intent_sha256.clone(),
        decision,
    }
}
fn start_gate(
    engine: Arc<Engine>,
    command: Command,
) -> (JoinHandle<Reply>, mpsc::Receiver<ExecutionEvent>) {
    let (tx, rx) = mpsc::channel(512);
    (
        tokio::spawn(async move { engine.handle(command, tx).await }),
        rx,
    )
}
async fn done(run: JoinHandle<Reply>) -> Reply {
    tokio::time::timeout(Duration::from_secs(12), run)
        .await
        .expect("actor deadline")
        .unwrap()
}
async fn pending(f: &Setup, events: &mut mpsc::Receiver<ExecutionEvent>) -> ToolApprovalRecord {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let ExecutionEvent::ToolApprovalRequested {
                session_id,
                root_operation_id,
                actor_operation_id,
                approval_operation_id,
            } = events.recv().await.unwrap()
            {
                let r = zero_engine::read_tool_approval(
                    &f.dir.path().join("state.db"),
                    &session_id,
                    &approval_operation_id,
                )
                .unwrap();
                assert_eq!(r.status, ToolApprovalStatus::Pending);
                assert_eq!(r.root_operation_id, root_operation_id);
                assert_eq!(r.actor_operation_id, actor_operation_id);
                return r;
            }
        }
    })
    .await
    .expect("approval event")
}

#[tokio::test]
async fn approve_or_deny_gates_exact_invocation_without_any_predecision_backend_effect() {
    for approved in [false, true] {
        let f = setup();
        let mut http = Http::new().await;
        let engine = f.engine();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let (run, mut events) = start_gate(engine.clone(), f.command(&session));
        http.next()
            .await
            .finish(json!([tool(
                "run",
                "execute_snapshot",
                json!({"argv":["fixture","literal ; $(false)"]})
            )]))
            .await;
        let r = pending(&f, &mut events).await;
        http.quiet().await;
        assert!(f.calls().is_empty());
        assert_eq!(budget(&engine, &session).await.reserved, 0);
        let intent = zero_engine::read_tool_approval_intent(
            &f.dir.path().join("state.db"),
            &session,
            &r.operation_id,
        )
        .unwrap();
        assert_eq!(
            intent["effect_payload"]["request"]["argv"],
            json!(["fixture", "literal ; $(false)"])
        );
        assert_eq!(
            intent["effect_payload"]["request"]["snapshot"]["digest"],
            f.request.snapshot_request().unwrap().snapshot.digest
        );
        let mut wrong = r.clone();
        wrong.intent_sha256 = format!("sha256:{}", "f".repeat(64));
        assert!(matches!(
            call(
                &engine,
                decide(&wrong, "wrong", ToolApprovalDecision::Approve)
            )
            .await,
            Reply::Error { .. }
        ));
        assert!(f.calls().is_empty());
        let choice = if approved {
            ToolApprovalDecision::Approve
        } else {
            ToolApprovalDecision::Deny
        };
        let receipt = call(&engine, decide(&r, "decision", choice)).await;
        assert!(matches!(
            receipt,
            Reply::ToolApprovalDecided {
                duplicate: false,
                ..
            }
        ));
        let next = http.next().await;
        if approved {
            assert!(
                next.body["input"]
                    .to_string()
                    .contains("child fixture output")
            );
        } else {
            assert!(
                next.body["input"]
                    .to_string()
                    .contains("Tool rejected: operator denied")
            );
            assert!(f.calls().is_empty());
        }
        next.answer("complete").await;
        let (_, result, _) = agent(done(run).await);
        assert_eq!(result.status, AgentStatus::Completed);
        let current = zero_engine::read_tool_approval(
            &f.dir.path().join("state.db"),
            &session,
            &r.operation_id,
        )
        .unwrap();
        assert_eq!(
            current.status,
            if approved {
                ToolApprovalStatus::Consumed
            } else {
                ToolApprovalStatus::Denied
            }
        );
        assert_eq!(current.consumption.is_some(), approved);
        let calls = f.calls();
        assert_eq!(
            calls.iter().filter(|v| v[0] == "create").count(),
            usize::from(approved)
        );
        engine.shutdown().await.unwrap();
        drop(engine);
        fs::remove_dir_all(f.dir.path().join("source")).unwrap();
        let engine = f.engine();
        assert!(matches!(
            call(&engine, decide(&r, "decision", choice)).await,
            Reply::ToolApprovalDecided {
                duplicate: true,
                ..
            }
        ));
        assert!(matches!(
            call(
                &engine,
                decide(
                    &r,
                    "decision",
                    if approved {
                        ToolApprovalDecision::Deny
                    } else {
                        ToolApprovalDecision::Approve
                    }
                )
            )
            .await,
            Reply::Error { .. }
        ));
        http.configure(&engine);
        assert!(agent(call(&engine, f.command(&session)).await).2);
        assert_eq!(http.count(), 2);
        assert_eq!(f.calls(), calls);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn cancel_pending_and_closed_observer_never_consume_or_dispatch() {
    for closed in [false, true] {
        let f = setup();
        let mut http = Http::new().await;
        let engine = f.engine();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let (run, mut events) = start_gate(engine.clone(), f.command(&session));
        let first = http.next().await;
        if closed {
            events.close();
        }
        first
            .finish(json!([tool(
                "run",
                "execute_snapshot",
                json!({"argv":["fixture"]})
            )]))
            .await;
        if !closed {
            let r = pending(&f, &mut events).await;
            call(
                &engine,
                Command::Cancel {
                    session_id: session.clone(),
                    execution_id: "parent-command".into(),
                },
            )
            .await;
            assert!(matches!(
                call(&engine, decide(&r, "late", ToolApprovalDecision::Approve)).await,
                Reply::Error { .. }
            ));
        }
        assert_eq!(agent(done(run).await).1.status, AgentStatus::Cancelled);
        assert!(f.calls().is_empty());
        let records = zero_engine::read_tool_approvals(
            &f.dir.path().join("state.db"),
            &session,
            None,
            0,
            100,
        )
        .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].status, ToolApprovalStatus::Cancelled);
        assert!(records[0].consumption.is_none());
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn invalid_calls_and_unsupported_or_mutable_profiles_do_not_request_permission() {
    let mut f = setup();
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let (run, _events) = start_gate(engine.clone(), f.command(&session));
    http.next()
        .await
        .finish(json!([tool(
            "bad",
            "execute_snapshot",
            json!({"argv":["fixture"],"network":true})
        )]))
        .await;
    let next = http.next().await;
    assert!(next.body["input"].to_string().contains("Tool rejected:"));
    next.answer("invalid").await;
    assert_eq!(agent(done(run).await).1.status, AgentStatus::Completed);
    assert!(f.calls().is_empty());
    assert!(
        zero_engine::read_tool_approvals(&f.dir.path().join("state.db"), &session, None, 0, 100)
            .unwrap()
            .is_empty()
    );
    f.request.tool_approval_policy = Some(ToolApprovalPolicy {
        require_approval: vec!["read_source_lines".into()],
    });
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "unknown-policy".into(),
                request: f.request.clone()
            }
        )
        .await,
        Reply::Error { .. }
    ));
    f.request.tool_approval_policy = Some(ToolApprovalPolicy {
        require_approval: vec!["execute_snapshot".into()],
    });
    if let zero_protocol::agent::AgentExecution::Docker(r) = f.request.execution.as_mut().unwrap() {
        r.image = "local:mutable".into();
    }
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "mutable".into(),
                request: f.request.clone()
            }
        )
        .await,
        Reply::Error { .. }
    ));
    assert_eq!(http.count(), 2);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn consumed_unknown_cleanup_stays_unknown_after_restart_without_reexecution() {
    let f = setup();
    fs::write(f.dir.path().join("scenario"), "cleanup-fail").unwrap();
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let (run, mut events) = start_gate(engine.clone(), f.command(&session));
    http.next()
        .await
        .finish(json!([tool(
            "run",
            "execute_snapshot",
            json!({"argv":["fixture"]})
        )]))
        .await;
    let r = pending(&f, &mut events).await;
    call(&engine, decide(&r, "yes", ToolApprovalDecision::Approve)).await;
    f.markers("started-", 1).await;
    call(
        &engine,
        Command::Cancel {
            session_id: session.clone(),
            execution_id: "parent-command".into(),
        },
    )
    .await;
    assert_eq!(agent(done(run).await).1.status, AgentStatus::Unknown);
    let r =
        zero_engine::read_tool_approval(&f.dir.path().join("state.db"), &session, &r.operation_id)
            .unwrap();
    assert_eq!(r.operation_status, OperationStatus::Unknown);
    assert_eq!(r.effect_status, Some(OperationStatus::Unknown));
    let calls = f.calls();
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    http.configure(&engine);
    assert!(agent(call(&engine, f.command(&session)).await).2);
    assert_eq!(http.count(), 1);
    assert_eq!(f.calls(), calls);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn parallel_children_inherit_gates_and_cannot_spend_sibling_permission() {
    let mut f = setup();
    let inherited = Setup::new(vec!["execute_snapshot"], 2, 2);
    f.request.delegation_policy = inherited.request.delegation_policy;
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let (run, mut events) = start_gate(engine.clone(), f.command(&session));
    http.next()
        .await
        .finish(json!([delegation(vec![
            ("investigator", "A"),
            ("investigator", "B")
        ])]))
        .await;
    let first = http.next().await;
    let second = http.next().await;
    let first_prompt = first.prompt();
    let second_prompt = second.prompt();
    first
        .finish(json!([tool(
            "run",
            "execute_snapshot",
            json!({"argv":["fixture","A"]})
        )]))
        .await;
    let a = pending(&f, &mut events).await;
    second
        .finish(json!([tool(
            "run",
            "execute_snapshot",
            json!({"argv":["fixture","B"]})
        )]))
        .await;
    let b = pending(&f, &mut events).await;
    assert!(f.calls().is_empty());
    assert_ne!(a.intent_sha256, b.intent_sha256);
    assert_ne!(a.actor_operation_id, b.actor_operation_id);
    let mut forged = a.clone();
    forged.operation_id = b.operation_id.clone();
    assert!(matches!(
        call(
            &engine,
            decide(&forged, "forged", ToolApprovalDecision::Approve)
        )
        .await,
        Reply::Error { .. }
    ));
    call(&engine, decide(&b, "denyB", ToolApprovalDecision::Deny)).await;
    let next = http.next().await;
    assert_eq!(next.prompt(), second_prompt);
    next.answer("denied child").await;
    assert!(f.calls().is_empty());
    call(
        &engine,
        decide(&a, "approveA", ToolApprovalDecision::Approve),
    )
    .await;
    let next = http.next().await;
    assert_eq!(next.prompt(), first_prompt);
    next.answer("executed child").await;
    let parent = http.next().await;
    parent.answer("joined").await;
    assert_eq!(agent(done(run).await).1.status, AgentStatus::Completed);
    assert_eq!(f.calls().iter().filter(|v| v[0] == "create").count(), 1);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn approved_historical_delegate_tasks_plugin_waits_without_lease_or_staging() {
    let mut f = setup();
    f.request.plugin_tools = vec![zero_protocol::agent::PluginToolBinding {
        alias: "delegate_tasks".into(),
        plugin: "fixture".into(),
        tool: "inspect".into(),
    }];
    f.request.tool_approval_policy = Some(ToolApprovalPolicy {
        require_approval: vec!["delegate_tasks".into()],
    });
    let artifact = plugin::register(&f);
    let mut http = Http::new().await;
    let engine = f.engine();
    plugin::configure(&f, &engine, &artifact);
    http.configure(&engine);
    let session = match call(&engine, Command::SessionCreatePinned { budget_limit: 100 }).await {
        Reply::Session { session } => session.id,
        r => panic!("{r:?}"),
    };
    let (run, mut events) = start_gate(engine.clone(), f.command(&session));
    http.next()
        .await
        .finish(json!([tool("plugin", "delegate_tasks", json!({}))]))
        .await;
    let r = pending(&f, &mut events).await;
    assert!(f.calls().is_empty());
    let conn = rusqlite::Connection::open(f.dir.path().join("evo.sqlite")).unwrap();
    let leases: u64 = conn
        .query_row("SELECT count(*) FROM leases", [], |r| r.get(0))
        .unwrap();
    assert_eq!(leases, 0);
    drop(conn);
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    assert!(
        store
            .events(&session, 0, 100)
            .unwrap()
            .iter()
            .all(|e| e.payload["kind"] != "plugin.preparing")
    );
    drop(store);
    call(
        &engine,
        decide(&r, "plugin-yes", ToolApprovalDecision::Approve),
    )
    .await;
    let next = http.next().await;
    assert!(next.body["input"].to_string().contains("historical_plugin"));
    next.answer("plugin result").await;
    let (parent, result, _) = agent(done(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    let calls = f.calls();
    assert_eq!(calls.iter().filter(|v| v[0] == "create").count(), 1);
    let mut request = f.request.clone();
    request.continuation_of = Some(parent.id);
    request.prompt = "continue result".into();
    let run = start(
        engine.clone(),
        Command::RunAgent {
            session_id: session.clone(),
            command_id: "continue".into(),
            request,
        },
    );
    http.next().await.answer("retained").await;
    assert_eq!(agent(joined(run).await).1.status, AgentStatus::Completed);
    assert_eq!(f.calls(), calls);
    engine.shutdown().await.unwrap();
}
