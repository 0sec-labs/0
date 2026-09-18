//! Deterministic synthetic wire fixtures, never evidence of an actual investigation.
//! Run: cargo run -p zero-cloud-compat --example managed_scan_fixtures -- OUTPUT_DIR
//! Every terminal passes the public builder/validator and the durable file writer.
#![allow(clippy::unwrap_used)]
#[path = "../tests/support/managed_scan.rs"]
mod fixtures;
use fixtures::{canonical, fixture, hash, id};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, error::Error, fs, path::Path};
use zero_cloud_compat::managed_scan::*;
use zero_protocol::{
    OperationStatus,
    agent::AgentStatus,
    managed_scan::*,
    scan::*,
    source::{ClaimedSeverity, VerificationState},
    web::*,
    web_experiment::{WebExperimentPolicy, WebExperimentReport},
};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
type Inputs = (ManagedScanGrant, ScanSnapshot, ScanReport);

fn raw_hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn refresh((grant, snapshot, report): &mut Inputs) {
    snapshot.scan.profile_sha256 = canonical(&grant.scan_profile);
    report.scan = snapshot.scan.clone();
    report.outcome.budget = snapshot.budget.clone();
    report.outcome.http_usage = snapshot.http_usage.clone();
    if let Some(web) = &mut report.web {
        if let Some(review) = &web.run.review {
            let review_hash = hash(review);
            report.outcome.review_sha256 = Some(review_hash.clone());
            web.run.artifacts.insert("web.review".into(), review_hash);
        }
    }
    snapshot.result = Some(ScanResult {
        outcome: report.outcome.clone(),
        publication: ScanPublication::Retained {
            report_sha256: hash(report),
        },
    });
}
fn baseline() -> Inputs {
    let mut inputs = fixture();
    inputs.0.organization_id = "Org_AbC0123456789-cloud".into();
    inputs
}
fn add_observation(inputs: &mut Inputs, n: u32) -> WebEvidenceReference {
    let (grant, snapshot, report) = inputs;
    // These deterministic bytes represent a hypothetical redacted body. No target is contacted.
    let body = "fixture body λ\n";
    let body_hash = raw_hash(body.as_bytes());
    let manifest = canonical(&json!({"fixture_operation":id(n),"body":body_hash}));
    report
        .web
        .as_mut()
        .unwrap()
        .observations
        .push(WebReportObservation {
            operation: WebHttpOperation {
                sequence: u64::from(n),
                operation_id: id(n),
                actor_operation_id: snapshot.scan.root_operation_id.clone(),
                operation_status: OperationStatus::Succeeded,
                response_manifest_sha256: Some(manifest.clone()),
            },
            evidence: Some(HttpEvidenceMetadata {
                session_id: snapshot.scan.session_id.clone(),
                operation_id: id(n),
                operation_status: OperationStatus::Succeeded,
                response_manifest_sha256: manifest.clone(),
                retained_body_sha256: body_hash.clone(),
                retained_bytes: body.len() as u64,
                complete: true,
                url: Some(grant.target.clone()),
                status: Some(200),
                headers: vec![("content-type".into(), "text/plain; charset=utf-8".into())],
                wire_bytes: body.len() as u64,
                decoded_bytes: body.len() as u64,
                artifacts: BTreeMap::from([("http.response.body".into(), body_hash.clone())]),
            }),
            error: None,
        });
    snapshot.http_usage.requests += 1;
    snapshot.http_usage.response_charged_bytes += body.len() as u64;
    WebEvidenceReference {
        operation_id: id(n),
        response_manifest_sha256: manifest,
        retained_body_sha256: body_hash,
        retained_bytes: body.len() as u64,
        status: 200,
    }
}
fn partial(inputs: &mut Inputs, close: Option<ScanCloseReason>) {
    let (_, snapshot, report) = inputs;
    snapshot.root_status = OperationStatus::Unknown;
    snapshot.close_reason = close;
    snapshot.budget.reserved = 10;
    snapshot.http_usage.requests = 1;
    snapshot.http_usage.response_reserved_bytes = 4096;
    report.outcome.root_status = OperationStatus::Unknown;
    report.outcome.agent_status = Some(AgentStatus::Unknown);
    report.outcome.close_reason = close;
    report.outcome.completeness = ScanCompleteness::Partial;
    report.outcome.stop_reason = ScanStopReason::Unknown;
    report.outcome.review_sha256 = None;
    let run = &mut report.web.as_mut().unwrap().run;
    run.operation_status = OperationStatus::Unknown;
    run.agent_status = Some(AgentStatus::Unknown);
    run.review = None;
    run.artifacts.clear();
    refresh(inputs);
}
fn record_file(dir: &Path, name: &str, bytes: &[u8]) -> Result<Value> {
    fs::write(dir.join(name), bytes)?;
    Ok(json!({"path":name,"sha256":raw_hash(bytes),"bytes":bytes.len()}))
}
fn emit(root: &Path, name: &str, inputs: Inputs, with_report: bool) -> Result<Value> {
    let (grant, snapshot, report) = inputs;
    let dir = root.join("cases").join(name);
    fs::create_dir_all(&dir)?;
    let grant_sha = validate_managed_grant(&grant)?;
    let grant_bytes = managed_json_bytes(&grant, MAX_MANAGED_GRANT_BYTES)?;
    // Exercise the same decoding entrypoint as a guest receiving a dispatched grant.
    let grant = parse_managed_grant(&grant_bytes)?;
    let terminal = managed_terminal(&grant, &snapshot, with_report.then_some(&report))?;
    validate_managed_terminal(&terminal, &grant)?;
    let file = write_managed_terminal(&dir.join("terminal.json"), &terminal)?;
    let marker = result_marker(&terminal, &file)?;
    let terminal_bytes = fs::read(dir.join("terminal.json"))?;
    assert_eq!(raw_hash(&terminal_bytes), file.file_sha256);
    assert_eq!(terminal_bytes.last(), Some(&b'\n'));
    let decoded: ManagedScanTerminal = serde_json::from_slice(&terminal_bytes)?;
    validate_managed_terminal(&decoded, &grant)?;
    let canonical_grant =
        managed_json_bytes(&serde_json::to_value(&grant)?, MAX_MANAGED_GRANT_BYTES)?;
    assert_eq!(raw_hash(&canonical_grant), grant_sha);
    let mut files = BTreeMap::new();
    files.insert("grant", record_file(&dir, "grant.json", &grant_bytes)?);
    files.insert(
        "canonical_grant",
        record_file(&dir, "canonical-grant.json", &canonical_grant)?,
    );
    files.insert(
        "marker",
        record_file(&dir, "marker.txt", marker.as_bytes())?,
    );
    files.insert(
        "terminal",
        json!({"path":"terminal.json","sha256":file.file_sha256,"bytes":file.bytes}),
    );
    let native_report_sha = match &terminal.publication {
        ManagedScanPublication::Retained {
            report,
            report_sha256,
        } => {
            let bytes = managed_json_bytes(report, MAX_SCAN_REPORT_BYTES)?;
            assert_eq!(raw_hash(&bytes), *report_sha256);
            files.insert(
                "native_report",
                record_file(&dir, "native-report.json", &bytes)?,
            );
            Some(report_sha256.clone())
        }
        _ => None,
    };
    let publication = match terminal.publication {
        ManagedScanPublication::Retained { .. } => "retained",
        ManagedScanPublication::ReportTooLarge { .. } => "report_too_large",
        ManagedScanPublication::Unavailable { .. } => "unavailable",
    };
    let body_files: Value = json!(files);
    Ok(
        json!({"name":name,"directory":format!("cases/{name}"),"files":body_files,
        "expected":{"grant_sha256":grant_sha,"report_sha256":native_report_sha,
        "publication":publication,"outcome_present":terminal.outcome.is_some(),
        "controller_status":terminal.controller_status,"root_status":terminal.root_status,
        "close_reason":terminal.close_reason,"stop_reason":terminal.outcome.as_ref().map(|o|o.stop_reason),
        "completeness":terminal.outcome.as_ref().map(|o|o.completeness),
        "budget":terminal.budget,"http_usage":terminal.http_usage,"currency":terminal.currency,
        "organization_id":terminal.organization_id,"vulnerability_reportable":false}}),
    )
}
fn generate(root: &Path) -> Result<()> {
    fs::create_dir_all(root)?;
    let schemas = BTreeMap::from([
        (
            "grant",
            record_file(
                root,
                "grant.schema.json",
                &serde_json::to_vec_pretty(&schemars::schema_for!(ManagedScanGrant))?,
            )?,
        ),
        (
            "terminal",
            record_file(
                root,
                "terminal.schema.json",
                &serde_json::to_vec_pretty(&schemars::schema_for!(ManagedScanTerminal))?,
            )?,
        ),
    ]);
    let mut cases = vec![];
    cases.push(emit(root, "completed_empty", baseline(), true)?);

    let mut x = baseline();
    let evidence = add_observation(&mut x, 20);
    let review = x.2.web.as_mut().unwrap().run.review.as_mut().unwrap();
    review.hypotheses.push(WebHypothesis {
        id: id(30),
        state: VerificationState::Unverified,
        claim: WebClaim {
            title: "Unverified fixture claim λ".into(),
            category: "access_control".into(),
            explanation: "Synthetic wire example, not an investigation result.".into(),
            claimed_impact: "Model-claimed impact only".into(),
            claimed_severity: ClaimedSeverity::High,
            citations: vec![WebCitation {
                operation_id: evidence.operation_id.clone(),
                response_manifest_sha256: evidence.response_manifest_sha256.clone(),
                part: WebCitationPart::Body {
                    offset: 0,
                    length: 7,
                },
            }],
        },
    });
    review.evidence.push(evidence);
    x.2.outcome.summary.submitted_hypotheses = 1;
    x.2.outcome.summary.claimed_high = 1;
    refresh(&mut x);
    cases.push(emit(root, "unverified_claim_observation", x, true)?);

    let mut x = baseline();
    x.1.budget.charged = 101;
    refresh(&mut x);
    cases.push(emit(root, "model_overrun", x, true)?);
    for (name, close) in [
        ("deadline_holds", ScanCloseReason::Deadline),
        ("cancel_holds", ScanCloseReason::Cancelled),
    ] {
        let mut x = baseline();
        partial(&mut x, Some(close));
        cases.push(emit(root, name, x, true)?);
    }
    let mut x = baseline();
    partial(&mut x, None);
    x.1.controller_status = OperationStatus::Unknown;
    x.1.result = None;
    cases.push(emit(
        root,
        "metadata_unknown_outcome_none",
        x.clone(),
        false,
    )?);
    x.2.kind = ScanReportKind::Recovery;
    x.2.outcome.completed_at_ms = 0;
    cases.push(emit(root, "recovery_timestamp_zero", x, true)?);
    cases.push(emit(root, "retained_unavailable", baseline(), false)?);
    let mut x = baseline();
    x.1.result.as_mut().unwrap().publication = ScanPublication::ReportTooLarge;
    x.2.kind = ScanReportKind::Compact;
    x.2.web = None;
    cases.push(emit(root, "report_too_large", x, true)?);

    let mut x = baseline();
    let pin = x.0.providers.remove("fixture").unwrap();
    x.0.scan_profile.provider = "10".into();
    x.0.scan_profile.delegation_policy = Some(serde_json::from_value(
        json!({"max_parallel":1,"max_children":1,"roles":[{"name":"observer","provider":"2","model":"model","instructions":"Read authorized responses.","description":"Observe only","tools":["http_request"],"max_turns":2,"reservation_per_turn":10}]}),
    )?);
    x.0.providers = BTreeMap::from([("2".into(), pin.clone()), ("10".into(), pin)]);
    refresh(&mut x);
    cases.push(emit(root, "numeric_provider_names", x.clone(), true)?);
    // Rust's UTF-8 key order differs from JavaScript's default UTF-16 sort.
    let first = x.0.providers.remove("10").unwrap();
    let second = x.0.providers.remove("2").unwrap();
    x.0.providers = BTreeMap::from([("\u{e000}".into(), first), ("\u{10000}".into(), second)]);
    x.0.scan_profile.provider = "\u{e000}".into();
    x.0.scan_profile.delegation_policy.as_mut().unwrap().roles[0].provider = "\u{10000}".into();
    x.0.scan_profile.instructions =
        "Fixture escapes: \"quote\", \\slash, tab\t and newline\n; λ".into();
    refresh(&mut x);
    cases.push(emit(root, "utf8_provider_names", x, true)?);

    let mut x = baseline();
    let policy = WebExperimentPolicy {
        schema_version: 1,
        max_experiments: 1,
        max_cases: 2,
        max_repeats: 2,
    };
    x.0.scan_profile.web_experiment_policy = Some(policy.clone());
    let mut attempts = vec![];
    for repeat in 0..2 {
        for (index, name) in ["attack", "control"].into_iter().enumerate() {
            let e = add_observation(&mut x, 40 + repeat * 2 + index as u32);
            attempts.push(
                json!({"case_name":name,"repeat_index":repeat,"operation_id":e.operation_id,
                "operation_status":"succeeded","request_sha256":canonical(&json!({"case":name})),
                "response_manifest_sha256":e.response_manifest_sha256,"status":200,
                "body_sha256":e.retained_body_sha256,"complete":true,"possible_dispatch":true}),
            );
        }
    }
    let matrix = canonical(&json!({"fixture_matrix":1}));
    let hypothesis = canonical(&json!({"fixture_hypothesis":1}));
    let body = raw_hash("fixture body λ\n".as_bytes());
    let experiment: WebExperimentReport = serde_json::from_value(json!({
        "schema_version":1,"session_id":x.1.scan.session_id,"web_operation_id":x.1.scan.root_operation_id,
        "operation_id":id(50),"operation_status":"succeeded","actor_operation_id":x.1.scan.root_operation_id,
        "inference_operation_id":id(51),"call_id":"experiment-call","policy":policy,
        "proposal":{"hypothesis":{"title":"Fixture conjecture","explanation":"Synthetic predicted response"},
            "purpose":"Exercise measured matrix wire shape","repeats":2,
            "cases":[{"name":"attack","role":"attack","request":{"url":"https://example.test/","method":"GET"},"expected":{"status":200,"body_sha256":body}},
                     {"name":"control","role":"legitimate_control","request":{"url":"https://example.test/control","method":"GET"},"expected":{"status":200,"body_sha256":body}}]},
        "hypothesis":{"hypothesis_sha256":hypothesis,"title":"Fixture conjecture","explanation":"Synthetic predicted response"},
        "intent_sha256":canonical(&json!({"fixture_intent":1})),"matrix_sha256":matrix,
        "outcome":{"assessment":{"schema_version":1,"disposition":"observed_for_plan","oracle_version":"zero-web-exact-response-v1","plan_sha256":matrix,
            "expected_attempts":4,"completed_attempts":4,"observed_attempts":4,"control_attempts":2,"reasons":[],"vulnerability_reportable":false},
            "attempts":attempts,"stop":null,"artifacts":{},"children":[id(40),id(41),id(42),id(43)],"error":null},"artifacts":{}}))?;
    experiment.proposal.validate()?;
    x.2.web.as_mut().unwrap().experiments.push(experiment);
    refresh(&mut x);
    cases.push(emit(root, "experiment_observations", x, true)?);

    let manifest = json!({"schema_version":1,"contract_version":MANAGED_SCAN_CONTRACT,
        "provenance":"synthetic_wire_fixtures_not_investigation_evidence",
        "generator":"zero-cloud-compat/examples/managed_scan_fixtures.rs",
        "file_hash_rule":"sha256 exact bytes; terminal includes final newline",
        "report_hash_rule":"sha256 typed serde report bytes, no newline",
        "grant_hash_rule":"sha256 serde_json::Value canonical bytes, no newline",
        "schemas":schemas,"cases":cases});
    let mut bytes = serde_json::to_vec_pretty(&manifest)?;
    bytes.push(b'\n');
    fs::write(root.join("manifest.json"), bytes)?;
    Ok(())
}
fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let output = args
        .next()
        .ok_or("usage: managed_scan_fixtures OUTPUT_DIR")?;
    if args.next().is_some() {
        return Err("expected one output directory".into());
    }
    generate(Path::new(&output))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn regeneration_is_byte_identical_and_all_files_match_manifest() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        generate(a.path()).unwrap();
        generate(b.path()).unwrap();
        let manifest = fs::read(a.path().join("manifest.json")).unwrap();
        assert_eq!(manifest, fs::read(b.path().join("manifest.json")).unwrap());
        let parsed: Value = serde_json::from_slice(&manifest).unwrap();
        assert_eq!(parsed["cases"].as_array().unwrap().len(), 12);
        for f in parsed["schemas"].as_object().unwrap().values() {
            let path = f["path"].as_str().unwrap();
            let bytes = fs::read(a.path().join(path)).unwrap();
            assert_eq!(bytes, fs::read(b.path().join(path)).unwrap());
            assert_eq!(raw_hash(&bytes), f["sha256"]);
        }
        for case in parsed["cases"].as_array().unwrap() {
            for f in case["files"].as_object().unwrap().values() {
                let path = Path::new(case["directory"].as_str().unwrap())
                    .join(f["path"].as_str().unwrap());
                let bytes = fs::read(a.path().join(&path)).unwrap();
                assert_eq!(bytes, fs::read(b.path().join(&path)).unwrap());
                assert_eq!(raw_hash(&bytes), f["sha256"]);
                assert_eq!(bytes.len() as u64, f["bytes"].as_u64().unwrap());
            }
        }
    }
}
