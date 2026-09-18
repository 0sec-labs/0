use crate::*;
use zero_evolution::Manifest;
use zero_plugin::HostPolicy;
use zero_protocol::{strategy::StrategyArtifact, strategy_registry::*};
/// Inert, host-verified advisory and rendering authority; never deserialized as a permission.
pub struct PreparedStrategy {
    advisory: StrategyArtifact,
    advisory_sha256: String,
    authority: StrategyHostAuthority,
}
impl PreparedStrategy {
    pub(crate) fn verify(
        registry: &Registry,
        manifest: &Manifest,
        authority: &StrategyHostAuthority,
    ) -> Result<Self> {
        authority
            .validate()
            .map_err(|_| Error::Binding("strategy authority invalid"))?;
        let digest = manifest
            .components
            .get("strategy:advisory")
            .ok_or(Error::Binding("strategy component absent"))?;
        let bytes = registry.artifact_bounded(digest, 256 * 1024)?;
        let advisory: StrategyArtifact = serde_json::from_slice(&bytes)?;
        advisory
            .validate()
            .map_err(|_| Error::Binding("strategy advisory invalid"))?;
        if serde_json::to_vec(&serde_json::to_value(&advisory)?)? != bytes {
            return Err(Error::Binding("noncanonical strategy advisory"));
        }
        Ok(Self {
            advisory,
            advisory_sha256: digest.clone(),
            authority: authority.clone(),
        })
    }
    pub fn advisory_sha256(&self) -> &str {
        &self.advisory_sha256
    }
    pub fn advisory(&self) -> &StrategyArtifact {
        &self.advisory
    }
    pub fn authority(&self) -> &StrategyHostAuthority {
        &self.authority
    }
    pub fn renderer_version(&self) -> &str {
        zero_protocol::strategy::STRATEGY_RENDERER
    }
    pub fn render_request(
        &self,
        prompt: &str,
        continuation: Option<String>,
    ) -> Result<zero_protocol::agent::AgentRequest> {
        render_strategy_request(
            &self.authority.host,
            &self.advisory,
            prompt,
            &self.authority.http_profile_name,
            continuation,
        )
        .map_err(|_| Error::Binding("strategy request rendering invalid"))
    }
}
fn retained_grants(registry: &Registry, manifest: &Manifest) -> Result<HostGrants> {
    let value: Value = serde_json::from_slice(
        &registry.artifact_bounded(&manifest.policy_artifact, 1024 * 1024)?,
    )?;
    if value["native_host_grants"] != 2 || value.as_object().is_none_or(|v| v.len() != 3) {
        return Err(Error::Binding("strategy host policy envelope invalid"));
    }
    let authority: StrategyHostAuthority = serde_json::from_value(value["strategy"].clone())?;
    let values = value["plugins"]
        .as_object()
        .ok_or(Error::Binding("strategy plugin policies absent"))?;
    if values.len() > 256 {
        return Err(Error::Binding("strategy plugin policies exceed bound"));
    }
    let mut policies = BTreeMap::new();
    for (id, p) in values {
        if p.as_object().is_none_or(|v| v.len() != 3) {
            return Err(Error::Binding("strategy plugin policy shape differs"));
        }
        policies.insert(
            id.clone(),
            HostPolicy {
                enabled: p["enabled"]
                    .as_bool()
                    .ok_or(Error::Binding("plugin enabled flag absent"))?,
                trusted: p["trusted"]
                    .as_bool()
                    .ok_or(Error::Binding("plugin trusted flag absent"))?,
                grants: serde_json::from_value(p["grants"].clone())?,
            },
        );
    }
    HostGrants::with_strategy(policies, authority)
}
impl Harness {
    pub fn bootstrap_strategy(
        &mut self,
        command: &str,
        manifest: &Manifest,
        grants: &HostGrants,
        reason: &str,
    ) -> Result<StrategyBaselineInstallReceipt> {
        let generation = self.registry.register_generation(manifest)?;
        if let Some(prior) = self.registry.strategy_bootstrap_by_command(command)? {
            if prior.generation != generation || prior.reason != reason {
                return Err(Error::Binding("strategy bootstrap retry differs"));
            }
            return Ok(prior);
        }
        if grants.strategy.is_none() {
            return Err(Error::Binding("strategy host authority required"));
        }
        let current = self.registry.current()?;
        if current.epoch != 0 || current.generation.is_some() {
            return Err(Error::Binding("strategy bootstrap requires fresh registry"));
        }
        let graph = Arc::new(PreparedGraph::verify(
            &self.registry,
            &generation,
            &self.engine_artifact,
            grants,
        )?);
        if graph.strategy().is_none() {
            return Err(Error::Binding("strategy graph not prepared"));
        }
        self.registry.put_artifact(&renderer_descriptor())?;
        self.registry.put_artifact(&evaluator_descriptor())?;
        let eligibility =
            self.registry
                .authorize_strategy_baseline(&generation, command, reason)?;
        let ticket =
            self.registry
                .prepare_activation(&generation, &eligibility, &current, |m, s| {
                    if m.state_schema != s.state_schema
                        && !m.compatible_state_schemas.contains(&s.state_schema)
                    {
                        return Err("strategy baseline state schema incompatible".into());
                    }
                    Ok(PreparedState {
                        state_schema: m.state_schema.clone(),
                        state: s.state.clone(),
                    })
                })?;
        let receipt =
            self.registry
                .commit_strategy_baseline(&ticket.id, &generation, command, reason)?;
        self.graphs.insert(generation, graph);
        Ok(receipt)
    }
    pub fn register_strategy_candidate(
        &mut self,
        baseline: &str,
        advisory: &StrategyArtifact,
    ) -> Result<StrategyCandidateRegistration> {
        let current = self.registry.current()?;
        if current.generation.as_deref() != Some(baseline) {
            return Err(Error::Stale);
        }
        let mut manifest = self.registry.generation(baseline)?;
        let grants = retained_grants(&self.registry, &manifest)?;
        let graph =
            PreparedGraph::verify(&self.registry, baseline, &self.engine_artifact, &grants)?;
        let old = graph
            .strategy()
            .ok_or(Error::Binding("baseline has no strategy"))?
            .advisory_sha256()
            .to_owned();
        advisory
            .validate()
            .map_err(|_| Error::Binding("candidate advisory invalid"))?;
        let digest = self
            .registry
            .put_artifact(&serde_json::to_vec(&serde_json::to_value(advisory)?)?)?;
        if digest == old {
            return Err(Error::Binding("candidate advisory equals baseline"));
        }
        manifest
            .components
            .insert("strategy:advisory".into(), digest.clone());
        let candidate = self.registry.register_generation(&manifest)?;
        if self.registry.current()? != current {
            return Err(Error::Stale);
        }
        Ok(StrategyCandidateRegistration {
            baseline_generation: baseline.into(),
            candidate_generation: candidate,
            baseline_advisory_sha256: old,
            candidate_advisory_sha256: digest,
        })
    }
    pub fn strategy_binding(&self, candidate: &str) -> Result<StrategyRegistryBinding> {
        Ok(self.registry.strategy_binding(candidate)?)
    }
    /// Runtime requires a graph actually prepared using current explicit host grants.
    pub fn strategy_capture(&self) -> Result<StrategyCapture> {
        let state = self.registry.current()?;
        let pin = GenerationPin::from_state(&state)?;
        let graph = self.prepared_graph(&pin)?;
        self.capture_from(&state, graph)
    }
    /// Retained-policy inspection is inert and does not prepare runtime permissions.
    pub fn inspect_strategy_capture(&self) -> Result<StrategyCapture> {
        let state = self.registry.current()?;
        let pin = GenerationPin::from_state(&state)?;
        let m = self.registry.generation(&pin.generation)?;
        let grants = retained_grants(&self.registry, &m)?;
        let graph = PreparedGraph::verify(
            &self.registry,
            &pin.generation,
            &self.engine_artifact,
            &grants,
        )?;
        self.capture_from(&state, &graph)
    }
    fn capture_from(&self, state: &RuntimeState, graph: &PreparedGraph) -> Result<StrategyCapture> {
        let strategy = graph
            .strategy()
            .ok_or(Error::Binding("active graph has no strategy"))?;
        let manifest = self.registry.generation(graph.generation())?;
        if self.registry.current()? != *state {
            return Err(Error::Stale);
        }
        Ok(StrategyCapture {
            registry: self.registry.identity()?,
            generation: graph.generation().into(),
            epoch: state.epoch,
            state_sha256: state.state_digest.clone(),
            advisory_sha256: strategy.advisory_sha256.clone(),
            advisory: strategy.advisory.clone(),
            host_policy_sha256: manifest.policy_artifact,
            authority: strategy.authority.clone(),
        })
    }
}
