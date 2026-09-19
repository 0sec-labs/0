#![cfg(target_os = "linux")]
mod support;
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::*;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use zero_plugin::{Capability, Schema};
use zero_plugin_runner::*;
const WORKER: &str = r#"
import json,sys,os,time
mode = MODE
count = 0
callback = 0
def emit(v):
    print(json.dumps(v),flush=True)
emit({'type':'ready','version':1})
for line in sys.stdin:
    request=json.loads(line)
    if request['type']=='shutdown':
        if mode=='trailing': print('malformed',flush=True)
        break
    assert request['type']=='invoke'
    count+=1
    if mode=='hang': time.sleep(60)
    if mode=='flood':
        print('x'*1100000,flush=True)
        time.sleep(60)
    if mode=='wrong':
        emit({'type':'result','id':request['id']+1,'result':{}})
        continue
    result={'count':count,'pid':os.getpid()}
    if mode in ('callback','replay','schema','unknown'):
        callback+=1
        emit({'type':'capability_request','call_id':request['id'],'id':callback,
              'operation':'missing' if mode=='unknown' else 'host.inspect',
              'input':{'extra':True} if mode=='schema' else {}})
        reply=json.loads(sys.stdin.readline())
        result['callback']=reply
        if mode=='replay':
            emit({'type':'capability_request','call_id':request['id'],'id':callback,'operation':'host.inspect','input':{}})
            time.sleep(60)
    emit({'type':'result','id':request['id'],'result':result})
