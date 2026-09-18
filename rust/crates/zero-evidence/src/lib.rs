//! Complete accounting of original findings across independent worker outputs.
//! Reconciliation establishes provenance coverage, not vulnerability validity.

use std::collections::{HashMap, HashSet};
use zero_protocol::{Disposition, ReconcileRequest, ReconcileResult, ReconciledGroup};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct EvidenceError(pub String);

fn require_id(value: &str, field: &str) -> Result<(), EvidenceError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(EvidenceError(format!("invalid {field}")));
    }
    Ok(())
}

/// Reconcile a trusted source inventory with proposed grouping decisions.
/// Every source must occur exactly once, including rejected and inconclusive
/// candidates. The reducer cannot overwrite source metadata or invent receipts.
pub fn reconcile(request: ReconcileRequest) -> Result<ReconcileResult, EvidenceError> {
    require_id(&request.scan_id, "scan_id")?;
    if request.sources.len() > 10_000 || request.groups.len() > 10_000 {
        return Err(EvidenceError(
            "finding inventory exceeds 10000 entries".into(),
        ));
    }
    let mut sources = HashMap::new();
    for source in &request.sources {
        require_id(&source.id, "source id")?;
        require_id(&source.worker_id, "worker id")?;
        if source.title.trim().is_empty() || source.title.len() > 16_384 {
            return Err(EvidenceError(format!(
                "invalid title for source {}",
                source.id
            )));
        }
        if source.artifact_sha256.len() != 64
            || !source
                .artifact_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(EvidenceError(format!(
                "invalid artifact SHA-256 for source {}",
                source.id
            )));
        }
        if sources.insert(&source.id, source).is_some() {
            return Err(EvidenceError(format!("duplicate source {}", source.id)));
        }
    }
    let mut seen = HashSet::new();
    let mut group_ids = HashSet::new();
    let mut groups = Vec::with_capacity(request.groups.len());
    let (mut reportable_count, mut rejected_count, mut inconclusive_count) = (0, 0, 0);
    for group in &request.groups {
        require_id(&group.id, "group id")?;
        if !group_ids.insert(&group.id) {
            return Err(EvidenceError(format!("duplicate group {}", group.id)));
        }
        if group.source_ids.is_empty() || group.source_ids.len() > sources.len() {
            return Err(EvidenceError(format!(
                "invalid source inventory for group {}",
                group.id
            )));
        }
        if group.reason.trim().is_empty() || group.reason.len() > 32_768 {
            return Err(EvidenceError(format!(
                "missing or oversized assessment for group {}",
                group.id
            )));
        }
        let mut originals = Vec::with_capacity(group.source_ids.len());
        for id in &group.source_ids {
            let source = sources
                .get(id)
                .ok_or_else(|| EvidenceError(format!("unknown source {id}")))?;
            if !seen.insert(id) {
                return Err(EvidenceError(format!(
                    "source {id} accounted for more than once"
                )));
            }
            originals.push((*source).clone());
        }
        match group.disposition {
            Disposition::Reportable => reportable_count += 1,
            Disposition::Rejected => rejected_count += 1,
            Disposition::Inconclusive => inconclusive_count += 1,
        }
        groups.push(ReconciledGroup {
            id: group.id.clone(),
            sources: originals,
            disposition: group.disposition.clone(),
            reason: group.reason.clone(),
        });
    }
    if seen.len() != sources.len() {
        let missing: Vec<_> = request
            .sources
            .iter()
            .filter(|source| !seen.contains(&source.id))
            .map(|source| source.id.as_str())
            .collect();
        return Err(EvidenceError(format!(
            "unaccounted source findings: {}",
            missing.join(", ")
        )));
    }
    Ok(ReconcileResult {
        scan_id: request.scan_id,
        groups,
        source_count: request.sources.len(),
        reportable_count,
        rejected_count,
        inconclusive_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use zero_protocol::{FindingGroup, SourceFinding};

    fn fixture() -> ReconcileRequest {
        ReconcileRequest {
            scan_id: "scan".into(),
            sources: (0..3)
                .map(|n| SourceFinding {
                    id: format!("f{n}"),
                    worker_id: format!("w{n}"),
                    title: format!("Original {n}"),
                    artifact_sha256: format!("{n:064x}"),
                })
                .collect(),
            groups: vec![
                FindingGroup {
                    id: "g0".into(),
                    source_ids: vec!["f0".into(), "f1".into()],
                    disposition: Disposition::Reportable,
                    reason: "Same observed root cause".into(),
                },
                FindingGroup {
                    id: "g1".into(),
                    source_ids: vec!["f2".into()],
                    disposition: Disposition::Inconclusive,
                    reason: "Reproduction unavailable".into(),
                },
            ],
        }
    }

    #[test]
    fn retains_every_original_without_promoting_uncertain_findings() {
        let request = fixture();
        let result = reconcile(request.clone()).unwrap();
        assert_eq!(result.groups[0].sources, request.sources[..2]);
        assert_eq!(result.groups[1].sources, request.sources[2..]);
        assert_eq!(result.groups[1].disposition, Disposition::Inconclusive);
        assert_eq!(
            (
                result.source_count,
                result.reportable_count,
                result.inconclusive_count
            ),
            (3, 1, 1)
        );
    }

    #[test]
    fn rejects_omitted_unknown_and_duplicate_attributions() {
        let mut request = fixture();
        request.groups.pop();
        assert!(reconcile(request).unwrap_err().0.contains("unaccounted"));
        let mut request = fixture();
        request.groups[1].source_ids[0] = "invented".into();
        assert!(reconcile(request).unwrap_err().0.contains("unknown"));
        let mut request = fixture();
        request.groups[1].source_ids.push("f0".into());
        assert!(reconcile(request).unwrap_err().0.contains("more than once"));
    }

    #[test]
    fn rejects_ambiguous_source_inventory_and_malformed_identity() {
        let mut request = fixture();
        request.sources.push(request.sources[0].clone());
        assert!(
            reconcile(request)
                .unwrap_err()
                .0
                .contains("duplicate source")
        );
        let mut request = fixture();
        request.sources[0].artifact_sha256 = "claimed-proof".into();
        assert!(reconcile(request).unwrap_err().0.contains("SHA-256"));
    }
}
