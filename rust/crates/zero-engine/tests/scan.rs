#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "scan/mod.rs"]
mod support;
use serde_json::json;
use support::*;
use zero_protocol::{Command, OperationStatus, Reply, scan::*};
#[tokio::test]
async fn actual_scan_has_atomic_roots_retained_claim_and_inert_offline_retry() {
    let f = setup();
    let (listener, policy) = target().await;
    let target_url = format!("{}/fixture", policy.base_url);
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    engine.configure_scan("web", profile()).unwrap();
    let running = start(engine.clone(), command(&target_url));
    let first = model.next().await;
    let initial = current(&f);
    assert_eq!(initial.controller_status, OperationStatus::Running);
    assert_eq!(initial.root_status, OperationStatus::Running);
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    let root = store
        .get_operation(&initial.scan.root_operation_id)
        .unwrap();
    assert_eq!(
        root.payload["scan_operation_id"],
        initial.scan.controller_operation_id
    );
    assert!(root.payload.get("parent_operation").is_none());
    drop(store);
    first
        .finish(json!([tool(
            "observe",
            "http_request",
            json!({"url":"/fixture","method":"GET"})
        )]))
        .await;
    let (socket, bytes) = receive(&listener).await;
    assert!(bytes.starts_with(b"GET /fixture "));
    respond(socket, 200, "", b"evidence").await;
    let next = model.next().await;
    let observation = outputs(&next.body)[0]["observation"].clone();
    next.finish(json!([tool("submit","submit_web_hypotheses",json!({"hypotheses":[{"title":"Fixture evidence","category":"test","explanation":"Retained evidence","claimed_impact":"Fixture only","claimed_severity":"low","citations":[{"operation_id":observation["operation_id"],"response_manifest_sha256":observation["response_manifest_sha256"],"part":{"type":"body","offset":0,"length":8}}]}]}))])).await;
    let (done, duplicate) = snapshot(joined(running).await);
    assert!(!duplicate);
    let result = done.result.unwrap();
    assert_eq!(result.outcome.stop_reason, ScanStopReason::Submitted);
    assert_eq!(result.outcome.summary.submitted_hypotheses, 1);
    assert!(!result.outcome.vulnerability_reportable);
    assert_eq!(result.outcome.summary.verified_vulnerabilities, 0);
    let report =
        zero_engine::read_scan_report(&f.dir.path().join("state.db"), &done.scan.id).unwrap();
    assert_eq!(report.kind, ScanReportKind::Retained);
    assert_eq!(report.web.as_ref().unwrap().observations.len(), 1);
    let hypothesis = report
        .web
        .as_ref()
        .unwrap()
        .run
        .review
        .as_ref()
        .unwrap()
        .hypotheses[0]
        .id
        .clone();
    assert!(matches!(
        call(
            &engine,
            Command::TriageWebFinding {
                session_id: done.scan.session_id.clone(),
                command_id: "triage".into(),
                web_operation_id: done.scan.root_operation_id.clone(),
                hypothesis_id: hypothesis,
                status: zero_protocol::web::WebTriageStatus::Accepted,
                expected_revision: 0,
                note: "Accepted for review, not verified".into()
            }
        )
        .await,
        Reply::WebFindingTriaged { .. }
    ));
    assert_eq!(
        serde_json::to_value(
            zero_engine::read_scan_report(&f.dir.path().join("state.db"), &done.scan.id).unwrap()
        )
        .unwrap(),
        serde_json::to_value(&report).unwrap()
    );
    assert!(matches!(
        call(
            &engine,
            Command::CancelScan {
                scan_id: done.scan.id.clone()
            }
        )
        .await,
        Reply::ScanCancelled {
            accepted: false,
            ..
        }
    ));
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    let (retry, duplicate) = snapshot(call(&engine, command(&target_url)).await);
    assert!(duplicate);
    assert_eq!(
        serde_json::to_value(retry.result).unwrap(),
        serde_json::to_value(Some(result)).unwrap()
    );
    assert!(matches!(
        call(&engine, command(&(target_url.clone() + "/changed"))).await,
        Reply::Error { .. }
    ));
    model.quiet().await;
    quiet(&listener).await;
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn empty_submission_prose_turn_and_budget_are_distinct() {
    for mode in ["empty", "prose", "turn", "budget"] {
        let f = setup();
        let (listener, policy) = target().await;
        let url = policy.base_url.clone();
        let mut model = Http::new().await;
        let engine = configure(&f, &policy);
        model.configure(&engine);
        let mut p = profile();
        if mode == "turn" {
            p.max_turns = 1;
        }
        if mode == "budget" {
            p.budget_limit = 10;
        }
        engine.configure_scan("web", p).unwrap();
        let running = start(engine.clone(), command(&url));
        let first = model.next().await;
        if mode == "empty" {
            first
                .finish(json!([tool(
                    "submit",
                    "submit_web_hypotheses",
                    json!({"hypotheses":[]})
                )]))
                .await;
        } else if mode == "prose" {
            first
                .answer("Investigation stopped without a structured submission")
                .await;
        } else {
            first
                .finish(json!([tool("invalid", "missing_tool", json!({}))]))
                .await;
        }
        let (done, _) = snapshot(joined(running).await);
        let result = done.result.unwrap();
        assert_eq!(
            result.outcome.stop_reason,
            match mode {
                "empty" => ScanStopReason::Submitted,
                "prose" => ScanStopReason::StoppedWithoutSubmission,
                "turn" => ScanStopReason::TurnLimit,
                _ => ScanStopReason::BudgetLimit,
            },
            "mode {mode}"
        );
        assert_eq!(result.outcome.summary.submitted_hypotheses, 0);
        assert_eq!(
            result.outcome.completeness,
            if mode == "empty" {
                ScanCompleteness::CompletedWorkflow
            } else {
                ScanCompleteness::Partial
            }
        );
        model.quiet().await;
        quiet(&listener).await;
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn cancel_and_deadline_drain_held_provider_and_preserve_unknown_holds() {
    for deadline in [false, true] {
        let f = setup();
        let (listener, policy) = target().await;
        let url = policy.base_url.clone();
        let mut model = Http::new().await;
        let engine = configure(&f, &policy);
        model.configure(&engine);
        let mut p = profile();
        if deadline {
            p.deadline_ms = 250;
        }
        engine.configure_scan("web", p).unwrap();
        let running = start(engine.clone(), command(&url));
        let _held = model.next().await;
        let initial = current(&f);
        if !deadline {
            assert!(matches!(
                call(
                    &engine,
                    Command::CancelScan {
                        scan_id: initial.scan.id.clone()
                    }
                )
                .await,
                Reply::ScanCancelled { accepted: true, .. }
            ));
        }
        let (done, _) = snapshot(joined(running).await);
        assert_eq!(
            done.close_reason,
            Some(if deadline {
                ScanCloseReason::Deadline
            } else {
                ScanCloseReason::Cancelled
            })
        );
        let result = done.result.unwrap();
        assert_eq!(result.outcome.stop_reason, ScanStopReason::Unknown);
        assert_eq!(result.outcome.budget.reserved, 10);
        engine.shutdown().await.unwrap();
        drop(engine);
        let engine = f.engine();
        let (retry, duplicate) = snapshot(call(&engine, command(&url)).await);
        assert!(duplicate);
        assert_eq!(retry.root_status, done.root_status);
        model.quiet().await;
        quiet(&listener).await;
        engine.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn joined_experiment_keeps_original_scan_http_and_model_accounts() {
    let f = setup();
    let (listener, policy) = target().await;
    let url = policy.base_url.clone();
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let mut p = profile();
    p.web_experiment_policy = Some(zero_protocol::web_experiment::WebExperimentPolicy {
        schema_version: 1,
        max_experiments: 2,
        max_cases: 2,
        max_repeats: 2,
    });
    p.delegation_policy=Some(serde_json::from_value(json!({"max_parallel":1,"max_children":1,"roles":[{"name":"investigator","provider":"fixture","model":"child","instructions":"Choose a bounded experiment.","description":"Investigate fixture","tools":["http_request","run_web_experiment"],"max_turns":2,"reservation_per_turn":5}]})).unwrap());
    engine.configure_scan("web", p).unwrap();
    let running = start(engine.clone(), command(&url));
    model
        .next()
        .await
        .finish(json!([tool(
            "delegate",
            "delegate_tasks",
            json!({"tasks":[{"role":"investigator","prompt":"Compare attack and control."}]})
        )]))
        .await;
    let child = model.next().await;
    assert_eq!(child.body["model"], "child");
    let digest = |s: &str| format!("sha256:{}", zero_plugin::sha256(s.as_bytes()));
    child.finish(json!([tool("experiment","run_web_experiment",json!({"hypothesis":{"title":"Conjecture","explanation":"Bodies differ"},"purpose":"Compare responses","repeats":2,"cases":[{"name":"attack","role":"attack","request":{"url":"/attack"},"expected":{"status":200,"body_sha256":digest("attack")}},{"name":"control","role":"legitimate_control","request":{"url":"/control"},"expected":{"status":200,"body_sha256":digest("control")}}]}))])).await;
    for expected in ["attack", "control", "attack", "control"] {
        let (socket, _) = receive(&listener).await;
        respond(socket, 200, "", expected.as_bytes()).await;
    }
    let feedback = model.next().await;
    assert_eq!(feedback.body["model"], "child");
    assert!(!outputs(&feedback.body).is_empty());
    feedback
        .answer("Experiment observed the predicted fixture difference; unverified.")
        .await;
    model
        .next()
        .await
        .finish(json!([tool(
            "submit",
            "submit_web_hypotheses",
            json!({"hypotheses":[]})
        )]))
        .await;
    let (done, _) = snapshot(joined(running).await);
    assert_eq!(
        done.result.unwrap().outcome.stop_reason,
        ScanStopReason::Submitted
    );
    let effects = effects(&f);
    assert_eq!(effects.len(), 4);
    for effect in effects {
        assert_eq!(
            effect.payload["http_context"]["account_id"],
            done.scan.http_account_id
        );
        assert_eq!(effect.session_id, done.scan.session_id);
    }
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    let accounts: u32 = db
        .query_row(
            "SELECT count(*) FROM http_accounts WHERE session_id=?1",
            [&done.scan.session_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(accounts, 1);
    assert_eq!(model.count(), 4);
    quiet(&listener).await;
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn scan_crash_child() {
    let Ok(path) = std::env::var("ZERO_SCAN_CRASH_FIXTURE") else {
        return;
    };
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
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
                zero_provider::Endpoint::responses(v["provider"].as_str().unwrap(), None).unwrap(),
                std::time::Duration::from_secs(10),
                262144,
            )
            .unwrap(),
            zero_protocol::model::Rates {
                input: 1000000,
                cached_input: 1000000,
                output: 1000000,
            },
        )
        .unwrap();
    engine.configure_scan("web", profile()).unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(512);
    let reply = engine
        .handle(command(v["target"].as_str().unwrap()), tx)
        .await;
    panic!("owner death fixture unexpectedly ended {reply:?}");
}
struct OwnedProcess(std::process::Child);
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[tokio::test]
async fn real_owner_death_keeps_partial_http_and_recovery_report_inert() {
    use tokio::io::AsyncWriteExt;
    let f = setup();
    let (listener, policy) = target().await;
    let url = policy.base_url.clone();
    let mut model = Http::new().await;
    let config = f.dir.path().join("crash.json");
    std::fs::write(&config,serde_json::to_vec(&json!({"db":f.dir.path().join("state.db"),"policy":policy,"provider":model.url,"target":url})).unwrap()).unwrap();
    let mut process = OwnedProcess(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "scan_crash_child", "--nocapture"])
            .env("ZERO_SCAN_CRASH_FIXTURE", &config)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    model
        .next()
        .await
        .finish(json!([tool(
            "observe",
            "http_request",
            json!({"url":"/held"})
        )]))
        .await;
    let (mut socket, _) = receive(&listener).await;
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length:100\r\n\r\npartial")
        .await
        .unwrap();
    let initial = current(&f);
    process.0.kill().unwrap();
    process.0.wait().unwrap();
    drop(process);
    let before =
        zero_engine::read_scan_status(&f.dir.path().join("state.db"), &initial.scan.id).unwrap();
    assert_eq!(before.controller_status, OperationStatus::Running);
    let engine = f.engine();
    let recovered =
        zero_engine::read_scan_status(&f.dir.path().join("state.db"), &initial.scan.id).unwrap();
    assert_eq!(recovered.controller_status, OperationStatus::Unknown);
    assert_eq!(recovered.root_status, OperationStatus::Unknown);
    assert!(recovered.result.is_none());
    let report =
        zero_engine::read_scan_report(&f.dir.path().join("state.db"), &initial.scan.id).unwrap();
    assert_eq!(report.kind, ScanReportKind::Recovery);
    assert_eq!(report.outcome.stop_reason, ScanStopReason::Unknown);
    assert_eq!(report.web.unwrap().observations.len(), 1);
    let (retry, duplicate) = snapshot(call(&engine, command(&url)).await);
    assert!(duplicate);
    assert_eq!(retry.scan, initial.scan);
    model.quiet().await;
    quiet(&listener).await;
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    db.execute("DELETE FROM events WHERE kind='operation_unknown' AND json_extract(payload,'$.operation_id')=?1",[&initial.scan.controller_operation_id]).unwrap();
    assert!(
        zero_engine::read_scan_report(&f.dir.path().join("state.db"), &initial.scan.id).is_err()
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancel_drains_joined_http_and_retains_original_account_hold() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = setup();
    let (listener, policy) = target().await;
    let url = policy.base_url.clone();
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    let mut p = profile();
    p.delegation_policy=Some(serde_json::from_value(json!({"max_parallel":1,"max_children":1,"roles":[{"name":"investigator","provider":"fixture","model":"child","instructions":"Inspect one response.","description":"Inspect fixture","tools":["http_request"],"max_turns":2,"reservation_per_turn":5}]})).unwrap());
    engine.configure_scan("web", p).unwrap();
    let running = start(engine.clone(), command(&url));
    model
        .next()
        .await
        .finish(json!([tool(
            "delegate",
            "delegate_tasks",
            json!({"tasks":[{"role":"investigator","prompt":"Inspect fixture response."}]})
        )]))
        .await;
    let child = model.next().await;
    assert_eq!(child.body["model"], "child");
    assert_eq!(child.body["tools"].as_array().unwrap().len(), 1);
    assert_eq!(child.body["tools"][0]["name"], "http_request");
    child
        .finish(json!([tool(
            "request",
            "http_request",
            json!({"url":"/held"})
        )]))
        .await;
    let (mut socket, _) = receive(&listener).await;
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length:100\r\n\r\npartial")
        .await
        .unwrap();
    let initial = current(&f);
    assert!(matches!(
        call(
            &engine,
            Command::CancelScan {
                scan_id: initial.scan.id.clone()
            }
        )
        .await,
        Reply::ScanCancelled { accepted: true, .. }
    ));
    let (done, _) = snapshot(joined(running).await);
    let result = done.result.unwrap();
    assert_eq!(result.outcome.stop_reason, ScanStopReason::Unknown);
    assert_eq!(
        result.outcome.close_reason,
        Some(ScanCloseReason::Cancelled)
    );
    assert_eq!(result.outcome.http_usage.requests, 1);
    assert!(result.outcome.http_usage.response_reserved_bytes > 0);
    assert_eq!(result.outcome.budget.reserved, 0);
    let mut byte = [0; 1];
    let closed = tokio::time::timeout(std::time::Duration::from_secs(2), socket.read(&mut byte))
        .await
        .unwrap();
    assert!(
        matches!(closed, Ok(0))
            || matches!(closed, Err(ref e) if e.kind() == std::io::ErrorKind::ConnectionReset),
        "owned HTTP socket remained open: {closed:?}"
    );
    assert_eq!(model.count(), 2);
    model.quiet().await;
    quiet(&listener).await;
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    let running:u32=db.query_row("SELECT count(*) FROM operations WHERE session_id=?1 AND status IN ('running','admitted')",[&done.scan.session_id],|r|r.get(0)).unwrap();
    assert_eq!(running, 0);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn repository_targets_reject_before_configuration_or_scan_admission() {
    let f = setup();
    let engine = f.engine();
    for target in [
        "https://github.com/owner/repository",
        "https://example.test/repository.git?ref=main",
        "npm:fixture",
    ] {
        let reply = call(&engine, command(target)).await;
        assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
        assert!(
            !serde_json::to_string(&reply)
                .unwrap()
                .contains("not configured")
        );
    }
    let mut policy = policy("https://github.com/".into());
    policy.in_scope = vec!["github.com".into()];
    engine
        .configure_http("target", zero_http::Client::new(policy, None).unwrap())
        .unwrap();
    engine.configure_scan("web", profile()).unwrap();
    for target in [
        "https://github.com:443/owner/repository",
        "https://%67ithub.com/owner/repository",
    ] {
        let reply = call(&engine, command(target)).await;
        assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
        assert!(
            serde_json::to_string(&reply)
                .unwrap()
                .contains("repository"),
            "{reply:?}"
        );
    }
    let db = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    for table in [
        "scans",
        "sessions",
        "operations",
        "http_accounts",
        "reservations",
    ] {
        let count: u64 = db
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "rejected target created {table}");
    }
    engine.shutdown().await.unwrap();
}
