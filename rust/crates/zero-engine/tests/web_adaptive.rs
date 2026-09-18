#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "web/mod.rs"]
mod web;
use serde_json::{Value, json};
use web::*;
use zero_protocol::{Command, Reply, agent::AgentStatus, web_experiment::WebExperimentPolicy};
fn setup_adaptive() -> Setup {
    let mut f = setup();
    f.request.web_experiment_policy = Some(WebExperimentPolicy {
        schema_version: 1,
        max_experiments: 2,
        max_cases: 2,
        max_repeats: 2,
    });
    f.request.max_turns = 6;
    f
}
fn hash(b: &[u8]) -> String {
    format!("sha256:{}", zero_plugin::sha256(b))
}
fn proposal(attack: &[u8]) -> Value {
    json!({"hypothesis":{"title":"Provisional model conjecture","explanation":"Compare the fixture routes without claiming a security conclusion"},"purpose":"Try a model prediction against fresh responses","cases":[{"name":"attack","role":"attack","request":{"url":"/attack"},"expected":{"status":200,"body_sha256":hash(attack)}},{"name":"control","role":"legitimate_control","request":{"url":"/control"},"expected":{"status":200,"body_sha256":hash(b"control")}}],"repeats":2})
}
async fn matrix(listener: &tokio::net::TcpListener) {
    for route in ["attack", "control", "attack", "control"] {
        let (socket, request) = receive(listener).await;
        assert!(String::from_utf8_lossy(&request).starts_with(&format!("POST /{route} ")));
        respond(socket, 200, "", route.as_bytes()).await;
    }
}
fn claim(observation: &Value) -> Value {
    json!({"title":"Fixture observation","category":"fixture","explanation":"Measured fixture bytes support only this provisional claim","claimed_impact":"No generic security conclusion","claimed_severity":"info","citations":[{"operation_id":observation["operation_id"],"response_manifest_sha256":observation["response_manifest_sha256"],"part":{"type":"body","offset":0,"length":6}}]})
}
#[tokio::test]
async fn model_revises_from_measured_feedback_repairs_citation_and_finishes_without_operator_ritual()
 {
    let f = setup_adaptive();
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
            "first",
            "run_web_experiment",
            proposal(b"wrong")
        )]))
        .await;
    matrix(&listener).await;
    let second = model.next().await;
    let first = outputs(&second.body).last().unwrap().clone();
    assert_eq!(first["assessment"]["disposition"], "not_observed");
    assert_eq!(first["vulnerability_reportable"], false);
    assert_eq!(first["evolution_eligible"], false);
    let measured = first["observations"][0]["body_preview"].as_str().unwrap();
    let mut revision = proposal(measured.as_bytes());
    revision["hypothesis"]["prior_revision"] = json!({"operation_id":first["experiment_operation_id"],"hypothesis_sha256":first["hypothesis"]["hypothesis_sha256"]});
    revision["hypothesis"]["explanation"] =
        json!("Revised prediction after the first experiment contradicted it");
    second
        .finish(json!([tool("revision", "run_web_experiment", revision)]))
        .await;
    matrix(&listener).await;
    let third = model.next().await;
    let revised = outputs(&third.body).last().unwrap().clone();
    assert_eq!(revised["assessment"]["disposition"], "observed_for_plan");
    assert_ne!(
        first["hypothesis"]["hypothesis_sha256"],
        revised["hypothesis"]["hypothesis_sha256"]
    );
    assert_eq!(
        revised["hypothesis"]["prior_revision"]["operation_id"],
        first["experiment_operation_id"]
    );
    let good = claim(&revised["observations"][0]);
    let mut bad = good.clone();
    bad["citations"][0]["part"]["offset"] = json!(9999);
    third
        .finish(json!([tool(
            "bad-citation",
            "submit_web_hypotheses",
            json!({"hypotheses":[bad]})
        )]))
        .await;
    let fourth = model.next().await;
    assert!(
        outputs(&fourth.body)
            .last()
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("Tool rejected:")
    );
    quiet(&listener).await;
    fourth
        .finish(json!([tool(
            "final",
            "submit_web_hypotheses",
            json!({"hypotheses":[good]})
        )]))
        .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed, "{:?}", result.error);
    assert_eq!(result.turns, 4);
    assert_eq!(
        result.web_review.as_ref().unwrap().review.hypotheses.len(),
        1
    );
    assert_eq!(effects(&f).len(), 8);
    assert!(matches!(
        call(
            &engine,
            Command::WebRun {
                session_id: session.clone(),
                operation_id: parent.id.clone()
            }
        )
        .await,
        Reply::WebRun { .. }
    ));
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    model.configure(&engine);
    let (_, cached, duplicate) = agent(call(&engine, f.command(&session)).await);
    assert!(duplicate);
    assert_eq!(cached.turns, 4);
    quiet(&listener).await;
    model.quiet().await;
    assert!(matches!(
        call(
            &engine,
            Command::WebRun {
                session_id: session,
                operation_id: parent.id
            }
        )
        .await,
        Reply::WebRun { .. }
    ));
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn zero_experiments_is_a_valid_agent_stopping_choice() {
    let mut f = setup_adaptive();
    f.request.web_submission_max_hypotheses = None;
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    model
        .next()
        .await
        .answer("Stop: available context does not justify an experiment.")
        .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    assert_eq!(result.tool_calls, 0);
    assert!(effects(&f).is_empty());
    quiet(&listener).await;
    assert!(matches!(
        call(
            &engine,
            Command::WebRun {
                session_id: session,
                operation_id: parent.id
            }
        )
        .await,
        Reply::WebRun { .. }
    ));
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn malformed_proposal_consumes_no_experiment_quota_and_can_be_corrected() {
    let mut f = setup_adaptive();
    f.request.web_submission_max_hypotheses = None;
    f.request
        .web_experiment_policy
        .as_mut()
        .unwrap()
        .max_experiments = 1;
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    let mut malformed = proposal(b"attack");
    malformed["🦀".repeat(2048)] = json!(true);
    model
        .next()
        .await
        .finish(json!([tool("invalid", "run_web_experiment", malformed)]))
        .await;
    let next = model.next().await;
    assert!(outputs(&next.body).last().unwrap().as_str().unwrap().len() <= 4096);
    assert!(
        outputs(&next.body)
            .last()
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("Tool rejected:")
    );
    quiet(&listener).await;
    next.finish(json!([tool(
        "valid",
        "run_web_experiment",
        proposal(b"attack")
    )]))
    .await;
    matrix(&listener).await;
    let next = model.next().await;
    assert_eq!(
        outputs(&next.body).last().unwrap()["assessment"]["disposition"],
        "observed_for_plan"
    );
    next.finish(json!([tool(
        "over-quota",
        "run_web_experiment",
        proposal(b"attack")
    )]))
    .await;
    let next = model.next().await;
    assert!(
        outputs(&next.body)
            .last()
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("Tool rejected:")
    );
    quiet(&listener).await;
    next.answer("Stop after the one authorized experiment.")
        .await;
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed, "{:?}", result.error);
    assert_eq!(effects(&f).len(), 4);
    engine.shutdown().await.unwrap();
}
async fn approval(
    engine: &zero_engine::Engine,
    session: &str,
) -> zero_protocol::approvals::ToolApprovalRecord {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match call(
                engine,
                Command::ToolApprovals {
                    session_id: session.into(),
                    root_operation_id: None,
                    after_sequence: 0,
                    limit: 32,
                },
            )
            .await
            {
                Reply::ToolApprovals { approvals } => {
                    if let Some(a) = approvals
                        .into_iter()
                        .find(|a| a.status == zero_protocol::approvals::ToolApprovalStatus::Pending)
                    {
                        return a;
                    }
                }
                r => panic!("{r:?}"),
            };
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn exact_matrix_approval_denial_is_effect_free_then_approved_invocation_uses_one_quota() {
    use zero_protocol::approvals::*;
    let mut f = setup_adaptive();
    f.request.web_submission_max_hypotheses = None;
    f.request
        .web_experiment_policy
        .as_mut()
        .unwrap()
        .max_experiments = 1;
    f.request.tool_approval_policy = Some(ToolApprovalPolicy {
        require_approval: vec!["http_request".into()],
    });
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
            "denied",
            "run_web_experiment",
            proposal(b"attack")
        )]))
        .await;
    let denied = approval(&engine, &session).await;
    assert!(effects(&f).is_empty());
    quiet(&listener).await;
    assert!(matches!(
        call(
            &engine,
            Command::DecideToolApproval {
                session_id: session.clone(),
                command_id: "deny".into(),
                approval_operation_id: denied.operation_id,
                expected_intent_sha256: denied.intent_sha256,
                decision: ToolApprovalDecision::Deny
            }
        )
        .await,
        Reply::ToolApprovalDecided { .. }
    ));
    let next = model.next().await;
    assert!(
        outputs(&next.body)
            .last()
            .unwrap()
            .as_str()
            .unwrap()
            .contains("denied")
    );
    next.finish(json!([tool(
        "approved",
        "run_web_experiment",
        proposal(b"attack")
    )]))
    .await;
    let approved = approval(&engine, &session).await;
    quiet(&listener).await;
    assert!(effects(&f).is_empty());
    let decide = || Command::DecideToolApproval {
        session_id: session.clone(),
        command_id: "approve".into(),
        approval_operation_id: approved.operation_id.clone(),
        expected_intent_sha256: approved.intent_sha256.clone(),
        decision: ToolApprovalDecision::Approve,
    };
    assert!(matches!(
        call(&engine, decide()).await,
        Reply::ToolApprovalDecided {
            duplicate: false,
            ..
        }
    ));
    matrix(&listener).await;
    let next = model.next().await;
    assert_eq!(
        outputs(&next.body).last().unwrap()["assessment"]["disposition"],
        "observed_for_plan"
    );
    next.answer("Stop: measured prediction match, not a verified vulnerability.")
        .await;
    let (_, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed, "{:?}", result.error);
    assert_eq!(effects(&f).len(), 4);
    assert!(matches!(
        call(&engine, decide()).await,
        Reply::ToolApprovalDecided {
            duplicate: true,
            ..
        }
    ));
    quiet(&listener).await;
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn projected_and_plain_checkpoint_continuations_preserve_quota_and_original_measurements() {
    for projected in [false, true] {
        let mut f = setup_adaptive();
        f.request.web_submission_max_hypotheses = None;
        f.request.max_turns = 1;
        f.request
            .web_experiment_policy
            .as_mut()
            .unwrap()
            .max_experiments = 1;
        if projected {
            f.request.context_policy = Some(
                serde_json::from_value(
                    json!({"schema_version":1,"max_input_bytes":131072,"keep_recent_rounds":1}),
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
                "experiment",
                "run_web_experiment",
                proposal(b"attack")
            )]))
            .await;
        matrix(&listener).await;
        let (parent, result, _) = agent(joined(run).await);
        assert_eq!(result.status, AgentStatus::TurnLimit, "{:?}", result.error);
        assert!(result.continuation_artifact.is_some());
        engine.shutdown().await.unwrap();
        drop(engine);
        let engine = configure(&f, &policy);
        model.configure(&engine);
        let (_, _, duplicate) = agent(call(&engine, f.command(&session)).await);
        assert!(duplicate);
        let mut request = f.request.clone();
        request.max_turns = 2;
        request.continuation_of = Some(parent.id.clone());
        request.prompt = "Choose whether more experiments are useful".into();
        let run = start(
            engine.clone(),
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "continuation".into(),
                request: request.clone(),
            },
        );
        let next = model.next().await;
        assert_eq!(
            outputs(&next.body).last().unwrap()["assessment"]["disposition"],
            "observed_for_plan"
        );
        next.finish(json!([tool(
            "quota",
            "run_web_experiment",
            proposal(b"attack")
        )]))
        .await;
        let next = model.next().await;
        assert!(
            outputs(&next.body)
                .last()
                .unwrap()
                .as_str()
                .unwrap()
                .starts_with("Tool rejected:")
        );
        next.answer("Stop after the account's experiment allowance.")
            .await;
        let (continued, result, _) = agent(joined(run).await);
        assert_eq!(result.status, AgentStatus::Completed, "{:?}", result.error);
        assert_eq!(effects(&f).len(), 4);
        quiet(&listener).await;
        request
            .web_experiment_policy
            .as_mut()
            .unwrap()
            .max_experiments = 2;
        assert!(matches!(
            call(
                &engine,
                Command::RunAgent {
                    session_id: session.clone(),
                    command_id: "changed-policy".into(),
                    request: request.clone()
                }
            )
            .await,
            Reply::Error { .. }
        ));
        let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
        let (experiment,raw):(String,String)=sql.query_row("SELECT id,outcome FROM operations WHERE json_extract(payload,'$.kind')='agent_web_experiment'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let mut changed: Value = serde_json::from_str(&raw).unwrap();
        changed["assessment"]["disposition"] = json!("not_observed");
        sql.execute(
            "UPDATE operations SET outcome=?1 WHERE id=?2",
            rusqlite::params![changed.to_string(), experiment],
        )
        .unwrap();
        request
            .web_experiment_policy
            .as_mut()
            .unwrap()
            .max_experiments = 1;
        request.continuation_of = Some(continued.id);
        let before = budget(&engine, &session).await;
        assert!(matches!(
            call(
                &engine,
                Command::RunAgent {
                    session_id: session.clone(),
                    command_id: "corrupt-ancestor".into(),
                    request
                }
            )
            .await,
            Reply::Error { .. }
        ));
        assert_eq!(budget(&engine, &session).await, before);
        model.quiet().await;
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn model_selected_joined_investigators_share_experiment_quota_and_citable_observations() {
    let mut f = setup_adaptive();
    f.request
        .web_experiment_policy
        .as_mut()
        .unwrap()
        .max_experiments = 1;
    f.request.delegation_policy=Some(serde_json::from_value(json!({"max_parallel":1,"max_children":2,"roles":[{"name":"investigator","provider":"fixture","model":"child","instructions":"Choose useful experiments and stop when done","description":"Scoped investigator","tools":["http_request","run_web_experiment"],"max_turns":3,"reservation_per_turn":5}]})).unwrap());
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let run = start(engine.clone(), f.command(&session));
    model.next().await.finish(json!([tool("delegation","delegate_tasks",json!({"tasks":[{"role":"investigator","prompt":"Measure the conjecture"},{"role":"investigator","prompt":"Choose a complementary measurement"}]}))])).await;
    let child = model.next().await;
    assert_eq!(child.body["model"], "child");
    assert!(
        !child.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "delegate_tasks" || t["name"] == "submit_web_hypotheses")
    );
    child
        .finish(json!([tool(
            "first-child",
            "run_web_experiment",
            proposal(b"attack")
        )]))
        .await;
    matrix(&listener).await;
    let child = model.next().await;
    let observed = outputs(&child.body).last().unwrap().clone();
    let observation = observed["observations"][0].clone();
    child
        .answer(&serde_json::to_string(&observation).unwrap())
        .await;
    let second = model.next().await;
    assert_eq!(second.body["model"], "child");
    second
        .finish(json!([tool(
            "second-child",
            "run_web_experiment",
            proposal(b"attack")
        )]))
        .await;
    let second = model.next().await;
    assert!(
        outputs(&second.body)
            .last()
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("Tool rejected:")
    );
    second
        .answer("No second experiment: shared allowance already consumed.")
        .await;
    let parent = model.next().await;
    assert_eq!(parent.body["model"], "parent");
    assert_eq!(
        outputs(&parent.body).last().unwrap()["children"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    parent
        .finish(json!([tool(
            "publish",
            "submit_web_hypotheses",
            json!({"hypotheses":[claim(&observation)]})
        )]))
        .await;
    let (root, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed, "{:?}", result.error);
    assert_eq!(effects(&f).len(), 4);
    assert!(matches!(
        call(
            &engine,
            Command::WebRun {
                session_id: session,
                operation_id: root.id
            }
        )
        .await,
        Reply::WebRun { .. }
    ));
    quiet(&listener).await;
    engine.shutdown().await.unwrap();
}
