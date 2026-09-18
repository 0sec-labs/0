#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    process::{Command, Output},
};
use zero_evolution::{Manifest, Registry};
use zero_harness::HostGrants;
use zero_plugin::{Artifact, Capability, EntryPoint, HostPolicy, Schema, Tool};

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

struct Fixture {
    dir: tempfile::TempDir,
    source: Registry,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut source = Registry::open(
            dir.path().join("source.db"),
            "v1",
            &json!({"production":"unchanged"}),
        )
        .unwrap();
        let engine = source.put_artifact(b"fixture engine identity").unwrap();
        let evaluator = source.put_artifact(b"fixture evaluator identity").unwrap();
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
        let plan = json!({
            "baseline":baseline,"candidate":candidate,"engine_artifact":engine,
            "evaluator_artifact":evaluator,"host_policy_artifact":policy,
            "plugin":"fixture","tool":"inspect",
            "launch":{"backend":{"type":"docker","image":format!("sha256:{}", "a".repeat(64))},
                "interpreter":["node"],"timeout_ms":2000,"memory_mb":128,"cpus":0.5,"max_output_bytes":4096},
            "cases":[
                {"id":"private-development-case","lane":"development","input":{"x":1},"expected":{"answer":1}},
                {"id":"private-held-out-case","lane":"held_out","input":{"x":2},"expected":{"answer":2}},
                {"id":"private-negative-case","lane":"negative_control","input":{"x":0},"expected":{"answer":0}}
            ],"repeats":2,"attempt_budget":12,
            "scoring":{"minimum_cases_per_lane":1,"minimum_development_gain":1,"minimum_held_out_gain":1}
        });
        fs::write(
            dir.path().join("plan.json"),
            serde_json::to_vec(&plan).unwrap(),
        )
        .unwrap();
        fs::write(
            dir.path().join("grants.json"),
            serde_json::to_vec(
                &json!({"fixture":{"enabled":true,"trusted":false,"grants":["compute"]}}),
            )
            .unwrap(),
        )
        .unwrap();
        let fake=include_str!("../../zero-executor/tests/fixtures/fake-docker.py")
            .replace("state.write_text(json.dumps({\"name\": name, \"id\": container_id}))", "state.write_text(json.dumps({\"name\": name, \"id\": container_id}))\n    mount = args[args.index('--mount') + 1]\n    source = pathlib.Path(mount.split('src=')[1].split(',')[0])\n    scripts = list(source.glob('plugins/*/artifacts/*'))\n    (root / 'variant.txt').write_text('candidate' if any(b'candidate fixture' in p.read_bytes() for p in scripts) else 'baseline')")
            .replace("sys.stdout.buffer.write(sys.stdin.buffer.read())", "request = json.loads(sys.stdin.buffer.read())\n        with (root / 'inputs.jsonl').open('a') as seen: seen.write(json.dumps(request)+'\\n')\n        answer = request['params']['input']['x'] if (root / 'variant.txt').read_text() == 'candidate' else 0\n        print(json.dumps({'jsonrpc':'2.0','id':1,'result':{'answer':answer}}))");
        fs::write(dir.path().join("docker"), fake).unwrap();
        fs::set_permissions(dir.path().join("docker"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("scenario.txt"), "echo").unwrap();
        Self { dir, source }
    }
    fn cli(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        command.current_dir(self.dir.path()).args([
            "--state",
            "unused/state.db",
            "--providers",
            "absent-providers.json",
            "--harness-config",
            "absent-harness.json",
            "--docker-bin",
            "./docker",
        ]);
        command
    }
    fn run(&self) -> Output {
        self.cli()
            .args([
                "evaluation",
                "run",
                "--source-registry",
                "source.db",
                "--plan",
                "plan.json",
                "--grants",
                "grants.json",
                "--output-dir",
                "evaluation",
            ])
            .output()
            .unwrap()
    }
    fn status(&self) -> Output {
        self.cli()
            .args(["evaluation", "status", "--directory", "evaluation"])
            .output()
            .unwrap()
    }
}
fn json_output(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn paired_local_run_is_read_only_to_source_and_status_never_replays_or_exposes_oracle() {
    let f = Fixture::new();
    let before = f.source.current().unwrap();
    let source_bytes = fs::read(f.dir.path().join("source.db")).unwrap();
    let output = f.run();
    let report = json_output(&output);
    assert_eq!(report["decision"], "eligible");
    assert_eq!(report["attempted"], 12);
    assert_eq!(report["settled"], 12);
    assert_eq!(report["reserved_slots"], 0);
    assert_eq!(before, f.source.current().unwrap());
    assert_eq!(
        source_bytes,
        fs::read(f.dir.path().join("source.db")).unwrap()
    );
    assert!(
        f.source
            .list_unreleased_leases(None, None, None, 20)
            .unwrap()
            .is_empty()
    );
    let calls = fs::read(f.dir.path().join("calls.jsonl")).unwrap();
    let inputs = fs::read_to_string(f.dir.path().join("inputs.jsonl")).unwrap();
    assert_eq!(inputs.lines().count(), 12);
    assert!(!inputs.contains("expected"));
    assert!(!inputs.contains("private-held-out-case"));
    let status = f.status();
    let inspection = json_output(&status);
    assert_eq!(inspection["started"], true);
    assert_eq!(inspection["attempt_budget"], 12);
    assert_eq!(inspection["settled"], 12);
    assert_eq!(inspection["reserved_slots"], 0);
    assert_eq!(inspection["states"]["finished"], 12);
    assert_eq!(
        inspection["report"]["receipt_digest"],
        report["receipt_digest"]
    );
    let text = String::from_utf8(status.stdout).unwrap();
    for private in [
        "private-development-case",
        "private-held-out-case",
        "private-negative-case",
        "\"expected\"",
        "\"answer\"",
        "\"stdout\"",
        "\"stderr\"",
    ] {
        assert!(!text.contains(private), "status exposed {private}");
    }
    let rerun = f.run();
    assert!(!rerun.status.success());
    assert!(rerun.stdout.is_empty());
    assert_eq!(calls, fs::read(f.dir.path().join("calls.jsonl")).unwrap());
    assert_eq!(
        source_bytes,
        fs::read(f.dir.path().join("source.db")).unwrap()
    );
    assert!(!f.dir.path().join("unused").exists());
}
#[test]
fn invalid_plan_missing_and_foreign_registries_fail_without_engine_or_sandbox_effects() {
    let f = Fixture::new();
    let valid = fs::read(f.dir.path().join("plan.json")).unwrap();
    fs::write(f.dir.path().join("plan.json"), b"{invalid").unwrap();
    let invalid = f.run();
    assert!(!invalid.status.success());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("Invalid evaluation plan JSON"));
    fs::write(f.dir.path().join("plan.json"), valid).unwrap();
    for path in ["missing.db", "foreign.db"] {
        if path == "foreign.db" {
            fs::write(f.dir.path().join(path), b"not a registry").unwrap();
        }
        let out = f
            .cli()
            .args([
                "evaluation",
                "run",
                "--source-registry",
                path,
                "--plan",
                "plan.json",
                "--grants",
                "grants.json",
                "--output-dir",
                "evaluation",
            ])
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("absent-providers"));
    }
    assert!(!f.dir.path().join("missing.db").exists());
    assert_eq!(
        fs::read(f.dir.path().join("foreign.db")).unwrap(),
        b"not a registry"
    );
    assert!(!f.dir.path().join("evaluation").exists());
    assert!(!f.dir.path().join("unused").exists());
    assert!(!f.dir.path().join("calls.jsonl").exists());
    let status = f.status();
    assert!(!status.status.success());
    assert!(!f.dir.path().join("evaluation").exists());
}
#[test]
fn evaluation_help_bypasses_all_runtime_configuration() {
    let f = Fixture::new();
    let output = f
        .cli()
        .args(["evaluation", "run", "--help"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("--source-registry"));
    assert!(!f.dir.path().join("unused").exists());
    assert!(!f.dir.path().join("calls.jsonl").exists());
}

#[test]
fn signal_during_fixture_execution_awaits_cleanup_and_leaves_inspectable_result() {
    use std::{
        process::Stdio,
        thread,
        time::{Duration, Instant},
    };
    let f = Fixture::new();
    fs::write(f.dir.path().join("scenario.txt"), "hang").unwrap();
    let mut child = f
        .cli()
        .args([
            "evaluation",
            "run",
            "--source-registry",
            "source.db",
            "--plan",
            "plan.json",
            "--grants",
            "grants.json",
            "--output-dir",
            "evaluation",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f.dir.path().join("child.pid").exists() {
        assert!(Instant::now() < deadline, "fixture execution did not start");
        assert!(
            child.try_wait().unwrap().is_none(),
            "evaluation exited before execution"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("evaluation did not drain cancellation");
        }
        thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_ne!(report["decision"], "eligible");
    assert!(
        !f.dir.path().join("container.json").exists(),
        "container cleanup must precede process exit"
    );
    let calls = fs::read(f.dir.path().join("calls.jsonl")).unwrap();
    let status = json_output(&f.status());
    assert_eq!(status["report"]["receipt_digest"], report["receipt_digest"]);
    assert_eq!(calls, fs::read(f.dir.path().join("calls.jsonl")).unwrap());
    assert!(!f.dir.path().join("unused").exists());
}

/// Opt-in integration against a preloaded immutable local Node image. Never pulls.
#[test]
#[ignore = "requires local Docker and ZERO_EVALUATION_DOCKER_IMAGE pinned image"]
fn real_local_docker_executes_paired_plan_and_status_verifies_receipt() {
    let image = std::env::var("ZERO_EVALUATION_DOCKER_IMAGE")
        .expect("set ZERO_EVALUATION_DOCKER_IMAGE to a preloaded sha256 image ID");
    assert!(image.starts_with("sha256:") && image.len() == 71);
    let f = Fixture::new();
    let plan_path = f.dir.path().join("plan.json");
    let mut plan: Value = serde_json::from_slice(&fs::read(&plan_path).unwrap()).unwrap();
    plan["launch"]["backend"]["image"] = json!(image);
    plan["launch"]["timeout_ms"] = json!(30_000);
    fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    let before = f.source.current().unwrap();
    let source_bytes = fs::read(f.dir.path().join("source.db")).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .current_dir(f.dir.path())
        .args([
            "--state",
            "unused/state.db",
            "--providers",
            "absent-providers.json",
            "--harness-config",
            "absent-harness.json",
            "evaluation",
            "run",
            "--source-registry",
            "source.db",
            "--plan",
            "plan.json",
            "--grants",
            "grants.json",
            "--output-dir",
            "evaluation",
        ])
        .output()
        .unwrap();
    let report = json_output(&output);
    assert_eq!(report["decision"], "eligible", "{report}");
    assert_eq!(report["attempted"], 12);
    assert_eq!(report["settled"], 12);
    assert_eq!(report["reserved_slots"], 0);
    let status = json_output(&f.status());
    assert_eq!(status["states"]["finished"], 12);
    assert_eq!(status["report"]["receipt_digest"], report["receipt_digest"]);
    assert_eq!(before, f.source.current().unwrap());
    assert_eq!(
        source_bytes,
        fs::read(f.dir.path().join("source.db")).unwrap()
    );
    assert!(
        f.source
            .list_unreleased_leases(None, None, None, 20)
            .unwrap()
            .is_empty()
    );
    // The fake executable is deliberately present: absence of its log establishes
    // that this test used real Docker, not the unit-test backend.
    assert!(!f.dir.path().join("calls.jsonl").exists());
    assert!(!f.dir.path().join("unused").exists());
}
