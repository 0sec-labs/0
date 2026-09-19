use serde_json::{Value, json};
use zero_protocol::{
    review_reproduction::{ReviewReproductionBinding, ReviewReproductionPlan},
    verification::SourceReproductionRequest,
};

fn raw() -> Value {
    let digest = format!("sha256:{}", "a".repeat(64));
    json!({
        "schema_version": 1,
        "review_id": "12345678-1234-4234-8234-123456789abc",
        "source_operation_id": "23456789-1234-4234-8234-123456789abc",
        "archive_manifest_sha256": digest,
        "deadline_ms": 60_000,
        "max_executions": 4,
        "plan": {
            "schema_version": 1,
            "oracle_version": "zero-verification-exact-output-v1",
            "hypothesis_id": "claim-1",
            "source_bundle_digest": digest,
            "snapshot": {"id":"pin", "root":"/private/source", "digest":digest,
                "files":[{"path":"app.rs","bytes":1,"digest":digest}]},
            "backend": {"type":"docker","image":digest},
            "limits": {"timeout_ms":1000,"memory_mb":128,"cpus":1.0,"max_output_bytes":4096},
            "repeats": 2,
            "cases": [
                {"id":"attack","mode":"attack","argv":["/app/probe","attack"],"stdin":null,
                    "expected":{"exit_code":0,"stdout":"/wA=","stderr":""},"safe_expected":null},
                {"id":"control","mode":"legitimate_control","argv":["/app/probe","control"],"stdin":null,
                    "expected":{"exit_code":0,"stdout":"b2sK","stderr":""},"safe_expected":null}
            ]
        }
    })
}

fn envelope(value: Value) -> ReviewReproductionPlan {
    serde_json::from_value(value).unwrap()
}

#[test]
fn envelope_roundtrips_without_changing_the_legacy_reproduction_request() {
    let original = raw();
    let parsed = envelope(original.clone());
    parsed.validate_envelope().unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), original);
    assert_eq!(parsed.plan.cases[0].expected.stdout, [255, 0]);
    let legacy =
        json!({"source_operation_id":original["source_operation_id"],"plan":original["plan"]});
    let request: SourceReproductionRequest = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(&request).unwrap(), legacy);
    assert_eq!(
        serde_json::to_value(&parsed.plan).unwrap(),
        serde_json::to_value(&request.plan).unwrap()
    );
}

#[test]
fn envelope_rejects_identity_version_deadline_and_execution_bounds() {
    for (field, value) in [
        ("schema_version", json!(0)),
        ("schema_version", json!(2)),
        ("deadline_ms", json!(0)),
        ("deadline_ms", json!(3_600_001)),
        ("max_executions", json!(0)),
        ("max_executions", json!(3)),
        ("max_executions", json!(257)),
    ] {
        let mut value_with_error = raw();
        value_with_error[field] = value.clone();
        assert!(
            envelope(value_with_error).validate_envelope().is_err(),
            "{field}: {value}"
        );
    }
    for field in ["review_id", "source_operation_id"] {
        for invalid in [
            "",
            "review",
            "00000000-0000-0000-0000-000000000000",
            "12345678-1234-4234-8234-123456789ABC",
        ] {
            let mut value = raw();
            value[field] = json!(invalid);
            assert!(
                envelope(value).validate_envelope().is_err(),
                "{field}: {invalid}"
            );
        }
    }
    for invalid in [
        "a".repeat(64),
        format!("sha256:{}", "A".repeat(64)),
        "sha256:bad".into(),
    ] {
        let mut value = raw();
        value["archive_manifest_sha256"] = json!(invalid);
        assert!(envelope(value).validate_envelope().is_err());
    }
    for deadline in [1, 3_600_000] {
        let mut value = raw();
        value["deadline_ms"] = json!(deadline);
        value["max_executions"] = json!(256);
        envelope(value).validate_envelope().unwrap();
    }
}

#[test]
fn matrix_product_is_checked_and_deep_oracle_validation_remains_separate() {
    let mut plan = envelope(raw());
    plan.plan.repeats = usize::MAX;
    assert!(plan.validate_envelope().is_err());
    plan.plan.repeats = 0;
    assert!(plan.validate_envelope().is_err());
    plan.plan.repeats = 2;
    plan.plan.cases.clear();
    assert!(plan.validate_envelope().is_err());
    let mut plan = envelope(raw());
    // Exact output semantics and backend immutability are checked by FrozenPlan,
    // not accepted as execution authority merely because this envelope fits.
    plan.plan.oracle_version = "unsupported".into();
    plan.validate_envelope().unwrap();
}

#[test]
fn both_wire_types_reject_unknown_fields_and_binding_preserves_exact_identities() {
    let mut plan = raw();
    plan["approve"] = json!(true);
    assert!(serde_json::from_value::<ReviewReproductionPlan>(plan).is_err());
    let mut plan = raw();
    plan["plan"]["network"] = json!(true);
    assert!(serde_json::from_value::<ReviewReproductionPlan>(plan).is_err());
    let original = raw();
    let binding = json!({
        "schema_version":1,
        "review_id":original["review_id"],
        "source_session_id":"34567890-1234-4234-8234-123456789abc",
        "source_operation_id":original["source_operation_id"],
        "archive_manifest_sha256":original["archive_manifest_sha256"],
        "authorization_sha256":format!("sha256:{}", "d".repeat(64)),
        "logical_plan_sha256":format!("sha256:{}", "b".repeat(64)),
        "execution_plan_sha256":format!("sha256:{}", "c".repeat(64))
    });
    let parsed: ReviewReproductionBinding = serde_json::from_value(binding.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), binding);
    assert_eq!(parsed.clone(), parsed);
    let mut unsupported = binding;
    unsupported["attested"] = json!(true);
    assert!(serde_json::from_value::<ReviewReproductionBinding>(unsupported).is_err());
}
