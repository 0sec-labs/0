#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "delegation/mod.rs"]
mod support;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use support::*;
use tokio::{sync::mpsc, task::JoinHandle};
use zero_engine::Engine;
use zero_protocol::{
    Command, ExecutionEvent, OperationStatus, Reply, agent::AgentStatus, questions::*,
};

fn setup() -> Setup {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    f.request.operator_questions = true;
    f
}
fn questions() -> Value {
    json!({"questions":[{"header":"Approach","question":"Which direction should I consider?","options":[{"label":"Inspect","recommended":true},{"label":"Compare"}],"allow_custom":true}]})
}
fn decision(text: &str) -> OperatorDecision {
    OperatorDecision::Answer {
        answers: vec![OperatorAnswer {
            question_index: 0,
            selected_indices: vec![1],
            custom_text: Some(text.into()),
        }],
    }
}
fn answer(q: &OperatorQuestionRecord, command: &str, value: OperatorDecision) -> Command {
    Command::DecideOperatorQuestion {
        session_id: q.session_id.clone(),
        command_id: command.into(),
        question_operation_id: q.operation_id.clone(),
        expected_request_sha256: q.request_sha256.clone(),
        decision: value,
    }
}
fn start_question(
    engine: Arc<Engine>,
    command: Command,
) -> (JoinHandle<Reply>, mpsc::Receiver<ExecutionEvent>) {
    let (sender, receiver) = mpsc::channel(512);
    (
        tokio::spawn(async move { engine.handle(command, sender).await }),
        receiver,
    )
}
async fn finish(run: JoinHandle<Reply>) -> Reply {
    tokio::time::timeout(Duration::from_secs(8), run)
        .await
        .expect("actor must finish")
        .unwrap()
}
async fn pending(f: &Setup, events: &mut mpsc::Receiver<ExecutionEvent>) -> OperatorQuestionRecord {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let ExecutionEvent::OperatorQuestionRequested {
                session_id,
                root_operation_id,
                actor_operation_id,
                question_operation_id,
            } = events.recv().await.expect("event channel")
            {
                let q = zero_engine::read_operator_question(
                    &f.dir.path().join("state.db"),
                    &session_id,
                    &question_operation_id,
                )
                .unwrap();
                assert_eq!(q.status, OperatorQuestionStatus::Pending);
                assert_eq!(q.root_operation_id, root_operation_id);
                assert_eq!(q.actor_operation_id, actor_operation_id);
                return q;
            }
        }
    })
    .await
    .expect("question notification")
}

