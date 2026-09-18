use crate::{Capability, Error, Manifest};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
/// Inert candidate bytes. Bytes are never executed or loaded into this process.
pub struct Bundle {
    pub manifest: Manifest,
    pub artifacts: BTreeMap<String, Vec<u8>>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admission {
    pub manifest_digest: String,
    pub dependencies: BTreeMap<String, String>,
}
/// Host-owned policy, intentionally not deserializable from plugin RPC/manifest.
/// `trusted` is provenance metadata only; neither flag confers any grant.
#[derive(Debug, Clone, Default)]
pub struct HostPolicy {
    pub enabled: bool,
    pub trusted: bool,
    pub grants: BTreeSet<Capability>,
}
struct Record {
    manifest: Manifest,
    admission: Admission,
    artifacts: BTreeMap<String, Vec<u8>>,
    policy: HostPolicy,
}
/// An immutable registry snapshot: one exact version/digest per plugin ID.
/// Build another registry for a new generation. No implicit replacement or loading.
#[derive(Default)]
pub struct Registry {
    entries: BTreeMap<String, Record>,
}
/// A validated request description, NOT an execution permit. The sandbox broker
/// must separately enforce engagement scope, resource limits and OS isolation.
#[derive(Debug, Clone, PartialEq)]
pub struct Invocation {
    pub manifest_digest: String,
    pub dependency_pins: BTreeMap<String, String>,
    pub tool: String,
    pub input: Value,
    pub capabilities: BTreeSet<Capability>,
}
impl Registry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn get(&self, id: &str) -> Option<(&Manifest, &Admission)> {
        self.entries.get(id).map(|r| (&r.manifest, &r.admission))
    }
    pub fn artifact(&self, id: &str, digest: &str) -> Option<&[u8]> {
        self.entries
            .get(id)?
            .artifacts
            .get(digest)
            .map(Vec::as_slice)
    }
    /// Batch validation is atomic; failure installs nothing and grants nothing.
    pub fn admit_batch(&mut self, bundles: Vec<Bundle>) -> Result<Vec<Admission>, Error> {
        if self.entries.len() + bundles.len() > 128 {
            return Err(Error::Limit);
        }
        let mut pending = BTreeMap::new();
        let mut total = self
            .entries
            .values()
            .flat_map(|r| r.artifacts.values())
            .map(Vec::len)
            .sum::<usize>();
        for bundle in bundles {
            bundle.manifest.validate()?;
            let id = bundle.manifest.id.clone();
            if self.entries.contains_key(&id) || pending.contains_key(&id) {
                return Err(Error::Conflict);
            }
            if bundle.artifacts.len() != bundle.manifest.artifacts.len() {
                return Err(Error::Identity);
            }
            for a in &bundle.manifest.artifacts {
                let bytes = bundle.artifacts.get(&a.sha256).ok_or(Error::Identity)?;
                if bytes.len() as u64 != a.size || crate::sha256(bytes) != a.sha256 {
                    return Err(Error::Identity);
                }
                total = total.checked_add(bytes.len()).ok_or(Error::Limit)?;
                if total > 64 * 1024 * 1024 {
                    return Err(Error::Limit);
                }
            }
            pending.insert(id, bundle);
        }
        let mut all: BTreeMap<&str, &Manifest> = self
            .entries
            .iter()
            .map(|(id, r)| (id.as_str(), &r.manifest))
            .collect();
        all.extend(pending.iter().map(|(id, b)| (id.as_str(), &b.manifest)));
        for manifest in all.values() {
            for dependency in &manifest.dependencies {
                let target = all
                    .get(dependency.id.as_str())
                    .ok_or(Error::MissingDependency)?;
                if target.version != dependency.version {
                    return Err(Error::Identity);
                }
            }
        }
        let mut done = BTreeSet::new();
        let mut visiting = BTreeSet::new();
        for id in all.keys() {
            visit(id, &all, &mut visiting, &mut done)?;
        }
        let mut admissions = BTreeMap::new();
        for (id, bundle) in &pending {
            let dependencies = bundle
                .manifest
                .dependencies
                .iter()
                .map(|d| {
                    Ok((
                        d.id.clone(),
                        all.get(d.id.as_str())
                            .ok_or(Error::MissingDependency)?
                            .digest()?,
                    ))
                })
                .collect::<Result<_, Error>>()?;
            admissions.insert(
                id.clone(),
                Admission {
                    manifest_digest: bundle.manifest.digest()?,
                    dependencies,
                },
            );
        }
        let result = admissions.values().cloned().collect();
        for (id, bundle) in pending {
            let admission = admissions.remove(&id).ok_or(Error::MissingDependency)?;
            self.entries.insert(
                id,
                Record {
                    manifest: bundle.manifest,
                    admission,
                    artifacts: bundle.artifacts,
                    policy: HostPolicy::default(),
                },
            );
        }
        Ok(result)
    }
    /// Host must choose these grants; no JSON frame calls this method. Pinning
    /// the digest prevents a same-name candidate inheriting another artifact's grant.
    pub fn authorize(&mut self, id: &str, digest: &str, policy: HostPolicy) -> Result<(), Error> {
        let record = self.entries.get_mut(id).ok_or(Error::Denied)?;
        if record.admission.manifest_digest != digest {
            return Err(Error::Identity);
        }
        if !policy.grants.is_subset(&record.manifest.capabilities()) {
            return Err(Error::Denied);
        }
        record.policy = policy;
        Ok(())
    }
    pub fn prepare_call(
        &self,
        id: &str,
        digest: &str,
        tool: &str,
        input: Value,
    ) -> Result<Invocation, Error> {
        let (selected, pins) = self.authorized(id, digest, tool)?;
        selected.parameters.accepts(&input)?;
        Ok(Invocation {
            manifest_digest: digest.into(),
            dependency_pins: pins,
            tool: tool.into(),
            input,
            capabilities: selected.capabilities.clone(),
        })
    }
    /// Read-only tool discovery under the same host and dependency policy as
    /// invocation preparation. This does not authorize effects or acquire leases.
    pub fn authorized_tool(
        &self,
        id: &str,
        digest: &str,
        tool: &str,
    ) -> Result<crate::Tool, Error> {
        self.authorized(id, digest, tool)
            .map(|(tool, _)| tool.clone())
    }
    fn authorized(
        &self,
        id: &str,
        digest: &str,
        tool: &str,
    ) -> Result<(&crate::Tool, BTreeMap<String, String>), Error> {
        let record = self.entries.get(id).ok_or(Error::Denied)?;
        if record.admission.manifest_digest != digest {
            return Err(Error::Identity);
        }
        let selected = record
            .manifest
            .tools
            .iter()
            .find(|t| t.name == tool)
            .ok_or(Error::Denied)?;
        if !record.policy.enabled || !selected.capabilities.is_subset(&record.policy.grants) {
            return Err(Error::Denied);
        }
        let mut pins = BTreeMap::new();
        self.dependencies_ready(id, &mut pins)?;
        Ok((selected, pins))
    }
    fn dependencies_ready(
        &self,
        id: &str,
        pins: &mut BTreeMap<String, String>,
    ) -> Result<(), Error> {
        let record = self.entries.get(id).ok_or(Error::MissingDependency)?;
        for (id, digest) in &record.admission.dependencies {
            if pins.contains_key(id) {
                continue;
            }
            let dependency = self.entries.get(id).ok_or(Error::MissingDependency)?;
            if !dependency.policy.enabled
                || !dependency
                    .manifest
                    .capabilities()
                    .is_subset(&dependency.policy.grants)
            {
                return Err(Error::Denied);
            }
            pins.insert(id.clone(), digest.clone());
            self.dependencies_ready(id, pins)?;
        }
        Ok(())
    }
}
fn visit<'a>(
    id: &'a str,
    all: &BTreeMap<&'a str, &'a Manifest>,
    visiting: &mut BTreeSet<&'a str>,
    done: &mut BTreeSet<&'a str>,
) -> Result<(), Error> {
    if done.contains(id) {
        return Ok(());
    }
    if !visiting.insert(id) {
        return Err(Error::Cycle);
    }
    for dependency in &all.get(id).ok_or(Error::MissingDependency)?.dependencies {
        visit(&dependency.id, all, visiting, done)?;
    }
    visiting.remove(id);
    done.insert(id);
    Ok(())
}
