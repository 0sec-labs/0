//! Public managed-worker wire values. Host revisions are assertions, not signatures.
//! Validation establishes shape/consistency, never source provenance or vulnerability proof.
use crate::{
    OperationStatus, ValidationError, campaign::CampaignProviderContext, http::HttpProfilePolicy,
    scan::*,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
};
pub const MANAGED_SCAN_CONTRACT: &str = "0sec-native-http/v1";
pub const MAX_MANAGED_GRANT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_MANAGED_TERMINAL_BYTES: usize = 9 * 1024 * 1024;
pub const MAX_MANAGED_COMPACT_BYTES: usize = 128 * 1024;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
fn bad() -> ValidationError {
    ValidationError("invalid managed scan binding, bounds or disposition".into())
}
fn bounded(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
pub fn canonical_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
        && s != "00000000-0000-0000-0000-000000000000"
}
/// Cloud organization IDs are opaque, case-sensitive better-auth identifiers or legacy UUIDs.
/// Match the consumer's URL-safe 16..=64-byte organization grammar; never normalize identity.
pub fn managed_organization_id(s: &str) -> bool {
    (16..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
/// Bound serialized expansion before allocation; reject numbers JavaScript cannot carry exactly.
pub fn managed_json_bytes<T: Serialize>(
    value: &T,
    limit: usize,
) -> Result<Vec<u8>, ValidationError> {
    struct Bounded {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl Write for Bounded {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            if b.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::other("managed wire size limit"));
            }
            self.bytes.extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut out = Bounded {
        bytes: vec![],
        limit,
    };
    serde_json::to_writer(&mut out, value).map_err(|_| bad())?;
    fn numbers(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::Number(n) => n.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER),
            serde_json::Value::Array(a) => a.iter().all(numbers),
            serde_json::Value::Object(o) => o.values().all(numbers),
            _ => true,
        }
    }
    let parsed: serde_json::Value = serde_json::from_slice(&out.bytes).map_err(|_| bad())?;
    if !numbers(&parsed) {
        return Err(bad());
    }
    Ok(out.bytes)
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedScanGrant {
    pub contract_version: String,
    pub cloud_scan_id: String,
    pub organization_id: String,
    pub dispatch_id: String,
    pub grant_revision: String,
    pub expires_at_ms: u64,
    pub target: String,
    pub scan_profile_name: String,
    pub scan_profile: ScanProfile,
    pub http_policy: HttpProfilePolicy,
    #[serde(deserialize_with = "providers")]
    pub providers: BTreeMap<String, CampaignProviderContext>,
}
fn providers<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<BTreeMap<String, CampaignProviderContext>, D::Error> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = BTreeMap<String, CampaignProviderContext>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("one to nine unique provider pins")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut a: A,
        ) -> Result<Self::Value, A::Error> {
            let mut out = BTreeMap::new();
            while let Some((key, value)) = a.next_entry::<String, CampaignProviderContext>()? {
                if out.len() >= 9 || !bounded(&key, 256) || out.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom(
                        "invalid or duplicate provider pin",
                    ));
                }
            }
            Ok(out)
        }
    }
    d.deserialize_map(Visitor)
}
impl ManagedScanGrant {
    pub fn command_id(&self) -> String {
        format!("managed-scan:{}:{}", self.cloud_scan_id, self.dispatch_id)
    }
    pub fn validate(&self) -> Result<(), ValidationError> {
        managed_json_bytes(self, MAX_MANAGED_GRANT_BYTES)?;
        self.scan_profile.validate()?;
        self.http_policy.validate()?;
        validate_scan_target(&self.target)?;
        if self.contract_version != MANAGED_SCAN_CONTRACT
            || !managed_organization_id(&self.organization_id)
            || ![&self.cloud_scan_id, &self.dispatch_id]
                .iter()
                .all(|s| canonical_uuid(s))
            || !bounded(&self.grant_revision, 256)
            || self.expires_at_ms == 0
            || !bounded(&self.scan_profile_name, 128)
            || !self
                .scan_profile_name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(bad());
        }
        let mut expected = BTreeSet::from([self.scan_profile.provider.as_str()]);
        if let Some(p) = &self.scan_profile.delegation_policy {
            expected.extend(p.roles.iter().map(|r| r.provider.as_str()));
        }
        if expected != self.providers.keys().map(String::as_str).collect()
            || self.providers.len() > 9
        {
            return Err(bad());
        }
        for pin in self.providers.values() {
            if !bounded(&pin.endpoint, 8192)
                || !(pin.endpoint.starts_with("https://") || pin.endpoint.starts_with("http://"))
            {
                return Err(bad());
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ManagedScanPublication {
    Retained {
        report_sha256: String,
        report: Box<ScanReport>,
    },
    ReportTooLarge {
        report: Option<Box<ScanReport>>,
    },
    Unavailable {
        reason: String,
        report: Option<Box<ScanReport>>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedScanTerminal {
    pub contract_version: String,
    pub cloud_scan_id: String,
    pub organization_id: String,
    pub dispatch_id: String,
    pub grant_sha256: String,
    pub scan: ScanRecord,
    pub controller_status: OperationStatus,
    pub root_status: OperationStatus,
    pub close_reason: Option<ScanCloseReason>,
    pub budget: crate::BudgetSnapshot,
    pub http_usage: ScanHttpUsage,
    pub currency: ScanCurrency,
    pub outcome: Option<ScanOutcome>,
    pub native_publication: Option<ScanPublication>,
    pub publication: ManagedScanPublication,
    pub enforcement: ManagedEnforcementAvailability,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedEnforcementAvailability {
    pub requests_out_of_scope_blocked: UnavailableMetric,
    pub peak_rps: UnavailableMetric,
    pub rate_limited_count: UnavailableMetric,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum UnavailableMetric {
    Unavailable { reason: String },
}
impl Default for ManagedEnforcementAvailability {
    fn default() -> Self {
        let metric = UnavailableMetric::Unavailable {
            reason: "not_measured_by_native_http_v1".into(),
        };
        Self {
            requests_out_of_scope_blocked: metric.clone(),
            peak_rps: metric.clone(),
            rate_limited_count: metric,
        }
    }
}
impl ManagedScanTerminal {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let limit = if matches!(self.publication, ManagedScanPublication::Retained { .. }) {
            MAX_MANAGED_TERMINAL_BYTES
        } else {
            MAX_MANAGED_COMPACT_BYTES
        };
        managed_json_bytes(self, limit)?;
        if self.contract_version != MANAGED_SCAN_CONTRACT
            || !managed_organization_id(&self.organization_id)
            || ![
                &self.cloud_scan_id,
                &self.dispatch_id,
                &self.scan.id,
                &self.scan.session_id,
                &self.scan.controller_operation_id,
                &self.scan.root_operation_id,
            ]
            .iter()
            .all(|s| canonical_uuid(s))
            || !crate::is_sha256(&self.grant_sha256)
            || !crate::is_sha256(&self.scan.intent_sha256)
            || !crate::is_sha256(&self.scan.profile_sha256)
            || !crate::is_sha256(&self.scan.http_account_id)
            || self.scan.schema_version != 1
            || self.scan.sequence == 0
            || self.scan.deadline_at_ms <= self.scan.created_at_ms
            || [
                &self.scan.id,
                &self.scan.session_id,
                &self.scan.controller_operation_id,
                &self.scan.root_operation_id,
            ]
            .into_iter()
            .collect::<BTreeSet<_>>()
            .len()
                != 4
            || self.scan.command_id
                != format!("managed-scan:{}:{}", self.cloud_scan_id, self.dispatch_id)
            || self.enforcement != ManagedEnforcementAvailability::default()
            || !matches!(
                self.controller_status,
                OperationStatus::Succeeded | OperationStatus::Unknown
            )
            || (self.controller_status == OperationStatus::Unknown
                && self.native_publication.is_some())
            || (self.controller_status == OperationStatus::Succeeded
                && self.native_publication.is_none())
            || matches!(
                self.root_status,
                OperationStatus::Admitted | OperationStatus::Running
            )
        {
            return Err(bad());
        }
        if let Some(o) = &self.outcome {
            self.check_outcome(o)?;
        } else if !matches!(
            self.publication,
            ManagedScanPublication::Unavailable { report: None, .. }
        ) || self.controller_status != OperationStatus::Unknown
        {
            return Err(bad());
        }
        let report = match &self.publication {
            ManagedScanPublication::Retained {
                report_sha256,
                report,
            } => {
                if self.native_publication
                    != Some(ScanPublication::Retained {
                        report_sha256: report_sha256.clone(),
                    })
                    || self.controller_status != OperationStatus::Succeeded
                    || !crate::is_sha256(report_sha256)
                    || report.kind != ScanReportKind::Retained
                    || report.web.is_none()
                {
                    return Err(bad());
                }
                managed_json_bytes(report, MAX_SCAN_REPORT_BYTES)?;
                Some(report)
            }
            ManagedScanPublication::ReportTooLarge { report } => {
                if self.native_publication != Some(ScanPublication::ReportTooLarge)
                    || self.controller_status != OperationStatus::Succeeded
                    || report
                        .as_ref()
                        .is_some_and(|r| r.kind != ScanReportKind::Compact || r.web.is_some())
                {
                    return Err(bad());
                }
                report.as_ref()
            }
            ManagedScanPublication::Unavailable { reason, report } => {
                let native_matches = match &self.native_publication {
                    Some(ScanPublication::Retained { report_sha256 }) => {
                        crate::is_sha256(report_sha256)
                            && reason == "retained_report_unavailable"
                            && report.is_none()
                    }
                    Some(ScanPublication::Unavailable { reason: original }) => original == reason,
                    None => reason == "controller_report_unavailable",
                    Some(ScanPublication::ReportTooLarge) => false,
                };
                if !native_matches
                    || !bounded(reason, 512)
                    || report
                        .as_ref()
                        .is_some_and(|r| r.kind != ScanReportKind::Recovery)
                {
                    return Err(bad());
                }
                report.as_ref()
            }
        };
        if let Some(report) = report {
            if report.schema_version != 1
                || report.scan != self.scan
                || serde_json::to_value(&report.outcome).map_err(|_| bad())?
                    != serde_json::to_value(self.outcome.as_ref().ok_or_else(bad)?)
                        .map_err(|_| bad())?
            {
                return Err(bad());
            }
        }
        Ok(())
    }
    fn check_outcome(&self, o: &ScanOutcome) -> Result<(), ValidationError> {
        let sum = o
            .summary
            .claimed_critical
            .checked_add(o.summary.claimed_high)
            .and_then(|n| n.checked_add(o.summary.claimed_medium))
            .and_then(|n| n.checked_add(o.summary.claimed_low))
            .and_then(|n| n.checked_add(o.summary.claimed_info));
        if o.schema_version != 1
            || o.scan_id != self.scan.id
            || o.root_status != self.root_status
            || o.close_reason != self.close_reason
            || o.budget != self.budget
            || o.http_usage != self.http_usage
            || o.currency != self.currency
            || o.started_at_ms != self.scan.created_at_ms
            // Recovery has no witnessed completion instant. Preserve the native zero
            // sentinel; consumers display unavailable time, never a negative duration.
            || (o.completed_at_ms < o.started_at_ms
                && !(o.completed_at_ms == 0
                    && self.controller_status == OperationStatus::Unknown
                    && self.native_publication.is_none()
                    && o.stop_reason == ScanStopReason::Unknown))
            || o.summary.verified_vulnerabilities != 0
            || sum != Some(o.summary.submitted_hypotheses)
            || o.vulnerability_reportable
            || o.security_conclusion != crate::source::SecurityConclusion::NotEstablished
            || o.review_sha256
                .as_ref()
                .is_some_and(|s| !crate::is_sha256(s))
            || (o.summary.submitted_hypotheses > 0 && o.review_sha256.is_none())
        {
            return Err(bad());
        }
        let completed = o.completeness == ScanCompleteness::CompletedWorkflow;
        if completed != (o.stop_reason == ScanStopReason::Submitted)
            || completed
                && (o.root_status != OperationStatus::Succeeded
                    || o.agent_status != Some(crate::agent::AgentStatus::Completed)
                    || o.review_sha256.is_none()
                    || o.close_reason.is_some()
                    || o.budget.reserved != 0
                    || o.http_usage.response_reserved_bytes != 0)
        {
            return Err(bad());
        }
        if (self.controller_status == OperationStatus::Unknown
            || o.root_status == OperationStatus::Unknown
            || o.budget.reserved > 0
            || o.http_usage.response_reserved_bytes > 0)
            && o.stop_reason != ScanStopReason::Unknown
        {
            return Err(bad());
        }
        if o.stop_reason != ScanStopReason::Unknown {
            if let Some(close) = o.close_reason {
                if o.stop_reason
                    != match close {
                        ScanCloseReason::Cancelled => ScanStopReason::Cancelled,
                        ScanCloseReason::Deadline => ScanStopReason::Deadline,
                    }
                {
                    return Err(bad());
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedScanFile {
    pub file_sha256: String,
    pub bytes: u64,
}
