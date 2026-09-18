#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use zero_evaluation::{Case, Evaluation, Lane, Plan, ScoringPolicy};
use zero_evolution::{EvaluationDecision, Manifest, Registry};
use zero_harness::HostGrants;
use zero_plugin::{Artifact, Capability, EntryPoint, HostPolicy, Schema, Tool};
use zero_plugin_runner::{Launch, Runner};
use zero_protocol::sandbox::SandboxBackend;
use zero_sandbox::SandboxExecutor;
struct Fixture {
    dir: tempfile::TempDir,
    source: Registry,
    plan: Plan,
    grants: HostGrants,
    runner: Runner,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut source = Registry::open(
            dir.path().join("production.sqlite"),
            "v1",
            &json!({"production":"unchanged"}),
        )
        .unwrap();
        let engine = source
            .put_artifact(b"fixture engine identity not attestation")
            .unwrap();
        let evaluator = source
            .put_artifact(b"fixture evaluator identity not attestation")
            .unwrap();
        let grants = HostGrants::new(BTreeMap::from([(
            "fixture".into(),
            HostPolicy {
                enabled: true,
                trusted: false,
                grants: BTreeSet::from([Capability::Compute]),
            },
        )]));
        let policy = source
            .put_artifact(&grants.artifact_bytes().unwrap())
            .unwrap();
        let baseline = register(&mut source, &engine, &policy, false);
        let candidate = register(&mut source, &engine, &policy, true);
        let plan = Plan {
            baseline,
            candidate,
            evaluator_artifact: evaluator,
            engine_artifact: engine,
            host_policy_artifact: policy,
            plugin: "fixture".into(),
            tool: "inspect".into(),
            launch: Launch {
                backend: SandboxBackend::Docker {
                    image: format!("sha256:{}", "a".repeat(64)),
                },
                interpreter: vec!["node".into()],
                timeout_ms: 2000,
                memory_mb: 128,
                cpus: 0.5,
                max_output_bytes: 4096,
            },
            cases: vec![
                Case {
                    id: "dev".into(),
                    lane: Lane::Development,
                    input: json!({"x":1}),
                    expected: json!({"answer":1}),
                },
                Case {
                    id: "held".into(),
                    lane: Lane::HeldOut,
                    input: json!({"x":2}),
                    expected: json!({"answer":2}),
                },
                Case {
                    id: "negative".into(),
                    lane: Lane::NegativeControl,
                    input: json!({"x":0}),
                    expected: json!({"answer":0}),
                },
            ],
            repeats: 2,
            attempt_budget: 12,
            scoring: ScoringPolicy {
                minimum_cases_per_lane: 1,
                minimum_development_gain: 1,
                minimum_held_out_gain: 1,
            },
        };
        let fake=include_str!("../../zero-executor/tests/fixtures/fake-docker.py")
   .replace("state.write_text(json.dumps({\"name\": name, \"id\": container_id}))","state.write_text(json.dumps({\"name\": name, \"id\": container_id}))\n    mount = args[args.index('--mount') + 1]\n    source = pathlib.Path(mount.split('src=')[1].split(',')[0])\n    scripts = list(source.glob('plugins/*/artifacts/*'))\n    (root / 'variant.txt').write_text('candidate' if any(b'candidate fixture' in p.read_bytes() for p in scripts) else 'baseline')")
   .replace("sys.stdout.buffer.write(sys.stdin.buffer.read())","request = json.loads(sys.stdin.buffer.read())\n        with (root / 'inputs.jsonl').open('a') as seen: seen.write(json.dumps(request)+'\\n')\n        answer = request['params']['input']['x'] if (root / 'variant.txt').read_text() == 'candidate' else 0\n        print(json.dumps({'jsonrpc':'2.0','id':1,'result':{'answer':answer}}))");
        let binary = dir.path().join("docker");
        fs::write(&binary, fake).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("scenario.txt"), "echo").unwrap();
        let runner = Runner::new(SandboxExecutor::with_backends(
            zero_executor::DockerExecutor::with_binary(binary),
            zero_smolvm::SmolvmConfig::default(),
        ));
        Self {
            dir,
            source,
            plan,
            grants,
            runner,
        }
    }
    fn root(&self) -> std::path::PathBuf {
        self.dir.path().join("evaluation")
    }
    fn create(&self) -> Evaluation {
        Evaluation::create(&self.root(), &self.source, self.plan.clone(), &self.grants).unwrap()
    }
}
fn register(r: &mut Registry, engine: &str, policy: &str, candidate: bool) -> String {
    let script = if candidate {
        b"// candidate fixture\nconst fs=require('fs');const q=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{answer:q.params.input.x}}));".as_slice()
    } else {
        b"// baseline fixture\nconsole.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{answer:0}}));"
            .as_slice()
    };
    let blob = r.put_artifact(script).unwrap();
    let sha = blob.strip_prefix("sha256:").unwrap().to_owned();
    let m = zero_plugin::Manifest {
        schema_version: 1,
        protocol_version: 1,
        id: "fixture".into(),
        version: "1.0.0".into(),
        artifacts: vec![Artifact {
            sha256: sha.clone(),
            size: script.len() as u64,
        }],
        entrypoint: EntryPoint {
            artifact: sha,
            argv: vec!["{artifact}".into()],
        },
        dependencies: vec![],
        tools: vec![Tool {
            name: "inspect".into(),
            description: "fixture".into(),
            parameters: Schema::Object {
                properties: BTreeMap::from([(
                    "x".into(),
                    Schema::Integer {
                        minimum: 0,
                        maximum: 10,
                    },
                )]),
                required: vec!["x".into()],
                additional_properties: false,
            },
            capabilities: BTreeSet::from([Capability::Compute]),
        }],
    };
    let component = r.put_artifact(&serde_json::to_vec(&m).unwrap()).unwrap();
    r.register_generation(&Manifest {
        engine_artifact: engine.into(),
        components: BTreeMap::from([("plugin:fixture".into(), component)]),
        protocol_version: 1,
        state_schema: "v1".into(),
        compatible_state_schemas: vec![],
        configuration: json!({"native_plugin_graph":1}),
        policy_artifact: policy.into(),
    })
    .unwrap()
}
#[tokio::test]
async fn measured_runner_outputs_drive_eligibility_without_production_activation() {
    let f = Fixture::new();
    let before = f.source.current().unwrap();
    let mut e = f.create();
    let report = e.run(&f.runner, CancellationToken::new()).await.unwrap();
    assert_eq!(
        report.decision,
        EvaluationDecision::Eligible,
        "{:?}",
        report.reasons
    );
    assert_eq!(report.attempted, 12);
    assert_eq!(report.settled, 12);
    assert_eq!(report.reserved_slots, 0);
    assert_ne!(report.host_policy_artifact, report.scoring_policy_digest);
    assert_eq!(before, f.source.current().unwrap());
    assert!(
        f.source
            .list_unreleased_leases(None, None, None, 20)
            .unwrap()
            .is_empty()
    );
    assert!(
        e.attempts()
            .unwrap()
            .iter()
            .all(|a| !std::path::Path::new(a.staging.as_ref().unwrap()).exists())
    );
    let inputs = fs::read_to_string(f.dir.path().join("inputs.jsonl")).unwrap();
    assert!(!inputs.contains("expected"));
    assert!(!inputs.contains("held"));
    let calls = fs::read(f.dir.path().join("calls.jsonl")).unwrap();
    drop(e);
    let mut reopened = Evaluation::reopen(&f.root()).unwrap();
    assert_eq!(
        reopened
            .run(&f.runner, CancellationToken::new())
            .await
            .unwrap()
            .receipt_digest,
        report.receipt_digest
    );
    assert_eq!(calls, fs::read(f.dir.path().join("calls.jsonl")).unwrap());
}
#[tokio::test]
async fn negative_control_mismatch_rejects_even_with_positive_gains() {
    let mut f = Fixture::new();
    f.plan.cases[2].expected = json!({"answer":99});
    let mut e = f.create();
    let r = e.run(&f.runner, CancellationToken::new()).await.unwrap();
    assert_eq!(r.decision, EvaluationDecision::Rejected);
    assert!(r.reasons.iter().any(|s| s.contains("negative-control")));
}
#[tokio::test]
async fn cancellation_before_start_retains_full_schedule_without_dispatch() {
    let f = Fixture::new();
    let mut e = f.create();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let r = e.run(&f.runner, cancel).await.unwrap();
    assert_eq!(r.decision, EvaluationDecision::Inconclusive);
    assert_eq!(r.attempted, 0);
    assert_eq!(e.attempts().unwrap().len(), 12);
    assert!(!f.dir.path().join("calls.jsonl").exists());
}
#[tokio::test]
async fn interrupted_waiter_reopens_unknown_without_replay() {
    let f = Fixture::new();
    fs::write(f.dir.path().join("scenario.txt"), "hang").unwrap();
    let mut e = f.create();
    assert!(
        tokio::time::timeout(
            Duration::from_millis(350),
            e.run(&f.runner, CancellationToken::new())
        )
        .await
        .is_err()
    );
    assert!(e.attempts().unwrap().iter().any(|a| a.state == "running"));
    drop(e);
    let mut e = Evaluation::reopen(&f.root()).unwrap();
    assert!(e.attempts().unwrap().iter().any(|a| a.state == "unknown"));
    let r = e.run(&f.runner, CancellationToken::new()).await.unwrap();
    assert_eq!(r.decision, EvaluationDecision::Inconclusive);
    assert_eq!(r.reserved_slots, 1);
    // Give the dropped waiter's owned cancellation cleanup time to finish before fixture deletion.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let calls = fs::read_to_string(f.dir.path().join("calls.jsonl")).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|l| l.starts_with("[\"start\""))
            .count(),
        1
    );
}
#[test]
fn foreign_aliases_live_owners_and_mutable_backend_are_rejected() {
    let mut f = Fixture::new();
    let e = f.create();
    assert!(Evaluation::reopen(&f.root()).is_err());
    drop(e);
    let db = f.root().join("evaluation.sqlite");
    fs::hard_link(&db, f.root().join("alias")).unwrap();
    assert!(Evaluation::reopen(&f.root()).is_err());
    f.plan.launch.backend = SandboxBackend::Docker {
        image: "node:latest".into(),
    };
    assert!(f.plan.validate().is_err());
}

