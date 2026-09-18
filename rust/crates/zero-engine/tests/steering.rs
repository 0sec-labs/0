#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "delegation/mod.rs"]
mod support;
use serde_json::{Value, json};
use support::*;
use zero_protocol::{
    Command, OperationStatus, Reply, agent::AgentStatus, steering::AgentSteeringStatus,
};

fn operation(f: &Setup, session: &str, command: &str) -> zero_protocol::Operation {
    zero_store::Store::open_read_only(f.dir.path().join("state.db"))
        .unwrap()
        .get_operation_by_command(session, command)
        .unwrap()
}
fn steer(session: &str, operation: &str, command: &str, prompt: &str) -> Command {
    Command::SteerAgent {
        session_id: session.into(),
        operation_id: operation.into(),
        command_id: command.into(),
        prompt: prompt.into(),
    }
}
async fn accepted(
    engine: &zero_engine::Engine,
    command: Command,
) -> zero_protocol::steering::AgentSteeringMessage {
    match call(engine, command).await {
        Reply::AgentSteered {
            message,
            duplicate: false,
        } => message,
        other => panic!("{other:?}"),
    }
}
fn users(body: &Value) -> Vec<String> {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["role"] == "user")
        .map(|item| item["content"].as_str().unwrap().into())
        .collect()
}

