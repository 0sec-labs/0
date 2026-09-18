use crate::{Error, Schema, identifier, valid_digest};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
pub const MAX_MANIFEST_BYTES: usize = 1_048_576;
pub const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    Compute,
    ModelCall,
    Network,
    FilesystemRead,
    FilesystemWrite,
    ProcessExec,
    FindingsWrite,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub sha256: String,
    pub size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EntryPoint {
    pub artifact: String,
    pub argv: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Dependency {
    pub id: String,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Schema,
    pub capabilities: BTreeSet<Capability>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub protocol_version: u32,
    pub id: String,
    pub version: String,
    pub artifacts: Vec<Artifact>,
    pub entrypoint: EntryPoint,
    pub dependencies: Vec<Dependency>,
    pub tools: Vec<Tool>,
}
impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(Error::Limit);
        }
        let result: Self =
            serde_json::from_slice(bytes).map_err(|_| Error::Invalid("manifest JSON"))?;
        result.validate()?;
        Ok(result)
    }
    pub fn validate(&self) -> Result<(), Error> {
        if self.schema_version != 1 || self.protocol_version != 1 {
            return Err(Error::Invalid("manifest or RPC version"));
        }
        if !identifier(&self.id, 64, b"._-") || !version(&self.version) {
            return Err(Error::Invalid("plugin identity"));
        }
        if self.artifacts.is_empty()
            || self.artifacts.len() > 32
            || self.tools.is_empty()
            || self.tools.len() > 64
            || self.dependencies.len() > 64
        {
            return Err(Error::Limit);
        }
        let mut artifacts = BTreeSet::new();
        let mut size = 0u64;
        for a in &self.artifacts {
            if !valid_digest(&a.sha256) || !artifacts.insert(&a.sha256) {
                return Err(Error::Invalid("artifact binding"));
            }
            size = size.checked_add(a.size).ok_or(Error::Limit)?;
        }
        if size > MAX_ARTIFACT_BYTES as u64 {
            return Err(Error::Limit);
        }
        if !artifacts.contains(&self.entrypoint.artifact)
            || self.entrypoint.argv.len() > 64
            || self
                .entrypoint
                .argv
                .iter()
                .any(|a| a.len() > 4096 || a.contains('\0'))
        {
            return Err(Error::Invalid("entrypoint"));
        }
        let mut dependencies = BTreeSet::new();
        for d in &self.dependencies {
            if !identifier(&d.id, 64, b"._-") || !version(&d.version) || !dependencies.insert(&d.id)
            {
                return Err(Error::Invalid("dependency"));
            }
        }
        let mut tools = BTreeSet::new();
        for t in &self.tools {
            if !identifier(&t.name, 48, b"_")
                || !tools.insert(&t.name)
                || t.description.len() > 4096
                || t.capabilities.is_empty()
            {
                return Err(Error::Invalid("tool declaration"));
            }
            if !matches!(t.parameters, Schema::Object { .. }) {
                return Err(Error::Invalid("tool input must be an object"));
            }
            t.parameters.validate()?;
        }
        if serde_json::to_vec(self)
            .map_err(|_| Error::Invalid("manifest"))?
            .len()
            > MAX_MANIFEST_BYTES
        {
            return Err(Error::Limit);
        }
        Ok(())
    }
    /// Deterministic typed serialization; field and set/map ordering is fixed.
    pub fn digest(&self) -> Result<String, Error> {
        self.validate()?;
        Ok(crate::sha256(
            &serde_json::to_vec(self).map_err(|_| Error::Invalid("manifest"))?,
        ))
    }
    pub fn capabilities(&self) -> BTreeSet<Capability> {
        self.tools
            .iter()
            .flat_map(|t| t.capabilities.iter().copied())
            .collect()
    }
}
fn version(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|v| {
            !v.is_empty()
                && v.len() <= 10
                && v.bytes().all(|c| c.is_ascii_digit())
                && (*v == "0" || !v.starts_with('0'))
                && v.parse::<u32>().is_ok()
        })
}
