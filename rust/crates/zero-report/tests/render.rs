use serde_json::{Value, json};
use zero_report::{Error, Report};
const SOURCE: &[u8] = include_bytes!("fixtures/report.json");
#[test]
fn sarif_matches_actual_typescript_golden_without_promoting_findings() {
    let report = Report::parse(SOURCE).unwrap();
    let result: Value = serde_json::from_str(&report.sarif("fixture-version").unwrap()).unwrap();
    let expected: Value =
        serde_json::from_str(include_str!("fixtures/typescript.sarif.json")).unwrap();
    assert_eq!(result, expected);
    assert_eq!(
        result["runs"][0]["results"][0]["properties"]["status"],
        "discovered"
    );
    assert_eq!(
        result["runs"][0]["invocations"][0]["executionSuccessful"],
        false
    );
    assert_eq!(
        result["runs"][0]["tool"]["driver"]["rules"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
}
#[test]
fn json_preserves_all_additive_unknown_fields_and_explicit_zero_values() {
    let report = Report::parse(SOURCE).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&report.json().unwrap()).unwrap(),
        serde_json::from_slice::<Value>(SOURCE).unwrap()
    );
}
#[test]
fn invalid_contracts_and_resource_expansion_fail_without_truncation() {
    let original: Value = serde_json::from_slice(SOURCE).unwrap();
    for (field, value) in [
        ("severity", json!("invalid")),
        ("evidence", Value::Null),
        ("pocSteps", json!({})),
    ] {
        let mut report = original.clone();
        report["findings"][0][field] = value;
        assert!(Report::parse(&serde_json::to_vec(&report).unwrap()).is_err());
    }
    let mut report = original.clone();
    report["findings"][0]["pocSteps"][0]["action"]["type"] = json!("host_callback");
    assert!(Report::parse(&serde_json::to_vec(&report).unwrap()).is_err());
    let mut report = original;
    report["target"] = json!("x".repeat(1024 * 1024));
    report["findings"][0]["pocSteps"] = json!(vec![
        json!({"id":"step","kind":"note","summary":"fixture","action":{"type":"note"}});
        1000
    ]);
    let bounded = Report::parse(&serde_json::to_vec(&report).unwrap()).unwrap();
    assert!(matches!(bounded.sarif("fixture"), Err(Error::Limit)));
    assert!(bounded.sarif("\x1b[31m").is_err());
}
#[test]
fn absent_optional_poc_fields_and_default_invocation_match_reference_semantics() {
    let mut report: Value = serde_json::from_slice(SOURCE).unwrap();
    report
        .as_object_mut()
        .unwrap()
        .remove("executionSuccessful");
    report["findings"] = json!([]);
    let parsed = Report::parse(&serde_json::to_vec(&report).unwrap()).unwrap();
    let output: Value = serde_json::from_str(&parsed.sarif("fixture").unwrap()).unwrap();
    assert_eq!(
        output["runs"][0]["invocations"][0]["executionSuccessful"],
        true
    );
    assert_eq!(output["runs"][0]["results"], json!([]));
    assert_eq!(output["runs"][0]["tool"]["driver"]["rules"], json!([]));
}