#[test]
fn repeats_do_not_satisfy_distinct_case_counts_or_allow_gain_overflow() {
    let mut f = Fixture::new();
    f.plan.repeats = 8;
    f.plan.attempt_budget = 48;
    f.plan.scoring.minimum_cases_per_lane = 2;
    assert!(f.plan.validate().is_err());
    f.plan.scoring.minimum_cases_per_lane = 1;
    f.plan.scoring.minimum_development_gain = usize::MAX;
    assert!(f.plan.validate().is_err());
}
#[tokio::test]
async fn retained_evidence_corruption_cannot_reuse_a_successful_report() {
    let f = Fixture::new();
    let mut e = f.create();
    assert_eq!(
        e.run(&f.runner, CancellationToken::new())
            .await
            .unwrap()
            .decision,
        EvaluationDecision::Eligible
    );
    drop(e);
    let db = rusqlite::Connection::open(f.root().join("evaluation.sqlite")).unwrap();
    let raw: String = db
        .query_row("SELECT json FROM attempts WHERE id=0", [], |r| r.get(0))
        .unwrap();
    let mut a: serde_json::Value = serde_json::from_str(&raw).unwrap();
    a["output"] = json!({"forged":true});
    db.execute("UPDATE attempts SET json=?1 WHERE id=0", [a.to_string()])
        .unwrap();
    drop(db);
    assert!(Evaluation::reopen(&f.root()).unwrap().report().is_err());
}
#[tokio::test]
#[ignore = "requires explicit existing local Docker image ID; never pulls"]
async fn real_local_docker_executes_both_fixture_artifacts_and_settles_every_lease() {
    let image = std::env::var("ZERO_EVALUATION_DOCKER_IMAGE")
        .expect("set existing immutable local sha256 image ID");
    let mut f = Fixture::new();
    f.plan.launch.backend = SandboxBackend::Docker { image };
    f.plan.launch.timeout_ms = 10_000;
    let runner = Runner::new(SandboxExecutor::new());
    let before = f.source.current().unwrap();
    let mut e = f.create();
    let report = e.run(&runner, CancellationToken::new()).await.unwrap();
    assert_eq!(
        report.decision,
        EvaluationDecision::Eligible,
        "{:?}; attempts {:?}",
        report.reasons,
        e.attempts().unwrap()
    );
    assert_eq!(report.settled, 12);
    assert_eq!(report.reserved_slots, 0);
    assert_eq!(before, f.source.current().unwrap());
    for index in 0..2 {
        let registry = Registry::open(
            f.root().join(format!("variant-{index}.sqlite")),
            "ignored",
            &json!({}),
        )
        .unwrap();
        assert!(
            registry
                .list_unreleased_leases(None, None, None, 20)
                .unwrap()
                .is_empty()
        );
    }
}

