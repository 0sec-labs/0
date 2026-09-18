#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    time::Duration,
};
use tokio::sync::mpsc;
use zero_engine::Engine;
use zero_evolution::{Manifest, PreparedState, Registry};
use zero_harness::{Harness, HostGrants};
use zero_plugin::{Artifact, Capability, EntryPoint, HostPolicy, Schema, Tool};
use zero_plugin_runner::Launch;
use zero_protocol::{
    Command, ExecutionEvent, Reply,
    sandbox::{SandboxBackend, SandboxCleanup, SandboxEvent, SandboxRecovery},
    session::OperationStatus,
};
struct Fixture {
    dir: tempfile::TempDir,
    engine_artifact: String,
    generation: String,
    eligibility: String,
    capability: Capability,
}
impl Fixture {
    fn new(capability: Capability, scenario: &str, reply: &str, script: &[u8]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::open(dir.path().join("evo.sqlite"), "v1", &json!({})).unwrap();
        let engine = r.put_artifact(b"fixtureengine").unwrap();
        let blob = r.put_artifact(script).unwrap();
        let digest = blob.strip_prefix("sha256:").unwrap().to_owned();
        let plugin = zero_plugin::Manifest {
            schema_version: 1,
            protocol_version: 1,
            id: "fixture".into(),
            version: "1.0.0".into(),
            artifacts: vec![Artifact {
                sha256: digest.clone(),
                size: script.len() as u64,
            }],
            entrypoint: EntryPoint {
                artifact: digest,
                argv: vec!["{artifact}".into(), "literal ; $(false)".into()],
            },
            dependencies: vec![],
            tools: vec![Tool {
                name: "inspect".into(),
                description: "fixture".into(),
                parameters: Schema::Object {
                    properties: BTreeMap::new(),
                    required: vec![],
                    additional_properties: false,
                },
                capabilities: BTreeSet::from([capability]),
            }],
        };
        let manifest = r
            .put_artifact(&serde_json::to_vec(&plugin).unwrap())
            .unwrap();
        let grants = HostGrants::new(BTreeMap::from([(
            "fixture".into(),
            HostPolicy {
                enabled: true,
                trusted: false,
                grants: BTreeSet::from([capability]),
            },
        )]));
        let policy = r.put_artifact(&grants.artifact_bytes().unwrap()).unwrap();
        let generation = r
            .register_generation(&Manifest {
                engine_artifact: engine.clone(),
                components: BTreeMap::from([("plugin:fixture".into(), manifest)]),
                protocol_version: 1,
                state_schema: "v1".into(),
                compatible_state_schemas: vec![],
                configuration: json!({"native_plugin_graph":1}),
                policy_artifact: policy,
            })
            .unwrap();
        let eligibility = r
            .authorize_baseline(&generation, "explicit fixture")
            .unwrap();
        let mut harness = Harness::new(r, engine.clone());
        let prepared = harness
            .prepare_activation(
                &generation,
                &eligibility,
                &harness.current().unwrap(),
                &grants,
                |m, s| {
                    Ok(PreparedState {
                        state_schema: m.state_schema.clone(),
                        state: s.state.clone(),
                    })
                },
            )
            .unwrap();
        harness.commit(prepared).unwrap();
        let fake=include_str!("../../zero-executor/tests/fixtures/fake-docker.py").replace("sys.stdout.buffer.write(sys.stdin.buffer.read())","(root / 'request.json').write_bytes(sys.stdin.buffer.read())\n        sys.stdout.buffer.write((root / 'reply.jsonl').read_bytes())");
        let binary = dir.path().join("docker");
        let fake=fake.replace("elif args[0] == \"start\":", "elif args[0] == \"start\":\n    import sqlite3\n    db=sqlite3.connect(root / \"native.sqlite\")\n    records=[json.loads(row[0]) for row in db.execute(\"SELECT payload FROM events WHERE kind=\'operation_detail\'\")]\n    assert any(r.get(\"kind\")==\"plugin.prepared\" for r in records), \"guest launch preceded durable prepared event\"");
        fs::write(&binary, fake).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("scenario.txt"), scenario).unwrap();
        fs::write(dir.path().join("reply.jsonl"), reply).unwrap();
        Self {
            dir,
            engine_artifact: engine,
            generation,
            eligibility,
            capability,
        }
    }
    fn registry(&self) -> Registry {
        Registry::open(self.dir.path().join("evo.sqlite"), "unused", &json!({})).unwrap()
    }
    fn harness(&self) -> Harness {
        let mut h = Harness::new(self.registry(), self.engine_artifact.clone());
        h.restore_current(&HostGrants::new(BTreeMap::from([(
            "fixture".into(),
            HostPolicy {
                enabled: true,
                trusted: false,
                grants: BTreeSet::from([self.capability]),
            },
        )])))
        .unwrap();
        h
    }
    fn engine(&self) -> Engine {
        let engine = Engine::open(
            self.dir.path().join("native.sqlite"),
            Some(self.dir.path().join("docker")),
        )
        .unwrap();
        engine.configure_plugins(self.harness(), launch()).unwrap();
        engine
    }
    fn calls(&self) -> usize {
        fs::read_to_string(self.dir.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .count()
    }
}
fn launch() -> Launch {
    Launch {
        backend: SandboxBackend::Docker {
            image: "local:test".into(),
        },
        interpreter: vec!["node".into()],
        timeout_ms: 700,
        memory_mb: 128,
        cpus: 0.5,
        max_output_bytes: 8192,
    }
}
const REPLY: &str = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n";
async fn call(engine: &Engine, cmd: Command) -> Reply {
    let (tx, _rx) = mpsc::channel(64);
    tokio::time::timeout(Duration::from_secs(8), engine.handle(cmd, tx))
        .await
        .unwrap()
}
async fn session(engine: &Engine) -> String {
    match call(engine, Command::SessionCreatePinned { budget_limit: 100 }).await {
        Reply::Session { session } => {
            assert_eq!(session.generation_epoch, Some(1));
            session.id
        }
        r => panic!("{r:?}"),
    }
}
fn run(session: &str, id: &str) -> Command {
    Command::RunPlugin {
        session_id: session.into(),
        command_id: id.into(),
        plugin: "fixture".into(),
        tool: "inspect".into(),
        input: json!({}),
    }
}
async fn events(engine: &Engine, session: &str) -> Vec<zero_protocol::SessionEvent> {
    match call(
        engine,
        Command::SessionEvents {
            session_id: session.into(),
            after_sequence: 0,
            limit: 100,
        },
    )
    .await
    {
        Reply::SessionEvents { events } => events,
        r => panic!("{r:?}"),
    }
}
#[tokio::test]
async fn prepare_is_durable_before_dispatch_and_retry_after_restart_has_no_effects() {
    let f = Fixture::new(Capability::Compute, "echo", REPLY, b"fixture");
    let engine = f.engine();
    let session = session(&engine).await;
    let first = call(&engine, run(&session, "one")).await;
    let operation = match first {
        Reply::Plugin {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Succeeded);
            assert!(result.untrusted_reply.is_some());
            assert_eq!(result.pin.unwrap().lease_owner, operation.id);
            operation
        }
        r => panic!("{r:?}"),
    };
    let journal = events(&engine, &session).await;
    let kinds: Vec<_> = journal
        .iter()
        .filter_map(|e| e.payload.get("kind").and_then(Value::as_str))
        .collect();
    assert!(kinds.contains(&"plugin.preparing"));
    assert!(kinds.contains(&"plugin.prepared"));
    assert!(kinds.contains(&"plugin.lease_released"));
    let prepared = journal
        .iter()
        .find(|e| e.payload["kind"] == "plugin.prepared")
        .unwrap();
    assert!(
        prepared.payload["details"]["request_digest"]
            .as_str()
            .unwrap()
            .len()
            == 64
    );
    assert!(
        f.registry()
            .list_unreleased_leases(Some(&operation.id), None, None, 16)
            .unwrap()
            .is_empty()
    );
    let count = f.calls();
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    match call(&engine, run(&session, "one")).await {
        Reply::Plugin {
            operation: again,
            duplicate: true,
            ..
        } => assert_eq!(again.id, operation.id),
        r => panic!("{r:?}"),
    };
    assert_eq!(f.calls(), count);
    let mut conflicting = run(&session, "one");
    if let Command::RunPlugin { input, .. } = &mut conflicting {
        *input = json!({"different":true});
    }
    assert!(matches!(call(&engine,conflicting).await,Reply::Error{code,..} if code=="conflict"));
    assert_eq!(f.calls(), count);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn stale_epoch_after_same_generation_rollback_and_unpinned_sessions_reject() {
    let f = Fixture::new(Capability::Compute, "echo", REPLY, b"fixture");
    let engine = f.engine();
    let session = session(&engine).await;
    assert!(matches!(
        call(&engine, run(&session, "one")).await,
        Reply::Plugin {
            duplicate: false,
            ..
        }
    ));
    let count = f.calls();
    let mut registry = f.registry();
    let state = registry.current().unwrap();
    let ticket = registry
        .prepare_rollback(&f.generation, &f.eligibility, &state, |m, s| {
            Ok(PreparedState {
                state_schema: m.state_schema.clone(),
                state: s.state.clone(),
            })
        })
        .unwrap();
    let changed = registry.commit(&ticket.id).unwrap();
    assert_eq!(changed.generation, state.generation);
    assert_eq!(changed.epoch, state.epoch + 1);
    let before = events(&engine, &session).await.len();
    assert!(matches!(
        call(&engine, run(&session, "stale-new")).await,
        Reply::Error { .. }
    ));
    assert_eq!(events(&engine, &session).await.len(), before);
    assert!(matches!(
        call(&engine, run(&session, "one")).await,
        Reply::Plugin {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(f.calls(), count);
    let unpinned = match call(
        &engine,
        Command::SessionCreate {
            generation: f.generation.clone(),
            budget_limit: 100,
        },
    )
    .await
    {
        Reply::Session { session } => session.id,
        r => panic!("{r:?}"),
    };
    assert!(matches!(
        call(&engine, run(&unpinned, "legacy")).await,
        Reply::Error { .. }
    ));
    assert_eq!(f.calls(), count);
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn uncertain_cleanup_retains_operation_correlated_lease_and_restart_never_retries() {
    let f = Fixture::new(Capability::Compute, "cleanup-fail", REPLY, b"fixture");
    let engine = f.engine();
    let session = session(&engine).await;
    let (id, result) = match call(&engine, run(&session, "one")).await {
        Reply::Plugin {
            operation,
            result: Some(result),
            ..
        } => {
            assert_eq!(operation.status, OperationStatus::Unknown);
            (operation.id, result)
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(
        f.registry()
            .list_unreleased_leases(Some(&id), None, None, 16)
            .unwrap()
            .len(),
        1
    );
    assert!(
        !events(&engine, &session)
            .await
            .iter()
            .any(|e| e.payload["kind"] == "plugin.lease_released")
    );
    let count = f.calls();
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = f.engine();
    assert!(matches!(
        call(&engine, run(&session, "one")).await,
        Reply::Plugin {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(f.calls(), count);
    assert_eq!(
        f.registry()
            .list_unreleased_leases(Some(&id), None, None, 16)
            .unwrap()
            .len(),
        1
    );
    engine.shutdown().await.unwrap();
    // Explicit fixture-only disposal: no real daemon/container exists.
    fs::remove_dir_all(result.staging_recovery.unwrap()).unwrap();
    if let Some(sandbox) = result.sandbox {
        if let SandboxCleanup::Unconfirmed {
            recovery:
                SandboxRecovery::Docker {
                    snapshot_dir: Some(path),
                    ..
                },
        } = sandbox.cleanup
        {
            fs::remove_dir_all(path).unwrap();
        }
    }
}
#[tokio::test]
async fn cancellation_waits_for_cleanup_before_durable_release() {
    let f = Fixture::new(Capability::Compute, "hang", REPLY, b"fixture");
    let engine = std::sync::Arc::new(f.engine());
    let session = session(&engine).await;
    let (tx, mut rx) = mpsc::channel(64);
    let cmd = run(&session, "one");
    let owner = engine.clone();
    let worker = tokio::spawn(async move { owner.handle(cmd, tx).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if matches!(
                rx.recv().await,
                Some(ExecutionEvent::Sandbox {
                    event: SandboxEvent::Output { .. }
                })
            ) {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        call(
            &engine,
            Command::Cancel {
                session_id: session.clone(),
                execution_id: "one".into()
            }
        )
        .await,
        Reply::Cancelled { accepted: true, .. }
    ));
    let operation = match worker.await.unwrap() {
        Reply::Plugin {
            operation,
            result: Some(result),
            ..
        } => {
            assert!(matches!(
                result.sandbox.unwrap().cleanup,
                SandboxCleanup::Confirmed
            ));
            assert_eq!(operation.status, OperationStatus::Cancelled);
            operation
        }
        r => panic!("{r:?}"),
    };
    assert!(
        f.registry()
            .list_unreleased_leases(Some(&operation.id), None, None, 16)
            .unwrap()
            .is_empty()
    );
    assert!(!f.dir.path().join("container.json").exists());
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn unsupported_capability_and_invalid_launch_cannot_start_processes() {
    let f = Fixture::new(Capability::Network, "echo", REPLY, b"fixture");
    let engine = f.engine();
    let session = session(&engine).await;
    let operation = match call(&engine, run(&session, "denied")).await {
        Reply::Plugin {
            operation,
            result: Some(result),
            ..
        } => {
            assert!(result.error.unwrap().contains("offline"));
            assert!(result.sandbox.is_none());
            assert_eq!(operation.status, OperationStatus::Failed);
            operation
        }
        r => panic!("{r:?}"),
    };
    assert_eq!(f.calls(), 0);
    assert!(
        f.registry()
            .list_unreleased_leases(Some(&operation.id), None, None, 16)
            .unwrap()
            .is_empty()
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    let engine = Engine::open(f.dir.path().join("native.sqlite"), None).unwrap();
    let mut invalid = launch();
    invalid.timeout_ms = 1;
    assert!(engine.configure_plugins(f.harness(), invalid).is_err());
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn intent_journal_failure_settles_without_lease_or_dispatch() {
    let f = Fixture::new(Capability::Compute, "echo", REPLY, b"fixture");
    let engine = f.engine();
    let session = session(&engine).await;
    let db = rusqlite::Connection::open(f.dir.path().join("native.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_detail BEFORE INSERT ON events WHEN NEW.kind='operation_detail' BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;").unwrap();
    let operation = match call(&engine, run(&session, "journal-fail")).await {
        Reply::Plugin {
            operation,
            result: Some(result),
            duplicate: false,
        } => {
            assert_eq!(operation.status, OperationStatus::Failed);
            assert!(!result.external_effects_started);
            assert!(result.pin.is_none());
            operation
        }
        other => panic!("{other:?}"),
    };
    assert_eq!(f.calls(), 0);
    assert!(
        f.registry()
            .list_unreleased_leases(None, None, None, 16)
            .unwrap()
            .is_empty()
    );
    match call(&engine, run(&session, "journal-fail")).await {
        Reply::Plugin {
            operation: retry,
            duplicate: true,
            ..
        } => assert_eq!(retry.id, operation.id),
        other => panic!("{other:?}"),
    }
    db.execute_batch("DROP TRIGGER reject_detail;").unwrap();
    assert!(matches!(
        call(&engine, run(&session, "next")).await,
        Reply::Plugin { .. }
    ));
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn intent_and_settlement_journal_failure_closes_admission_and_recovers_unknown() {
    let f = Fixture::new(Capability::Compute, "echo", REPLY, b"fixture");
    let engine = f.engine();
    let session = session(&engine).await;
    let db = rusqlite::Connection::open(f.dir.path().join("native.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_detail BEFORE INSERT ON events WHEN NEW.kind IN ('operation_detail','operation_settled','operation_unknown') BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;").unwrap();
    assert!(matches!(
        call(&engine, run(&session, "journal-fail")).await,
        Reply::Error { .. }
    ));
    assert!(matches!(
        call(&engine, run(&session, "next")).await,
        Reply::Error { .. }
    ));
    assert_eq!(f.calls(), 0);
    assert!(
        f.registry()
            .list_unreleased_leases(None, None, None, 16)
            .unwrap()
            .is_empty()
    );
    engine.shutdown().await.unwrap();
    drop(engine);
    db.execute_batch("DROP TRIGGER reject_detail;").unwrap();
    let engine = f.engine();
    match call(&engine, run(&session, "journal-fail")).await {
        Reply::Plugin {
            operation,
            duplicate: true,
            ..
        } => assert_eq!(operation.status, OperationStatus::Unknown),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.calls(), 0);
    engine.shutdown().await.unwrap();
}
