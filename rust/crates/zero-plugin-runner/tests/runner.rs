#![cfg(target_os = "linux")]
use serde_json::json;
use std::{fs, sync::Arc, time::Duration};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use zero_plugin::Capability;
use zero_plugin_runner::{Runner, UntrustedReply};
use zero_protocol::sandbox::{SandboxCleanup, SandboxEvent, SandboxRecovery};
use zero_sandbox::SandboxExecutor;
mod support;
use support::*;
#[tokio::test]
async fn fixed_request_and_literal_artifact_argv_return_untrusted_result_then_explicit_release() {
    let mut f = Fixture::new(Capability::Compute, "echo", REPLY, b"fixturebytes");
    let call = f.call();
    let task = f
        .runner
        .start(
            &f.harness,
            call,
            "fixture",
            launch(),
            CancellationToken::new(),
            sink(),
        )
        .ok()
        .unwrap();
    let stage = task.staging_path().to_owned();
    let mut result = task.wait().await.unwrap();
    assert!(matches!(&result.reply,Ok(UntrustedReply::Result(v)) if v["ok"]==true));
    assert!(result.backend_settled());
    assert!(!stage.exists());
    assert_eq!(f.harness.unreleased(None, None, 16).unwrap().len(), 1);
    let request: serde_json::Value =
        serde_json::from_slice(&fs::read(f.dir.path().join("request.json")).unwrap()).unwrap();
    assert_eq!(
        request,
        json!({"jsonrpc":"2.0","id":1,"method":"tool.invoke","params":{"tool":"inspect","input":{}}})
    );
    let calls = fs::read_to_string(f.dir.path().join("calls.jsonl")).unwrap();
    assert!(calls.contains("literal ; $(false)"));
    assert!(calls.contains("./plugins/"));
    assert!(calls.contains("--read-only"));
    assert!(calls.contains("none"));
    f.harness.complete_settled(&mut result.call).unwrap();
    assert!(f.harness.unreleased(None, None, 16).unwrap().is_empty());
}
#[tokio::test]
async fn callbacks_extra_wrong_id_malformed_and_nonzero_cannot_be_results() {
    for (reply, scenario) in [
        (
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tool.invoke\",\"params\":{\"tool\":\"inspect\",\"input\":{}}}\n",
            "echo",
        ),
        (
            concat!(
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":1}\n",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":2}\n"
            ),
            "echo",
        ),
        ("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":1}\n", "echo"),
        ("not json\n", "echo"),
        ("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":1}", "echo"),
        (REPLY, "nonzero"),
    ] {
        let mut f = Fixture::new(Capability::Compute, scenario, reply, b"fixture");
        let call = f.call();
        let mut outcome = f
            .runner
            .start(
                &f.harness,
                call,
                "fixture",
                launch(),
                CancellationToken::new(),
                sink(),
            )
            .ok()
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert!(outcome.reply.is_err(), "{reply}");
        assert!(outcome.backend_settled());
        f.harness.complete_settled(&mut outcome.call).unwrap();
    }
}
#[tokio::test]
async fn unsupported_capability_and_stale_handle_never_launch() {
    for capability in [
        Capability::Network,
        Capability::ModelCall,
        Capability::FindingsWrite,
    ] {
        let mut f = Fixture::new(capability, "echo", REPLY, b"fixture");
        let call = f.call();
        let mut rejection = f
            .runner
            .start(
                &f.harness,
                call,
                "fixture",
                launch(),
                CancellationToken::new(),
                sink(),
            )
            .err()
            .unwrap();
        assert!(!f.dir.path().join("calls.jsonl").exists());
        f.harness.complete_settled(&mut rejection.call).unwrap();
    }
    let mut f = Fixture::new(Capability::Compute, "echo", REPLY, b"fixture");
    let mut call = f.call();
    f.harness.complete_settled(&mut call).unwrap();
    assert!(
        f.runner
            .start(
                &f.harness,
                call,
                "fixture",
                launch(),
                CancellationToken::new(),
                sink()
            )
            .is_err()
    );
    assert!(!f.dir.path().join("calls.jsonl").exists());
}
#[tokio::test]
async fn unknown_cleanup_retains_private_staging_and_durable_lease() {
    let mut f = Fixture::new(Capability::Compute, "cleanup-fail", REPLY, b"fixture");
    let call = f.call();
    let mut limits = launch();
    limits.timeout_ms = 300;
    let result = f
        .runner
        .start(
            &f.harness,
            call,
            "fixture",
            limits,
            CancellationToken::new(),
            sink(),
        )
        .ok()
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(!result.backend_settled());
    assert!(result.reply.is_err());
    assert!(result.staging_recovery.as_ref().unwrap().exists());
    assert_eq!(f.harness.unreleased(None, None, 16).unwrap().len(), 1);
    // Fixture has no daemon/container. Remove only this fixture's retained trees.
    fs::remove_dir_all(result.staging_recovery.unwrap()).unwrap();
    if let SandboxCleanup::Unconfirmed {
        recovery:
            SandboxRecovery::Docker {
                snapshot_dir: Some(path),
                ..
            },
    } = &result.sandbox.unwrap().cleanup
    {
        fs::remove_dir_all(path).unwrap();
    }
}
#[tokio::test]
async fn dropping_waiter_keeps_owned_cleanup_and_leaves_lease_for_reconciliation() {
    let mut f = Fixture::new(Capability::Compute, "hang", REPLY, b"fixture");
    let notify = Arc::new(Notify::new());
    let ready = notify.clone();
    let events = Arc::new(move |e| {
        if matches!(e, SandboxEvent::Output { .. }) {
            ready.notify_one();
        }
    });
    let call = f.call();
    let task = f
        .runner
        .start(
            &f.harness,
            call,
            "fixture",
            launch(),
            CancellationToken::new(),
            events,
        )
        .ok()
        .unwrap();
    let stage = task.staging_path().to_owned();
    let waiter = tokio::spawn(task.wait());
    tokio::time::timeout(Duration::from_secs(3), notify.notified())
        .await
        .unwrap();
    assert!(stage.exists());
    waiter.abort();
    let _ = waiter.await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while stage.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(!f.dir.path().join("container.json").exists());
    assert_eq!(f.harness.unreleased(None, None, 16).unwrap().len(), 1);
}
#[tokio::test]
#[ignore = "requires an already-installed local node:24-alpine image; never pulls"]
async fn real_offline_node_plugin() {
    let script=br#"const fs=require('fs'); const request=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{tool:request.params.tool,uid:process.getuid(),literal:process.argv[2]}})+'\n');"#;
    let mut f = Fixture::new(Capability::Compute, "echo", REPLY, script);
    f.runner = Runner::new(SandboxExecutor::new());
    let call = f.call();
    let mut result = f
        .runner
        .start(
            &f.harness,
            call,
            "fixture",
            launch(),
            CancellationToken::new(),
            sink(),
        )
        .ok()
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(result.backend_settled());
    match &result.reply {
        Ok(UntrustedReply::Result(value)) => {
            assert_eq!(value["tool"], "inspect");
            assert_ne!(value["uid"], 0);
            assert_eq!(value["literal"], "literal ; $(false)");
        }
        other => panic!("{other:?}; {:?}", result.sandbox),
    }
    f.harness.complete_settled(&mut result.call).unwrap();
}

