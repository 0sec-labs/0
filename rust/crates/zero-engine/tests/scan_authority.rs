#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]
#[path = "scan/mod.rs"]
mod support;
use support::*;
use zero_protocol::{Command, Reply, scan::*};

#[tokio::test]
async fn generic_cancel_commits_scan_closure_before_acknowledging_and_preserves_holds() {
    let f = setup();
    let (_listener, policy) = target().await;
    let target_url = format!("{}/fixture", policy.base_url);
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    engine.configure_scan("web", profile()).unwrap();
    let running = start(engine.clone(), command(&target_url));
    let held = model.next().await;
    let initial = current(&f);
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    let root = store
        .get_operation(&initial.scan.root_operation_id)
        .unwrap();
    assert!(matches!(
        call(
            &engine,
            Command::Cancel {
                session_id: initial.scan.session_id.clone(),
                execution_id: "wrong-execution".into(),
            }
        )
        .await,
        Reply::Cancelled {
            accepted: false,
            ..
        }
    ));
    assert_eq!(
        store.scan_snapshot(&initial.scan.id).unwrap().close_reason,
        None
    );
    assert!(matches!(
        call(
            &engine,
            Command::Cancel {
                session_id: initial.scan.session_id.clone(),
                execution_id: root.command_id,
            }
        )
        .await,
        Reply::Cancelled { accepted: true, .. }
    ));
    // The acknowledgement itself implies the durable admission fence, even before joining the worker.
    assert_eq!(
        store.scan_snapshot(&initial.scan.id).unwrap().close_reason,
        Some(ScanCloseReason::Cancelled)
    );
    let (done, _) = snapshot(joined(running).await);
    let outcome = done.result.unwrap().outcome;
    assert_eq!(outcome.close_reason, Some(ScanCloseReason::Cancelled));
    assert_eq!(outcome.completeness, ScanCompleteness::Partial);
    assert_eq!(outcome.budget.reserved, 10);
    let request = zero_protocol::model::ResponsesRequest {
        model: "fixture-model".into(),
        instructions: "Unauthorized second effect".into(),
        input: vec![],
        tools: vec![],
        max_output_tokens: 16,
    };
    assert!(matches!(
        call(
            &engine,
            Command::Infer {
                session_id: initial.scan.session_id,
                command_id: "bypass-after-cancel".into(),
                provider: "fixture".into(),
                reservation: 1,
                request,
            }
        )
        .await,
        Reply::Error { .. }
    ));
    drop(held);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_closes_scan_before_drain_and_exact_reopen_never_replays_provider_work() {
    let f = setup();
    let (_listener, policy) = target().await;
    let target_url = format!("{}/fixture", policy.base_url);
    let mut model = Http::new().await;
    let engine = configure(&f, &policy);
    model.configure(&engine);
    engine.configure_scan("web", profile()).unwrap();
    let running = start(engine.clone(), command(&target_url));
    let held = model.next().await;
    let initial = current(&f);
    engine.shutdown().await.unwrap();
    let (done, _) = snapshot(joined(running).await);
    assert_eq!(done.close_reason, Some(ScanCloseReason::Cancelled));
    assert_eq!(done.budget.reserved, 10);
    drop(held);
    drop(engine);
    let reopened = zero_engine::Engine::open(f.dir.path().join("state.db"), None).unwrap();
    let (retry, duplicate) = snapshot(call(&reopened, command(&target_url)).await);
    assert!(duplicate);
    assert_eq!(retry.scan.id, initial.scan.id);
    assert_eq!(retry.budget.reserved, 10);
    assert_eq!(retry.close_reason, Some(ScanCloseReason::Cancelled));
    reopened.shutdown().await.unwrap();
}
