#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "web/mod.rs"]
mod support_web;
use serde_json::{Value, json};
use support_web::*;
use zero_protocol::{Command, Reply, agent::AgentStatus};
fn claim(observation: &Value) -> Value {
    json!({"title":"Fixture claim","category":"disclosure","explanation":"Response contained fixture evidence","claimed_impact":"Fixture disclosure only","claimed_severity":"low","citations":[{"operation_id":observation["operation_id"],"response_manifest_sha256":observation["response_manifest_sha256"],"part":{"type":"body","offset":0,"length":7}}]})
}
#[tokio::test]
async fn snapshot_free_web_submission_retains_citations_and_restart_never_contacts_provider_or_target()
 {
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    let first = model.next().await;
    assert!(
        !first.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["name"] == "execute_snapshot")
    );
    first
        .finish(json!([tool(
            "observation",
            "http_request",
            json!({"url":"/fixture"})
        )]))
        .await;
    let (socket, request) = receive(&listener).await;
    assert!(request.starts_with(b"POST /fixture "));
    respond(socket, 200, "X-Fixture: proof\r\n", b"fixture evidence").await;
    let next = model.next().await;
    let output = outputs(&next.body);
    assert_eq!(output[0]["observation"]["completeness"], "complete");
    let observation = output[0]["observation"].clone();
    next.finish(json!([tool(
        "submit",
        "submit_web_hypotheses",
        json!({"hypotheses":[claim(&observation)]})
    )]))
    .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed, "{:?}", result.error);
    assert_eq!(parent.payload["kind"], "scoped_web_agent");
    assert!(parent.payload["request"].get("execution").is_none());
    let review = result.web_review.unwrap();
    assert_eq!(review.review.hypotheses.len(), 1);
    assert_eq!(
        serde_json::to_value(&review.review.hypotheses[0].state).unwrap(),
        "unverified"
    );
    let (events, _) = tokio::sync::mpsc::channel(16);
    let shown = engine
        .handle(
            Command::WebRun {
                session_id: session.clone(),
                operation_id: parent.id.clone(),
            },
            events,
        )
        .await;
    assert!(matches!(shown, Reply::WebRun { .. }));
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    model.configure(&engine);
    let (retry, _, duplicate) = agent(call(&engine, f.command(&session)).await);
    assert!(duplicate);
    assert_eq!(retry.outcome, parent.outcome);
    model.quiet().await;
    quiet(&listener).await;
    assert!(f.calls().is_empty());
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn malformed_citation_and_prose_are_failed_workflows_not_clean_reports() {
    for mode in ["range", "hash", "prose", "duplicate", "refusal"] {
        let f = setup();
        let (listener, policy) = target().await;
        let mut model = Http::new().await;
        let engine = configure(&f, &policy);
        model.configure(&engine);
        let session = session(&engine, 100).await;
        let run = start(engine.clone(), f.command(&session));
        model
            .next()
            .await
            .finish(json!([tool("http", "http_request", json!({"url":"/"}))]))
            .await;
        let (socket, _) = receive(&listener).await;
        respond(socket, 200, "", b"fixture").await;
        let next = model.next().await;
        let observation = outputs(&next.body)[0]["observation"].clone();
        let mut c = claim(&observation);
        match mode {
            "range" => c["citations"][0]["part"]["offset"] = json!(u64::MAX),
            "hash" => {
                c["citations"][0]["response_manifest_sha256"] =
                    json!(format!("sha256:{}", "0".repeat(64)))
            }
            _ => {}
        }
        if mode == "prose" {
            next.answer("Everything is safe").await;
        } else {
            let mut blocks = vec![tool(
                "submit",
                "submit_web_hypotheses",
                json!({"hypotheses":[c]}),
            )];
            if mode == "duplicate" {
                blocks.push(tool("other", "http_request", json!({"url":"/extra"})));
            }
            if mode == "refusal" {
                blocks.push(json!({"type":"message","content":[{"type":"refusal","refusal":"cannot submit"}]}));
            }
            next.finish(json!(blocks)).await;
        }
        let (_, result, _) = agent(joined(run).await);
        assert_eq!(
            result.status,
            AgentStatus::Failed,
            "{mode}: {:?}",
            result.error
        );
        assert!(result.web_review.is_none());
        quiet(&listener).await;
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn empty_submission_is_explicitly_unverified_and_cannot_be_continued() {
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([tool(
            "submit",
            "submit_web_hypotheses",
            json!({"hypotheses":[]})
        )]))
        .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed, "{:?}", result.error);
    assert!(result.web_review.unwrap().review.hypotheses.is_empty());
    let mut request = f.request.clone();
    request.continuation_of = Some(parent.id);
    let (tx, _) = tokio::sync::mpsc::channel(8);
    assert!(matches!(
        engine
            .handle(
                Command::RunAgent {
                    session_id: session,
                    command_id: "no-continuation".into(),
                    request
                },
                tx
            )
            .await,
        Reply::Error { .. }
    ));
    model.quiet().await;
    quiet(&listener).await;
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn same_session_foreign_run_cannot_supply_a_citation() {
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let first = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([tool(
            "http",
            "http_request",
            json!({"url":"/foreign"})
        )]))
        .await;
    let (socket, _) = receive(&listener).await;
    respond(socket, 200, "", b"fixture").await;
    let next = model.next().await;
    let observation = outputs(&next.body)[0]["observation"].clone();
    next.finish(json!([tool(
        "submit",
        "submit_web_hypotheses",
        json!({"hypotheses":[]})
    )]))
    .await;
    assert_eq!(agent(joined(first).await).1.status, AgentStatus::Completed);
    let second = start(
        engine.clone(),
        Command::RunAgent {
            session_id: session,
            command_id: "foreign-citation".into(),
            request: f.request.clone(),
        },
    );
    model
        .next()
        .await
        .finish(json!([tool(
            "submit",
            "submit_web_hypotheses",
            json!({"hypotheses":[claim(&observation)]})
        )]))
        .await;
    let (_, result, _) = agent(joined(second).await);
    assert_eq!(result.status, AgentStatus::Failed);
    assert!(result.web_review.is_none());
    quiet(&listener).await;
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn joined_http_only_child_keeps_v2_and_can_supply_verified_retained_bytes() {
    let mut f = setup();
    f.request.delegation_policy=Some(serde_json::from_value(json!({"max_parallel":1,"max_children":1,"roles":[{"name":"investigator","provider":"fixture","model":"child","instructions":"Inspect only","description":"Inspect scoped target","tools":["http_request"],"max_turns":2,"reservation_per_turn":5}]})).unwrap());
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([delegation(vec![(
            "investigator",
            "Inspect response"
        )])]))
        .await;
    let child = model.next().await;
    assert_eq!(child.body["model"], "child");
    assert_eq!(child.body["tools"].as_array().unwrap().len(), 1);
    child
        .finish(json!([tool(
            "http",
            "http_request",
            json!({"url":"/child"})
        )]))
        .await;
    let (socket, _) = receive(&listener).await;
    respond(socket, 200, "", b"fixture").await;
    let child = model.next().await;
    let observation = outputs(&child.body)[0]["observation"].clone();
    assert_eq!(observation["completeness"], "complete");
    child.answer(&observation.to_string()).await;
    let parent = model.next().await;
    assert_eq!(parent.body["model"], "parent");
    parent
        .finish(json!([tool(
            "submit",
            "submit_web_hypotheses",
            json!({"hypotheses":[claim(&observation)]})
        )]))
        .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed, "{:?}", result.error);
    let db = f.dir.path().join("state.db");
    let report = zero_engine::read_web_run(&db, &session, &parent.id).unwrap();
    assert_eq!(report.review.unwrap().hypotheses.len(), 1);
    assert!(f.calls().is_empty());
    quiet(&listener).await;
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancellation_preserves_partial_observations_without_a_finding() {
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .finish(json!([tool(
            "http",
            "http_request",
            json!({"url":"/partial"})
        )]))
        .await;
    let (socket, _) = receive(&listener).await;
    respond(socket, 200, "", b"fixture").await;
    let held = model.next().await;
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
    assert!(result.web_review.is_none());
    drop(held);
    let db = f.dir.path().join("state.db");
    let report = zero_engine::read_web_run(&db, &session, &parent.id).unwrap();
    assert!(report.review.is_none());
    assert_eq!(
        report.operation_status,
        zero_protocol::OperationStatus::Unknown
    );
    let list = zero_engine::read_web_http_operations(&db, &session, &parent.id, 0, 32).unwrap();
    assert_eq!(list.operations.len(), 1);
    assert!(budget(&engine, &session).await.reserved > 0);
    quiet(&listener).await;
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn checkpoint_ancestry_preserves_citations_and_later_corruption_fails_readonly() {
    for projected in [false, true] {
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
        model
            .next()
            .await
            .finish(json!([tool(
                "http",
                "http_request",
                json!({"url":"/ancestor"})
            )]))
            .await;
        let (socket, _) = receive(&listener).await;
        respond(socket, 200, "", b"fixture").await;
        let (first, result, _) = agent(joined(run).await);
        assert_eq!(result.status, AgentStatus::TurnLimit);
        assert!(result.continuation_artifact.is_some());
        engine.shutdown().await.unwrap();
        drop(engine);
        let engine = configure(&f, &policy);
        model.configure(&engine);
        let mut request = f.request.clone();
        request.max_turns = 2;
        request.continuation_of = Some(first.id);
        request.prompt = "Submit retained observations".into();
        let run = start(
            engine.clone(),
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "continue-web".into(),
                request,
            },
        );
        let next = model.next().await;
        let observation = outputs(&next.body)[0]["observation"].clone();
        next.finish(json!([tool(
            "submit",
            "submit_web_hypotheses",
            json!({"hypotheses":[claim(&observation)]})
        )]))
        .await;
        let (parent, result, _) = agent(joined(run).await);
        assert_eq!(
            result.status,
            AgentStatus::Completed,
            "projected={projected}: {:?}",
            result.error
        );
        let db = f.dir.path().join("state.db");
        assert_eq!(
            zero_engine::read_web_run(&db, &session, &parent.id)
                .unwrap()
                .review
                .unwrap()
                .hypotheses
                .len(),
            1
        );
        engine.shutdown().await.unwrap();
        drop(engine);
        let store = zero_store::Store::open_read_only(&db).unwrap();
        let attachments = store.operation_artifacts(&parent.id).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute(
            "UPDATE artifacts SET bytes=?2 WHERE digest=?1",
            rusqlite::params![
                attachments["web.completion"],
                b"changed retained bytes".as_slice()
            ],
        )
        .unwrap();
        assert!(zero_engine::read_web_run(&db, &session, &parent.id).is_err());
        quiet(&listener).await;
        model.quiet().await;
    }
}
