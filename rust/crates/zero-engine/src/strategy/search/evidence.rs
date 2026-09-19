//! Source-only complete adaptive history. Imported packages provide integrity, not source authority.
use super::*;
use zero_protocol::strategy_registry::{StrategyHostAuthority, StrategySearchEvidenceDescriptor};
use zero_store::CampaignSnapshotData;
pub struct VerifiedStrategySearchEvidence {
    data: CampaignSnapshotData,
    measurement: RecomputedStrategySearchEvidence,
}
pub struct RecomputedStrategySearchEvidence {
    descriptor: StrategySearchEvidenceDescriptor,
    report: StrategySearchReport,
    authority: StrategyHostAuthority,
    evidence_sha256: String,
}
impl VerifiedStrategySearchEvidence {
    pub fn descriptor(&self) -> &StrategySearchEvidenceDescriptor {
        &self.measurement.descriptor
    }
    pub fn report(&self) -> &StrategySearchReport {
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
impl RecomputedStrategySearchEvidence {
    pub fn descriptor(&self) -> &StrategySearchEvidenceDescriptor {
        &self.descriptor
    }
    pub fn report(&self) -> &StrategySearchReport {
        &self.report
    }
    pub fn authority(&self) -> &StrategyHostAuthority {
        &self.authority
    }
    pub fn evidence_sha256(&self) -> &str {
        &self.evidence_sha256
    }
}
fn validate(data: &CampaignSnapshotData) -> Result<RecomputedStrategySearchEvidence, EngineError> {
    let frozen = Store::hydrate_campaign_snapshot(data)?;
    let c = frozen.search_configuration(data.campaign_id())?;
    let report = provenance::report(&frozen, data.campaign_id())?;
    let selection = report
        .selection
        .as_ref()
        .ok_or_else(|| error("search stopped without protected selection"))?;
    let final_report = report
        .final_measurement
        .as_ref()
        .ok_or_else(|| error("search Final measurement absent"))?;
    let development = report
        .evaluations
        .iter()
        .find(|e| e.evaluation.id == selection.evaluation_id)
        .ok_or_else(|| error("selected Development absent"))?;
    let usage = &report.usage;
    let limits = &c.plan.limits;
    if !matches!(c.plan.schema_version, 2 | 3)
        || report.schema_version != c.plan.schema_version
        || report.stop_reason.as_deref() != Some("model_selected_final")
        || !development.improved
        || final_report.decision != StrategyDecision::ImprovedForFixtureSuite
        || final_report.matrix_sha256.is_none()
        || development
            .cases
            .iter()
            .chain(&final_report.cases)
            .any(|r| {
                r.disposition != StrategyCaseDisposition::Observed
                    || r.model_reserved_micro_usd != 0
            })
        || report.proposals.iter().any(|p| {
            matches!(
                p.operation_status,
                OperationStatus::Running | OperationStatus::Admitted | OperationStatus::Unknown
            )
        })
        || report.evaluations.iter().flat_map(|e| &e.cases).any(|r| {
            r.disposition == StrategyCaseDisposition::Unknown || r.model_reserved_micro_usd != 0
        })
        || usage.model_reserved_micro_usd != 0
        || usage.http_response_reserved_bytes != 0
        || usage.active_runs != 0
        || usage.unknown_runs != 0
        || usage.model_charged_micro_usd > limits.model_micro_usd
        || usage.model_calls > u64::from(limits.model_calls)
        || usage.http_requests > limits.http_requests
        || usage.http_request_body_bytes > limits.http_request_body_bytes
        || usage.http_response_charged_bytes > limits.http_response_decoded_bytes
        || usage.experiments > u64::from(limits.experiments)
        || usage.runs > u64::from(limits.runs)
    {
        return Err(error(
            "complete search does not establish independently measured bounded improvement",
        ));
    }
    if c.plan.protected_canary.is_some() {
        let measured = report
            .canary_measurement
            .as_ref()
            .ok_or_else(|| error("canary measurement missing"))?;
        let commitment = selection
            .canary
            .as_ref()
            .ok_or_else(|| error("canary commitment missing"))?;
        if measured.decision != StrategyDecision::ImprovedForFixtureSuite
            || measured.matrix_sha256.is_none()
            || measured.cases.len() != commitment.run_count as usize
            || measured.cases.iter().any(|r| {
                r.lane != CampaignLane::Canary
                    || r.disposition != StrategyCaseDisposition::Observed
                    || r.model_reserved_micro_usd != 0
            })
        {
            return Err(error(
                "independent canary has not established complete improvement",
            ));
        }
    }
    let snapshot = frozen.campaign(data.campaign_id())?;
    let controller = frozen.get_operation_by_command(
        &snapshot.campaign.journal_session_id,
        &command(data.campaign_id()),
    )?;
    if controller.status != OperationStatus::Succeeded {
        return Err(error("search controller did not complete"));
    }
    let descriptor = StrategySearchEvidenceDescriptor {
        schema_version: c.plan.schema_version,
        binding: selection.binding.clone(),
        campaign_id: data.campaign_id().into(),
        snapshot_sha256: data.digest().into(),
        report_sha256: hash(&serde_json::to_value(&report)?)?,
        suite_sha256: selection.suite_sha256.clone(),
        pair_sha256: selection.final_pair_sha256.clone(),
        config_sha256: report.config_sha256.clone(),
        selection_sha256: hash(&serde_json::to_value(selection)?)?,
        canary_suite_sha256: selection.canary.as_ref().map(|k| k.suite_sha256.clone()),
    };
    let evidence_sha256 = hash(&serde_json::to_value(&descriptor)?)?;
    Ok(RecomputedStrategySearchEvidence {
        descriptor,
        report,
        authority: c.capture.authority,
        evidence_sha256,
    })
}
pub fn export_strategy_search_evidence(
    path: &Path,
    campaign: &str,
) -> Result<VerifiedStrategySearchEvidence, EngineError> {
    let data = Store::open_read_only(path)?.freeze_strategy_search(campaign)?;
    let measurement = validate(&data)?;
    Ok(VerifiedStrategySearchEvidence { data, measurement })
}
pub fn reassess_strategy_search_evidence(
    manifest: &[u8],
    mut read: impl FnMut(&str) -> Result<Vec<u8>, EngineError>,
) -> Result<RecomputedStrategySearchEvidence, EngineError> {
    let data = CampaignSnapshotData::from_package(manifest, |digest| {
        read(digest).map_err(|e| zero_store::Error::Invalid(e.to_string()))
    })?;
    validate(&data)
}
