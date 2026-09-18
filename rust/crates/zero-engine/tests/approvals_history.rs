#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "delegation/mod.rs"]
mod support;
use serde_json::json;
use support::*;
use zero_protocol::{
    Command, Reply,
    agent::AgentStatus,
    approvals::{ToolApprovalDecision, ToolApprovalRecord, ToolApprovalStatus},
};

async fn pending(engine: &zero_engine::Engine, session: &str, root: &str) -> ToolApprovalRecord {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match call(
                engine,
                Command::ToolApprovals {
                    session_id: session.into(),
                    root_operation_id: Some(root.into()),
                    after_sequence: 0,
                    limit: 10,
                },
            )
            .await
            {
                Reply::ToolApprovals { approvals } if !approvals.is_empty() => {
                    return approvals[0].clone();
                }
                Reply::ToolApprovals { .. } => {}
                other => panic!("approval list failed: {other:?}"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

async fn exercise(projected: bool, approve: bool) {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    f.request.max_turns = 1;
    if let zero_protocol::agent::AgentExecution::Docker(execution) = &mut f.request.execution {
        execution.image = format!("sha256:{}", "a".repeat(64));
    }
    f.request.tool_approval_policy =
        Some(serde_json::from_value(json!({"require_approval":["execute_snapshot"]})).unwrap());
    if projected {
        f.request.context_policy = Some(
            serde_json::from_value(
                json!({"schema_version":1,"max_input_bytes":32768,"keep_recent_rounds":1}),
            )
            .unwrap(),
        );
    }
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    let first = http.next().await;
    let tools = first.body["tools"].clone();
    let root = zero_store::Store::open_read_only(f.dir.path().join("state.db"))
        .unwrap()
        .get_operation_by_command(&session, "parent-command")
        .unwrap();
    first
        .finish(json!([tool(
            "effect",
            "execute_snapshot",
            json!({"argv":["echo","approved-once"]})
        )]))
        .await;
    let approval = pending(&engine, &session, &root.id).await;
    assert_eq!(approval.status, ToolApprovalStatus::Pending);
    assert!(
        f.calls().is_empty(),
        "permission must precede backend activity"
    );
    let decide = || Command::DecideToolApproval {
        session_id: session.clone(),
        command_id: "decision-once".into(),
        approval_operation_id: approval.operation_id.clone(),
        expected_intent_sha256: approval.intent_sha256.clone(),
        decision: if approve {
            ToolApprovalDecision::Approve
        } else {
            ToolApprovalDecision::Deny
        },
    };
    assert!(matches!(
        call(&engine, decide()).await,
        Reply::ToolApprovalDecided {
            duplicate: false,
            ..
        }
    ));
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::TurnLimit);
    assert!(result.continuation_artifact.is_some());
    let saved = pending(&engine, &session, &root.id).await;
    assert_eq!(
        saved.status,
        if approve {
            ToolApprovalStatus::Consumed
        } else {
            ToolApprovalStatus::Denied
        }
    );
    assert_eq!(saved.consumption.is_some(), approve);
    let effects = f.calls();
    assert_eq!(
        effects.iter().filter(|v| v[0] == "create").count(),
        usize::from(approve)
    );
    http.quiet().await;
    engine.shutdown().await.unwrap();
    drop(engine);

    let engine = f.engine();
    http.configure(&engine);
    assert!(matches!(
        call(&engine, decide()).await,
        Reply::ToolApprovalDecided {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(f.calls(), effects);
    let mut request = f.request.clone();
    request.max_turns = 2;
    request.continuation_of = Some(root.id.clone());
    request.prompt = "continue from retained decision".into();
    let mut weakened = request.clone();
    weakened.tool_approval_policy = None;
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "removed-policy".into(),
                request: weakened,
            }
        )
        .await,
        Reply::Error { .. }
    ));
    http.quiet().await;
    let run = start(
        engine.clone(),
        Command::RunAgent {
            session_id: session.clone(),
            command_id: "continue-approved".into(),
            request: request.clone(),
        },
    );
    let continued = http.next().await;
    assert_eq!(continued.body["tools"], tools);
    let replay = outputs(&continued.body);
    assert_eq!(replay.len(), 1);
    if approve {
        assert!(replay[0].to_string().contains("child fixture output"));
    } else {
        assert!(replay[0].to_string().contains("Tool rejected:"));
    }
    continued
        .answer("finished with retained tool receipt")
        .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    assert_eq!(
        f.calls(),
        effects,
        "continuation cannot consume approval again"
    );
    let before = budget(&engine, &session).await;
    engine.shutdown().await.unwrap();
    drop(engine);

    let connection = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    if let Some(consumed) = saved.consumption {
        connection.execute("UPDATE operations SET payload=json_set(payload,'$.request.argv[0]','forged-command') WHERE id=?1", [&consumed.effect_operation_id]).unwrap();
    } else {
        connection
            .execute(
                "UPDATE operations SET outcome=?2 WHERE id=?1",
                rusqlite::params![
                    approval.operation_id,
                    json!({"forged":"approval granted"}).to_string()
                ],
            )
            .unwrap();
    }
    drop(connection);
    let engine = f.engine();
    http.configure(&engine);
    request.continuation_of = Some(parent.id);
    request.prompt = "must reject changed effect or decision evidence".into();
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "corrupt-approval".into(),
                request,
            }
        )
        .await,
        Reply::Error { .. }
    ));
    http.quiet().await;
    assert_eq!(http.count(), 2);
    assert_eq!(f.calls(), effects);
    let after = budget(&engine, &session).await;
    assert_eq!(
        (before.charged, before.reserved),
        (after.charged, after.reserved)
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn approved_effect_plain_history_survives_restart_and_rejects_changed_child() {
    exercise(false, true).await;
}
#[tokio::test]
async fn approved_effect_projected_history_survives_restart_and_rejects_changed_child() {
    exercise(true, true).await;
}
#[tokio::test]
async fn denied_effect_plain_history_is_retained_without_dispatch() {
    exercise(false, false).await;
}
#[tokio::test]
async fn denied_effect_projected_history_is_retained_without_dispatch() {
    exercise(true, false).await;
}
