use crate::{Error, Result};
use serde_json::json;
use std::collections::BTreeMap;
use zero_evolution::Registry as Evolution;
use zero_plugin::{Bundle, HostPolicy, Manifest, Registry};
/// Trusted host input, not deserializable from model/plugin output. Its exact
/// serialized bytes must already be pinned as the generation policy artifact.
pub struct HostGrants {
    policies: BTreeMap<String, HostPolicy>,
}
impl HostGrants {
    pub fn new(policies: BTreeMap<String, HostPolicy>) -> Self {
        Self { policies }
    }
    pub fn artifact_bytes(&self) -> Result<Vec<u8>> {
        let policies: BTreeMap<_, _> = self
            .policies
            .iter()
            .map(|(id, p)| {
                (
                    id,
                    json!({"enabled":p.enabled,"trusted":p.trusted,"grants":p.grants}),
                )
            })
            .collect();
        let bytes = serde_json::to_vec(&json!({"native_host_grants":1,"plugins":policies}))?;
        if bytes.len() > zero_evolution::MAX_JSON_BYTES {
            return Err(Error::Binding("host grants exceed limit"));
        }
        Ok(bytes)
    }
}
pub struct PreparedGraph {
    pub(crate) generation: String,
    pub(crate) plugins: Registry,
}
impl PreparedGraph {
    pub fn generation(&self) -> &str {
        &self.generation
    }
    pub fn plugin_digest(&self, id: &str) -> Option<&str> {
        self.plugins
            .get(id)
            .map(|(_, a)| a.manifest_digest.as_str())
    }
    pub fn artifact(&self, plugin: &str, digest: &str) -> Option<&[u8]> {
        self.plugins.artifact(plugin, digest)
    }
    pub(crate) fn verify(
        registry: &Evolution,
        generation: &str,
        engine_artifact: &str,
        grants: &HostGrants,
    ) -> Result<Self> {
        let manifest = registry.generation(generation)?;
        if manifest.protocol_version != 1
            || manifest.engine_artifact != engine_artifact
            || manifest.configuration != json!({"native_plugin_graph":1})
        {
            return Err(Error::Binding(
                "unsupported generation configuration, engine or protocol",
            ));
        }
        registry.artifact(engine_artifact)?;
        if registry.artifact(&manifest.policy_artifact)? != grants.artifact_bytes()? {
            return Err(Error::Binding("host grants differ from pinned policy"));
        }
        if manifest.components.len() != grants.policies.len() {
            return Err(Error::Binding("grant/plugin set differs"));
        }
        let mut bundles = vec![];
        let mut total = 0usize;
        for (component, digest) in &manifest.components {
            let id = component
                .strip_prefix("plugin:")
                .ok_or(Error::Binding("non-plugin component unsupported"))?;
            if !grants.policies.contains_key(id) {
                return Err(Error::Binding("plugin missing host policy"));
            }
            let bytes = registry.artifact(digest)?;
            let plugin = Manifest::parse(&bytes)?;
            // Exactly one canonical plugin manifest serialization; identities
            // across the two stores differ only by evolution's sha256: prefix.
            if plugin.id != id || format!("sha256:{}", plugin.digest()?) != *digest {
                return Err(Error::Binding("component/plugin identity mismatch"));
            }
            let mut artifacts = BTreeMap::new();
            for artifact in &plugin.artifacts {
                let data = registry.artifact(&format!("sha256:{}", artifact.sha256))?;
                total = total
                    .checked_add(data.len())
                    .ok_or(Error::Binding("graph size overflow"))?;
                if total > 64 * 1024 * 1024 {
                    return Err(Error::Binding("graph artifact size exceeds 64 MiB"));
                }
                artifacts.insert(artifact.sha256.clone(), data);
            }
            bundles.push(Bundle {
                manifest: plugin,
                artifacts,
            });
        }
        let mut plugins = Registry::new();
        plugins.admit_batch(bundles)?;
        for (id, policy) in &grants.policies {
            let digest = plugins
                .get(id)
                .ok_or(Error::Binding("missing plugin"))?
                .1
                .manifest_digest
                .clone();
            plugins.authorize(id, &digest, policy.clone())?;
        }
        Ok(Self {
            generation: generation.into(),
            plugins,
        })
    }
}