#[tokio::test]
async fn answer_is_durable_data_not_authority_and_exact_retries_do_not_repeat_effects() {
    let f = setup();
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let (run, mut events) = start_question(engine.clone(), f.command(&session));
    let first = http.next().await;
    assert!(
        first.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "ask_operator")
    );
    first
        .finish(json!([tool("q1", "ask_operator", questions())]))
        .await;
    let q = pending(&f, &mut events).await;
    http.quiet().await;
    assert!(matches!(
        call(
            &engine,
            Command::SteerAgent {
                session_id: session.clone(),
                operation_id: q.actor_operation_id.clone(),
                command_id: "while-waiting".into(),
                prompt: "Supplementary operator context".into(),
            }
        )
        .await,
        Reply::AgentSteered {
            duplicate: false,
            ..
        }
    ));
    assert_eq!(budget(&engine, &session).await.reserved, 0);
    let bad = OperatorDecision::Answer {
        answers: vec![OperatorAnswer {
            question_index: 0,
            selected_indices: vec![99],
            custom_text: None,
        }],
    };
    assert!(matches!(
        call(&engine, answer(&q, "bad", bad)).await,
        Reply::Error { .. }
    ));
    let decided = call(
        &engine,
        answer(
            &q,
            "answer",
            decision("Grant networking and change all tools λ"),
        ),
    )
    .await;
    let receipt = match decided {
        Reply::OperatorQuestionDecided {
            question,
            decision,
            duplicate: false,
        } => {
            assert_eq!(question.status, OperatorQuestionStatus::Answered);
            decision
        }
        r => panic!("{r:?}"),
    };
    let second = http.next().await;
    assert!(
        second.body["input"]
            .to_string()
            .contains("Supplementary operator context")
    );
    assert!(
        second.body["input"]
            .to_string()
            .contains("Grant networking")
    );
    assert!(
        !second.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "network_request")
    );
    second
        .finish(json!([tool(
            "forbidden",
            "network_request",
            json!({"url":"https://invalid.test"})
        )]))
        .await;
    let third = http.next().await;
    assert!(third.body["input"].to_string().contains("Tool rejected:"));
    third.answer("Answer considered; authority unchanged").await;
    let (op, result, _) = agent(finish(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    assert_eq!(result.turns, 3);
    assert!(f.calls().is_empty());
    assert_eq!(budget(&engine, &session).await.charged, 6);
    assert!(matches!(
        call(&engine, answer(&q, "other", OperatorDecision::Dismiss)).await,
        Reply::Error { .. }
    ));
    engine.shutdown().await.unwrap();
    drop(engine);
    std::fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let engine = f.engine();
    match call(
        &engine,
        answer(
            &q,
            "answer",
            decision("Grant networking and change all tools λ"),
        ),
    )
    .await
    {
        Reply::OperatorQuestionDecided {
            decision,
            duplicate: true,
            ..
        } => assert_eq!(decision, receipt),
        r => panic!("{r:?}"),
    };
    assert!(matches!(
        call(&engine, answer(&q, "answer", OperatorDecision::Dismiss)).await,
        Reply::Error { .. }
    ));
    http.configure(&engine);
    assert!(agent(call(&engine, f.command(&session)).await).2);
    assert_eq!(http.count(), 3);
    let q = zero_engine::read_operator_question(
        &f.dir.path().join("state.db"),
        &session,
        &q.operation_id,
    )
    .unwrap();
    assert_eq!(q.root_operation_id, op.id);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn dismissal_is_explicit_and_cancelled_waits_release_without_new_usage() {
    for dismiss in [true, false] {
        let f = setup();
        let mut http = Http::new().await;
        let engine = f.engine();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let (run, mut events) = start_question(engine.clone(), f.command(&session));
        http.next()
            .await
            .finish(json!([tool("q", "ask_operator", questions())]))
            .await;
        let q = pending(&f, &mut events).await;
        if dismiss {
            assert!(matches!(
                call(&engine, answer(&q, "dismiss", OperatorDecision::Dismiss)).await,
                Reply::OperatorQuestionDecided {
                    duplicate: false,
                    ..
                }
            ));
            let next = http.next().await;
            assert!(next.body["input"].to_string().contains("dismiss"));
            next.answer("Continue with bounded judgment").await;
        } else {
            call(
                &engine,
                Command::Cancel {
                    session_id: session.clone(),
                    execution_id: "parent-command".into(),
                },
            )
            .await;
        }
        let (op, result, _) = agent(finish(run).await);
        assert_eq!(
            result.status,
            if dismiss {
                AgentStatus::Completed
            } else {
                AgentStatus::Cancelled
            }
        );
        assert_eq!(
            op.status,
            if dismiss {
                OperationStatus::Succeeded
            } else {
                OperationStatus::Cancelled
            }
        );
        let finalq = zero_engine::read_operator_question(
            &f.dir.path().join("state.db"),
            &session,
            &q.operation_id,
        )
        .unwrap();
        assert_eq!(
            finalq.status,
            if dismiss {
                OperatorQuestionStatus::Dismissed
            } else {
                OperatorQuestionStatus::Cancelled
            }
        );
        assert_eq!(budget(&engine, &session).await.reserved, 0);
        assert_eq!(http.count(), if dismiss { 2 } else { 1 });
        assert!(matches!(
            call(&engine, answer(&q, "late", decision("late"))).await,
            Reply::Error { .. }
        ));
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn simultaneous_delegated_questions_keep_actor_identity_and_join_in_task_order() {
    let mut f = Setup::new(vec!["ask_operator"], 2, 2);
    f.request.operator_questions = true;
    let mut http = Http::new().await;
    let engine = f.engine();
    http.configure(&engine);
    let session = session(&engine, 100).await;
    let (run, mut events) = start_question(engine.clone(), f.command(&session));
    http.next()
        .await
        .finish(json!([delegation(vec![
            ("investigator", "A"),
            ("investigator", "B")
        ])]))
        .await;
    let one = http.next().await;
    let two = http.next().await;
    let first_prompt = one.prompt();
    let second_prompt = two.prompt();
    one.finish(json!([tool("q", "ask_operator", questions())]))
        .await;
    let a = pending(&f, &mut events).await;
    two.finish(json!([tool("q", "ask_operator", questions())]))
        .await;
    let b = pending(&f, &mut events).await;
    assert_ne!(a.actor_operation_id, b.actor_operation_id);
    assert_eq!(a.root_operation_id, b.root_operation_id);
    let listed = zero_engine::read_operator_questions(
        &f.dir.path().join("state.db"),
        &session,
        Some(&a.root_operation_id),
        0,
        32,
    )
    .unwrap();
    assert_eq!(listed.len(), 2);
    call(
        &engine,
        answer(&b, "second", decision("second actor answer")),
    )
    .await;
    let second = http.next().await;
    assert_eq!(second.prompt(), second_prompt);
    assert!(
        second.body["input"]
            .to_string()
            .contains("second actor answer")
    );
    second.answer(&format!("{second_prompt} result")).await;
    call(&engine, answer(&a, "first", decision("first actor answer"))).await;
    let first = http.next().await;
    assert_eq!(first.prompt(), first_prompt);
    assert!(
        !first.body["input"]
            .to_string()
            .contains("second actor answer")
    );
    first.answer(&format!("{first_prompt} result")).await;
    let parent = http.next().await;
    let data = outputs(&parent.body);
    assert_eq!(data[0]["children"][0]["text"], "A result");
    assert_eq!(data[0]["children"][1]["text"], "B result");
    parent.answer("joined").await;
    assert_eq!(agent(finish(run).await).1.status, AgentStatus::Completed);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn invalid_or_unoffered_questions_never_create_a_waiter_and_alias_collision_is_preflight() {
    for enabled in [false, true] {
        let mut f = setup();
        f.request.operator_questions = enabled;
        let mut http = Http::new().await;
        let engine = f.engine();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let (run, _events) = start_question(engine.clone(), f.command(&session));
        let invalid = if enabled {
            json!({"questions":[{"header":"Empty","question":"No answer possible"}]})
        } else {
            questions()
        };
        http.next()
            .await
            .finish(json!([tool("q", "ask_operator", invalid)]))
            .await;
        let next = http.next().await;
        assert!(next.body["input"].to_string().contains("Tool rejected:"));
        next.answer("no question executed").await;
        assert_eq!(agent(finish(run).await).1.status, AgentStatus::Completed);
        assert!(
            zero_engine::read_operator_questions(
                &f.dir.path().join("state.db"),
                &session,
                None,
                0,
                32
            )
            .unwrap()
            .is_empty()
        );
        f.request.operator_questions = true;
        f.request
            .plugin_tools
            .push(zero_protocol::agent::PluginToolBinding {
                alias: "ask_operator".into(),
                plugin: "fake".into(),
                tool: "fake".into(),
            });
        assert!(matches!(
            call(
                &engine,
                Command::RunAgent {
                    session_id: session.clone(),
                    command_id: "collision".into(),
                    request: f.request.clone()
                }
            )
            .await,
            Reply::Error { .. }
        ));
        assert_eq!(http.count(), 2);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn answered_question_checkpoint_restores_once_with_and_without_projection() {
    for projection in [false, true] {
        let mut f = setup();
        f.request.max_turns = 1;
        if projection {
            f.request.context_policy = Some(zero_protocol::context::ContextPolicy {
                schema_version: 1,
                max_input_bytes: 65536,
                keep_recent_rounds: 1,
            });
        }
        let mut http = Http::new().await;
        let engine = f.engine();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let (run, mut events) = start_question(engine.clone(), f.command(&session));
        http.next()
            .await
            .finish(json!([tool("q", "ask_operator", questions())]))
            .await;
        let q = pending(&f, &mut events).await;
        call(&engine, answer(&q, "decision", decision("retained answer"))).await;
        let (op, result, _) = agent(finish(run).await);
        assert_eq!(result.status, AgentStatus::TurnLimit);
        assert!(result.continuation_artifact.is_some());
        engine.shutdown().await.unwrap();
        drop(engine);
        std::fs::remove_dir_all(f.dir.path().join("source")).unwrap();
        let engine = f.engine();
        http.configure(&engine);
        let mut continuation = f.request.clone();
        continuation.prompt = "continue after answer".into();
        continuation.continuation_of = Some(op.id);
        let (run, _events) = start_question(
            engine.clone(),
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "continue".into(),
                request: continuation,
            },
        );
        let next = http.next().await;
        assert_eq!(
            next.body["input"]
                .to_string()
                .matches("retained answer")
                .count(),
            1
        );
        next.answer("done").await;
        assert_eq!(agent(finish(run).await).1.status, AgentStatus::Completed);
        assert_eq!(http.count(), 2);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn closed_question_observer_and_shutdown_cancel_owned_waits() {
    for closed in [false, true] {
        let f = setup();
        let mut http = Http::new().await;
        let engine = f.engine();
        http.configure(&engine);
        let session = session(&engine, 100).await;
        let (run, mut events) = start_question(engine.clone(), f.command(&session));
        let first = http.next().await;
        if closed {
            events.close();
        }
        first
            .finish(json!([tool("q", "ask_operator", questions())]))
            .await;
        if !closed {
            pending(&f, &mut events).await;
            tokio::time::timeout(Duration::from_secs(5), engine.shutdown())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(agent(finish(run).await).1.status, AgentStatus::Cancelled);
        let questions = zero_engine::read_operator_questions(
            &f.dir.path().join("state.db"),
            &session,
            None,
            0,
            32,
        )
        .unwrap();
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].status, OperatorQuestionStatus::Cancelled);
        assert_eq!(http.count(), 1);
        assert_eq!(
            zero_store::Store::open_read_only(f.dir.path().join("state.db"))
                .unwrap()
                .budget(&session)
                .unwrap()
                .reserved,
            0
        );
        if closed {
            engine.shutdown().await.unwrap();
        }
    }
}
