//! Explicit host configuration for the actual advisory adapter, separate from plugin launch.
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    path::{Path, PathBuf},
};
use tokio::io::AsyncReadExt;
use zero_harness::{Harness, HostGrants};
use zero_plugin::{Capability, HostPolicy};
use zero_protocol::{strategy::StrategyArtifact, strategy_registry::StrategyHostAuthority};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PluginPolicy {
    enabled: bool,
    trusted: bool,
    grants: BTreeSet<Capability>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    state_schema: String,
    #[serde(default)]
    compatible_state_schemas: Vec<String>,
    initial_state: serde_json::Value,
    /// Explicit local artifact closure. Paths resolve relative to this host configuration.
    artifacts: BTreeMap<String, PathBuf>,
    #[serde(default)]
    plugin_components: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    registry: PathBuf,
    engine_artifact: String,
    plugins: BTreeMap<String, PluginPolicy>,
    strategy: StrategyHostAuthority,
    #[serde(default)]
    bootstrap: Option<Bootstrap>,
}
impl Config {
    fn grants(&self) -> Result<HostGrants, Box<dyn Error>> {
        Ok(HostGrants::with_strategy(
            self.plugins
                .iter()
                .map(|(id, p)| {
                    (
                        id.clone(),
                        HostPolicy {
                            enabled: p.enabled,
                            trusted: p.trusted,
                            grants: p.grants.clone(),
                        },
                    )
                })
                .collect(),
            self.strategy.clone(),
        )?)
    }
}
async fn load(path: &Path) -> Result<Config, Box<dyn Error>> {
    let bytes = crate::providers::read_bounded(path).await?;
    let mut config: Config =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid strategy host configuration JSON")?;
    if !config.registry.is_absolute() || !zero_protocol::is_sha256(&config.engine_artifact) {
        return Err(
            "Strategy host requires an absolute registry path and engine artifact digest".into(),
        );
    }
    config.strategy.http_policy = zero_http::normalize_policy(config.strategy.http_policy)
        .map_err(|_| "Invalid strategy host HTTP policy")?;
    config
        .strategy
        .validate()
        .map_err(|_| "Invalid strategy host authority")?;
    Ok(config)
}
pub async fn configure(engine: &zero_engine::Engine, path: &Path) -> Result<(), Box<dyn Error>> {
    let config = load(path).await?;
    let metadata = std::fs::symlink_metadata(&config.registry)
        .map_err(|_| "Strategy registry is unavailable")?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("Strategy registry must be an existing nonempty regular file".into());
    }
    let grants = config.grants()?;
    let mut harness = Harness::new(
        zero_evolution::Registry::open(&config.registry, "native-host", &serde_json::json!({}))?,
        config.engine_artifact,
    );
    harness.restore_current(&grants)?;
    engine.configure_strategy(harness)?;
    Ok(())
}
pub async fn advisory(path: &Path) -> Result<StrategyArtifact, Box<dyn Error>> {
    let value: StrategyArtifact =
        serde_json::from_slice(&crate::providers::read_bounded(path).await?)
            .map_err(|_| "Invalid strategy advisory JSON")?;
    value
        .validate()
        .map_err(|_| "Invalid strategy advisory version or bounds")?;
    Ok(value)
}
pub async fn bootstrap(
    host: &Path,
    baseline: &Path,
    command: &str,
    reason: &str,
) -> Result<zero_protocol::strategy_registry::StrategyBaselineInstallReceipt, Box<dyn Error>> {
    if [command, reason]
        .iter()
        .any(|value| value.trim().is_empty() || value.len() > 4096)
    {
        return Err("Bootstrap command and reason must each contain 1..4096 UTF-8 bytes".into());
    }
    let config = load(host).await?;
    let advice = advisory(baseline).await?;
    let grants = config.grants()?;
    let seed = config
        .bootstrap
        .ok_or("Strategy bootstrap requires an explicit artifact closure and initial state")?;
    if seed.artifacts.len() > 256
        || seed.plugin_components.len() > 256
        || seed
            .plugin_components
            .keys()
            .any(|k| !k.starts_with("plugin:"))
    {
        return Err("Invalid strategy bootstrap component bounds or kind".into());
    }
    let mut total = 0usize;
    let mut artifacts = BTreeMap::new();
    for (digest, path) in seed.artifacts {
        if !zero_protocol::is_sha256(&digest) {
            return Err("Invalid bootstrap artifact digest".into());
        }
        let path = if path.is_absolute() {
            path
        } else {
            host.parent().unwrap_or_else(|| Path::new(".")).join(path)
        };
        let remaining = (64 * 1024 * 1024usize)
            .checked_sub(total)
            .ok_or("Strategy bootstrap closure exceeds 64 MiB")?;
        let read = async {
            let mut bytes = Vec::new();
            tokio::fs::File::open(path)
                .await?
                .take((remaining + 1) as u64)
                .read_to_end(&mut bytes)
                .await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let bytes = tokio::select! {
            result=tokio::time::timeout(std::time::Duration::from_secs(5),read)=>result.map_err(|_|"Bootstrap artifact read deadline exceeded")??,
            _=crate::server::shutdown_signal()=>return Err("Bootstrap input interrupted".into()),
        };
        if bytes.is_empty()
            || bytes.len() > remaining
            || format!("sha256:{}", zero_plugin::sha256(&bytes)) != digest
        {
            return Err("Bootstrap artifact hash, size or closure bound differs".into());
        }
        total += bytes.len();
        artifacts.insert(digest, bytes);
    }
    if !artifacts.contains_key(&config.engine_artifact) {
        return Err("Bootstrap closure is missing engine artifact bytes".into());
    }
    let policy = grants.artifact_bytes()?;
    let advice = serde_json::to_vec(&serde_json::to_value(&advice)?)?;
    if total
        .saturating_add(policy.len())
        .saturating_add(advice.len())
        > 64 * 1024 * 1024
    {
        return Err("Strategy bootstrap closure exceeds 64 MiB".into());
    }
    // Closure hashes and input bounds are checked before registry creation.
    // The harness validates the complete graph before publishing it.
    let command = command.to_owned();
    let reason = reason.to_owned();
    let result = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let mut registry = zero_evolution::Registry::open(
            &config.registry,
            &seed.state_schema,
            &seed.initial_state,
        )
        .map_err(|e| e.to_string())?;
        for bytes in artifacts.values() {
            registry.put_artifact(bytes).map_err(|e| e.to_string())?;
        }
        let mut components = seed.plugin_components;
        components.insert(
            "strategy:advisory".into(),
            registry.put_artifact(&advice).map_err(|e| e.to_string())?,
        );
        let manifest = zero_evolution::Manifest {
            engine_artifact: config.engine_artifact.clone(),
            components,
            protocol_version: 1,
            state_schema: seed.state_schema,
            compatible_state_schemas: seed.compatible_state_schemas,
            configuration: zero_protocol::strategy_registry::strategy_configuration(),
            policy_artifact: registry.put_artifact(&policy).map_err(|e| e.to_string())?,
        };
        Harness::new(registry, config.engine_artifact)
            .bootstrap_strategy(&command, &manifest, &grants, &reason)
            .map_err(|e| e.to_string())
    })
    .await?
    .map_err(std::io::Error::other)?;
    Ok(result)
}
