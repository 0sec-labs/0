#![allow(dead_code)]
#![cfg(target_os = "linux")]
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    sync::Arc,
};
use zero_evolution::{Manifest, PreparedState, Registry};
use zero_harness::{GenerationPin, Harness, HostGrants};
use zero_plugin::{Artifact, Capability, EntryPoint, HostPolicy, Schema, Tool};
use zero_plugin_runner::{Launch, Runner};
use zero_protocol::sandbox::SandboxBackend;
use zero_sandbox::SandboxExecutor;
pub(crate) struct Fixture {
    pub(crate) dir: tempfile::TempDir,
    pub(crate) harness: Harness,
    pub(crate) pin: GenerationPin,
    pub(crate) runner: Runner,
}
impl Fixture {
    pub(crate) fn new(capability: Capability, scenario: &str, reply: &str, script: &[u8]) -> Self {
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
        let mut harness = Harness::new(r, engine);
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
        let pin = harness.commit(prepared).unwrap();
        let fake=include_str!("../../../zero-executor/tests/fixtures/fake-docker.py").replace("sys.stdout.buffer.write(sys.stdin.buffer.read())","(root / 'request.json').write_bytes(sys.stdin.buffer.read())\n        sys.stdout.buffer.write((root / 'reply.jsonl').read_bytes())");
        let binary = dir.path().join("docker");
        fs::write(&binary, fake).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("scenario.txt"), scenario).unwrap();
        fs::write(dir.path().join("reply.jsonl"), reply).unwrap();
        let runner = Runner::new(SandboxExecutor::with_backends(
            zero_executor::DockerExecutor::with_binary(binary),
            zero_smolvm::SmolvmConfig::default(),
        ));
        Self {
            dir,
            harness,
            pin,
            runner,
        }
    }
    pub(crate) fn call(&mut self) -> zero_harness::PinnedCall {
        self.harness
            .begin_call(&self.pin, "fixture-owner", "fixture", "inspect", json!({}))
            .unwrap()
    }
}
pub(crate) fn launch() -> Launch {
    Launch {
        backend: SandboxBackend::Docker {
            image: "node:24-alpine".into(),
        },
        interpreter: vec!["node".into()],
        timeout_ms: 3000,
        memory_mb: 128,
        cpus: 0.5,
        max_output_bytes: 8192,
    }
}
pub(crate) fn sink() -> zero_sandbox::EventSink {
    Arc::new(|_| {})
}
pub(crate) const REPLY: &str = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n";
