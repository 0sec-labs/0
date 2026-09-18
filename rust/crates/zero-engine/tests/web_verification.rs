#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "web/mod.rs"]
mod web;
use serde_json::{Value, json};
use web::*;
use zero_protocol::{Command, Reply, verification::Disposition, web::*};
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", zero_plugin::sha256(bytes))
}
async fn review(
    f: &Setup,
    engine: &std::sync::Arc<zero_engine::Engine>,
    model: &mut Http,
    listener: &tokio::net::TcpListener,
    session: &str,
) -> (zero_protocol::Operation, WebVerificationPlan) {
    let run = start(engine.clone(), f.command(session));
    model
        .next()
        .await
        .finish(json!([tool(
            "observation",
            "http_request",
            json!({"url":"/fixture"})
        )]))
        .await;
    if f.request.tool_approval_policy.is_some() {
        let record = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let store =
                    zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
                let page = store.tool_approvals(session, None, 0, 32).unwrap();
                if let Some(record) = page.into_iter().next() {
                    break record;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        call(
            engine,
            Command::DecideToolApproval {
                session_id: session.into(),
                command_id: "approve-source-observation".into(),
                approval_operation_id: record.operation_id,
                expected_intent_sha256: record.intent_sha256,
                decision: zero_protocol::approvals::ToolApprovalDecision::Approve,
            },
        )
        .await;
    }
    let (socket, _) = receive(listener).await;
    respond(socket, 200, "", b"fixture").await;
    let next = model.next().await;
    let o = outputs(&next.body)[0]["observation"].clone();
    next.finish(json!([tool("submit","submit_web_hypotheses",json!({"hypotheses":[{"title":"Fixture","category":"disclosure","explanation":"Fixture only","claimed_impact":"Fixture only","claimed_severity":"low","citations":[{"operation_id":o["operation_id"],"response_manifest_sha256":o["response_manifest_sha256"],"part":{"type":"body","offset":0,"length":7}}]}]}))])).await;
    let (parent, result, _) = agent(joined(run).await);
    let r = result.web_review.unwrap();
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    let attachments = store.operation_artifacts(&parent.id).unwrap();
    let plan=serde_json::from_value(json!({"schema_version":1,"oracle_version":zero_web_verification::ORACLE_VERSION,"web_operation_id":parent.id,"web_review_sha256":attachments["web.review"],"hypothesis_id":r.review.hypotheses[0].id,"state_mode":"same_static_identity_existing_target","repeats":2,"cases":[{"name":"attack","role":"attack","request":{"url":"/attack"},"expected":{"status":200,"body_sha256":digest(b"attack")}}, {"name":"control","role":"legitimate_control","request":{"url":"/control"},"expected":{"status":200,"body_sha256":digest(b"control")}}]})).unwrap();
    (parent, plan)
}
async fn request(
    engine: &zero_engine::Engine,
    session: &str,
    plan: WebVerificationPlan,
) -> WebVerificationRequest {
    let Reply::WebVerificationPrepared { preparation } = call(
        engine,
        Command::PrepareWebVerification {
            session_id: session.into(),
            plan: plan.clone(),
        },
    )
    .await
    else {
        panic!("wrong preparation")
    };
    WebVerificationRequest {
        plan,
        expected_intent_sha256: preparation.intent_sha256,
        approved_intent_sha256: None,
    }
}
#[tokio::test]
async fn fresh_matrix_reassesses_after_restart_without_provider_or_http_replay() {
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let (source, plan) = review(&f, &engine, &mut model, &listener, &session).await;
    let request = request(&engine, &session, plan).await;
    let command = Command::VerifyWebHypothesis {
        session_id: session.clone(),
        command_id: "verify".into(),
        request,
    };
    let run = start(engine.clone(), command.clone());
    for path in ["attack", "control", "attack", "control"] {
        let (socket, raw) = receive(&listener).await;
        assert!(String::from_utf8_lossy(&raw).starts_with(&format!("POST /{path} ")));
        respond(socket, 200, "", path.as_bytes()).await;
    }
    let Reply::WebVerification {
        operation,
        result: Some(result),
        duplicate: false,
    } = joined(run).await
    else {
        panic!("wrong verification")
    };
    assert_eq!(result.assessment.disposition, Disposition::ObservedForPlan);
    assert!(!result.assessment.vulnerability_reportable);
    assert_eq!(result.children.len(), 4);
    let report = zero_engine::read_web_verification(
        &f.dir.path().join("state.db"),
        &session,
        &source.id,
        &operation.id,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(report.outcome).unwrap(),
        serde_json::to_value(&result).unwrap()
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    let Reply::WebVerification {
        duplicate: true,
        result: Some(retry),
        ..
    } = call(&engine, command).await
    else {
        panic!("wrong retry")
    };
    assert_eq!(
        serde_json::to_value(retry).unwrap(),
        serde_json::to_value(&result).unwrap()
    );
    model.quiet().await;
    quiet(&listener).await;
    let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    let mut corrupted: Value = sql
        .query_row(
            "SELECT outcome FROM operations WHERE id=?1",
            [&result.children[0]],
            |r| r.get::<_, String>(0),
        )
        .map(|s| serde_json::from_str(&s).unwrap())
        .unwrap();
    corrupted["http_response_artifact"] = json!(digest(b"forged"));
    sql.execute(
        "UPDATE operations SET outcome=?1 WHERE id=?2",
        rusqlite::params![corrupted.to_string(), result.children[0]],
    )
    .unwrap();
    assert!(
        zero_engine::read_web_verification(
            &f.dir.path().join("state.db"),
            &session,
            &source.id,
            &operation.id
        )
        .is_err()
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn control_failure_and_stable_negative_have_distinct_assessments() {
    for bad_control in [false, true] {
        let f = setup();
        let (listener, policy) = target().await;
        let mut model = Http::new().await;
        let engine = configure(&f, &policy);
        model.configure(&engine);
        let session = session(&engine, 100).await;
        let (source, plan) = review(&f, &engine, &mut model, &listener, &session).await;
        let request = request(&engine, &session, plan).await;
        let run = start(
            engine.clone(),
            Command::VerifyWebHypothesis {
                session_id: session.clone(),
                command_id: "verify".into(),
                request,
            },
        );
        for index in 0..4 {
            let (socket, _) = receive(&listener).await;
            let body: &[u8] = if index % 2 == 0 {
                b"negative".as_slice()
            } else if bad_control {
                b"expired login"
            } else {
                b"control"
            };
            respond(socket, 200, "", body).await;
        }
        let Reply::WebVerification {
            operation,
            result: Some(result),
            ..
        } = joined(run).await
        else {
            panic!("wrong result")
        };
        assert_eq!(
            result.assessment.disposition,
            if bad_control {
                Disposition::Inconclusive
            } else {
                Disposition::NotObserved
            }
        );
        zero_engine::read_web_verification(
            &f.dir.path().join("state.db"),
            &session,
            &source.id,
            &operation.id,
        )
        .unwrap();
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn cancelling_a_dispatched_case_retains_unknown_without_running_remaining_cases() {
    use tokio::io::AsyncWriteExt;
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let (source, plan) = review(&f, &engine, &mut model, &listener, &session).await;
    let request = request(&engine, &session, plan).await;
    let command = Command::VerifyWebHypothesis {
        session_id: session.clone(),
        command_id: "cancel-verify".into(),
        request,
    };
    let run = start(engine.clone(), command.clone());
    let (mut socket, _) = receive(&listener).await;
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
        .await
        .unwrap();
    call(
        &engine,
        Command::Cancel {
            session_id: session.clone(),
            execution_id: "cancel-verify".into(),
        },
    )
    .await;
    let Reply::WebVerification {
        operation,
        result: Some(result),
        ..
    } = joined(run).await
    else {
        panic!("wrong cancelled result")
    };
    assert_eq!(result.assessment.disposition, Disposition::Unknown);
    assert_eq!(result.attempts.len(), 1);
    assert!(result.attempts[0].possible_dispatch);
    assert!(!result.attempts[0].complete);
    zero_engine::read_web_verification(
        &f.dir.path().join("state.db"),
        &session,
        &source.id,
        &operation.id,
    )
    .unwrap();
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    let Reply::WebVerification {
        duplicate: true, ..
    } = call(&engine, command).await
    else {
        panic!("wrong cancelled retry")
    };
    quiet(&listener).await;
    model.quiet().await;
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn changed_intent_and_unrelated_approval_are_rejected_before_admission_or_http() {
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let (_, plan) = review(&f, &engine, &mut model, &listener, &session).await;
    let valid = request(&engine, &session, plan).await;
    for variant in 0..3 {
        let mut request = valid.clone();
        match variant {
            0 => request.expected_intent_sha256 = digest(b"other"),
            1 => request.approved_intent_sha256 = Some(digest(b"other")),
            _ => request.plan.cases[0].request.url = "/changed".into(),
        };
        let reply = call(
            &engine,
            Command::VerifyWebHypothesis {
                session_id: session.clone(),
                command_id: format!("reject-{variant}"),
                request,
            },
        )
        .await;
        assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
        let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
        assert!(matches!(
            store.get_operation_by_command(&session, &format!("reject-{variant}")),
            Err(zero_store::Error::NotFound(_))
        ));
    }
    quiet(&listener).await;
    model.quiet().await;
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn inherited_gate_requires_explicit_whole_plan_approval_then_four_fresh_effects() {
    let mut f = setup();
    f.request.tool_approval_policy = Some(zero_protocol::approvals::ToolApprovalPolicy {
        require_approval: vec!["http_request".into()],
    });
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let (source, plan) = review(&f, &engine, &mut model, &listener, &session).await;
    let Reply::WebVerificationPrepared { preparation } = call(
        &engine,
        Command::PrepareWebVerification {
            session_id: session.clone(),
            plan: plan.clone(),
        },
    )
    .await
    else {
        panic!("wrong preparation")
    };
    assert!(preparation.approval_required);
    let mut request = WebVerificationRequest {
        plan,
        expected_intent_sha256: preparation.intent_sha256.clone(),
        approved_intent_sha256: None,
    };
    assert!(matches!(
        call(
            &engine,
            Command::VerifyWebHypothesis {
                session_id: session.clone(),
                command_id: "verify".into(),
                request: request.clone()
            }
        )
        .await,
        Reply::Error { .. }
    ));
    quiet(&listener).await;
    request.approved_intent_sha256 = Some(preparation.intent_sha256.clone());
    let run = start(
        engine.clone(),
        Command::VerifyWebHypothesis {
            session_id: session.clone(),
            command_id: "verify".into(),
            request,
        },
    );
    for body in [b"attack".as_slice(), b"control", b"attack", b"control"] {
        let (socket, _) = receive(&listener).await;
        respond(socket, 200, "", body).await;
    }
    let Reply::WebVerification {
        operation,
        result: Some(result),
        ..
    } = joined(run).await
    else {
        panic!("wrong approved result")
    };
    assert_eq!(result.assessment.disposition, Disposition::ObservedForPlan);
    let report = zero_engine::read_web_verification(
        &f.dir.path().join("state.db"),
        &session,
        &source.id,
        &operation.id,
    )
    .unwrap();
    assert_eq!(
        report.approved_intent_sha256,
        Some(preparation.intent_sha256)
    );
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    assert_eq!(
        store.tool_approvals(&session, None, 0, 32).unwrap().len(),
        1,
        "plan consent must not fabricate interactive approvals"
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn owner_loss_reports_actual_partial_admissions_without_replaying_or_inventing_responses() {
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let (source, plan) = review(&f, &engine, &mut model, &listener, &session).await;
    let Reply::WebVerificationPrepared { preparation } = call(
        &engine,
        Command::PrepareWebVerification {
            session_id: session.clone(),
            plan,
        },
    )
    .await
    else {
        panic!("wrong preparation")
    };
    let frozen = zero_web_verification::FrozenPlan::from_intent(&preparation.intent).unwrap();
    let request = WebVerificationRequest {
        plan: frozen.plan().clone(),
        expected_intent_sha256: preparation.intent_sha256.clone(),
        approved_intent_sha256: None,
    };
    engine.shutdown().await.unwrap();
    drop(engine);
    let mut store = zero_store::Store::open(f.dir.path().join("state.db")).unwrap();
    let parent=store.admit_command(&session,"crashed-verify",&json!({"kind":"host_web_verification","request":request,"execution_intent":frozen.intent(),"intent_sha256":frozen.intent_sha256(),"plan_sha256":frozen.plan_sha256(),"http_context":frozen.intent()["http_context"],"http_output_version":2})).unwrap().operation;
    store
        .begin_operation(&parent.id, source.owner.as_deref().unwrap())
        .unwrap();
    let child=store.admit_command(&session,&format!("{}:web:case:0:0",parent.id),&json!({"kind":"agent_http","parent_operation":parent.id,"origin":{"kind":"frozen_web_plan","plan_sha256":frozen.plan_sha256(),"case_index":0,"case_name":"attack","repeat_index":0},"http_context":frozen.intent()["http_context"],"http_output_version":2,"request":frozen.request(0,0).unwrap()})).unwrap().operation;
    store
        .begin_operation(&child.id, source.owner.as_deref().unwrap())
        .unwrap();
    drop(store);
    let engine = f.engine();
    let report = zero_engine::read_web_verification(
        &f.dir.path().join("state.db"),
        &session,
        &source.id,
        &parent.id,
    )
    .unwrap();
    assert_eq!(report.outcome.assessment.disposition, Disposition::Unknown);
    assert_eq!(report.outcome.attempts.len(), 1);
    assert!(!report.outcome.attempts[0].complete);
    assert!(!report.outcome.attempts[0].possible_dispatch);
    assert!(report.outcome.attempts[0].body_sha256.is_none());
    let Reply::WebVerification {
        duplicate: true,
        result: Some(result),
        ..
    } = call(
        &engine,
        Command::VerifyWebHypothesis {
            session_id: session.clone(),
            command_id: "crashed-verify".into(),
            request,
        },
    )
    .await
    else {
        panic!("wrong interrupted retry")
    };
    assert_eq!(result.assessment.disposition, Disposition::Unknown);
    quiet(&listener).await;
    model.quiet().await;
    let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    sql.execute("DELETE FROM events WHERE session_id=?1 AND kind='operation_unknown' AND json_extract(payload,'$.operation_id')=?2",rusqlite::params![session,parent.id]).unwrap();
    assert!(
        zero_engine::read_web_verification(
            &f.dir.path().join("state.db"),
            &session,
            &source.id,
            &parent.id
        )
        .is_err()
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn disconnected_admission_observer_cancels_before_first_case_without_effects() {
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let session = session(&engine, 100).await;
    let (source, plan) = review(&f, &engine, &mut model, &listener, &session).await;
    let request = request(&engine, &session, plan).await;
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    drop(rx);
    let Reply::WebVerification {
        operation,
        result: Some(result),
        ..
    } = engine
        .handle(
            Command::VerifyWebHypothesis {
                session_id: session.clone(),
                command_id: "cancel-before".into(),
                request,
            },
            tx,
        )
        .await
    else {
        panic!("wrong result")
    };
    assert_eq!(result.assessment.disposition, Disposition::Cancelled);
    assert!(result.children.is_empty());
    zero_engine::read_web_verification(
        &f.dir.path().join("state.db"),
        &session,
        &source.id,
        &operation.id,
    )
    .unwrap();
    quiet(&listener).await;
    engine.shutdown().await.unwrap();
}
