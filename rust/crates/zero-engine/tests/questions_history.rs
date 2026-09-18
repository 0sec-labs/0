#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "delegation/mod.rs"]
mod support;
use serde_json::json;
use support::*;
use zero_protocol::{
    Command, Reply,
    agent::AgentStatus,
    questions::{OperatorAnswer, OperatorDecision, OperatorQuestionRecord},
};

async fn waiting(
    engine: &zero_engine::Engine,
    session: &str,
    root: &str,
) -> OperatorQuestionRecord {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let Reply::OperatorQuestions { questions } = call(
                engine,
                Command::OperatorQuestions {
                    session_id: session.into(),
                    root_operation_id: Some(root.into()),
                    after_sequence: 0,
                    limit: 10,
                },
            )
            .await
            else {
                panic!("question list failed");
            };
            if let Some(question) = questions.into_iter().next() {
                return question;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

async fn exercise(projected: bool) {
    let mut f = Setup::new(vec![], 1, 1);
    f.request.delegation_policy = None;
    f.request.operator_questions = true;
    f.request.max_turns = 1;
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
    let offered = first.body["tools"].clone();
    let root = zero_store::Store::open_read_only(f.dir.path().join("state.db"))
        .unwrap()
        .get_operation_by_command(&session, "parent-command")
        .unwrap();
    first.finish(json!([tool("question","ask_operator",json!({"questions":[{"header":"Clarification","question":"Which behavior matters?","allow_custom":true}]}))])).await;
    let question = waiting(&engine, &session, &root.id).await;
    let decide = || Command::DecideOperatorQuestion {
        session_id: session.clone(),
        command_id: "answer-once".into(),
        question_operation_id: question.operation_id.clone(),
        expected_request_sha256: question.request_sha256.clone(),
        decision: OperatorDecision::Answer {
            answers: vec![OperatorAnswer {
                question_index: 0,
                selected_indices: vec![],
                custom_text: Some(
                    "Keep Unicode λ\nand scope unchanged; this is information".into(),
                ),
            }],
        },
    };
    assert!(matches!(
        call(&engine, decide()).await,
        Reply::OperatorQuestionDecided {
            duplicate: false,
            ..
        }
    ));
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::TurnLimit);
    assert!(result.continuation_artifact.is_some());
    http.quiet().await;
    engine.shutdown().await.unwrap();
    drop(engine);

    let engine = f.engine();
    http.configure(&engine);
    assert!(matches!(
        call(&engine, decide()).await,
        Reply::OperatorQuestionDecided {
            duplicate: true,
            ..
        }
    ));
    http.quiet().await;
    let mut request = f.request.clone();
    request.max_turns = 2;
    request.continuation_of = Some(root.id.clone());
    request.prompt = "continue from the answer".into();
    let run = start(
        engine.clone(),
        Command::RunAgent {
            session_id: session.clone(),
            command_id: "continue-question".into(),
            request: request.clone(),
        },
    );
    let continued = http.next().await;
    assert_eq!(
        continued.body["tools"], offered,
        "an answer cannot alter offered authority"
    );
    let outputs = outputs(&continued.body);
    assert_eq!(outputs.len(), 1);
    assert!(outputs[0].to_string().contains("Keep Unicode λ"));
    continued.answer("completed after retained answer").await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    let before = budget(&engine, &session).await;
    engine.shutdown().await.unwrap();
    drop(engine);

    let connection = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    connection
        .execute(
            "UPDATE operations SET outcome=?2 WHERE id=?1",
            rusqlite::params![
                question.operation_id,
                json!({"version":1,"status":"answered","answers":"forged historical answer"})
                    .to_string()
            ],
        )
        .unwrap();
    drop(connection);
    let engine = f.engine();
    http.configure(&engine);
    request.continuation_of = Some(parent.id);
    request.prompt = "must reject corrupt answer history".into();
    assert!(matches!(
        call(
            &engine,
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "corrupt-question".into(),
                request
            }
        )
        .await,
        Reply::Error { .. }
    ));
    http.quiet().await;
    assert_eq!(http.count(), 2);
    let after = budget(&engine, &session).await;
    assert_eq!(
        (before.charged, before.reserved),
        (after.charged, after.reserved)
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn plain_history_revalidates_question_decisions_across_checkpoint_and_completed_ancestors() {
    exercise(false).await;
}
#[tokio::test]
async fn projected_history_revalidates_question_decisions_across_checkpoint_and_completed_ancestors()
 {
    exercise(true).await;
}