#[tokio::test]
async fn uncertain_teardown_retains_lease_staging_and_accounting_hold() {
    let f = Fixture::new();
    fs::write(f.dir.path().join("scenario.txt"), "cleanup-fail").unwrap();
    let mut e = f.create();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        stop.cancel();
    });
    let report = e.run(&f.runner, cancel).await.unwrap();
    assert_eq!(report.decision, EvaluationDecision::Inconclusive);
    assert_eq!(report.reserved_slots, 1);
    let attempts = e.attempts().unwrap();
    let first = &attempts[0];
    assert_eq!(first.state, "unknown");
    assert!(!first.settled);
    assert!(std::path::Path::new(first.staging.as_ref().unwrap()).exists());
    let registry =
        Registry::open(f.root().join("variant-0.sqlite"), "ignored", &json!({})).unwrap();
    assert_eq!(
        registry
            .list_unreleased_leases(None, None, None, 20)
            .unwrap()
            .len(),
        1
    );
    // This fixture never created an OS guest; remove its intentionally retained
    // executor staging only after the fake child processes have settled.
    if let Some(result) = &first.sandbox {
        if let zero_protocol::sandbox::SandboxCleanup::Unconfirmed {
            recovery:
                zero_protocol::sandbox::SandboxRecovery::Docker {
                    snapshot_dir: Some(path),
                    ..
                },
        } = &result.cleanup
        {
            fs::remove_dir_all(path).unwrap();
        }
    }
}
#[tokio::test]
async fn unstable_repeated_guest_outputs_cannot_qualify() {
    let f = Fixture::new();
    let path = f.dir.path().join("docker");
    let fake = fs::read_to_string(&path).unwrap();
    let fake=fake.replace("print(json.dumps({'jsonrpc':'2.0','id':1,'result':{'answer':answer}}))", "if len((root / 'inputs.jsonl').read_text().splitlines()) > 6 and (root / 'variant.txt').read_text() == 'candidate': answer += 1\n        print(json.dumps({'jsonrpc':'2.0','id':1,'result':{'answer':answer}}))");
    fs::write(path, fake).unwrap();
    let mut e = f.create();
    let report = e.run(&f.runner, CancellationToken::new()).await.unwrap();
    assert_eq!(report.decision, EvaluationDecision::Inconclusive);
    assert!(report.reasons.iter().any(|r| r.contains("instability")));
    assert_eq!(e.attempts().unwrap().len(), 12);
}
#[test]
fn unexpected_schema_objects_reject_before_owner_recovery() {
    let f = Fixture::new();
    drop(f.create());
    let db = rusqlite::Connection::open(f.root().join("evaluation.sqlite")).unwrap();
    db.execute_batch("CREATE VIEW foreign_view AS SELECT 1;")
        .unwrap();
    drop(db);
    assert!(Evaluation::reopen(&f.root()).is_err());
}

#[test]
fn rejected_foreign_wal_database_is_not_mutated() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("owner.lock"), b"").unwrap();
    let path = dir.path().join("evaluation.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE unrelated(value TEXT);")
        .unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    assert!(Evaluation::reopen(dir.path()).is_err());
    assert_eq!(before, fs::read(&path).unwrap());
    let db =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let mode: String = db
        .pragma_query_value(None, "journal_mode", |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}
