#![allow(dead_code)]
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    time::{SystemTime, UNIX_EPOCH},
};
use zero_evaluation::{Case, Lane, PythonEvolutionPlan, PythonProposalContext, ScoringPolicy};
use zero_evolution::{Manifest, Registry};
use zero_harness::HostGrants;
use zero_plugin::{Artifact, Capability, EntryPoint, HostPolicy, Schema, Tool};
use zero_plugin_runner::{Launch, Runner};
use zero_protocol::{
    model::{Completion, CompletionStatus, Content, ResponsesRequest, Usage},
    sandbox::SandboxBackend,
    session::{Operation, OperationStatus},
};
use zero_store::Store;
pub const BASELINE: &str = "import json,sys\nq=json.load(sys.stdin)\nprint(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':{'answer':0}}))\n";
pub const CANDIDATE: &str = "import json,sys\nq=json.load(sys.stdin)\nprint(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':{'answer':q['params']['input']['x']}}))\n";
pub const CHEAT: &str = "import json,sys\nq=json.load(sys.stdin)\nx=q['params']['input']['x']\nprint(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':{'answer':1 if x==1 else 0}}))\n";
pub struct Fixture {
    pub dir: tempfile::TempDir,
    pub source: Registry,
    pub store: Store,
    pub plan: PythonEvolutionPlan,
    pub grants: HostGrants,
    pub context: PythonProposalContext,
    pub runner: Runner,
}
impl Fixture {
    pub fn new() -> Self {
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
        let artifact = source.put_artifact(BASELINE.as_bytes()).unwrap();
        let sha = artifact.strip_prefix("sha256:").unwrap().to_string();
        let plugin = zero_plugin::Manifest {
            schema_version: 1,
            protocol_version: 1,
            id: "fixture".into(),
            version: "1.0.0".into(),
            artifacts: vec![Artifact {
                sha256: sha.clone(),
                size: BASELINE.len() as u64,
            }],
            entrypoint: EntryPoint {
                artifact: sha,
                argv: vec!["{artifact}".into()],
            },
            dependencies: vec![],
            tools: vec![Tool {
                name: "inspect".into(),
                description: "Return the input number".into(),
                parameters: Schema::Object {
                    properties: BTreeMap::from([
                        (
                            "x".into(),
                            Schema::Integer {
                                minimum: 0,
                                maximum: 10,
                            },
                        ),
                        ("tag".into(), Schema::String { max_length: 128 }),
                    ]),
                    required: vec!["x".into(), "tag".into()],
                    additional_properties: false,
                },
                capabilities: BTreeSet::from([Capability::Compute]),
            }],
        };
        let component = source
            .put_artifact(&serde_json::to_vec(&plugin).unwrap())
            .unwrap();
        let baseline = source
            .register_generation(&Manifest {
                engine_artifact: engine.clone(),
                components: BTreeMap::from([("plugin:fixture".into(), component)]),
                protocol_version: 1,
                state_schema: "v1".into(),
                compatible_state_schemas: vec![],
                configuration: json!({"native_plugin_graph":1}),
                policy_artifact: policy.clone(),
            })
            .unwrap();
        let plan = PythonEvolutionPlan {
            schema_version: 1,
            baseline,
            evaluator_artifact: evaluator,
            engine_artifact: engine,
            host_policy_artifact: policy,
            plugin: "fixture".into(),
            tool: "inspect".into(),
            launch: Launch {
                backend: SandboxBackend::Docker {
                    image: format!("sha256:{}", "a".repeat(64)),
                },
                interpreter: vec!["python3".into(), "-I".into()],
                timeout_ms: 2000,
                memory_mb: 128,
                cpus: 0.5,
                max_output_bytes: 4096,
            },
            cases: vec![
                Case {
                    id: "dev".into(),
                    lane: Lane::Development,
                    input: json!({"x":1,"tag":"public-development"}),
                    expected: json!({"answer":1}),
                },
                Case {
                    id: "private-held".into(),
                    lane: Lane::HeldOut,
                    input: json!({"x":7,"tag":"HELDOUT_PRIVATE_SENTINEL"}),
                    expected: json!({"answer":7}),
                },
                Case {
                    id: "private-control".into(),
                    lane: Lane::NegativeControl,
                    input: json!({"x":0,"tag":"NEGATIVE_PRIVATE_SENTINEL"}),
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
            objective: "Preserve the numeric input in the answer field.".into(),
            provider: "fixture".into(),
            model: "fixture".into(),
            reservation: 10,
            max_output_tokens: 1024,
            expires_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 60000,
        };
        let mut store = Store::open(dir.path().join("state.sqlite")).unwrap();
        store.claim_engine_epoch("fixture-owner").unwrap();
        let session = store.create_session("host-existing-session", 100).unwrap();
        let context = PythonProposalContext {
            state_database: dir.path().join("state.sqlite").to_string_lossy().into(),
            session_id: session.id,
            command_id: "python-proposal".into(),
        };
        let fake=include_str!("../../../zero-executor/tests/fixtures/fake-docker.py")
            .replace("state.write_text(json.dumps({\"name\": name, \"id\": container_id}))","state.write_text(json.dumps({\"name\": name, \"id\": container_id}))\n    mount=args[args.index('--mount')+1]\n    source=pathlib.Path(mount.split('src=')[1].split(',')[0])\n    scripts=list(source.glob('plugins/*/artifacts/*'))\n    assert len(scripts)==1\n    (root/'script-path').write_text(str(scripts[0]))\n    with (root/'snapshots.jsonl').open('a') as log: log.write(json.dumps([str(p.relative_to(source)) for p in source.rglob('*')])+'\\n')")
            .replace("sys.stdout.buffer.write(sys.stdin.buffer.read())","data=sys.stdin.buffer.read()\n        result=subprocess.run(['python3','-I',(root/'script-path').read_text()],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=1)\n        sys.stdout.buffer.write(result.stdout)\n        sys.stderr.buffer.write(result.stderr)\n        sys.exit(result.returncode)");
        let docker = dir.path().join("docker");
        fs::write(&docker, fake).unwrap();
        fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("scenario.txt"), "echo").unwrap();
        let runner = Runner::new(zero_sandbox::SandboxExecutor::with_backends(
            zero_executor::DockerExecutor::with_binary(docker),
            zero_smolvm::SmolvmConfig::default(),
        ));
        Self {
            dir,
            source,
            store,
            plan,
            grants,
            context,
            runner,
        }
    }
    pub fn root(&self) -> std::path::PathBuf {
        self.dir.path().join("proposal")
    }
    pub fn infer(&mut self, request: &ResponsesRequest, source: &str) -> Operation {
        let command = self.context.command_id.clone();
        self.infer_tool(
            request,
            &command,
            "submit_python_candidate",
            json!({"action":"propose","source_utf8":source,"rationale":"Preserve input value"}),
            3,
        )
    }
    pub fn infer_tool(
        &mut self,
        request: &ResponsesRequest,
        command: &str,
        name: &str,
        arguments: serde_json::Value,
        charge: u64,
    ) -> Operation {
        let payload = json!({"kind":"responses_inference","provider":"fixture","request":request,"reservation":10,"rates":{"input":1000000,"cached_input":0,"output":1000000}});
        let op = self
            .store
            .admit_command(&self.context.session_id, command, &payload)
            .unwrap()
            .operation;
        self.store.begin_operation(&op.id, "fixture-owner").unwrap();
        self.store
            .reserve_budget(&self.context.session_id, &op.id, 10)
            .unwrap();
        self.store
            .settle_budget(&self.context.session_id, &op.id, charge)
            .unwrap();
        let completion = Completion {
            status: CompletionStatus::Completed,
            response_id: None,
            content: vec![Content::ToolCall {
                id: "fixture-call".into(),
                name: name.into(),
                arguments,
            }],
            usage: Some(Usage {
                input_tokens: charge.saturating_sub(1),
                output_tokens: 1,
                cached_input_tokens: 0,
            }),
            usage_is_final: true,
            replay: vec![],
            error: None,
        };
        self.store
            .settle_operation(
                &op.id,
                "fixture-owner",
                OperationStatus::Succeeded,
                &serde_json::to_value(completion).unwrap(),
            )
            .unwrap()
    }
}