#[tokio::test]
async fn held_final_answers_service_fifo_without_extending_turn_cap_and_retry_is_inert() {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    let first = http.next().await;
    let root = operation(&f, &session, "parent-command");
    let a = accepted(&engine, steer(&session, &root.id, "a", "first λ")).await;
    let b = accepted(&engine, steer(&session, &root.id, "b", "second\nline")).await;
    assert_eq!(a.status, AgentSteeringStatus::Pending);
    assert!(a.sequence < b.sequence);
    http.quiet().await;
    first.answer("premature answer").await;
    let second = http.next().await;
    assert_eq!(
        users(&second.body),
        vec!["parent prompt", "first λ", "second\nline"]
    );
    assert!(
        second.body["input"]
            .to_string()
            .contains("premature answer")
    );
    let captured =
        zero_engine::read_agent_steering(&f.dir.path().join("state.db"), &session, &root.id, 0, 32)
            .unwrap();
    assert!(
        captured
            .iter()
            .all(|m| m.status == AgentSteeringStatus::Captured)
    );
    assert_eq!(
        captured[0].inference_operation_id,
        captured[1].inference_operation_id
    );
    accepted(&engine, steer(&session, &root.id, "c", "third direction")).await;
    second.answer("second premature answer").await;
    let third = http.next().await;
    assert_eq!(users(&third.body).last().unwrap(), "third direction");
    accepted(
        &engine,
        steer(&session, &root.id, "d", "turn budget exhausted"),
    )
    .await;
    third.answer("final within original cap").await;
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    assert_eq!(result.turns, 3);
    let messages =
        zero_engine::read_agent_steering(&f.dir.path().join("state.db"), &session, &root.id, 0, 32)
            .unwrap();
    assert_eq!(messages[3].status, AgentSteeringStatus::Undelivered);
    assert!(messages[3].inference_operation_id.is_none());
    assert!(matches!(
        call(&engine, steer(&session, &root.id, "late", "too late")).await,
        Reply::Error { .. }
    ));
    assert!(matches!(
        call(&engine, steer(&session, &root.id, "a", "changed")).await,
        Reply::Error { .. }
    ));
    assert_eq!(budget(&engine, &session).await.charged, 6);
    engine.shutdown().await.unwrap();
    drop(engine);
    std::fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let engine = f.engine();
    match call(
        &engine,
        steer(&session, &root.id, "d", "turn budget exhausted"),
    )
    .await
    {
        Reply::AgentSteered {
            message,
            duplicate: true,
        } => assert_eq!(message.status, AgentSteeringStatus::Undelivered),
        other => panic!("{other:?}"),
    }
    http.configure(&engine);
    assert!(agent(call(&engine, f.command(&session)).await).2);
    assert_eq!(http.count(), 3);
    assert!(f.calls().is_empty());
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn delegated_targeting_does_not_steer_pending_or_sibling_actors_and_group_replay_survives() {
    let f = Setup::new(vec![], 2, 1);
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    http.next()
        .await
        .finish(json!([delegation(vec![
            ("investigator", "A"),
            ("investigator", "B")
        ])]))
        .await;
    let child = http.next().await;
    assert_eq!(child.prompt(), "A");
    let root = operation(&f, &session, "parent-command");
    let a = operation(&f, &session, &format!("{}:tool:0:0:agent:0", root.id));
    let b = operation(&f, &session, &format!("{}:tool:0:0:agent:1", root.id));
    assert!(matches!(
        call(
            &engine,
            steer(&session, &b.id, "pending", "do not start early")
        )
        .await,
        Reply::Error { .. }
    ));
    accepted(
        &engine,
        steer(&session, &a.id, "child", "child-only direction"),
    )
    .await;
    accepted(
        &engine,
        steer(&session, &root.id, "root", "root-only direction"),
    )
    .await;
    child.answer("A initial answer").await;
    let revised = http.next().await;
    assert_eq!(users(&revised.body), vec!["A", "child-only direction"]);
    revised.answer("A revised").await;
    let sibling = http.next().await;
    assert_eq!(users(&sibling.body), vec!["B"]);
    sibling.answer("B done").await;
    let parent = http.next().await;
    assert_eq!(
        users(&parent.body),
        vec!["parent prompt", "root-only direction"]
    );
    assert!(parent.body["input"].to_string().contains("A revised"));
    parent.answer("joined final").await;
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    let mut next = f.request.clone();
    next.continuation_of = Some(root.id);
    next.prompt = "continue saved group".into();
    let run = start(
        engine.clone(),
        Command::RunAgent {
            session_id: session.clone(),
            command_id: "continue".into(),
            request: next,
        },
    );
    let request = http.next().await;
    assert_eq!(
        users(&request.body),
        vec![
            "parent prompt",
            "root-only direction",
            "continue saved group"
        ]
    );
    request.answer("continuation verified").await;
    assert_eq!(agent(joined(run).await).1.status, AgentStatus::Completed);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_actor_leaves_uncaptured_intent_visible_and_never_releases_uncertain_usage() {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    let held = http.next().await;
    let root = operation(&f, &session, "parent-command");
    accepted(&engine, steer(&session, &root.id, "steer", "not yet read")).await;
    assert!(matches!(
        call(
            &engine,
            Command::Cancel {
                session_id: session.clone(),
                execution_id: "parent-command".into()
            }
        )
        .await,
        Reply::Cancelled { accepted: true, .. }
    ));
    let (operation, result, _) = agent(joined(run).await);
    drop(held);
    assert_eq!(operation.status, OperationStatus::Unknown);
    assert_eq!(result.status, AgentStatus::Unknown);
    let budget = budget(&engine, &session).await;
    assert_eq!((budget.charged, budget.reserved), (0, 5));
    let messages =
        zero_engine::read_agent_steering(&f.dir.path().join("state.db"), &session, &root.id, 0, 32)
            .unwrap();
    assert_eq!(messages[0].status, AgentSteeringStatus::Undelivered);
    assert_eq!(http.count(), 1);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn source_submission_retains_original_question_and_exact_supplementary_operator_input() {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    f.request.source_snapshot_tools = true;
    f.request.source_submission_max_hypotheses = Some(2);
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    let first = http.next().await;
    let root = operation(&f, &session, "parent-command");
    accepted(
        &engine,
        steer(
            &session,
            &root.id,
            "supplement",
            "Pay attention to the first line",
        ),
    )
    .await;
    first
        .finish(json!([tool(
            "read",
            "read_source_lines",
            json!({"path":"file.txt","start_line":1,"end_line":1})
        )]))
        .await;
    let submit = http.next().await;
    assert_eq!(
        users(&submit.body),
        vec!["parent prompt", "Pay attention to the first line"]
    );
    submit
        .finish(json!([tool(
            "submit",
            "submit_source_hypotheses",
            json!({"selected_files":["file.txt"],"hypotheses":[]})
        )]))
        .await;
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed, "{result:?}");
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    let bundle = zero_source::SourceBundle::from_bytes(
        &store
            .artifact(&result.source_review.unwrap().artifacts["source.bundle"])
            .unwrap(),
    )
    .unwrap();
    assert_eq!(bundle.question(), "parent prompt");
    assert!(
        zero_engine::read_source_report(&f.dir.path().join("state.db"), &session, &root.id)
            .unwrap()
            .review
            .hypotheses
            .is_empty()
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn protected_context_and_tool_checkpoint_restore_steering_once_without_replaying_effects() {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    f.request.max_turns = 2;
    f.request.context_policy = Some(zero_protocol::context::ContextPolicy {
        schema_version: 1,
        max_input_bytes: 65536,
        keep_recent_rounds: 1,
    });
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    let first = http.next().await;
    let root = operation(&f, &session, "parent-command");
    accepted(
        &engine,
        steer(
            &session,
            &root.id,
            "protected",
            "Keep this operator instruction verbatim λ",
        ),
    )
    .await;
    first
        .finish(json!([tool(
            "execute",
            "execute_snapshot",
            json!({"argv":["fixture"]})
        )]))
        .await;
    let second = http.next().await;
    assert_eq!(
        users(&second.body),
        vec!["parent prompt", "Keep this operator instruction verbatim λ"]
    );
    second
        .finish(json!([tool("denied", "unknown_tool", json!({}))]))
        .await;
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::TurnLimit, "{result:?}");
    assert!(result.continuation_artifact.is_some());
    let calls = f.calls();
    assert_eq!(calls.iter().filter(|c| c[0] == "create").count(), 1);
    engine.shutdown().await.unwrap();
    drop(engine);
    std::fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let engine = f.engine();
    http.configure(&engine);
    let mut next = f.request.clone();
    next.continuation_of = Some(root.id);
    next.prompt = "Resume exact checkpoint".into();
    next.max_turns = 1;
    let run = start(
        engine.clone(),
        Command::RunAgent {
            session_id: session.clone(),
            command_id: "continued".into(),
            request: next,
        },
    );
    let resumed = http.next().await;
    assert_eq!(
        users(&resumed.body),
        vec![
            "parent prompt",
            "Keep this operator instruction verbatim λ",
            "Resume exact checkpoint"
        ]
    );
    assert!(resumed.body["input"].to_string().contains("Tool rejected:"));
    resumed.answer("resumed without repeating tool").await;
    assert_eq!(agent(joined(run).await).1.status, AgentStatus::Completed);
    assert_eq!(f.calls(), calls);
    engine.shutdown().await.unwrap();
}
