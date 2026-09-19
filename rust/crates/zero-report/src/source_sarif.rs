//! SARIF presentation of structurally validated, unverified source hypotheses.
use crate::{MAX_REPORT_BYTES, Result, SourceReport, bounded_pretty};
use serde_json::{Value, json};

// Encode UTF-8 bytes so filenames cannot become URI queries, fragments or links.
fn relative_uri(path: &str) -> String {
    let mut uri = String::new();
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            use std::fmt::Write;
            let _ = write!(uri, "%{byte:02X}");
        }
    }
    uri
}

pub(crate) fn render(report: &SourceReport) -> Result<String> {
    let results: Vec<Value> = report.review.hypotheses.iter().map(|hypothesis| {
        let locations: Vec<Value> = hypothesis.claim.citations.iter().map(|citation| json!({
            "physicalLocation": {
                "artifactLocation": {"uri": relative_uri(&citation.path)},
                "region": {"startLine": citation.start_line, "endLine": citation.end_line}
            },
            "properties": {"sha256": citation.sha256}
        })).collect();
        json!({
            "ruleId": "0sec/source-hypothesis",
            "kind": "review",
            "level": "note",
            "message": {"text": format!("{}\n\n{}", hypothesis.claim.title, hypothesis.claim.explanation)},
            "locations": locations,
            "partialFingerprints": {"0sec/snapshotHypothesis/v1": format!("{}:{}", report.snapshot_sha256, hypothesis.id)},
            "properties": {
                "hypothesisId": hypothesis.id,
                "verificationState": "unverified",
                "claimedSeverity": hypothesis.claim.claimed_severity,
                "securityConclusion": "not_established"
            }
        })
    }).collect();
    let value = json!({
        "$schema": "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {"driver": {
                "name": "0sec",
                "version": env!("CARGO_PKG_VERSION"),
                "rules": [{
                    "id": "0sec/source-hypothesis",
                    "shortDescription": {"text": "Unverified source hypothesis"},
                    "defaultConfiguration": {"level": "note"}
                }]
            }},
            "results": results,
            "properties": {
                "notice": "Source hypotheses remain unverified. Empty results do not establish target safety. Frozen-plan reproduction and repair assessments do not establish general vulnerability or repair validity.",
                "sourceReport": report
            }
        }]
    });
    bounded_pretty(&value, 4 * MAX_REPORT_BYTES)
}
