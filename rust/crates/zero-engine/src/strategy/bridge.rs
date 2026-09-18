//! Trusted host bridge. Only source-exported evidence can initiate eligibility.
use super::*;
use zero_evolution::Registry;
use zero_protocol::strategy_registry::{
    StrategyEvidenceDescriptor, StrategyImportRequest, StrategyImportResult,
};
#[derive(serde::Serialize)]
pub struct StrategyEligibilityPreparation {
    pub evidence_sha256: String,
    pub descriptor: StrategyEvidenceDescriptor,
}
fn encoded(v: &impl serde::Serialize) -> Result<Vec<u8>, EngineError> {
    Ok(serde_json::to_vec(&serde_json::to_value(v)?)?)
}
fn retained(
    registry: &Registry,
    result: StrategyImportResult,
) -> Result<StrategyImportResult, EngineError> {
    let bytes = registry
        .artifact_bounded(&result.receipt.evidence_sha256, 1024 * 1024)
        .map_err(error)?;
    let descriptor: StrategyEvidenceDescriptor = serde_json::from_slice(&bytes)?;
    let manifest = registry
        .artifact_bounded(&descriptor.snapshot_sha256, 1024 * 1024)
        .map_err(error)?;
    let measured = reassess_strategy_evidence(&manifest, |id| {
        registry
            .artifact_bounded(id, 4 * 1024 * 1024)
            .map_err(error)
    })?;
    let authority = registry
        .strategy_authority(&descriptor.binding.candidate_generation)
        .map_err(error)?;
    if serde_json::to_value(measured.authority())? != serde_json::to_value(authority)? {
        return Err(error(
            "retained strategy policy differs from registry authority",
        ));
    }
    if measured.evidence_sha256() != result.receipt.evidence_sha256
        || measured.descriptor() != &descriptor
        || measured.descriptor().report_sha256 != result.receipt.report_sha256
        || registry
            .artifact_bounded(&descriptor.report_sha256, 4 * 1024 * 1024)
            .map_err(error)?
            != encoded(measured.report())?
    {
        return Err(error("retained strategy eligibility evidence differs"));
    }
    Ok(result)
}
pub fn prepare_strategy_eligibility(
    source: &Path,
    registry: &Path,
    campaign: &str,
) -> Result<StrategyEligibilityPreparation, EngineError> {
    let evidence = export_strategy_evidence(source, campaign)?;
    let registry = Registry::open_read_only(registry).map_err(error)?;
    registry
        .validate_strategy_binding(&evidence.descriptor().binding)
        .map_err(error)?;
    if serde_json::to_value(evidence.authority())?
        != serde_json::to_value(
            registry
                .strategy_authority(&evidence.descriptor().binding.candidate_generation)
                .map_err(error)?,
        )?
    {
        return Err(error("source strategy authority differs from registry"));
    }
    Ok(StrategyEligibilityPreparation {
        evidence_sha256: evidence.evidence_sha256().into(),
        descriptor: evidence.descriptor().clone(),
    })
}
pub fn import_strategy_eligibility(
    source: &Path,
    registry_path: &Path,
    request: &StrategyImportRequest,
) -> Result<StrategyImportResult, EngineError> {
    // Historic retries require only retained registry evidence, even if the source was removed.
    let registry = Registry::open_read_only(registry_path).map_err(error)?;
    if let Some(prior) = registry
        .strategy_import_by_command(request)
        .map_err(error)?
    {
        return retained(&registry, prior);
    }
    drop(registry);
    let evidence = export_strategy_evidence(source, &request.campaign_id)?;
    if request.expected_evidence_sha256 != evidence.evidence_sha256() {
        return Err(error("expected evidence digest differs"));
    }
    let mut artifacts = evidence.blobs().clone();
    artifacts.insert(
        evidence.descriptor().snapshot_sha256.clone(),
        evidence.manifest_bytes().to_vec(),
    );
    artifacts.insert(
        evidence.descriptor().report_sha256.clone(),
        encoded(evidence.report())?,
    );
    artifacts.insert(
        evidence.evidence_sha256().into(),
        encoded(evidence.descriptor())?,
    );
    let mut registry = Registry::open(registry_path, "native-host", &json!({})).map_err(error)?;
    let descriptor = evidence.descriptor().clone();
    let authority = registry
        .strategy_authority(&descriptor.binding.candidate_generation)
        .map_err(error)?;
    if serde_json::to_value(evidence.authority())? != serde_json::to_value(&authority)? {
        return Err(error("source strategy authority differs from registry"));
    }

    registry
        .import_strategy_evidence(request, &descriptor, &artifacts, |reader| {
            let manifest = reader(&descriptor.snapshot_sha256)?;
            let measured =
                reassess_strategy_evidence(&manifest, |digest| reader(digest).map_err(error))
                    .map_err(|e| zero_evolution::Error::Invalid(e.to_string()))?;
            if serde_json::to_value(measured.authority())? != serde_json::to_value(&authority)? {
                return Err(zero_evolution::Error::Invalid(
                    "imported strategy authority differs".into(),
                ));
            }
            if measured.descriptor() != &descriptor {
                return Err(zero_evolution::Error::Invalid(
                    "imported evidence descriptor differs".into(),
                ));
            }
            Ok(measured.report().clone())
        })
        .map_err(error)
}
pub fn read_strategy_eligibility_receipt(
    registry_path: &Path,
    receipt: &str,
) -> Result<StrategyImportResult, EngineError> {
    let registry = Registry::open_read_only(registry_path).map_err(error)?;
    retained(
        &registry,
        registry.strategy_import_receipt(receipt).map_err(error)?,
    )
}
pub fn read_strategy_eligibility(
    registry_path: &Path,
    request: &StrategyImportRequest,
) -> Result<StrategyImportResult, EngineError> {
    let registry = Registry::open_read_only(registry_path).map_err(error)?;
    let found = registry
        .strategy_import_by_command(request)
        .map_err(error)?
        .ok_or_else(|| error("strategy import command absent"))?;
    retained(&registry, found)
}
