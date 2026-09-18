#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "http/mod.rs"]
mod support;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    process::Stdio,
    time::Duration,
};
#[tokio::test]
async fn executable_real_strategy_capture_registry_bound_measurement_and_offline_eligibility() {
    let dir = tempfile::tempdir().unwrap();
    let worker = b"inert retained fixture worker; never launched";
    let worker_hash = zero_plugin::sha256(worker);
    let plugin = zero_plugin::Manifest {
        schema_version: 1,
        protocol_version: 1,
        id: "inspector".into(),
        version: "1.0.0".into(),
        artifacts: vec![zero_plugin::Artifact {
            sha256: worker_hash.clone(),
            size: worker.len() as u64,
        }],
        entrypoint: zero_plugin::EntryPoint {
            artifact: worker_hash.clone(),
            argv: vec![],
        },
        dependencies: vec![],
        tools: vec![zero_plugin::Tool {
            name: "inspect".into(),
            description: "Inert existing plugin component".into(),
            parameters: zero_plugin::Schema::Object {
                properties: BTreeMap::new(),
                required: vec![],
                additional_properties: false,
            },
            capabilities: BTreeSet::from([zero_plugin::Capability::Compute]),
        }],
    };
    let plugin_bytes = serde_json::to_vec(&plugin).unwrap();
    std::fs::write(dir.path().join("worker.bin"), worker).unwrap();
    std::fs::write(dir.path().join("plugin.json"), &plugin_bytes).unwrap();
    let cfg = dir.path().join("fixture.json");
    std::fs::write(&cfg,json!({"binary":env!("CARGO_BIN_EXE_0sec-native"),"root":dir.path(),"http_policy":support::policy("http://127.0.0.1:1/target/"),"plugin_sha256":format!("sha256:{}",zero_plugin::sha256(&plugin_bytes)),"worker_sha256":format!("sha256:{worker_hash}")}).to_string()).unwrap();
    let child = tokio::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/strategy_registry_driver.py"
        ))
        .arg(cfg)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(100), child.wait_with_output())
        .await
        .expect("bounded local registry fixture")
        .unwrap();
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
fn registry_readonly_and_import_identity_checks_do_not_create_missing_state() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("missing/state.db");
    let registry = dir.path().join("absent/registry.db");
    for args in [
        vec!["registry", "status"],
        vec!["eligibility", "show", "--receipt", "invalid"],
        vec!["eligibility", "prepare", "--campaign", "none"],
        vec![
            "eligibility",
            "import",
            "--campaign",
            "none",
            "--command-id",
            "none",
            "--expected-evidence",
            "invalid",
        ],
    ] {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .args([
                "--providers",
                "/missing/provider",
                "--strategy-host",
                "/missing/host",
                "strategy",
            ])
            .args(args)
            .arg("--registry")
            .arg(&registry)
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(!state.parent().unwrap().exists());
        assert!(!registry.parent().unwrap().exists());
    }
}
