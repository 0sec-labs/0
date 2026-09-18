#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "web/mod.rs"]
mod web;
use serde_json::{Value, json};
use web::*;
use zero_protocol::{
    Command, Reply, agent::AgentStatus, verification::Disposition, web_experiment::*,
};
fn setup_experiment() -> Setup {
    let mut f = setup();
    f.request.web_submission_max_hypotheses = None;
    f.request.web_experiment_policy = Some(WebExperimentPolicy {
        schema_version: 1,
        max_experiments: 2,
        max_cases: 2,
        max_repeats: 2,
    });
    f
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", zero_plugin::sha256(bytes))
}
fn proposal() -> Value {
    json!({"hypothesis":{"title":"Provisional fixture conjecture","explanation":"Predict different fixture bodies; no vulnerability claim"},"purpose":"Compare attack and control outputs","repeats":2,"cases":[{"name":"attack","role":"attack","request":{"url":"/attack"},"expected":{"status":200,"body_sha256":digest(b"attack")}},{"name":"control","role":"legitimate_control","request":{"url":"/control"},"expected":{"status":200,"body_sha256":digest(b"control")}}]})
}
fn experiment_id(f: &Setup) -> String {
    rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap().query_row("SELECT id FROM operations WHERE json_extract(payload,'$.kind')='agent_web_experiment' ORDER BY rowid LIMIT 1",[],|r|r.get(0)).unwrap()
}
async fn detail(
    engine: &zero_engine::Engine,
    session: &str,
    root: &str,
    id: &str,
) -> WebExperimentReport {
    let reply = call(
        engine,
        Command::WebExperiment {
            session_id: session.into(),
            web_operation_id: root.into(),
            experiment_operation_id: id.into(),
        },
    )
    .await;
    match reply {
        Reply::WebExperiment { experiment } => experiment,
        r => panic!("{r:?}"),
    }
}
#[tokio::test]
async fn fresh_experiment_feedback_is_reassessed_after_restart_and_corruption_rejects() {
    let f = setup_experiment();
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
            proposal()
        )]))
        .await;
    for name in ["attack", "control", "attack", "control"] {
        let (socket, request) = receive(&listener).await;
        assert!(String::from_utf8_lossy(&request).starts_with(&format!("POST /{name} ")));
        respond(socket, 200, "", name.as_bytes()).await;
    }
    let next = model.next().await;
    let observed = outputs(&next.body);
    assert!(
        serde_json::to_string(&observed)
            .unwrap()
            .contains("observed_for_plan")
    );
    next.answer("The predictions matched. This alone does not establish a vulnerability.")
        .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed, "{:?}", result.error);
    let id = experiment_id(&f);
    let report = detail(&engine, &session, &parent.id, &id).await;
    let measured = report.outcome.as_ref().unwrap();
    assert_eq!(
        measured.assessment.disposition,
        Disposition::ObservedForPlan
    );
    assert!(!measured.assessment.vulnerability_reportable);
    assert_eq!(measured.children.len(), 4);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    let cached = detail(&engine, &session, &parent.id, &id).await;
    assert_eq!(
        serde_json::to_value(&cached).unwrap(),
        serde_json::to_value(&report).unwrap()
    );
    model.configure(&engine);
    let (_, _, duplicate) = agent(call(&engine, f.command(&session)).await);
    assert!(duplicate);
    model.quiet().await;
    quiet(&listener).await;
    let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    let old: String = sql
        .query_row(
            "SELECT payload FROM operations WHERE id=?1",
            [&measured.children[0]],
            |r| r.get(0),
        )
        .unwrap();
    let mut changed: Value = serde_json::from_str(&old).unwrap();
    changed["origin"]["repeat_index"] = json!(1);
    sql.execute(
        "UPDATE operations SET payload=?1 WHERE id=?2",
        rusqlite::params![changed.to_string(), measured.children[0]],
    )
    .unwrap();
    let reply = call(
        &engine,
        Command::WebExperiment {
            session_id: session,
            web_operation_id: parent.id,
            experiment_operation_id: id,
        },
    )
    .await;
    assert!(matches!(reply, Reply::Error { .. }));
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancel_after_first_dispatch_preserves_partial_unknown_and_never_runs_rest() {
    use tokio::io::AsyncWriteExt;
    let f = setup_experiment();
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
            proposal()
        )]))
        .await;
    let (mut socket, _) = receive(&listener).await;
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
        .await
        .unwrap();
    call(
        &engine,
        Command::Cancel {
            session_id: session.clone(),
            execution_id: "parent-command".into(),
        },
    )
    .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Unknown, "{:?}", result.error);
    let id = experiment_id(&f);
    let report = detail(&engine, &session, &parent.id, &id).await;
    let outcome = report.outcome.as_ref().unwrap();
    assert_eq!(outcome.assessment.disposition, Disposition::Unknown);
    assert_eq!(outcome.children.len(), 1);
    assert!(outcome.attempts[0].possible_dispatch);
    assert!(!outcome.attempts[0].complete);
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    let same = detail(&engine, &session, &parent.id, &id).await;
    assert_eq!(
        serde_json::to_value(&report).unwrap(),
        serde_json::to_value(same).unwrap()
    );
    model.configure(&engine);
    let (_, _, duplicate) = agent(call(&engine, f.command(&session)).await);
    assert!(duplicate);
    quiet(&listener).await;
    model.quiet().await;
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn failed_control_is_measured_feedback_and_model_can_stop_without_another_experiment() {
    let f = setup_experiment();
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
            proposal()
        )]))
        .await;
    for i in 0..4 {
        let (socket, _) = receive(&listener).await;
        respond(
            socket,
            if i % 2 == 0 { 200 } else { 401 },
            "",
            if i % 2 == 0 { b"attack" } else { b"expired" },
        )
        .await;
    }
    let next = model.next().await;
    assert!(
        serde_json::to_string(&outputs(&next.body))
            .unwrap()
            .contains("inconclusive")
    );
    next.answer("Control failed; stop without claiming a vulnerability.")
        .await;
    let (parent, result, _) = agent(joined(run).await);
    assert_eq!(result.status, AgentStatus::Completed);
    let report = detail(&engine, &session, &parent.id, &experiment_id(&f)).await;
    assert_eq!(
        report.outcome.unwrap().assessment.disposition,
        Disposition::Inconclusive
    );
    quiet(&listener).await;
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn crash_fixture_child() {
    let Ok(path) = std::env::var("ZERO_WEB_EXPERIMENT_CRASH_FIXTURE") else {
        return;
    };
    let v: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let engine = zero_engine::Engine::open(v["db"].as_str().unwrap(), None).unwrap();
    engine
        .configure_http(
            "target",
            zero_http::Client::new(serde_json::from_value(v["policy"].clone()).unwrap(), None)
                .unwrap(),
        )
        .unwrap();
    engine
        .configure_provider(
            "fixture",
            zero_provider::ProviderClient::new(
                zero_provider::Endpoint::responses(v["provider_url"].as_str().unwrap(), None)
                    .unwrap(),
                std::time::Duration::from_secs(10),
                262144,
            )
            .unwrap(),
            zero_protocol::model::Rates {
                input: 1_000_000,
                cached_input: 1_000_000,
                output: 1_000_000,
            },
        )
        .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(512);
    engine
        .handle(
            Command::RunAgent {
                session_id: v["session"].as_str().unwrap().into(),
                command_id: "parent-command".into(),
                request: serde_json::from_value(v["request"].clone()).unwrap(),
            },
            tx,
        )
        .await;
    panic!("crash fixture unexpectedly completed before parent killed its owned process");
}
struct OwnedProcess(std::process::Child);
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[tokio::test]
async fn real_owner_death_preserves_quota_partial_dispatch_and_readonly_unknown() {
    use tokio::io::AsyncWriteExt;
    let f = setup_experiment();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let engine = f.engine();
    let session = session(&engine, 100).await;
    engine.shutdown().await.unwrap();
    drop(engine);
    let config = f.dir.path().join("crash-fixture.json");
    std::fs::write(&config,serde_json::to_vec(&json!({"db":f.dir.path().join("state.db"),"policy":policy,"provider_url":model.url,"session":session,"request":f.request})).unwrap()).unwrap();
    let mut process = OwnedProcess(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_fixture_child", "--nocapture"])
            .env("ZERO_WEB_EXPERIMENT_CRASH_FIXTURE", &config)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    model
        .next()
        .await
        .finish(json!([tool(
            "experiment",
            "run_web_experiment",
            proposal()
        )]))
        .await;
    let (mut socket, _) = receive(&listener).await;
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
        .await
        .unwrap();
    let id = experiment_id(&f);
    process.0.kill().unwrap();
    process.0.wait().unwrap();
    drop(process);
    let engine = f.engine();
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    let root = store
        .get_operation_by_command(&session, "parent-command")
        .unwrap();
    assert_eq!(root.status, zero_protocol::OperationStatus::Unknown);
    let report = detail(&engine, &session, &root.id, &id).await;
    let outcome = report.outcome.unwrap();
    assert_eq!(outcome.assessment.disposition, Disposition::Unknown);
    assert_eq!(outcome.attempts.len(), 1);
    assert!(outcome.attempts[0].possible_dispatch);
    assert!(!outcome.attempts[0].complete);
    assert!(outcome.attempts[0].body_sha256.is_none());
    model.configure(&engine);
    let reply = call(&engine, f.command(&session)).await;
    assert!(matches!(
        reply,
        Reply::Agent {
            duplicate: true,
            ..
        }
    ));
    quiet(&listener).await;
    model.quiet().await;
    let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    sql.execute("DELETE FROM events WHERE kind='operation_unknown' AND json_extract(payload,'$.operation_id')=?1",[&id]).unwrap();
    let reply = call(
        &engine,
        Command::WebExperiment {
            session_id: session,
            web_operation_id: root.id,
            experiment_operation_id: id,
        },
    )
    .await;
    assert!(matches!(reply, Reply::Error { .. }));
    engine.shutdown().await.unwrap();
}
