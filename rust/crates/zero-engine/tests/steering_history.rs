#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "delegation/mod.rs"]
mod support;
use serde_json::Value;
use support::*;
use zero_protocol::{Command, Reply, agent::AgentStatus};

#[tokio::test]
async fn earlier_steering_survives_plain_history_restart_and_corruption_blocks_new_effects() {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&s));
    let first = http.next().await;
    let root = zero_store::Store::open_read_only(f.dir.path().join("state.db"))
        .unwrap()
        .get_operation_by_command(&s, "parent-command")
        .unwrap();
    {
        assert!(matches!(
            call(
                &engine,
                Command::SteerAgent {
                    session_id: s.clone(),
                    operation_id: root.id.clone(),
                    command_id: "steer-one".into(),
                    prompt: "preserve this first correction".into()
                }
            )
            .await,
            Reply::AgentSteered {
                duplicate: false,
                ..
            }
        ));
        first.answer("first provisional answer").await;
    }
    let second = http.next().await;
    assert_eq!(second.prompt(), "preserve this first correction");
    assert!(matches!(
        call(
            &engine,
            Command::SteerAgent {
                session_id: s.clone(),
                operation_id: root.id.clone(),
                command_id: "steer-two".into(),
                prompt: "second correction".into()
            }
        )
        .await,
        Reply::AgentSteered { .. }
    ));
    second.answer("second provisional answer").await;
    let third = http.next().await;
    assert_eq!(third.prompt(), "second correction");
    third.answer("completed after both corrections").await;
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    assert_eq!(result.turns, 3);
    engine.shutdown().await.unwrap();
    drop(engine);

    let engine = f.engine();
    http.configure(&engine);
    let mut request = f.request.clone();
    request.continuation_of = Some(root.id.clone());
    request.prompt = "next conversation turn".into();
    let run = start(
        engine.clone(),
        Command::RunAgent {
            session_id: s.clone(),
            command_id: "continued".into(),
            request: request.clone(),
        },
    );
    let resumed = http.next().await;
    let users: Vec<_> = resumed.body["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["role"] == "user")
        .map(|v| v["content"].as_str().unwrap())
        .collect();
    assert_eq!(
        users,
        [
            "parent prompt",
            "preserve this first correction",
            "second correction",
            "next conversation turn"
        ]
    );
    resumed.answer("continued once").await;
    let (continued, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    let before = budget(&engine, &s).await;
    engine.shutdown().await.unwrap();
    drop(engine);

    // A later continuation also retains the original ancestor's captured route
    // and rates, not just equal AgentRequest fields and user-message bytes.
    for field in ["endpoint", "rates"] {
        let conn = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
        let original: String = conn
            .query_row(
                "SELECT payload FROM operations WHERE id=?1",
                [&root.id],
                |r| r.get(0),
            )
            .unwrap();
        let mut altered: Value = serde_json::from_str(&original).unwrap();
        altered[field] = serde_json::json!("changed captured authority");
        conn.execute(
            "UPDATE operations SET payload=?2 WHERE id=?1",
            rusqlite::params![root.id, serde_json::to_string(&altered).unwrap()],
        )
        .unwrap();
        drop(conn);
        let engine = f.engine();
        http.configure(&engine);
        let mut next = request.clone();
        next.continuation_of = Some(continued.id.clone());
        assert!(matches!(
            call(
                &engine,
                Command::RunAgent {
                    session_id: s.clone(),
                    command_id: format!("bad-ancestor-{field}"),
                    request: next
                }
            )
            .await,
            Reply::Error { .. }
        ));
        http.quiet().await;
        engine.shutdown().await.unwrap();
        drop(engine);
        let conn = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
        conn.execute(
            "UPDATE operations SET payload=?2 WHERE id=?1",
            rusqlite::params![root.id, original],
        )
        .unwrap();
    }

    // Remove an earlier captured input only from the later ancestor's full model
    // request. Its immediate steering suffix is empty, so suffix-only checking
    // would miss the loss. Keep the rest of the retained record intact.
    let conn = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    let command = format!("{}:model:0", continued.id);
    let text: String = conn
        .query_row(
            "SELECT payload FROM operations WHERE session_id=?1 AND command_id=?2",
            rusqlite::params![s, command],
            |r| r.get(0),
        )
        .unwrap();
    let mut payload: Value = serde_json::from_str(&text).unwrap();
    payload["request"]["input"]
        .as_array_mut()
        .unwrap()
        .retain(|v| v["content"] != "preserve this first correction");
    conn.execute(
        "UPDATE operations SET payload=?3 WHERE session_id=?1 AND command_id=?2",
        rusqlite::params![s, command, serde_json::to_string(&payload).unwrap()],
    )
    .unwrap();
    drop(conn);
    let engine = f.engine();
    http.configure(&engine);
    request.continuation_of = Some(continued.id);
    request.prompt = "must fail before a new request".into();
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: s.clone(),
                command_id: "corrupt-continuation".into(),
                request
            }
        )
        .await,
        Reply::Error { .. }
    ));
    http.quiet().await;
    let after = budget(&engine, &s).await;
    assert_eq!(
        (before.charged, before.reserved),
        (after.charged, after.reserved)
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn ordinary_conversation_retains_more_than_one_operations_turn_limit_of_ancestors() {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    f.request.max_turns = 1;
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let s = session(&engine, 100).await;
    let mut previous = None;
    for index in 0..34 {
        let mut request = f.request.clone();
        request.continuation_of = previous;
        request.prompt = format!("conversation prompt {index}");
        let run = start(
            engine.clone(),
            Command::RunAgent {
                session_id: s.clone(),
                command_id: format!("conversation-{index}"),
                request,
            },
        );
        let held = http.next().await;
        assert_eq!(
            held.body["input"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|v| v["role"] == "user")
                .count(),
            index + 1
        );
        held.answer("short answer").await;
        let (operation, result, _) = agent(joined(run).await);
        assert_eq!(result.status, AgentStatus::Completed);
        previous = Some(operation.id);
    }
    assert_eq!(http.count(), 34);
    engine.shutdown().await.unwrap();
}
