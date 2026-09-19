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
    bounded_pretty(&document(Some(report)), 4 * MAX_REPORT_BYTES)
}

fn document(report: Option<&SourceReport>) -> Value {
    let results: Vec<Value> = report.into_iter().flat_map(|report| report.review.hypotheses.iter().map(move |hypothesis| (report, hypothesis))).map(|(report, hypothesis)| {
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
    json!({
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
    })
}

/// Present a retained point-in-time review. Caller authenticates journal provenance;
/// this renderer checks report structure and source/lifecycle identity only.
pub fn render_review_sarif(report: &zero_protocol::review::ReviewReport) -> Result<String> {
    let record = &report.review.review;
    if report.schema_version != 1
        || record.schema_version != 1
        || !zero_protocol::is_sha256(&record.snapshot_sha256)
    {
        return Err(crate::Error::Field("review report identity"));
    }
    if let Some(source) = &report.source {
        crate::source_report::validate(source)?;
        if source.session_id != record.session_id
            || source.operation_id != record.root_operation_id
            || source.snapshot_sha256 != record.snapshot_sha256
        {
            return Err(crate::Error::Field("review source identity"));
        }
    }
    let mut value = document(report.source.as_ref());
    let properties = &mut value["runs"][0]["properties"];
    properties["review"] = serde_json::to_value(&report.review).map_err(|_| crate::Error::Json)?;
    properties["securityConclusion"] =
        serde_json::to_value(report.security_conclusion).map_err(|_| crate::Error::Json)?;
    properties["reportState"] = json!(if report.source.is_some() {
        "source_submission"
    } else {
        "no_source_submission"
    });
    bounded_pretty(&value, 4 * MAX_REPORT_BYTES)
}
