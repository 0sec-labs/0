//! Pre-exposure host registry authority, separate from measured results.
use super::*;
use zero_protocol::strategy_registry::{evaluator_descriptor, renderer_descriptor};
fn raw_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", zero_plugin::sha256(bytes))
}
pub(super) fn validate(config: &Configuration) -> Result<(), EngineError> {
    let (binding, authority) = match (&config.registry_binding, &config.registry_authority) {
        (None, None) => return Ok(()),
        (Some(b), Some(a)) => (b, a),
        _ => return Err(error("incomplete strategy registry binding")),
    };
    authority.validate().map_err(error)?;
    let plan = &config.plan;
    let limits = &plan.limits;
    let max = &authority.campaign_limits;
    let hashes = [
        &binding.baseline_generation,
        &binding.candidate_generation,
        &binding.baseline_state_sha256,
        &binding.baseline_advisory_sha256,
        &binding.candidate_advisory_sha256,
        &binding.host_policy_sha256,
        &binding.engine_artifact_sha256,
        &binding.renderer_artifact_sha256,
        &binding.evaluator_artifact_sha256,
        &binding.registry.genesis_sha256,
    ];
    if binding.schema_version != 1
        || binding.registry.schema_version != 1
        || binding.registry.registry_id.is_empty()
        || binding.registry.registry_id.len() > 256
        || binding.baseline_epoch == 0
        || binding.baseline_generation == binding.candidate_generation
        || hashes.iter().any(|s| !zero_protocol::is_sha256(s))
        || binding.baseline_advisory_sha256 != hash(&serde_json::to_value(&plan.baseline)?)?
        || binding.candidate_advisory_sha256 != hash(&serde_json::to_value(&plan.candidate)?)?
        || binding.renderer_artifact_sha256 != raw_digest(&renderer_descriptor())
        || binding.evaluator_artifact_sha256 != raw_digest(&evaluator_descriptor())
        || serde_json::to_value(&plan.host)? != serde_json::to_value(&authority.host)?
        || serde_json::to_value(&config.provider_context)?
            != serde_json::to_value(&authority.provider_context)?
        || !authority
            .accepted_suite_sha256
            .contains(&provenance::suite(config)?)
        || plan.minimum_development_gain < authority.minimum_development_gain
        || plan.minimum_final_gain < authority.minimum_final_gain
        || limits.model_micro_usd > max.model_micro_usd
        || limits.model_calls > max.model_calls
        || limits.http_requests > max.http_requests
        || limits.http_request_body_bytes > max.http_request_body_bytes
        || limits.http_response_decoded_bytes > max.http_response_decoded_bytes
        || limits.experiments > max.experiments
        || limits.runs > max.runs
        || limits.max_parallel_runs > max.max_parallel_runs
    {
        return Err(error(
            "strategy campaign differs from its pre-exposure registry authority",
        ));
    }
    Ok(())
}
pub(super) fn configured(
    shared: &Shared,
    config: &mut Configuration,
    candidate: &str,
) -> Result<(), EngineError> {
    let profiles = lock(&shared.strategy_runtime)?;
    let harness = profiles
        .as_ref()
        .ok_or_else(|| error("strategy runtime is not configured"))?;
    let capture = harness.strategy_capture().map_err(error)?;
    let binding = harness.strategy_binding(candidate).map_err(error)?;
    if capture.registry != binding.registry
        || capture.generation != binding.baseline_generation
        || capture.epoch != binding.baseline_epoch
        || capture.state_sha256 != binding.baseline_state_sha256
        || capture.advisory_sha256 != binding.baseline_advisory_sha256
        || capture.host_policy_sha256 != binding.host_policy_sha256
    {
        return Err(error("strategy registry changed during binding capture"));
    }
    config.registry_binding = Some(binding);
    config.registry_authority = Some(capture.authority);
    validate(config)
}
pub(super) fn match_retry(
    config: &Configuration,
    candidate: Option<&str>,
) -> Result<(), EngineError> {
    match (&config.registry_binding, candidate) {
        (None, None) => Ok(()),
        (Some(b), Some(c)) if b.candidate_generation == c => Ok(()),
        _ => Err(error("strategy create retry registry binding differs")),
    }
}
