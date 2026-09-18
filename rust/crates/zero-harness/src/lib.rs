//! Generation-bound inert plugin graphs. No worker execution or process hot swap.
mod graph;
mod strategy;
pub use graph::{HostGrants, PreparedGraph};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
pub use strategy::PreparedStrategy;
use zero_evolution::{
    GenerationLease, PreparedActivation, PreparedState, Registry, RuntimeLifecycle, RuntimeState,
};
use zero_plugin::Invocation;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Evolution(#[from] zero_evolution::Error),
    #[error(transparent)]
    Plugin(#[from] zero_plugin::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("invalid generation binding: {0}")]
    Binding(&'static str),
    #[error("stale generation, epoch or invocation pin")]
    Stale,
    #[error("generation graph is not prepared in this process")]
    NotPrepared,
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenerationPin {
    pub generation: String,
    pub epoch: u64,
}
impl GenerationPin {
    pub fn from_state(state: &RuntimeState) -> Result<Self> {
        Ok(Self {
            generation: state.generation.clone().ok_or(Error::NotPrepared)?,
            epoch: state.epoch,
        })
    }
}
/// Reply correlation data only; plugin-supplied matching bytes are NOT authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerPin {
    pub generation: GenerationPin,
    pub lease_id: String,
    pub plugin_manifest: String,
}
/// Not Clone/Deserialize. Issued only after durable acquisition and validation.
/// Drop keeps its durable lease outstanding: lost work requires fenced recovery.
pub struct PinnedCall {
    issuer: String,
    lease: GenerationLease,
    graph: Arc<PreparedGraph>,
    invocation: Invocation,
    completed: bool,
}
impl PinnedCall {
    pub fn pin(&self) -> BrokerPin {
        BrokerPin {
            generation: GenerationPin {
                generation: self.lease.generation.clone(),
                epoch: self.lease.epoch,
            },
            lease_id: self.lease.id.clone(),
            plugin_manifest: self.invocation.manifest_digest.clone(),
        }
    }
    pub fn lease(&self) -> &GenerationLease {
        &self.lease
    }
    pub fn invocation(&self) -> &Invocation {
        &self.invocation
    }
    pub fn graph(&self) -> &PreparedGraph {
        &self.graph
    }
}
pub struct PreparedSwitch {
    issuer: String,
    ticket: PreparedActivation,
    graph: Arc<PreparedGraph>,
}
/// Single host/controller instance. External lease recovery must fence owners;
/// external activation is detected through generation/epoch checks and SQL CAS.
pub struct Harness {
    registry: Registry,
    engine_artifact: String,
    issuer: String,
    graphs: BTreeMap<String, Arc<PreparedGraph>>,
    issued: BTreeSet<String>,
}
impl Harness {
    pub fn new(registry: Registry, engine_artifact: String) -> Self {
        Self {
            registry,
            engine_artifact,
            issuer: uuid::Uuid::new_v4().to_string(),
            graphs: BTreeMap::new(),
            issued: BTreeSet::new(),
        }
    }
    pub fn current(&self) -> Result<RuntimeState> {
        Ok(self.registry.current()?)
    }
    pub fn lifecycle(&self, generation: &str) -> Result<RuntimeLifecycle> {
        Ok(self.registry.lifecycle(generation)?)
    }
    /// Rebuild inert current graph after restart using freshly supplied host
    /// authority. Restoring does not adopt leases or resume unfinished effects.
    pub fn restore_current(&mut self, grants: &HostGrants) -> Result<GenerationPin> {
        let state = self.registry.current()?;
        let pin = GenerationPin::from_state(&state)?;
        self.capacity(&pin.generation)?;
        let graph = PreparedGraph::verify(
            &self.registry,
            &pin.generation,
            &self.engine_artifact,
            grants,
        )?;
        if self.registry.current()? != state {
            return Err(Error::Stale);
        }
        self.graphs.insert(pin.generation.clone(), Arc::new(graph));
        Ok(pin)
    }
    pub fn prepare_activation<F>(
        &mut self,
        target: &str,
        eligibility: &str,
        expected: &RuntimeState,
        grants: &HostGrants,
        migrate: F,
    ) -> Result<PreparedSwitch>
    where
        F: FnOnce(
            &zero_evolution::Manifest,
            &RuntimeState,
        ) -> std::result::Result<PreparedState, String>,
    {
        self.prepare(target, eligibility, expected, grants, false, migrate)
    }
    pub fn prepare_rollback<F>(
        &mut self,
        target: &str,
        eligibility: &str,
        expected: &RuntimeState,
        grants: &HostGrants,
        migrate: F,
    ) -> Result<PreparedSwitch>
    where
        F: FnOnce(
            &zero_evolution::Manifest,
            &RuntimeState,
        ) -> std::result::Result<PreparedState, String>,
    {
        self.prepare(target, eligibility, expected, grants, true, migrate)
    }
    fn prepare<F>(
        &mut self,
        target: &str,
        eligibility: &str,
        expected: &RuntimeState,
        grants: &HostGrants,
        rollback: bool,
        migrate: F,
    ) -> Result<PreparedSwitch>
    where
        F: FnOnce(
            &zero_evolution::Manifest,
            &RuntimeState,
        ) -> std::result::Result<PreparedState, String>,
    {
        self.capacity(target)?;
        let graph = Arc::new(PreparedGraph::verify(
            &self.registry,
            target,
            &self.engine_artifact,
            grants,
        )?);
        let ticket = if rollback {
            self.registry
                .prepare_rollback(target, eligibility, expected, migrate)?
        } else {
            self.registry
                .prepare_activation(target, eligibility, expected, migrate)?
        };
        Ok(PreparedSwitch {
            issuer: self.issuer.clone(),
            ticket,
            graph,
        })
    }
    pub fn commit(&mut self, prepared: PreparedSwitch) -> Result<GenerationPin> {
        if prepared.issuer != self.issuer {
            return Err(Error::Stale);
        }
        self.capacity(&prepared.ticket.generation)?;
        let state = self.registry.commit(&prepared.ticket.id)?;
        let pin = GenerationPin::from_state(&state)?;
        self.graphs.insert(pin.generation.clone(), prepared.graph);
        Ok(pin)
    }
    /// Read-only preflight against the active activation epoch. Call admission
    /// still rechecks the epoch atomically when it acquires its durable lease.
    pub fn prepared_graph(&self, expected: &GenerationPin) -> Result<&PreparedGraph> {
        if GenerationPin::from_state(&self.registry.current()?)? != *expected {
            return Err(Error::Stale);
        }
        self.graphs
            .get(&expected.generation)
            .map(Arc::as_ref)
            .ok_or(Error::NotPrepared)
    }
    pub fn tool_definition(
        &self,
        expected: &GenerationPin,
        plugin: &str,
        tool: &str,
    ) -> Result<(String, zero_plugin::Tool)> {
        let graph = self.prepared_graph(expected)?;
        let digest = graph
            .plugin_digest(plugin)
            .ok_or(Error::Binding("plugin not in generation"))?;
        Ok((
            digest.to_owned(),
            graph.plugins.authorized_tool(plugin, digest, tool)?,
        ))
    }
    /// Validate input without staging files, acquiring a lease or starting work.
    pub fn validate_call(
        &self,
        expected: &GenerationPin,
        plugin: &str,
        tool: &str,
        input: Value,
    ) -> Result<Invocation> {
        let graph = self.prepared_graph(expected)?;
        let digest = graph
            .plugin_digest(plugin)
            .ok_or(Error::Binding("plugin not in generation"))?;
        Ok(graph.plugins.prepare_call(plugin, digest, tool, input)?)
    }
    /// Caller supplies the session's expected generation and activation epoch.
    /// Acquisition is durable and atomic; a concurrent switch cannot silently
    /// repin an invocation to a different implementation.
    pub fn begin_call(
        &mut self,
        expected: &GenerationPin,
        owner: &str,
        plugin: &str,
        tool: &str,
        input: Value,
    ) -> Result<PinnedCall> {
        let graph = self
            .graphs
            .get(&expected.generation)
            .cloned()
            .ok_or(Error::NotPrepared)?;
        let digest = graph
            .plugin_digest(plugin)
            .ok_or(Error::Binding("plugin not in generation"))?;
        let invocation = graph.plugins.prepare_call(plugin, digest, tool, input)?;
        let lease = self.registry.acquire_active(owner)?;
        if lease.generation != expected.generation || lease.epoch != expected.epoch {
            self.registry.release(&lease.id, owner)?;
            return Err(Error::Stale);
        }
        self.issued.insert(lease.id.clone());
        Ok(PinnedCall {
            issuer: self.issuer.clone(),
            lease,
            graph,
            invocation,
            completed: false,
        })
    }
    /// Old-generation replies remain valid for their still-issued invocation;
    /// they cannot satisfy a new generation/epoch/lease/plugin invocation.
    pub fn validate_reply(&self, call: &PinnedCall, pin: &BrokerPin) -> Result<()> {
        if call.issuer != self.issuer
            || call.completed
            || !self.issued.contains(&call.lease.id)
            || call.pin() != *pin
        {
            return Err(Error::Stale);
        }
        Ok(())
    }
    /// The trusted caller asserts all associated backend/broker work has settled.
    /// This releases bookkeeping; it does not kill workers or undo effects.
    pub fn complete_settled(&mut self, call: &mut PinnedCall) -> Result<()> {
        if call.issuer != self.issuer {
            return Err(Error::Stale);
        }
        if call.completed {
            return Ok(());
        }
        self.validate_reply(call, &call.pin())?;
        self.registry.release(&call.lease.id, &call.lease.owner)?;
        self.issued.remove(&call.lease.id);
        call.completed = true;
        Ok(())
    }
    pub fn unreleased(
        &self,
        owner: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<GenerationLease>> {
        Ok(self
            .registry
            .list_unreleased_leases(owner, None, after, limit)?)
    }
    /// Recovery-only host assertion: owner has been externally fenced/quiesced.
    /// No lease timeout, liveness detection or automatic replay is inferred.
    pub fn release_fenced(&mut self, lease_id: &str, owner: &str) -> Result<()> {
        self.registry.release(lease_id, owner)?;
        self.issued.remove(lease_id);
        Ok(())
    }
    fn capacity(&self, target: &str) -> Result<()> {
        if self.graphs.len() >= 8 && !self.graphs.contains_key(target) {
            Err(Error::Binding(
                "eight retained graphs reached; restart/reprepare required",
            ))
        } else {
            Ok(())
        }
    }
}