#[tokio::test]
async fn preparation_writes_only_owned_snapshot_and_never_dispatches() {
    let mut f = Fixture::new(Capability::Compute, "echo", REPLY, b"fixture");
    let call = f.call();
    let lease = call.lease().clone();
    let directory = f.dir.path().join("recorded-attempt");
    // A durable controller records this exact owned path before this method.
    let prepared = f
        .runner
        .prepare_in(&f.harness, call, "fixture", launch(), &directory)
        .ok()
        .unwrap();
    assert!(directory.join("plugins.json").is_file());
    assert_eq!(prepared.request_digest().unwrap().len(), 64);
    assert!(prepared.execution_id().contains(&lease.id));
    assert!(!f.dir.path().join("calls.jsonl").exists());
    drop(prepared);
    assert!(directory.exists());
    assert_eq!(f.harness.unreleased(None, None, 16).unwrap().len(), 1);
    // This test knows the dispatch permit was dropped without start.
    fs::remove_dir_all(directory).unwrap();
    f.harness.release_fenced(&lease.id, &lease.owner).unwrap();
}

#[tokio::test]
async fn preparation_never_claims_or_removes_existing_staging() {
    let mut f = Fixture::new(Capability::Compute, "echo", REPLY, b"fixture");
    let call = f.call();
    let directory = f.dir.path().join("previous-attempt");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("recovery"), b"retain").unwrap();
    let mut rejected = f
        .runner
        .prepare_in(&f.harness, call, "fixture", launch(), &directory)
        .err()
        .unwrap();
    assert!(rejected.owned_staging.is_none());
    assert_eq!(fs::read(directory.join("recovery")).unwrap(), b"retain");
    assert!(!f.dir.path().join("calls.jsonl").exists());
    f.harness.complete_settled(&mut rejected.call).unwrap();
}
