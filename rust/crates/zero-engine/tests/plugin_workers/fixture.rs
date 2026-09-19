use super::support::*;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};
use zero_evolution::{Manifest, PreparedState, Registry};
use zero_harness::{Harness, HostGrants};
use zero_plugin::{Artifact, Capability, EntryPoint, HostPolicy, Schema, Tool};
use zero_protocol::sandbox::SandboxBackend;

fn grants(capability: Capability) -> HostGrants {
    HostGrants::new(BTreeMap::from([(
        "fixture".into(),
        HostPolicy {
            enabled: true,
            trusted: false,
            grants: BTreeSet::from([capability]),
        },
    )]))
}
// Same content-addressed offline plugin graph and fake Docker RPC path as plugin.rs.
pub fn register(f: &Setup, capability: Capability) -> String {
    let mut r = Registry::open(f.dir.path().join("evo.sqlite"), "v1", &json!({})).unwrap();
    let engine = r.put_artifact(b"fixtureengine").unwrap();
    let script = b"fixture";
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
            argv: vec!["{artifact}".into()],
        },
        dependencies: vec![],
        tools: vec![Tool {
            name: "inspect".into(),
            description: "Historical offline plugin, not an operator question".into(),
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
    let policy = r
        .put_artifact(&grants(capability).artifact_bytes().unwrap())
        .unwrap();
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
    let mut h = Harness::new(r, engine.clone());
    let prepared = h
        .prepare_activation(
            &generation,
            &eligibility,
            &h.current().unwrap(),
            &grants(capability),
            |m, s| {
                Ok(PreparedState {
                    state_schema: m.state_schema.clone(),
                    state: s.state.clone(),
                })
            },
        )
        .unwrap();
    h.commit(prepared).unwrap();
    let fake=include_str!("../../../zero-executor/tests/fixtures/fake-docker.py").replace("sys.stdout.buffer.write(sys.stdin.buffer.read())","(root / 'request.json').write_bytes(sys.stdin.buffer.read())\n        sys.stdout.buffer.write((root / 'reply.jsonl').read_bytes())");
    fs::write(f.dir.path().join("docker"), fake).unwrap();
    fs::write(f.dir.path().join("scenario.txt"), "echo").unwrap();
    fs::write(
        f.dir.path().join("reply.jsonl"),
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"historical_plugin\":true}}\n",
    )
    .unwrap();
    engine
}
pub fn configure(
    f: &Setup,
    engine: &zero_engine::Engine,
    artifact: &str,
    capability: Capability,
    timeout: u64,
) {
    let mut h = Harness::new(
        Registry::open(f.dir.path().join("evo.sqlite"), "unused", &json!({})).unwrap(),
        artifact.into(),
    );
    h.restore_current(&grants(capability)).unwrap();
    engine
        .configure_plugins(
            h,
            zero_plugin_runner::Launch {
                backend: SandboxBackend::Docker {
                    image: format!("sha256:{}", "a".repeat(64)),
                },
                interpreter: vec!["node".into()],
                timeout_ms: timeout,
                memory_mb: 128,
                cpus: 0.5,
                max_output_bytes: 8192,
            },
        )
        .unwrap();
}
