//! A historical plugin alias must not become the opt-in native question tool.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "delegation/mod.rs"]
mod support;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};
use support::*;
use zero_evolution::{Manifest, PreparedState, Registry};
use zero_harness::{Harness, HostGrants};
use zero_plugin::{Artifact, Capability, EntryPoint, HostPolicy, Schema, Tool};
use zero_protocol::{
    Command, OperationStatus, Reply,
    agent::{AgentStatus, PluginToolBinding},
    sandbox::SandboxBackend,
};

fn grants() -> HostGrants {
    HostGrants::new(BTreeMap::from([(
        "fixture".into(),
        HostPolicy {
            enabled: true,
            trusted: false,
            grants: BTreeSet::from([Capability::Compute]),
        },
    )]))
}
// Same content-addressed offline plugin graph and fake Docker RPC path as plugin.rs.
fn register(f: &Setup) -> String {
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
            capabilities: BTreeSet::from([Capability::Compute]),
        }],
    };
    let manifest = r
        .put_artifact(&serde_json::to_vec(&plugin).unwrap())
        .unwrap();
    let policy = r.put_artifact(&grants().artifact_bytes().unwrap()).unwrap();
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
            &grants(),
            |m, s| {
                Ok(PreparedState {
                    state_schema: m.state_schema.clone(),
                    state: s.state.clone(),
                })
            },
        )
        .unwrap();
    h.commit(prepared).unwrap();
    let fake=include_str!("../../zero-executor/tests/fixtures/fake-docker.py").replace("sys.stdout.buffer.write(sys.stdin.buffer.read())","(root / 'request.json').write_bytes(sys.stdin.buffer.read())\n        sys.stdout.buffer.write((root / 'reply.jsonl').read_bytes())");
    fs::write(f.dir.path().join("docker"), fake).unwrap();
    fs::write(f.dir.path().join("scenario.txt"), "echo").unwrap();
    fs::write(
        f.dir.path().join("reply.jsonl"),
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"historical_plugin\":true}}\n",
    )
    .unwrap();
    engine
}
fn configure(f: &Setup, engine: &zero_engine::Engine, artifact: &str) {
    let mut h = Harness::new(
        Registry::open(f.dir.path().join("evo.sqlite"), "unused", &json!({})).unwrap(),
        artifact.into(),
    );
    h.restore_current(&grants()).unwrap();
    engine
        .configure_plugins(
            h,
            zero_plugin_runner::Launch {
                backend: SandboxBackend::Docker {
                    image: "local:test".into(),
                },
                interpreter: vec!["node".into()],
                timeout_ms: 1000,
                memory_mb: 128,
                cpus: 0.5,
                max_output_bytes: 8192,
            },
        )
        .unwrap();
}

#[tokio::test]
async fn historical_ask_operator_plugin_alias_survives_checkpoint_and_completed_continuation() {
    for projected in [false, true] {
        let mut f = Setup::new(vec![], 1, 1);
        f.request.delegation_policy = None;
        f.request.operator_questions = false;
        f.request.max_turns = 1;
        if projected {
            f.request.context_policy = Some(zero_protocol::context::ContextPolicy {
                schema_version: 1,
                max_input_bytes: 65536,
                keep_recent_rounds: 1,
            });
        }
        f.request.plugin_tools = vec![PluginToolBinding {
            alias: "ask_operator".into(),
            plugin: "fixture".into(),
            tool: "inspect".into(),
        }];
        let artifact = register(&f);
        let mut http = Http::new().await;
        let engine = f.engine();
        configure(&f, &engine, &artifact);
        http.configure(&engine);
        let session = match call(&engine, Command::SessionCreatePinned { budget_limit: 100 }).await
        {
            Reply::Session { session } => session.id,
            r => panic!("{r:?}"),
        };
        let run = start(engine.clone(), f.command(&session));
        let first = http.next().await;
        let offered = first.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "ask_operator")
            .unwrap()
            .clone();
        assert_eq!(offered["parameters"]["properties"], json!({}));
        first
            .finish(json!([tool("legacy", "ask_operator", json!({}))]))
            .await;
        let (parent, result, _) = agent(joined(run).await);
        assert_eq!(result.status, AgentStatus::TurnLimit);
        assert!(result.continuation_artifact.is_some());
        assert!(
            parent.payload["request"]
                .get("operator_questions")
                .is_none()
        );
        let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
        let child = store
            .get_operation_by_command(&session, &format!("{}:tool:0:0", parent.id))
            .unwrap();
        assert_eq!(child.payload["kind"], "agent_plugin");
        assert_eq!(
            child.status,
            OperationStatus::Succeeded,
            "{:?}",
            child.outcome
        );
        let outcome: zero_protocol::plugin::PluginOutcome =
            serde_json::from_value(child.outcome.clone().unwrap()).unwrap();
        assert!(outcome.external_effects_started);
        assert!(outcome.pin.is_some());
        assert!(outcome.error.is_none());
        let expected = json!({"untrusted_plugin_data":outcome.untrusted_reply,"error":outcome.error,"status":child.status});
        assert!(expected.to_string().contains("historical_plugin"));
        let rpc: Value =
            serde_json::from_slice(&fs::read(f.dir.path().join("request.json")).unwrap()).unwrap();
        assert_eq!(rpc["method"], "tool.invoke");
        assert_eq!(rpc["params"]["tool"], "inspect");
        assert!(
            store
                .operator_questions(&session, None, 0, 100)
                .unwrap()
                .is_empty()
        );
        drop(store);
        let backend_calls = f.calls();
        assert_eq!(backend_calls.iter().filter(|v| v[0] == "create").count(), 1);
        engine.shutdown().await.unwrap();
        drop(engine);
        fs::remove_dir_all(f.dir.path().join("source")).unwrap();
        let engine = f.engine();
        configure(&f, &engine, &artifact);
        http.configure(&engine);
        assert!(agent(call(&engine, f.command(&session)).await).2);
        assert_eq!(http.count(), 1);
        let mut request = f.request.clone();
        request.continuation_of = Some(parent.id);
        request.prompt = "Continue historical plugin result".into();
        let run = start(
            engine.clone(),
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "continue".into(),
                request: request.clone(),
            },
        );
        let next = http.next().await;
        assert_eq!(
            next.body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == "ask_operator")
                .unwrap(),
            &offered
        );
        assert_eq!(outputs(&next.body), vec![expected.clone()]);
        next.answer("plugin result retained").await;
        let (completed, result, _) = agent(joined(run).await);
        assert_eq!(result.status, AgentStatus::Completed);
        request.continuation_of = Some(completed.id);
        request.prompt = "One more explanation".into();
        let run = start(
            engine.clone(),
            Command::RunAgent {
                session_id: session.clone(),
                command_id: "later".into(),
                request,
            },
        );
        let later = http.next().await;
        assert_eq!(outputs(&later.body), vec![expected]);
        later.answer("same plugin data").await;
        assert_eq!(agent(joined(run).await).1.status, AgentStatus::Completed);
        assert_eq!(f.calls(), backend_calls);
        assert_eq!(http.count(), 3);
        assert!(
            zero_engine::read_operator_questions(
                &f.dir.path().join("state.db"),
                &session,
                None,
                0,
                100
            )
            .unwrap()
            .is_empty()
        );
        engine.shutdown().await.unwrap();
    }
}
