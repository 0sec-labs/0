//! Source-bound export and portable integrity reassessment share one native validator.
use super::*;
use zero_protocol::strategy_registry::{
    StrategyEvidenceDescriptor, StrategyHostAuthority, StrategyRegistryBinding,
};
use zero_store::CampaignSnapshotData;

/// Issued only by the trusted source export path. Portable packages do not create source authority.
pub struct VerifiedStrategyEvidence {
    data: CampaignSnapshotData,
    measurement: RecomputedStrategyEvidence,
}
pub struct RecomputedStrategyEvidence {
    descriptor: StrategyEvidenceDescriptor,
    report: StrategyReport,
    authority: StrategyHostAuthority,
    evidence_sha256: String,
}
impl VerifiedStrategyEvidence {
    pub fn descriptor(&self) -> &StrategyEvidenceDescriptor {
        &self.measurement.descriptor
    }
    pub fn report(&self) -> &StrategyReport {
        &self.measurement.report
    }
    pub fn authority(&self) -> &StrategyHostAuthority {
        &self.measurement.authority
    }
    pub fn evidence_sha256(&self) -> &str {
        &self.measurement.evidence_sha256
    }
    pub fn manifest_bytes(&self) -> &[u8] {
        self.data.manifest_bytes()
    }
    pub fn blobs(&self) -> &BTreeMap<String, Vec<u8>> {
        self.data.blobs()
    }
}
impl RecomputedStrategyEvidence {
    pub fn descriptor(&self) -> &StrategyEvidenceDescriptor {
        &self.descriptor
    }
    pub fn binding(&self) -> &StrategyRegistryBinding {
        &self.descriptor.binding
    }
    pub fn report(&self) -> &StrategyReport {
        &self.report
    }
    pub fn authority(&self) -> &StrategyHostAuthority {
        &self.authority
    }
    pub fn evidence_sha256(&self) -> &str {
        &self.evidence_sha256
    }
}
fn validate(data: &CampaignSnapshotData) -> Result<RecomputedStrategyEvidence, EngineError> {
    let frozen = Store::hydrate_campaign_snapshot(data)?;
    let (_, config) = provenance::configuration(&frozen, data.campaign_id())?;
    binding::validate(&config)?;
    let binding = config
        .registry_binding
        .clone()
        .ok_or_else(|| error("historical unbound campaign remains qualification-only"))?;
    let authority = config
        .registry_authority
        .clone()
        .ok_or_else(|| error("strategy registry authority absent"))?;
    let report = provenance::report(&frozen, data.campaign_id())?;
    if report.decision != StrategyDecision::ImprovedForFixtureSuite
        || report.completed_lanes != vec![CampaignLane::Development, CampaignLane::Final]
        || report.case_results.iter().any(|r| {
            r.disposition != StrategyCaseDisposition::Observed || r.model_reserved_micro_usd != 0
        })
        || report.usage.model_reserved_micro_usd != 0
        || report.usage.http_response_reserved_bytes != 0
        || report.usage.active_runs != 0
        || report.usage.unknown_runs != 0
    {
        return Err(error(
            "strategy evidence does not establish complete independent measured improvement",
        ));
    }
    let descriptor = StrategyEvidenceDescriptor {
        schema_version: 1,
        binding,
        campaign_id: data.campaign_id().into(),
        snapshot_sha256: data.digest().into(),
        report_sha256: hash(&serde_json::to_value(&report)?)?,
        suite_sha256: report.suite_sha256.clone(),
        pair_sha256: provenance::pair(&config)?,
    };
    let evidence_sha256 = hash(&serde_json::to_value(&descriptor)?)?;
    Ok(RecomputedStrategyEvidence {
        descriptor,
        report,
        authority,
        evidence_sha256,
    })
}
pub fn export_strategy_evidence(
    path: &Path,
    campaign: &str,
) -> Result<VerifiedStrategyEvidence, EngineError> {
    let data = Store::open_read_only(path)?.freeze_campaign(campaign)?;
    let measurement = validate(&data)?;
    Ok(VerifiedStrategyEvidence { data, measurement })
}
pub fn reassess_strategy_evidence(
    manifest: &[u8],
    mut read: impl FnMut(&str) -> Result<Vec<u8>, EngineError>,
) -> Result<RecomputedStrategyEvidence, EngineError> {
    let data = CampaignSnapshotData::from_package(manifest, |digest| {
        read(digest).map_err(|e| zero_store::Error::Invalid(e.to_string()))
    })?;
    validate(&data)
}
pub(super) fn snapshot_report(
    store: &Store,
    campaign: &str,
) -> Result<StrategyReport, EngineError> {
    let data = store.freeze_campaign(campaign)?;
    provenance::report(&Store::hydrate_campaign_snapshot(&data)?, campaign)
}