"#;
fn fixture(capability: Capability, mode: &str) -> Fixture {
    let script = WORKER.replace("MODE", &serde_json::to_string(mode).unwrap());
    let f = Fixture::new(capability, "echo", "", script.as_bytes());
    fs::write(f.dir.path().join("worker.py"), script).unwrap();
    let fake = include_str!("../../zero-executor/tests/fixtures/fake-docker.py")
        .replace(
            "sys.stdout.buffer.write(sys.stdin.buffer.read())",
            "exec((root / 'worker.py').read_text())",
        )
        .replace(
            "(\"hang\", \"cancel\", \"cleanup-fail\")",
            "(\"hang\", \"cancel\")",
        );
    fs::write(f.dir.path().join("docker"), fake).unwrap();
    f
}
#[derive(Default)]
struct Counter {
    calls: AtomicUsize,
    started: Notify,
    release: Notify,
    mode: u8,
}
struct Handler(Arc<Counter>);
impl HostCapability for Handler {
    fn invoke(
        &self,
        request: AuthorizedCapability,
        cancel: CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = CapabilityOutcome> + Send>> {
        let state = self.0.clone();
        Box::pin(async move {
            assert_eq!(request.operation(), "host.inspect");
            assert_eq!(request.input(), &json!({}));
            assert!(!request.pin().lease_id.is_empty());
            assert!(request.request_id() > 0);
            let n = state.calls.fetch_add(1, Ordering::SeqCst) + 1;
            state.started.notify_one();
            if state.mode == 1 {
                cancel.cancelled().await;
            }
            if state.mode == 2 {
                state.release.notified().await;
            }
            if state.mode == 3 {
                panic!("fixture broker panic");
            }
            CapabilityOutcome {
                reply: match state.mode {
                    5 => Ok(json!("x".repeat(100_001))),
                    6 => Err(zero_plugin::RpcError {
                        code: -1,
                        message: "x".repeat(4097),
                    }),
                    _ => Ok(json!({"host_count":n})),
                },
                settled: state.mode != 4,
            }
        })
    }
}
fn handlers(cap: Capability, state: Arc<Counter>) -> BTreeMap<String, CapabilityHandler> {
    BTreeMap::from([(
        "host.inspect".into(),
        CapabilityHandler {
            capability: cap,
            parameters: Schema::Object {
                properties: BTreeMap::new(),
                required: vec![],
                additional_properties: false,
            },
            handler: Arc::new(Handler(state)),
        },
    )])
}
fn start(
    f: &mut Fixture,
    handlers: BTreeMap<String, CapabilityHandler>,
    limits: WorkerLimits,
) -> (RunningWorker, WorkerReply) {
    let call = f.call();
    let mut launch = launch();
    launch.timeout_ms = 5000;
    launch.max_output_bytes = 1_048_576;
    f.runner
        .start_worker_in(
            &f.harness,
            call,
            "fixture",
            launch,
            limits,
            handlers,
            &f.dir.path().join("worker-stage"),
            CancellationToken::new(),
            sink(),
        )
        .ok()
        .unwrap()
}
fn value(reply: UntrustedReply) -> serde_json::Value {
    match reply {
        UntrustedReply::Result(v) => v,
        other => panic!("{other:?}"),
    }
}
#[tokio::test]
async fn persistent_process_multiple_leases_and_authorized_bidirectional_callbacks() {
    let mut f = fixture(Capability::Network, "callback");
    let state = Arc::new(Counter::default());
    let (mut worker, first) = start(
        &mut f,
        handlers(Capability::Network, state.clone()),
        WorkerLimits::default(),
    );
    let first = value(first.wait().await.unwrap());
    assert_eq!(first["callback"]["result"]["host_count"], 1);
    let call = f.call();
    let second = value(
        worker
            .submit(&f.harness, call)
            .ok()
            .unwrap()
            .wait()
            .await
            .unwrap(),
    );
    assert_eq!(first["pid"], second["pid"]);
    assert_eq!(second["count"], 2);
    assert_eq!(second["callback"]["result"]["host_count"], 2);
    assert_eq!(f.harness.unreleased(None, None, 64).unwrap().len(), 2);
    let mut outcome = worker.finish().await.unwrap();
    assert!(outcome.backend_settled(), "{:?}", outcome.error);
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert_eq!(outcome.calls.len(), 2);
    assert!(!f.dir.path().join("worker-stage").exists());
    for c in &mut outcome.calls {
        f.harness.complete_settled(&mut c.call).unwrap();
    }
    assert!(f.harness.unreleased(None, None, 64).unwrap().is_empty());
    let calls = fs::read_to_string(f.dir.path().join("calls.jsonl")).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|l| l.starts_with("[\"create\""))
            .count(),
        1
    );
    assert!(calls.contains("--read-only") && calls.contains("none"));
}
#[tokio::test]
async fn captured_grants_operation_allowlist_and_schema_each_gate_host_effects() {
    for (mode, plugin_cap, host_cap) in [
        ("callback", Capability::Compute, Capability::Network),
        ("unknown", Capability::Network, Capability::Network),
        ("schema", Capability::Network, Capability::Network),
    ] {
        let mut f = fixture(plugin_cap, mode);
        let state = Arc::new(Counter::default());
        let (worker, first) = start(
            &mut f,
            handlers(host_cap, state.clone()),
            WorkerLimits::default(),
        );
        let reply = value(first.wait().await.unwrap());
        assert_eq!(reply["callback"]["type"], "capability_error");
        assert_eq!(state.calls.load(Ordering::SeqCst), 0);
        let outcome = worker.finish().await.unwrap();
        assert!(outcome.backend_settled());
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
    }
}
#[tokio::test]
async fn callback_replay_never_dispatches_twice() {
    let mut f = fixture(Capability::Network, "replay");
    let state = Arc::new(Counter::default());
    let (worker, first) = start(
        &mut f,
        handlers(Capability::Network, state.clone()),
        WorkerLimits::default(),
    );
    assert!(first.wait().await.is_err());
    let outcome = worker.finish().await.unwrap();
    assert!(outcome.error.is_some());
    assert!(outcome.backend_settled());
    assert_eq!(state.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn malformed_trailing_wrong_correlation_and_output_flood_fail_closed() {
    for mode in ["trailing", "wrong", "flood"] {
        let mut f = fixture(Capability::Compute, mode);
        let (worker, first) = start(&mut f, BTreeMap::new(), WorkerLimits::default());
        let _ = first.wait().await;
        let outcome = worker.finish().await.unwrap();
        assert!(outcome.error.is_some(), "{mode}");
        assert!(outcome.backend_settled(), "{mode}");
        assert!(!f.dir.path().join("container.json").exists());
    }
}
#[tokio::test]
async fn cancel_joins_cooperative_broker_and_container_before_settlement() {
    let mut f = fixture(Capability::Network, "callback");
    let state = Arc::new(Counter {
        mode: 1,
        ..Default::default()
    });
    let (worker, first) = start(
        &mut f,
        handlers(Capability::Network, state.clone()),
        WorkerLimits::default(),
    );
    state.started.notified().await;
    worker.cancel();
    assert!(first.wait().await.is_err());
    let outcome = worker.finish().await.unwrap();
    assert!(outcome.backend_settled());
    assert_eq!(outcome.status, WorkerStatus::Cancelled);
    assert!(outcome.pending_capability.is_none());
    assert!(!f.dir.path().join("container.json").exists());
}
#[tokio::test]
async fn unknown_broker_teardown_retains_owned_recovery_and_all_leases() {
    let mut f = fixture(Capability::Network, "callback");
    let state = Arc::new(Counter {
        mode: 2,
        ..Default::default()
    });
    let (worker, first) = start(
        &mut f,
        handlers(Capability::Network, state.clone()),
        WorkerLimits {
            broker_drain_ms: 20,
            ..Default::default()
        },
    );
    state.started.notified().await;
    worker.cancel();
    assert!(first.wait().await.is_err());
    let mut outcome = worker.finish().await.unwrap();
    assert!(!outcome.backend_settled());
    assert_eq!(outcome.status, WorkerStatus::Unknown);
    assert!(outcome.staging_recovery.as_ref().unwrap().exists());
    assert_eq!(f.harness.unreleased(None, None, 64).unwrap().len(), 1);
    state.release.notify_one();
    assert!(
        outcome
            .pending_capability
            .take()
            .unwrap()
            .wait()
            .await
            .unwrap()
            .settled
    );
    fs::remove_dir_all(outcome.staging_recovery.take().unwrap()).unwrap();
}
#[tokio::test]
async fn panicking_or_explicitly_unsettled_handler_cannot_release_lease() {
    for mode in [3, 4] {
        let mut f = fixture(Capability::Network, "callback");
        let state = Arc::new(Counter {
            mode,
            ..Default::default()
        });
        let (worker, first) = start(
            &mut f,
            handlers(Capability::Network, state),
            WorkerLimits::default(),
        );
        assert!(first.wait().await.is_err());
        let outcome = worker.finish().await.unwrap();
        assert!(!outcome.backend_settled());
        assert_eq!(outcome.status, WorkerStatus::Unknown);
        assert_eq!(f.harness.unreleased(None, None, 64).unwrap().len(), 1);
        fs::remove_dir_all(outcome.staging_recovery.unwrap()).unwrap();
    }
}
#[tokio::test]
async fn separate_issuer_and_call_limit_reject_before_enqueue() {
    let mut f = fixture(Capability::Compute, "plain");
    let mut other = fixture(Capability::Compute, "plain");
    let (mut worker, first) = start(
        &mut f,
        BTreeMap::new(),
        WorkerLimits {
            max_calls: 2,
            ..Default::default()
        },
    );
    first.wait().await.unwrap();
    let foreign = other.call();
    let rejected = worker.submit(&f.harness, foreign).err().unwrap();
    assert_eq!(rejected.call.lease().owner, "fixture-owner");
    // Passing the foreign Harness too must not authorize its otherwise identical
    // graph/epoch/plugin into this process owner's worker.
    let foreign = other.call();
    assert_eq!(foreign.pin().generation, f.pin);
    assert!(worker.submit(&other.harness, foreign).is_err());
    let call = f.call();
    worker
        .submit(&f.harness, call)
        .ok()
        .unwrap()
        .wait()
        .await
        .unwrap();
    let call = f.call();
    assert!(worker.submit(&f.harness, call).is_err());
    assert!(worker.finish().await.unwrap().backend_settled());
}
#[tokio::test]
async fn dropping_handle_cancels_broker_and_keeps_durable_lease() {
    let mut f = fixture(Capability::Network, "callback");
    let state = Arc::new(Counter {
        mode: 1,
        ..Default::default()
    });
    let (worker, _first) = start(
        &mut f,
        handlers(Capability::Network, state.clone()),
        WorkerLimits::default(),
    );
    state.started.notified().await;
    let stage = worker.staging_path().to_owned();
    drop(worker);
    tokio::time::timeout(Duration::from_secs(5), async {
        while stage.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(f.harness.unreleased(None, None, 64).unwrap().len(), 1);
    assert!(!f.dir.path().join("container.json").exists());
}
#[tokio::test]
async fn callback_limit_and_bounded_pending_calls_do_not_grant_more_work() {
    let mut f = fixture(Capability::Network, "callback");
    let state = Arc::new(Counter::default());
    let (mut worker, first) = start(
        &mut f,
        handlers(Capability::Network, state.clone()),
        WorkerLimits {
            max_callbacks: 1,
            ..Default::default()
        },
    );
    first.wait().await.unwrap();
    let call = f.call();
    assert!(
        worker
            .submit(&f.harness, call)
            .ok()
            .unwrap()
            .wait()
            .await
            .is_err()
    );
    assert!(worker.finish().await.unwrap().backend_settled());
    assert_eq!(state.calls.load(Ordering::SeqCst), 1);
    let mut f = fixture(Capability::Network, "callback");
    let state = Arc::new(Counter {
        mode: 1,
        ..Default::default()
    });
    let (mut worker, _first) = start(
        &mut f,
        handlers(Capability::Network, state.clone()),
        WorkerLimits::default(),
    );
    state.started.notified().await;
    let call = f.call();
    let waiting = worker.submit(&f.harness, call).ok().unwrap();
    let call = f.call();
    assert!(worker.submit(&f.harness, call).is_err());
    worker.cancel();
    let outcome = worker.finish().await.unwrap();
    assert!(waiting.wait().await.is_err());
    assert_eq!(outcome.calls.len(), 2);
    assert!(outcome.backend_settled());
}
#[tokio::test]
async fn container_cleanup_uncertainty_keeps_staging_and_generation_lease() {
    let mut f = fixture(Capability::Compute, "plain");
    fs::write(f.dir.path().join("scenario.txt"), "cleanup-fail").unwrap();
    let (worker, first) = start(&mut f, BTreeMap::new(), WorkerLimits::default());
    first.wait().await.unwrap();
    let outcome = worker.finish().await.unwrap();
    assert!(!outcome.backend_settled());
    assert_eq!(outcome.status, WorkerStatus::Unknown);
    assert!(outcome.error.is_some());
    assert_eq!(f.harness.unreleased(None, None, 64).unwrap().len(), 1);
    // Fake Docker has no daemon. Remove fixture-only retained snapshots.
    fs::remove_dir_all(outcome.staging_recovery.unwrap()).unwrap();
    if let zero_protocol::sandbox::SandboxCleanup::Unconfirmed {
        recovery:
            zero_protocol::sandbox::SandboxRecovery::Docker {
                snapshot_dir: Some(path),
                ..
            },
    } = outcome.sandbox.cleanup
    {
        fs::remove_dir_all(path).unwrap();
    }
}
#[tokio::test]
async fn overall_deadline_cancels_and_joins_broker_without_new_budget_or_timeout() {
    let mut f = fixture(Capability::Network, "callback");
    let state = Arc::new(Counter {
        mode: 1,
        ..Default::default()
    });
    let call = f.call();
    let mut launch = launch();
    launch.timeout_ms = 500;
    let (worker, first) = f
        .runner
        .start_worker_in(
            &f.harness,
            call,
            "fixture",
            launch,
            WorkerLimits::default(),
            handlers(Capability::Network, state.clone()),
            &f.dir.path().join("worker-stage"),
            CancellationToken::new(),
            sink(),
        )
        .ok()
        .unwrap();
    assert!(first.wait().await.is_err());
    let outcome = worker.finish().await.unwrap();
    assert!(outcome.backend_settled());
    assert_eq!(outcome.status, WorkerStatus::TimedOut);
    assert!(outcome.error.is_some());
    assert_eq!(state.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
#[ignore = "requires an already-installed local python:3.12-alpine image; never pulls"]
async fn actual_offline_python_worker_persists_across_calls() {
    let script = WORKER.replace("MODE", "'plain'");
    let mut f = Fixture::new(Capability::Compute, "echo", "", script.as_bytes());
    f.runner = Runner::new(zero_sandbox::SandboxExecutor::new());
    let call = f.call();
    let mut launch = launch();
    launch.interpreter = vec!["python3".into(), "-u".into()];
    launch.backend = zero_protocol::sandbox::SandboxBackend::Docker {
        image: "python:3.12-alpine".into(),
    };
    launch.timeout_ms = 10000;
    let (mut worker, first) = f
        .runner
        .start_worker_in(
            &f.harness,
            call,
            "fixture",
            launch,
            WorkerLimits::default(),
            BTreeMap::new(),
            &f.dir.path().join("worker-stage"),
            CancellationToken::new(),
            sink(),
        )
        .ok()
        .unwrap();
    let first = value(first.wait().await.unwrap());
    let call = f.call();
    let second = value(
        worker
            .submit(&f.harness, call)
            .ok()
            .unwrap()
            .wait()
            .await
            .unwrap(),
    );
    assert_eq!(first["pid"], second["pid"]);
    assert_eq!(second["count"], 2);
    let outcome = worker.finish().await.unwrap();
    assert!(outcome.backend_settled());
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
}
#[tokio::test]
async fn activation_drains_old_worker_without_repinning_or_accepting_new_generation_calls() {
    use std::collections::BTreeSet;
    use zero_evolution::{
        EvaluationDecision, EvaluationReceipt, PreparedState, Registry, RuntimeLifecycle,
    };
    use zero_harness::HostGrants;
    let mut f = fixture(Capability::Compute, "plain");
    let (mut worker, first) = start(&mut f, BTreeMap::new(), WorkerLimits::default());
    let first = value(first.wait().await.unwrap());
    let old_issued = f.call();
    let mut registry =
        Registry::open(f.dir.path().join("evo.sqlite"), "ignored", &json!({})).unwrap();
    let mut manifest = registry.generation(&f.pin.generation).unwrap();
    let bytes = registry
        .artifact(&manifest.components["plugin:fixture"])
        .unwrap();
    let mut plugin: zero_plugin::Manifest = serde_json::from_slice(&bytes).unwrap();
    plugin.version = "1.0.1".into();
    manifest.components.insert(
        "plugin:fixture".into(),
        registry
            .put_artifact(&serde_json::to_vec(&plugin).unwrap())
            .unwrap(),
    );
    let next = registry.register_generation(&manifest).unwrap();
    let evaluator = registry
        .put_artifact(b"fixture evaluator, not a production qualification")
        .unwrap();
    let evidence = registry
        .put_artifact(b"lifecycle fixture evidence")
        .unwrap();
    let receipt = registry
        .record_evaluation(&EvaluationReceipt {
            candidate: next.clone(),
            baseline: f.pin.generation.clone(),
            evaluator_artifact: evaluator.clone(),
            policy_artifact: manifest.policy_artifact.clone(),
            evidence_artifacts: BTreeMap::from([("fixture".into(), evidence)]),
            decision: EvaluationDecision::Eligible,
            observations: json!({"fixture":true}),
        })
        .unwrap();
    let eligibility = registry
        .admit_eligibility(
            &next,
            &receipt,
            &f.pin.generation,
            &evaluator,
            &manifest.policy_artifact,
        )
        .unwrap();
    let grants = HostGrants::new(BTreeMap::from([(
        "fixture".into(),
        zero_plugin::HostPolicy {
            enabled: true,
            trusted: false,
            grants: BTreeSet::from([Capability::Compute]),
        },
    )]));
    let switch = f
        .harness
        .prepare_activation(
            &next,
            &eligibility,
            &f.harness.current().unwrap(),
            &grants,
            |m, s| {
                Ok(PreparedState {
                    state_schema: m.state_schema.clone(),
                    state: s.state.clone(),
                })
            },
        )
        .unwrap();
    let next_pin = f.harness.commit(switch).unwrap();
    assert_eq!(
        f.harness.lifecycle(&f.pin.generation).unwrap(),
        RuntimeLifecycle::Draining { leases: 2 }
    );
    assert!(
        f.harness
            .begin_call(&f.pin, "fixture-owner", "fixture", "inspect", json!({}))
            .is_err()
    );
    let new_call = f
        .harness
        .begin_call(&next_pin, "fixture-owner", "fixture", "inspect", json!({}))
        .unwrap();
    let mut rejected = worker.submit(&f.harness, new_call).err().unwrap();
    f.harness.complete_settled(&mut rejected.call).unwrap();
    let old_reply = value(
        worker
            .submit(&f.harness, old_issued)
            .ok()
            .unwrap()
            .wait()
            .await
            .unwrap(),
    );
    assert_eq!(old_reply["pid"], first["pid"]);
    let mut outcome = worker.finish().await.unwrap();
    assert_eq!(outcome.status, WorkerStatus::Completed);
    for c in &mut outcome.calls {
        assert_eq!(c.call.pin().generation, f.pin);
        f.harness.complete_settled(&mut c.call).unwrap();
    }
    assert_eq!(
        f.harness.lifecycle(&f.pin.generation).unwrap(),
        RuntimeLifecycle::Inactive
    );
}
#[tokio::test]
async fn persistent_smolvm_and_completed_permits_reject_before_staging_or_dispatch() {
    let mut f = fixture(Capability::Compute, "plain");
    let call = f.call();
    let mut profile = launch();
    profile.backend = zero_protocol::sandbox::SandboxBackend::Smolvm {
        image_archive: "/missing/archive".into(),
        archive_digest: format!("sha256:{}", "0".repeat(64)),
        storage_gb: 1,
    };
    assert!(
        f.runner
            .start_worker_in(
                &f.harness,
                call,
                "fixture",
                profile,
                WorkerLimits::default(),
                BTreeMap::new(),
                &f.dir.path().join("worker-stage"),
                CancellationToken::new(),
                sink()
            )
            .is_err()
    );
    let mut call = f.call();
    f.harness.complete_settled(&mut call).unwrap();
    assert!(
        f.runner
            .start_worker_in(
                &f.harness,
                call,
                "fixture",
                launch(),
                WorkerLimits::default(),
                BTreeMap::new(),
                &f.dir.path().join("worker-stage"),
                CancellationToken::new(),
                sink()
            )
            .is_err()
    );
    assert!(!f.dir.path().join("worker-stage").exists());
    assert!(!f.dir.path().join("calls.jsonl").exists());
}

#[tokio::test]
async fn oversized_host_replies_fail_before_delivery_without_inventing_uncertain_effects() {
    for mode in [5, 6] {
        let mut f = fixture(Capability::Network, "callback");
        let state = Arc::new(Counter {
            mode,
            ..Default::default()
        });
        let (worker, first) = start(
            &mut f,
            handlers(Capability::Network, state.clone()),
            WorkerLimits::default(),
        );
        assert!(first.wait().await.is_err());
        let outcome = worker.finish().await.unwrap();
        assert_eq!(outcome.status, WorkerStatus::Failed);
        assert!(outcome.backend_settled());
        assert_eq!(state.calls.load(Ordering::SeqCst), 1);
        assert!(outcome.calls[0].reply.is_none());
    }
}
