#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    os::unix::fs::PermissionsExt,
    process::Command,
};
use tempfile::TempDir;
use zero_evolution::{Manifest, PreparedState, Registry};
use zero_harness::{Harness, HostGrants};
use zero_plugin::{Artifact, Capability, EntryPoint, HostPolicy, Schema, Tool};
struct Fixture {
    dir: TempDir,
    config: std::path::PathBuf,
    docker: std::path::PathBuf,
}
impl Fixture {
    fn new(reply: &str) -> Self {
        Self::with_script(reply, b"inert plugin fixture")
    }
    fn with_script(reply: &str, script: &[u8]) -> Self {
        let dir = TempDir::new().unwrap();
        let registry_path = dir.path().join("registry.db");
        let mut registry = Registry::open(&registry_path, "v1", &json!({})).unwrap();
        let engine = registry.put_artifact(b"fixtureengine").unwrap();
        let artifact = registry.put_artifact(script).unwrap();
        let digest = artifact.strip_prefix("sha256:").unwrap().to_owned();
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
                description: "fixture".into(),
                parameters: Schema::Object {
                    properties: BTreeMap::new(),
                    required: vec![],
                    additional_properties: false,
                },
                capabilities: BTreeSet::from([Capability::Compute]),
            }],
        };
        let manifest = registry
            .put_artifact(&serde_json::to_vec(&plugin).unwrap())
            .unwrap();
        let grants = HostGrants::new(BTreeMap::from([(
            "fixture".into(),
            HostPolicy {
                enabled: true,
                trusted: false,
                grants: BTreeSet::from([Capability::Compute]),
            },
        )]));
        let policy = registry
            .put_artifact(&grants.artifact_bytes().unwrap())
            .unwrap();
        let generation = registry
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
        let eligibility = registry
            .authorize_baseline(&generation, "explicit test fixture")
            .unwrap();
        let mut harness = Harness::new(registry, engine.clone());
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
        drop(harness);
        let config = dir.path().join("host.json");
        std::fs::write(&config,json!({"registry":registry_path,"engine_artifact":engine,"plugins":{"fixture":{"enabled":true,"trusted":false,"grants":["compute"]}},"launch":{"backend":{"type":"docker","image":"fixture:local"},"interpreter":["node"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":8192}}).to_string()).unwrap();
        let fake=include_str!("../../zero-executor/tests/fixtures/fake-docker.py").replace("sys.stdout.buffer.write(sys.stdin.buffer.read())","(root / 'request.json').write_bytes(sys.stdin.buffer.read())\n        sys.stdout.buffer.write((root / 'reply.jsonl').read_bytes())");
        let docker = dir.path().join("docker");
        std::fs::write(&docker, fake).unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(dir.path().join("scenario.txt"), "echo").unwrap();
        std::fs::write(dir.path().join("reply.jsonl"), reply).unwrap();
        std::fs::write(dir.path().join("input.json"), "{}").unwrap();
        Self {
            dir,
            config,
            docker,
        }
    }
    fn cli(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state")
            .arg(self.dir.path().join("state.db"))
            .arg("--harness-config")
            .arg(&self.config)
            .arg("--docker-bin")
            .arg(&self.docker);
        c
    }
    fn session(&self, pinned: bool) -> String {
        let output = self
            .cli()
            .args(if pinned {
                vec!["session", "create-pinned"]
            } else {
                vec!["session", "create"]
            })
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        value["session"]["id"].as_str().unwrap().into()
    }
    fn call(&self, session: &str) -> std::process::Output {
        self.cli()
            .args([
                "plugin-call",
                "--session",
                session,
                "--command-id",
                "plugin-once",
                "--plugin",
                "fixture",
                "--tool",
                "inspect",
                "--input",
            ])
            .arg(self.dir.path().join("input.json"))
            .output()
            .unwrap()
    }
}
#[test]
fn pinned_plugin_calls_persist_and_exact_retry_does_not_execute_again() {
    if String::from_utf8_lossy(&Command::new("id").arg("-u").output().unwrap().stdout).trim() == "0"
    {
        eprintln!("requires qualified nonroot executor host");
        return;
    }
    let fixture = Fixture::new("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n");
    let session = fixture.session(true);
    let first = fixture.call(&session);
    assert!(
        first.status.success(),
        "{} {}",
        String::from_utf8_lossy(&first.stdout),
        String::from_utf8_lossy(&first.stderr)
    );
    let first: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(first["type"], "plugin");
    assert_eq!(first["duplicate"], false);
    assert_eq!(first["operation"]["status"], "succeeded");
    let before = std::fs::read(fixture.dir.path().join("calls.jsonl")).unwrap();
    let retry = fixture.call(&session);
    assert!(retry.status.success());
    let retry: Value = serde_json::from_slice(&retry.stdout).unwrap();
    assert_eq!(retry["duplicate"], true);
    assert_eq!(
        std::fs::read(fixture.dir.path().join("calls.jsonl")).unwrap(),
        before
    );
}
#[test]
fn unpinned_session_and_wrong_host_artifact_cannot_run_plugin() {
    let fixture = Fixture::new("");
    let session = fixture.session(false);
    let output = fixture.call(&session);
    assert_eq!(output.status.code(), Some(1));
    assert!(!fixture.dir.path().join("calls.jsonl").exists());
    let mut config: Value =
        serde_json::from_slice(&std::fs::read(&fixture.config).unwrap()).unwrap();
    config["engine_artifact"] = json!(format!("sha256:{}", "0".repeat(64)));
    std::fs::write(&fixture.config, config.to_string()).unwrap();
    let output = fixture.call(&session);
    assert_eq!(output.status.code(), Some(2));
    assert!(!fixture.dir.path().join("calls.jsonl").exists());
}
#[test]
fn harness_config_metadata_bypass_and_no_implicit_registry_creation() {
    let dir = TempDir::new().unwrap();
    for args in [
        vec!["schema"],
        vec!["--help"],
        vec!["hosted", "--help"],
        vec!["doctor", "--help"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(dir.path().join("state.db"))
            .arg("--harness-config")
            .arg(dir.path().join("missing.json"))
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!dir.path().join("state.db").exists());
    }
}

#[test]
fn plugin_failure_or_unavailable_backend_is_never_success_or_fallback() {
    let fixture = Fixture::new(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"fixture refusal\"}}\n",
    );
    let mut config: Value =
        serde_json::from_slice(&std::fs::read(&fixture.config).unwrap()).unwrap();
    config["launch"]["backend"] = json!({"type":"smolvm","image_archive":fixture.dir.path().join("missing.tar"),"archive_digest":format!("sha256:{}","a".repeat(64)),"storage_gb":1});
    config["launch"]["cpus"] = json!(1);
    std::fs::write(&fixture.config, config.to_string()).unwrap();
    let session = fixture.session(true);
    let output = fixture.call(&session);
    assert!(!output.status.success());
    assert!(
        !fixture.dir.path().join("calls.jsonl").exists(),
        "smolvm plugin fell back to Docker"
    );
    config["registry"] = json!(fixture.dir.path().join("absent-registry.db"));
    std::fs::write(&fixture.config, config.to_string()).unwrap();
    let output = fixture.call(&session);
    assert_eq!(output.status.code(), Some(2));
    assert!(!fixture.dir.path().join("absent-registry.db").exists());
}

#[test]
fn untrusted_plugin_error_reply_has_nonzero_exit_and_persisted_outcome() {
    if String::from_utf8_lossy(&Command::new("id").arg("-u").output().unwrap().stdout).trim() == "0"
    {
        eprintln!("requires qualified nonroot executor host");
        return;
    }
    let fixture = Fixture::new(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"fixture refusal\"}}\n",
    );
    let session = fixture.session(true);
    let output = fixture.call(&session);
    assert_eq!(output.status.code(), Some(1));
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["operation"]["status"], "failed");
    assert_eq!(reply["result"]["untrusted_reply"]["type"], "error");
}

#[path = "plugin/workers.rs"]
mod workers;
