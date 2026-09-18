//! Explicit local microVM qualification, not a detector-quality or vulnerability claim.
#![cfg(target_os = "linux")]
// Test setup and assertions intentionally fail immediately on unexpected errors.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use serde_json::json;
use std::{collections::BTreeSet, fs, os::unix::fs::PermissionsExt, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use zero_engine::Engine;
use zero_protocol::{
    Command, Reply,
    model::{Rates, WireApi},
    sandbox::{SandboxArtifact, SandboxBackend, SandboxCleanup},
    session::OperationStatus,
    source::{ReviewRequest, SourceReviewRequest, VerificationState},
    verification::{
        Case, Disposition, Evidence, ExactOutput, Limits, Mode, Plan, SourceReproductionRequest,
    },
};
use zero_provider::{Endpoint, ProviderClient};

const ARCHIVE_DIGEST: &str =
    "sha256:2bda0b195b4a451d7e3c516a2c08178024f4407e60e7abfed831eb5f06444c48";

async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, mut rx) = mpsc::channel(64);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let reply = engine.handle(command, tx).await;
    drain.await.unwrap();
    reply
}

#[tokio::test]
#[ignore = "real smolvm; requires ZERO_SMOLVM_SMOKE_ARCHIVE, installed 1.14.6 and nonroot KVM access; no pulls or paid calls"]
async fn source_review_to_frozen_reproduction_and_restart_retry() {
    let archive = std::env::var("ZERO_SMOLVM_SMOKE_ARCHIVE")
        .expect("explicit existing local archive required");
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    fs::create_dir(&source).unwrap();
    let original = b"process.stdout.write(process.argv[2] + '\\n');\n";
    fs::write(source.join("app.js"), original).unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    // This executable records any accidental fallback or backend call on restart.
    let forbidden = dir.path().join("forbidden-backend");
    fs::write(
        &forbidden,
        "#!/bin/sh\nprintf invoked > \"$(dirname \"$0\")/unexpected-backend\"\nexit 97\n",
    )
    .unwrap();
    fs::set_permissions(&forbidden, fs::Permissions::from_mode(0o700)).unwrap();
    let db = dir.path().join("state.db");
    let engine = Engine::open_with_backends(
        &db,
        Some(forbidden.clone()),
        Some("/home/dev/.local/bin/smolvm".into()),
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let body = format!(
        "data: {}\n\n",
        json!({"type":"response.completed","response":{
        "id":"local-source-fixture","status":"completed",
        "output":[{"type":"function_call","call_id":"submit-1","name":"submit_source_hypotheses",
        "arguments":json!({"hypotheses":[{"title":"Fixture input is echoed","claimed_severity":"low",
        "explanation":"The fixture writes the supplied argument unchanged.",
        "citations":[{"path":"app.js","sha256":snapshot.files[0].digest,"start_line":1,"end_line":1}]}]}).to_string()}],
        "usage":{"input_tokens":1,"output_tokens":1}}})
    );
    let http = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(10), async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut data = vec![];
            loop {
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).await.unwrap();
                assert_ne!(n, 0);
                data.extend_from_slice(&buf[..n]);
                assert!(data.len() < 1_000_000);
                if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                    let length = String::from_utf8_lossy(&data[..end]).lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                    }).unwrap();
                    if data.len() >= end + 4 + length {
                        let _: serde_json::Value = serde_json::from_slice(&data[end+4..end+4+length]).unwrap();
                        break;
                    }
                }
            }
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }).await.unwrap();
    });
    engine
        .configure_provider(
            "local",
            ProviderClient::with_wire(
                Endpoint::responses(&url, None).unwrap(),
                WireApi::Responses,
                Duration::from_secs(10),
                65536,
            )
            .unwrap(),
            Rates {
                input: 1_000_000,
                cached_input: 1_000_000,
                output: 1_000_000,
            },
        )
        .unwrap();
    let session = match call(
        &engine,
        Command::SessionCreate {
            generation: "fixture".into(),
            budget_limit: 100,
        },
    )
    .await
    {
        Reply::Session { session } => session.id,
        r => panic!("{r:?}"),
    };
    let (source_operation_id, review, bundle) = match call(
        &engine,
        Command::ReviewSource {
            session_id: session.clone(),
            command_id: "review".into(),
            request: SourceReviewRequest {
                provider: "local".into(),
                model: "local-fixture".into(),
                reservation: 5,
                source: ReviewRequest {
                    snapshot: snapshot.clone(),
                    selected_files: vec!["app.js".into()],
                    question: "Describe the harmless echo fixture".into(),
                    max_hypotheses: 1,
                },
            },
        },
    )
    .await
    {
        Reply::SourceReview {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
            (
                operation.id,
                result.review.unwrap(),
                result.artifacts["source.bundle"].clone(),
            )
        }
        r => panic!("{r:?}"),
    };
    http.await.unwrap(); // Endpoint is now closed; remaining work is entirely offline.
    assert_eq!(review.hypotheses[0].state, VerificationState::Unverified);
    let plan = Plan {
        schema_version: 1,
        oracle_version: zero_verification::ORACLE_VERSION.into(),
        hypothesis_id: review.hypotheses[0].id.clone(),
        source_bundle_digest: bundle,
        snapshot: snapshot.clone(),
        backend: SandboxBackend::Smolvm {
            image_archive: archive.into(),
            archive_digest: ARCHIVE_DIGEST.into(),
            storage_gb: 4,
        },
        limits: Limits {
            timeout_ms: 60_000,
            memory_mb: 2048,
            cpus: 2.0,
            max_output_bytes: 1024,
        },
        repeats: 2,
        cases: [
            ("attack", Mode::Attack),
            ("control", Mode::LegitimateControl),
        ]
        .into_iter()
        .map(|(id, mode)| Case {
            id: id.into(),
            mode,
            argv: vec!["node".into(), "app.js".into(), id.into()],
            stdin: None,
            expected: ExactOutput {
                exit_code: 0,
                stdout: format!("{id}\n").into_bytes(),
                stderr: vec![],
            },
            safe_expected: None,
        })
        .collect(),
    };
    let command = Command::ReproduceSource {
        session_id: session.clone(),
        command_id: "reproduce".into(),
        request: SourceReproductionRequest {
            source_operation_id,
            plan: plan.clone(),
        },
    };
    let (parent, result) = match call(&engine, command.clone()).await {
        Reply::SourceReproduction {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded, "{result:?}");
            (operation.id, result)
        }
        r => panic!("{r:?}"),
    };
    let assessment = result.assessment.as_ref().unwrap();
    assert_eq!(assessment.disposition, Disposition::ObservedForPlan);
    assert!(!assessment.vulnerability_reportable);
    assert_eq!(
        (assessment.observed_attempts, assessment.required_attempts),
        (4, 4)
    );
    assert_eq!(result.children.len(), 4);
    let store = zero_store::Store::open_read_only(&db).unwrap();
    let mut evidence = vec![];
    let mut ids = BTreeSet::new();
    for child in &result.children {
        let artifacts = store.operation_artifacts(child).unwrap();
        let item: Evidence =
            serde_json::from_slice(&store.artifact(&artifacts["reproduction.evidence"]).unwrap())
                .unwrap();
        assert!(ids.insert(item.request.execution_id.clone()));
        assert!(matches!(item.result.cleanup, SandboxCleanup::Confirmed));
        assert!(
            matches!(&item.result.artifact, SandboxArtifact::SmolvmArchive { digest } if digest == ARCHIVE_DIGEST)
        );
        assert_eq!(item.result.stdout, format!("{}\n", item.case_id).as_bytes());
        assert!(item.result.stderr.is_empty());
        assert_eq!(item.result.exit_code, Some(0));
        assert_eq!(
            store.artifact(&artifacts["reproduction.request"]).unwrap(),
            serde_json::to_vec(&item.request).unwrap()
        );
        evidence.push(item);
    }
    let recomputed = zero_verification::assess(
        &zero_verification::FrozenPlan::new(plan).unwrap(),
        &evidence,
    )
    .unwrap();
    assert_eq!(assessment.assessment_digest, recomputed.assessment_digest);
    drop(store);
    match call(
        &engine,
        Command::SessionBudget {
            session_id: session.clone(),
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => assert_eq!((budget.charged, budget.reserved), (2, 0)),
        r => panic!("{r:?}"),
    }
    engine.shutdown().await.unwrap();
    drop(engine);
    assert_eq!(fs::read(source.join("app.js")).unwrap(), original);
    assert_eq!(
        zero_executor::pin_snapshot(&source).unwrap().digest,
        snapshot.digest
    );
    assert!(!dir.path().join("unexpected-backend").exists());
    // Reopening with both launchers replaced by fail-closed recorders proves an
    // exact retry reads the journal without starting any backend or provider.
    let engine = Engine::open_with_backends(&db, Some(forbidden.clone()), Some(forbidden)).unwrap();
    match call(&engine, command).await {
        Reply::SourceReproduction {
            operation,
            result: Some(retried),
            duplicate: true,
        } => {
            assert_eq!(operation.id, parent);
            assert_eq!(
                serde_json::to_value(retried).unwrap(),
                serde_json::to_value(result).unwrap()
            );
        }
        r => panic!("{r:?}"),
    }
    assert!(!dir.path().join("unexpected-backend").exists());
    engine.shutdown().await.unwrap();
}
