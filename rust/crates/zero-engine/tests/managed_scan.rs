#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]
#[path = "scan/mod.rs"]
mod support;
use serde_json::json;
use std::collections::BTreeMap;
use support::*;
use zero_protocol::{
    Command, Reply,
    campaign::CampaignProviderContext,
    managed_scan::*,
    model::{Rates, WireApi},
    scan::*,
};
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn grant(model: &Http, policy: &zero_protocol::http::HttpProfilePolicy) -> ManagedScanGrant {
    ManagedScanGrant {
        contract_version: MANAGED_SCAN_CONTRACT.into(),
        cloud_scan_id: "11111111-1111-4111-8111-111111111111".into(),
        organization_id: "22222222-2222-4222-8222-222222222222".into(),
        dispatch_id: "33333333-3333-4333-8333-333333333333".into(),
        grant_revision: "host-policy-1".into(),
        expires_at_ms: now() + 10000,
        target: zero_http::normalize_target(policy, &format!("{}/fixture", policy.base_url))
            .unwrap(),
        scan_profile_name: "web".into(),
        scan_profile: profile(),
        http_policy: zero_http::normalize_policy(policy.clone()).unwrap(),
        providers: BTreeMap::from([(
            "fixture".into(),
            CampaignProviderContext {
                endpoint: model.url.clone(),
                wire_api: WireApi::Responses,
                rates: Rates {
                    input: 1_000_000,
                    cached_input: 1_000_000,
                    output: 1_000_000,
                },
                hosted_catalog: None,
            },
        )]),
    }
}
fn run(g: &ManagedScanGrant) -> Command {
    Command::RunManagedScan {
        grant: Box::new(g.clone()),
    }
}
#[tokio::test]
async fn managed_real_http_retains_grant_and_offline_retry_cannot_change_authority() {
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let e = configure(&f, &policy);
    model.configure(&e);
    e.configure_scan("web", profile()).unwrap();
    let g = grant(&model, &policy);
    let running = start(e.clone(), run(&g));
    model
        .next()
        .await
        .finish(json!([tool(
            "get",
            "http_request",
            json!({"url":"/fixture","method":"GET"})
        )]))
        .await;
    let (socket, bytes) = receive(&listener).await;
    assert!(bytes.starts_with(b"GET /fixture "));
    respond(socket, 200, "", b"native").await;
    model
        .next()
        .await
        .finish(json!([tool(
            "submit",
            "submit_web_hypotheses",
            json!({"hypotheses":[]})
        )]))
        .await;
    let (done, duplicate) = snapshot(joined(running).await);
    assert!(!duplicate);
    assert_eq!(
        done.result.as_ref().unwrap().outcome.completeness,
        ScanCompleteness::CompletedWorkflow
    );
    assert_eq!(done.http_usage.requests, 1);
    assert_eq!(done.budget.charged, 4);
    let db = f.dir.path().join("state.db");
    let store = zero_store::Store::open_read_only(&db).unwrap();
    assert_eq!(
        serde_json::to_value(store.scan_managed_grant(&done.scan.id).unwrap()).unwrap(),
        json!(g)
    );
    drop(store);
    e.shutdown().await.unwrap();
    drop(e);
    let reopened = zero_engine::Engine::open(&db, None).unwrap();
    let (retry, duplicate) = snapshot(call(&reopened, run(&g)).await);
    assert!(duplicate);
    assert_eq!(retry.scan.id, done.scan.id);
    assert_eq!(retry.budget, done.budget);
    for field in [
        "grant_revision",
        "organization_id",
        "expires_at_ms",
        "target",
    ] {
        let mut raw = json!(g);
        raw[field] = match field {
            "expires_at_ms" => json!(g.expires_at_ms + 1000),
            "organization_id" => json!("44444444-4444-4444-8444-444444444444"),
            "target" => json!(format!("{}/changed", policy.base_url)),
            _ => json!("changed"),
        };
        let changed: ManagedScanGrant = serde_json::from_value(raw).unwrap();
        assert!(
            matches!(call(&reopened, run(&changed)).await, Reply::Error { .. }),
            "{field}"
        );
    }
    assert!(matches!(
        call(
            &reopened,
            Command::RunScan {
                command_id: g.command_id(),
                target: g.target.clone(),
                profile: g.scan_profile_name.clone()
            }
        )
        .await,
        Reply::Error { .. }
    ));
    model.quiet().await;
    quiet(&listener).await;
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn changed_live_pins_and_expired_grants_reject_before_any_admission() {
    let f = setup();
    let (listener, policy) = target().await;
    let mut model = Http::new().await;
    let e = configure(&f, &policy);
    model.configure(&e);
    e.configure_scan("web", profile()).unwrap();
    let g = grant(&model, &policy);
    let mut variants = vec![];
    let mut bad = g.clone();
    bad.expires_at_ms = now() - 1;
    variants.push(bad);
    let mut bad = g.clone();
    bad.providers.get_mut("fixture").unwrap().rates.input += 1;
    variants.push(bad);
    let mut bad = g.clone();
    bad.http_policy.budget.max_requests += 1;
    variants.push(bad);
    let mut bad = g.clone();
    bad.scan_profile.budget_limit += 1;
    variants.push(bad);
    for bad in variants {
        assert!(matches!(call(&e, run(&bad)).await, Reply::Error { .. }));
    }
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    assert!(store.scan_by_command(&g.command_id()).unwrap().is_none());
    let sql = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
    for table in ["sessions", "operations", "http_accounts"] {
        let n: u64 = sql
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    model.quiet().await;
    quiet(&listener).await;
    e.shutdown().await.unwrap();
}
#[tokio::test]
async fn managed_absolute_expiry_closes_original_account_and_retry_preserves_hold() {
    let f = setup();
    let (_listener, policy) = target().await;
    let mut model = Http::new().await;
    let e = configure(&f, &policy);
    model.configure(&e);
    e.configure_scan("web", profile()).unwrap();
    let mut g = grant(&model, &policy);
    g.expires_at_ms = now() + 500;
    let running = start(e.clone(), run(&g));
    let held = model.next().await;
    let (done, _) = snapshot(joined(running).await);
    assert_eq!(done.scan.deadline_at_ms, g.expires_at_ms);
    assert_eq!(done.close_reason, Some(ScanCloseReason::Deadline));
    assert_eq!(done.budget.reserved, 10);
    let (retry, duplicate) = snapshot(call(&e, run(&g)).await);
    assert!(duplicate);
    assert_eq!(retry.budget, done.budget);
    assert_eq!(retry.scan.id, done.scan.id);
    drop(held);
    model.quiet().await;
    e.shutdown().await.unwrap();
}
