//! Host-owned authority, loaded only from an explicitly selected configuration.
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    path::{Path, PathBuf},
};
use zero_engine::Engine;
use zero_harness::{Harness, HostGrants};
use zero_plugin::{Capability, HostPolicy};
use zero_plugin_runner::Launch;
use zero_protocol::{
    plugin::{PluginHostOperation, PluginWorkerPolicy},
    sandbox::SandboxBackend,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    enabled: bool,
    trusted: bool,
    grants: BTreeSet<Capability>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    registry: PathBuf,
    engine_artifact: String,
    plugins: BTreeMap<String, Policy>,
    launch: Launch,
    #[serde(default)]
    workers: BTreeMap<String, PluginWorkerPolicy>,
}

impl Config {
    fn validate_workers(&self) -> Result<(), Box<dyn Error>> {
        if self.workers.is_empty() {
            return Ok(());
        }
        if self.workers.len() > 4 {
            return Err("Harness allows at most four persistent worker plugins".into());
        }
        let SandboxBackend::Docker { image } = &self.launch.backend else {
            return Err("Persistent plugin workers require Docker".into());
        };
        let digest = image
            .rsplit_once('@')
            .map_or(image.as_str(), |(_, digest)| digest);
        if !zero_protocol::is_sha256(digest) {
            return Err(
                "Persistent plugin workers require an immutable Docker image digest".into(),
            );
        }
        for (plugin, worker) in &self.workers {
            worker.validate()?;
            let policy = self
                .plugins
                .get(plugin)
                .filter(|p| p.enabled)
                .ok_or("Worker plugin requires an enabled host policy")?;
            for operation in &worker.operations {
                let capability = match operation {
                    PluginHostOperation::HttpRequest => Capability::Network,
                    PluginHostOperation::ListSourceFiles
                    | PluginHostOperation::ReadSourceLines
                    | PluginHostOperation::SearchSourceText => Capability::FilesystemRead,
                };
                if !policy.grants.contains(&capability) {
                    return Err("Worker operation exceeds explicit host capability grants".into());
                }
            }
        }
        Ok(())
    }
}
pub async fn configure(engine: &Engine, path: &Path) -> Result<(), Box<dyn Error>> {
    let bytes = crate::providers::read_bounded(path).await?;
    let config: Config =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid host harness configuration JSON")?;
    config.validate_workers()?;
    if !config.registry.is_absolute() || !zero_protocol::is_sha256(&config.engine_artifact) {
        return Err(
            "Harness requires an absolute existing registry and expected engine artifact digest"
                .into(),
        );
    }
    let metadata = std::fs::symlink_metadata(&config.registry)
        .map_err(|_| "Harness registry is unavailable")?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("Harness registry must be an existing nonempty regular file".into());
    }
    let grants = HostGrants::new(
        config
            .plugins
            .into_iter()
            .map(|(id, p)| {
                (
                    id,
                    HostPolicy {
                        enabled: p.enabled,
                        trusted: p.trusted,
                        grants: p.grants,
                    },
                )
            })
            .collect(),
    );
    // Initial values are ignored by an existing registry; no generation is installed
    // or activated here. restore_current fails if no verified active graph exists.
    let registry =
        zero_evolution::Registry::open(&config.registry, "native-host", &serde_json::json!({}))?;
    let mut harness = Harness::new(registry, config.engine_artifact);
    harness.restore_current(&grants)?;
    engine.configure_plugins(harness, config.launch)?;
    if !config.workers.is_empty() {
        engine.configure_plugin_workers(config.workers)?;
    }
    Ok(())
}
