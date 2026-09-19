use crate::*;
use zero_protocol::strategy::{StrategyArtifact, StrategyDecision, StrategyReport};
use zero_protocol::strategy_registry::*;
mod import;
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Scope {
    Bootstrap {
        registry: RegistryIdentity,
        command_id: String,
        request_sha256: String,
        advisory_sha256: String,
        reason: String,
    },
    Measured {
        binding: Box<StrategyRegistryBinding>,
        evidence_sha256: String,
        report_sha256: String,
        canary_required: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        canary_suite_sha256: Option<String>,
        retained_artifacts: std::collections::BTreeMap<String, u64>,
        protected_suite_sha256: String,
        evaluation_pair_sha256: String,
    },
}
pub(crate) fn reserved(m: &Manifest) -> bool {
    m.configuration.get("strategy").is_some()
        || m.configuration["native_plugin_graph"] == 2
        || m.components.keys().any(|s| s.starts_with("strategy:"))
}
fn invalid(s: &str) -> Error {
    Error::Invalid(s.into())
}
fn bounded_artifact(conn: &Connection, id: &str, max: usize) -> Result<Vec<u8>> {
    let size: usize = conn
        .query_row(
            "SELECT length(bytes) FROM artifacts WHERE digest=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::Missing(id.into()))?;
    if size > max {
        return Err(invalid("strategy artifact exceeds bound"));
    }
    artifact(conn, id)
}
pub(crate) fn identity(conn: &Connection) -> Result<RegistryIdentity> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 2 {
        return Err(invalid(
            "strategy identity requires writable schema migration",
        ));
    }
    let (id,digest):(String,String)=conn.query_row("SELECT CASE WHEN length(CAST(registry_id AS BLOB))<=64 THEN registry_id END,CASE WHEN length(CAST(genesis_artifact AS BLOB))=71 THEN genesis_artifact END FROM registry_identity WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let value: Value = serde_json::from_slice(&bounded_artifact(conn, &digest, 4096)?)?;
    if uuid::Uuid::parse_str(&id).is_err()
        || value["registry_id"] != id
        || value["schema_version"] != 1
        || value.as_object().is_none_or(|v| v.len() != 5)
        || !zero_protocol::is_sha256(value["adopted_state_sha256"].as_str().unwrap_or(""))
        || value["adopted_epoch"].as_u64().is_none()
    {
        return Err(invalid("strategy registry genesis differs"));
    }
    Ok(RegistryIdentity {
        schema_version: 1,
        registry_id: id,
        genesis_sha256: digest,
    })
}
pub(crate) fn parts(
    conn: &Connection,
    generation: &str,
) -> Result<(Manifest, StrategyArtifact, StrategyHostAuthority)> {
    let m: Manifest = read_json(conn, "generations", generation)?;
    if m.configuration != strategy_configuration()
        || m.protocol_version != 1
        || m.components
            .keys()
            .any(|k| k != "strategy:advisory" && !k.starts_with("plugin:"))
    {
        return Err(invalid("unsupported strategy generation"));
    }
    let id = m
        .components
        .get("strategy:advisory")
        .ok_or_else(|| invalid("strategy advisory component absent"))?;
    let bytes = bounded_artifact(conn, id, 256 * 1024)?;
    let advisory: StrategyArtifact = serde_json::from_slice(&bytes)?;
    advisory.validate().map_err(|e| invalid(&e.to_string()))?;
    if encode(&advisory)?.as_bytes() != bytes {
        return Err(invalid("noncanonical strategy advisory"));
    }
    let policy: Value =
        serde_json::from_slice(&bounded_artifact(conn, &m.policy_artifact, MAX_JSON_BYTES)?)?;
    if policy["native_host_grants"] != 2
        || policy.as_object().is_none_or(|o| o.len() != 3)
        || !policy["plugins"].is_object()
    {
        return Err(invalid("strategy host policy envelope"));
    }
    let authority: StrategyHostAuthority = serde_json::from_value(policy["strategy"].clone())?;
    authority.validate().map_err(|e| invalid(&e.to_string()))?;
    if m.components.len() != policy["plugins"].as_object().map_or(0, |v| v.len()) + 1
        || m.components
            .keys()
            .filter_map(|s| s.strip_prefix("plugin:"))
            .any(|id| policy["plugins"].get(id).is_none())
    {
        return Err(invalid("strategy plugin/grant closure differs"));
    }
    Ok((m, advisory, authority))
}
pub(crate) fn authorize(
    conn: &Connection,
    generation: &str,
    eligibility_id: &str,
    e: &Eligibility,
    state: &RuntimeState,
    rollback: bool,
) -> Result<()> {
    let (m, _, authority) = parts(conn, generation)?;
    let scope = e
        .strategy_scope
        .as_ref()
        .ok_or_else(|| Error::Ineligible("strategy scope absent".into()))?;
    match scope {
        Scope::Bootstrap {
            registry,
            command_id,
            request_sha256,
            advisory_sha256,
            reason,
        } => {
            if *registry != identity(conn)?
                || m.components["strategy:advisory"] != *advisory_sha256
                || e.bootstrap_reason.as_deref() != Some(reason)
                || e.receipt.is_some()
                || bootstrap_request(generation, reason, registry)? != *request_sha256
            {
                return Err(Error::Ineligible("strategy bootstrap scope differs".into()));
            }
            if rollback {
                let receipt = bootstrap(conn, command_id)?.ok_or_else(|| {
                    Error::Ineligible("strategy baseline install witness absent".into())
                })?;
                if receipt.generation != generation {
                    return Err(Error::Ineligible("bootstrap generation differs".into()));
                }
            } else if state.epoch != 0 || state.generation.is_some() {
                return Err(Error::Ineligible(
                    "strategy bootstrap requires empty registry".into(),
                ));
            }
        }
        Scope::Measured {
            binding,
            evidence_sha256,
            report_sha256,
            canary_required,
            canary_suite_sha256,
            retained_artifacts,
            protected_suite_sha256,
            evaluation_pair_sha256,
        } => {
            verify_retained(conn, retained_artifacts)?;
            validate_binding(conn, binding, false)?;
            let row:Option<(String,String)>=conn.query_row("SELECT CASE WHEN length(CAST(record_json AS BLOB))<=?2 THEN record_json END,CASE WHEN length(CAST(record_sha256 AS BLOB))=71 THEN record_sha256 END FROM strategy_imports WHERE eligibility_sha256=?1 LIMIT 1",params![eligibility_id,MAX_JSON_BYTES],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let (raw, digest) =
                row.ok_or_else(|| Error::Ineligible("strategy trusted import absent".into()))?;
            let receipt: StrategyImportReceipt = serde_json::from_str(&raw)?;
            if hash(raw.as_bytes()) != digest
                || receipt.suite_sha256 != *protected_suite_sha256
                || receipt.pair_sha256 != *evaluation_pair_sha256
                || receipt.evidence_sha256 != *evidence_sha256
                || receipt.report_sha256 != *report_sha256
                || receipt.eligibility_sha256 != eligibility_id
                || receipt.candidate_generation != generation
                || e.receipt.as_deref() != Some(&receipt.evaluation_receipt_sha256)
            {
                return Err(Error::Ineligible("strategy import witness differs".into()));
            }
            import::validate_canary_scope(
                conn,
                evidence_sha256,
                report_sha256,
                canary_suite_sha256.as_deref(),
                &authority,
            )?;
            if !rollback {
                validate_binding(conn, binding, true)?;
                if *canary_required && canary_suite_sha256.is_none() {
                    return Err(Error::Ineligible(
                        "independent canary prerequisite is not satisfied".into(),
                    ));
                }
            }
        }
    }
    Ok(())
}
fn bootstrap_request(
    generation: &str,
    reason: &str,
    registry: &RegistryIdentity,
) -> Result<String> {
    Ok(hash(
        encode(&serde_json::json!({"generation":generation,"reason":reason,"registry":registry}))?
            .as_bytes(),
    ))
}
pub(crate) fn bootstrap(
    conn: &Connection,
    command: &str,
) -> Result<Option<StrategyBaselineInstallReceipt>> {
    let row:Option<(String,String,String,String,u64)>=conn.query_row("SELECT CASE WHEN length(CAST(record_json AS BLOB))<=?2 THEN record_json END,CASE WHEN length(CAST(record_sha256 AS BLOB))=71 THEN record_sha256 END,CASE WHEN length(CAST(request_sha256 AS BLOB))=71 THEN request_sha256 END,CASE WHEN length(CAST(generation AS BLOB))=71 THEN generation END,activation_epoch FROM strategy_bootstraps WHERE command_id=?1",params![command,MAX_JSON_BYTES],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let Some((raw, digest, request, generation, epoch)) = row else {
        return Ok(None);
    };
    let r: StrategyBaselineInstallReceipt = serde_json::from_str(&raw)?;
    let active: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM activations WHERE epoch=?1 AND generation=?2 AND rollback=0)",
        params![epoch, generation],
        |q| q.get(0),
    )?;
    if hash(raw.as_bytes()) != digest
        || r.command_id != command
        || r.request_sha256 != request
        || r.generation != generation
        || r.activation_epoch != epoch
        || r.registry != identity(conn)?
        || bootstrap_request(&generation, &r.reason, &r.registry)? != request
        || !active
    {
        return Err(invalid("strategy bootstrap receipt differs"));
    }
    Ok(Some(r))
}
pub(crate) fn finish_bootstrap(
    conn: &Connection,
    preparation: &str,
    command: &str,
    reason: &str,
    state: &RuntimeState,
) -> Result<StrategyBaselineInstallReceipt> {
    let (generation, eligibility): (String, String) = conn.query_row(
        "SELECT CASE WHEN length(CAST(generation AS BLOB))=71 THEN generation END,CASE WHEN length(CAST(eligibility AS BLOB))=71 THEN eligibility END FROM preparations WHERE id=?1",
        [preparation],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let e: Eligibility = read_json(conn, "eligibilities", &eligibility)?;
    let Some(Scope::Bootstrap {
        registry,
        command_id,
        request_sha256,
        advisory_sha256,
        reason: stored_reason,
    }) = e.strategy_scope
    else {
        return Err(invalid("strategy bootstrap scope absent"));
    };
    if command_id != command
        || stored_reason != reason
        || state.generation.as_deref() != Some(&generation)
    {
        return Err(invalid("strategy bootstrap commit identity differs"));
    }
    let m: Manifest = read_json(conn, "generations", &generation)?;
    let receipt = StrategyBaselineInstallReceipt {
        schema_version: 1,
        registry,
        command_id,
        request_sha256,
        generation,
        advisory_sha256,
        host_policy_sha256: m.policy_artifact,
        activation_epoch: state.epoch,
        reason: reason.into(),
        qualification: "trusted_unmeasured_baseline".into(),
    };
    let raw = encode(&receipt)?;
    conn.execute(
        "INSERT INTO strategy_bootstraps VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            command,
            receipt.request_sha256,
            receipt.generation,
            eligibility,
            state.epoch,
            hash(raw.as_bytes()),
            raw
        ],
    )?;
    Ok(receipt)
}
pub(crate) fn validate_binding(
    conn: &Connection,
    b: &StrategyRegistryBinding,
    current: bool,
) -> Result<()> {
    if b.schema_version != 1
        || b.registry != identity(conn)?
        || b.baseline_epoch == 0
        || b.renderer_artifact_sha256 != hash(&renderer_descriptor())
        || b.evaluator_artifact_sha256 != hash(&evaluator_descriptor())
    {
        return Err(invalid("strategy registry binding differs"));
    }
    let (base, _, _) = parts(conn, &b.baseline_generation)?;
    let (candidate, _, _) = parts(conn, &b.candidate_generation)?;
    let mut expected = base.clone();
    expected.components.insert(
        "strategy:advisory".into(),
        b.candidate_advisory_sha256.clone(),
    );
    if candidate != expected
        || base.components["strategy:advisory"] != b.baseline_advisory_sha256
        || b.baseline_advisory_sha256 == b.candidate_advisory_sha256
        || base.engine_artifact != b.engine_artifact_sha256
        || base.policy_artifact != b.host_policy_sha256
    {
        return Err(invalid("strategy candidate differs beyond advisory"));
    }
    if current {
        let state = lifecycle::current(conn)?;
        if state.generation.as_deref() != Some(&b.baseline_generation)
            || state.epoch != b.baseline_epoch
            || state.state_digest != b.baseline_state_sha256
        {
            return Err(Error::Conflict(
                "stale strategy baseline epoch or state".into(),
            ));
        }
    }
    Ok(())
}
pub(super) fn verify_retained(
    conn: &Connection,
    entries: &std::collections::BTreeMap<String, u64>,
) -> Result<()> {
    if entries.is_empty() || entries.len() > 4096 {
        return Err(invalid("strategy evidence retained count"));
    }
    let mut total = 0u64;
    for (digest, size) in entries {
        total = total
            .checked_add(*size)
            .ok_or_else(|| invalid("strategy evidence retained overflow"))?;
        if *size == 0
            || *size > 4 * 1024 * 1024
            || total > 64 * 1024 * 1024
            || bounded_artifact(conn, digest, *size as usize)?.len() as u64 != *size
        {
            return Err(invalid(
                "strategy evidence retained identity or length differs",
            ));
        }
    }
    Ok(())
}
impl Registry {
    pub fn artifact_bounded(&self, digest: &str, maximum: usize) -> Result<Vec<u8>> {
        let tx = self.conn.unchecked_transaction()?;
        bounded_artifact(&tx, digest, maximum.min(MAX_ARTIFACT_BYTES))
    }
    pub fn identity(&self) -> Result<RegistryIdentity> {
        identity(&self.conn)
    }
    pub fn strategy_authority(&self, generation: &str) -> Result<StrategyHostAuthority> {
        Ok(parts(&self.conn, generation)?.2)
    }
    pub fn strategy_bootstrap_by_command(
        &self,
        command: &str,
    ) -> Result<Option<StrategyBaselineInstallReceipt>> {
        bootstrap(&self.conn, command)
    }
    /// Trusted Harness invokes this only after preparing the complete strategy graph.
    pub fn authorize_strategy_baseline(
        &mut self,
        generation: &str,
        command: &str,
        reason: &str,
    ) -> Result<String> {
        nonempty(command)?;
        nonempty(reason)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = lifecycle::current(&tx)?;
        if state.epoch != 0 || state.generation.is_some() {
            return Err(Error::Ineligible(
                "strategy baseline requires fresh registry".into(),
            ));
        }
        let (m, _, _) = parts(&tx, generation)?;
        let registry = identity(&tx)?;
        let e = Eligibility {
            generation: generation.into(),
            receipt: None,
            bootstrap_reason: Some(reason.into()),
            strategy_scope: Some(Scope::Bootstrap {
                registry: registry.clone(),
                command_id: command.into(),
                request_sha256: bootstrap_request(generation, reason, &registry)?,
                advisory_sha256: m.components["strategy:advisory"].clone(),
                reason: reason.into(),
            }),
        };
        let raw = encode(&e)?;
        let id = hash(raw.as_bytes());
        insert_json(&tx, "eligibilities", &id, &raw)?;
        tx.commit()?;
        Ok(id)
    }
    pub fn strategy_binding(&self, candidate: &str) -> Result<StrategyRegistryBinding> {
        let tx = self.conn.unchecked_transaction()?;
        let state = lifecycle::current(&tx)?;
        let generation = state
            .generation
            .as_deref()
            .ok_or_else(|| invalid("strategy baseline not active"))?;
        let (m, _, _) = parts(&tx, generation)?;
        let (target, _, _) = parts(&tx, candidate)?;
        let b = StrategyRegistryBinding {
            schema_version: 1,
            registry: identity(&tx)?,
            baseline_generation: generation.into(),
            baseline_epoch: state.epoch,
            baseline_state_sha256: state.state_digest,
            candidate_generation: candidate.into(),
            baseline_advisory_sha256: m.components["strategy:advisory"].clone(),
            candidate_advisory_sha256: target.components["strategy:advisory"].clone(),
            host_policy_sha256: m.policy_artifact,
            engine_artifact_sha256: m.engine_artifact,
            renderer_artifact_sha256: hash(&renderer_descriptor()),
            evaluator_artifact_sha256: hash(&evaluator_descriptor()),
        };
        validate_binding(&tx, &b, true)?;
        Ok(b)
    }
    pub fn validate_strategy_binding(&self, binding: &StrategyRegistryBinding) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        validate_binding(&tx, binding, true)
    }
}
impl Registry {
    /// Hold Registry write exclusion while a trusted host commits its bounded
    /// selection in another database. Callbacks perform no provider/fixture I/O.
    pub fn with_current_strategy_binding<T>(
        &mut self,
        binding: &StrategyRegistryBinding,
        callback: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        validate_binding(&tx, binding, true)?;
        let value = callback()?;
        tx.commit()?;
        Ok(value)
    }
}
