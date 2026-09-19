use super::*;
use zero_protocol::{
    ExecutionStatus,
    repair::{CandidateReceipt, RepairPhase, RepairValidationOutcome, RepairValidationStatus},
    sandbox::{SandboxArtifact, SandboxCleanup, SandboxResult},
    verification::{Evidence, Plan},
};

fn prepared() -> (
    tempfile::TempDir,
    Store,
    NativeRepairAdmission,
    Plan,
    CandidateReceipt,
) {
    let (dir, mut store, a) = super::tests::admitted_source();
    store.admit_native_repair("repair", "owner", &a).unwrap();
    store
        .begin_native_repair_preparation(&a.id, "owner")
        .unwrap();
    assert!(
        store
            .begin_native_repair_preparation(&a.id, "owner")
            .is_err()
    );
    let original = store
        .native_reproduction_authorization(&a.authorization.reproduction_id)
        .unwrap();
    let mut pin = original.plan.snapshot.clone();
    pin.root = "/private/baseline".into();
    let baseline = FrozenPlan::new(original.plan)
        .unwrap()
        .reanchor_snapshot(&pin)
        .unwrap();
    let (binding, materialize) = {
        let tx = store.conn.unchecked_transaction().unwrap();
        let mut r = Reader::new();
        let b = bound(&tx, &a.id, &mut r).unwrap();
        authority::source::expected_source(&tx, &b, &baseline, &mut r).unwrap()
    };
    store
        .bind_native_repair_source(&a.id, "owner", baseline.plan(), &binding, &materialize)
        .unwrap();
    store
        .bind_native_repair_source(&a.id, "owner", baseline.plan(), &binding, &materialize)
        .unwrap();
    let receipt = zero_repair::expected_receipt(&materialize).unwrap();
    let mut candidate = baseline.plan().clone();
    candidate.snapshot.root = "/private/candidate".into();
    candidate.snapshot.digest = receipt.candidate_snapshot_sha256.clone();
    candidate.snapshot.id = candidate.snapshot.digest.clone();
    let target = candidate
        .snapshot
        .files
        .iter_mut()
        .find(|f| f.path == materialize.target)
        .unwrap();
    target.digest = receipt.replacement_sha256.clone();
    target.bytes = receipt.replacement_bytes;
    for c in &mut candidate.cases {
        if c.mode == Mode::Attack {
            c.expected = c.safe_expected.take().unwrap();
        }
    }
    (dir, store, a, candidate, receipt)
}
fn bind_phase(
    store: &mut Store,
    a: &NativeRepairAdmission,
    phase: &str,
    plan: &Plan,
    receipt: &CandidateReceipt,
) {
    store
        .begin_native_repair_candidate(&a.id, "owner", phase)
        .unwrap();
    assert!(
        store
            .begin_native_repair_candidate(&a.id, "owner", phase)
            .is_err()
    );
    store
        .bind_native_repair_candidate(&a.id, "owner", phase, plan, receipt)
        .unwrap();
}
fn matrix(
    store: &mut Store,
    a: &NativeRepairAdmission,
    phase: &str,
    plan: &Plan,
) -> ReproductionOutcome {
    let mut evidence = vec![];
    let mut children = vec![];
    let mut index = vec![];
    for (i, case) in plan.cases.iter().enumerate() {
        for repeat in 0..plan.repeats {
            let (op, request) = store
                .admit_native_repair_case(&a.id, "owner", phase, i, repeat)
                .unwrap();
            let req = store
                .retain_operation_artifact(
                    &op.id,
                    "owner",
                    "reproduction.request",
                    &serde_json::to_vec(&request).unwrap(),
                )
                .unwrap();
            store
                .begin_native_repair_effect(&a.id, &op.id, "owner")
                .unwrap();
            assert!(
                store
                    .begin_native_repair_effect(&a.id, &op.id, "owner")
                    .is_err()
            );
            let zero_protocol::sandbox::SandboxBackend::Docker { image } = &plan.backend else {
                panic!("fixture backend")
            };
            let item = Evidence {
                case_id: case.id.clone(),
                repeat,
                request: request.clone(),
                result: SandboxResult {
                    execution_id: request.execution_id,
                    artifact: SandboxArtifact::Docker {
                        image_reference: image.clone(),
                        resolved_image_id: Some(image.clone()),
                    },
                    status: ExecutionStatus::Exited,
                    exit_code: Some(case.expected.exit_code),
                    stdout: case.expected.stdout.clone(),
                    stderr: case.expected.stderr.clone(),
                    duration_ms: 1,
                    cleanup: SandboxCleanup::Confirmed,
                    error: None,
                },
            };
            let obs = store
                .retain_operation_artifact(
                    &op.id,
                    "owner",
                    "reproduction.evidence",
                    &serde_json::to_vec(&item).unwrap(),
                )
                .unwrap();
            store.settle_operation(&op.id,"owner",OperationStatus::Succeeded,&json!({"request_artifact":req,"evidence_artifact":obs,"status":item.result.status,"exit_code":item.result.exit_code,"cleanup":item.result.cleanup})).unwrap();
            index.push(json!({"child_operation":op.id,"case_id":case.id,"repeat":repeat,"request_artifact":req,"evidence_artifact":obs}));
            children.push(op.id);
            evidence.push(item);
        }
    }
    let assessment =
        zero_verification::assess(&FrozenPlan::new(plan.clone()).unwrap(), &evidence).unwrap();
    let mut artifacts = std::collections::BTreeMap::new();
    for (name, bytes) in [
        ("plan", serde_json::to_vec(plan).unwrap()),
        ("evidence_index", serde_json::to_vec(&index).unwrap()),
        ("assessment", serde_json::to_vec(&assessment).unwrap()),
    ] {
        let name = format!("{phase}.{name}");
        let digest = store
            .retain_operation_artifact(&a.operation_id, "owner", &name, &bytes)
            .unwrap();
        artifacts.insert(name, digest);
    }
    ReproductionOutcome {
        assessment: Some(assessment),
        artifacts,
        children,
        external_effects_started: true,
        stop_reason: None,
        error: None,
    }
}
fn outcome(
    store: &Store,
    a: &NativeRepairAdmission,
    receipt: Option<CandidateReceipt>,
    phases: Vec<RepairPhase>,
    status: RepairValidationStatus,
) -> RepairValidationOutcome {
    let (_, binding, _) = store.native_repair_bound_source(&a.id).unwrap().unwrap();
    RepairValidationOutcome {
        status,
        original_plan_digest: Some(binding.logical_plan_sha256),
        candidate_receipt: receipt,
        phases,
        artifacts: store
            .operation_artifacts(&a.operation_id)
            .unwrap()
            .into_iter()
            .filter(|(k, _)| k.starts_with("repair."))
            .collect(),
        cleanup_recovery: vec![],
        error: None,
        vulnerability_reportable: false,
    }
}
#[test]
fn two_fresh_matrices_require_independent_observation_before_reconstruction() {
    let (_dir, mut store, a, plan, receipt) = prepared();
    assert!(
        store
            .begin_native_repair_candidate(&a.id, "owner", "reconstructed")
            .is_err()
    );
    bind_phase(&mut store, &a, "candidate", &plan, &receipt);
    let first = matrix(&mut store, &a, "candidate", &plan);
    let mut forged = first.clone();
    forged.assessment.as_mut().unwrap().evidence_digest = format!("sha256:{}", "0".repeat(64));
    assert!(
        store
            .complete_native_repair_phase(&a.id, "owner", "candidate", &forged)
            .is_err()
    );
    assert!(
        store
            .begin_native_repair_candidate(&a.id, "owner", "reconstructed")
            .is_err()
    );
    store
        .complete_native_repair_phase(&a.id, "owner", "candidate", &first)
        .unwrap();
    store
        .begin_native_repair_candidate(&a.id, "owner", "reconstructed")
        .unwrap();
    assert!(
        store
            .bind_native_repair_candidate(&a.id, "owner", "reconstructed", &plan, &receipt)
            .is_err()
    );
    let mut second_plan = plan.clone();
    second_plan.snapshot.root = "/private/reconstructed".into();
    store
        .bind_native_repair_candidate(&a.id, "owner", "reconstructed", &second_plan, &receipt)
        .unwrap();
    let second = matrix(&mut store, &a, "reconstructed", &second_plan);
    store
        .complete_native_repair_phase(&a.id, "owner", "reconstructed", &second)
        .unwrap();
    let phases = vec![
        RepairPhase {
            name: "candidate".into(),
            derived_plan_digest: FrozenPlan::new(plan).unwrap().digest().into(),
            observations: first,
        },
        RepairPhase {
            name: "reconstructed".into(),
            derived_plan_digest: FrozenPlan::new(second_plan).unwrap().digest().into(),
            observations: second,
        },
    ];
    let result = outcome(
        &store,
        &a,
        Some(receipt),
        phases,
        RepairValidationStatus::ValidatedCandidateForPlan,
    );
    let op = store
        .settle_native_repair(&a.id, "owner", &result, false)
        .unwrap();
    assert_eq!(op.status, OperationStatus::Succeeded);
    assert!(
        store
            .native_repair_read_snapshot(&a.id)
            .unwrap()
            .native_repair(&a.id)
            .is_ok()
    );
}
#[test]
fn widened_candidate_and_deleted_effect_witness_fail_closed() {
    let (_dir, mut store, a, plan, receipt) = prepared();
    store
        .begin_native_repair_candidate(&a.id, "owner", "candidate")
        .unwrap();
    let mut forged = plan.clone();
    forged.limits.timeout_ms += 1;
    assert!(
        store
            .bind_native_repair_candidate(&a.id, "owner", "candidate", &forged, &receipt)
            .is_err()
    );
    store
        .bind_native_repair_candidate(&a.id, "owner", "candidate", &plan, &receipt)
        .unwrap();
    assert!(
        store
            .admit_native_repair_case(&a.id, "wrong", "candidate", 0, 0)
            .is_err()
    );
    assert!(
        store
            .admit_native_repair_case(&a.id, "owner", "candidate", 0, 1)
            .is_err()
    );
    let (op, request) = store
        .admit_native_repair_case(&a.id, "owner", "candidate", 0, 0)
        .unwrap();
    assert!(
        store
            .begin_native_repair_effect(&a.id, &op.id, "owner")
            .is_err()
    );
    store
        .retain_operation_artifact(
            &op.id,
            "owner",
            "reproduction.request",
            &serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
    store
        .begin_native_repair_effect(&a.id, &op.id, "owner")
        .unwrap();
    store
        .conn
        .execute(
            "DELETE FROM events WHERE session_id=?1 AND kind='native_repair_effect_started'",
            [&a.session_id],
        )
        .unwrap();
    assert!(
        store
            .begin_native_repair_effect(&a.id, &op.id, "owner")
            .is_err()
    );
    assert!(store.native_repair(&a.id).is_err());
}
#[test]
fn cancellation_fences_dispatch_and_summary_uses_final_atomic_status() {
    let (_dir, mut store, a, plan, receipt) = prepared();
    bind_phase(&mut store, &a, "candidate", &plan, &receipt);
    let (op, request) = store
        .admit_native_repair_case(&a.id, "owner", "candidate", 0, 0)
        .unwrap();
    store
        .retain_operation_artifact(
            &op.id,
            "owner",
            "reproduction.request",
            &serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
    store
        .stop_native_repair(&a.id, "owner", ReviewCloseReason::Cancelled)
        .unwrap();
    assert!(
        store
            .begin_native_repair_effect(&a.id, &op.id, "owner")
            .is_err()
    );
    store
        .settle_operation(
            &op.id,
            "owner",
            OperationStatus::Cancelled,
            &json!({"external_effects_started":false,"request_artifact":"fixture"}),
        )
        .unwrap();
    let result = outcome(
        &store,
        &a,
        Some(receipt),
        vec![],
        RepairValidationStatus::NotValidated,
    );
    let terminal = store
        .settle_native_repair(&a.id, "owner", &result, false)
        .unwrap();
    assert_eq!(terminal.status, OperationStatus::Cancelled);
    let result: RepairValidationOutcome =
        serde_json::from_value(terminal.outcome.unwrap()).unwrap();
    let summary: Value = serde_json::from_slice(
        &store
            .artifact(&result.artifacts["repair.validation_summary"])
            .unwrap(),
    )
    .unwrap();
    assert_eq!(summary["status"], "cancelled");
    assert!(
        store
            .begin_native_repair_candidate(&a.id, "owner", "reconstructed")
            .is_err()
    );
}

#[test]
fn private_attachment_inventory_and_orphan_start_receipts_are_not_hidden() {
    let (_dir, mut store, a, _, _) = prepared();
    store
        .retain_operation_artifact(
            &a.operation_id,
            "owner",
            "native_repair.hidden",
            b"unreviewed",
        )
        .unwrap();
    assert!(store.native_repair(&a.id).is_err());
    let (_dir, mut store, a, _, _) = prepared();
    store
        .begin_native_repair_candidate(&a.id, "owner", "candidate")
        .unwrap();
    store
        .conn
        .execute(
            "DELETE FROM events WHERE session_id=?1 AND kind='native_repair_candidate_started'",
            [&a.session_id],
        )
        .unwrap();
    assert!(
        store
            .begin_native_repair_candidate(&a.id, "owner", "candidate")
            .is_err()
    );
    assert!(store.native_repair_read_snapshot(&a.id).is_err());
}
#[test]
fn source_binding_requires_original_limits_and_all_retained_artifact_witnesses() {
    let (_dir, mut store, a, _, _) = prepared();
    let (mut plan, binding, request) = store.native_repair_bound_source(&a.id).unwrap().unwrap();
    plan.limits.max_output_bytes += 1;
    assert!(
        store
            .bind_native_repair_source(&a.id, "owner", &plan, &binding, &request)
            .is_err()
    );
    store.conn.execute("DELETE FROM events WHERE session_id=?1 AND kind='operation_artifact' AND json_extract(payload,'$.name')='repair.replacement'",[&a.session_id]).unwrap();
    assert!(store.native_repair(&a.id).is_err());
}
#[test]
fn expired_admission_never_opens_preparation_and_exact_retry_keeps_original_deadline() {
    let (_dir, mut store, mut a) = super::tests::admitted_source();
    a.authorization.deadline_ms = 1;
    let first = store.admit_native_repair("repair", "owner", &a).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    assert!(
        store
            .begin_native_repair_preparation(&a.id, "owner")
            .is_err()
    );
    assert!(store.native_repair_closed(&a.id).unwrap());
    let retry = store.admit_native_repair("repair", "owner", &a).unwrap();
    assert!(retry.duplicate);
    assert_eq!(retry.record.deadline_at_ms, first.record.deadline_at_ms);
    assert!(
        store
            .stop_native_repair(&a.id, "owner", ReviewCloseReason::Deadline)
            .unwrap()
    );
}
#[test]
fn unresolved_child_overrides_cancellation_without_fabricated_cleanup_path() {
    let (_dir, mut store, a, plan, receipt) = prepared();
    bind_phase(&mut store, &a, "candidate", &plan, &receipt);
    let (op, request) = store
        .admit_native_repair_case(&a.id, "owner", "candidate", 0, 0)
        .unwrap();
    store
        .retain_operation_artifact(
            &op.id,
            "owner",
            "reproduction.request",
            &serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
    store
        .begin_native_repair_effect(&a.id, &op.id, "owner")
        .unwrap();
    store
        .mark_operation_unknown(&op.id, "owner", "fixture supervisor lost")
        .unwrap();
    let result = outcome(
        &store,
        &a,
        Some(receipt),
        vec![],
        RepairValidationStatus::Unknown,
    );
    let terminal = store
        .settle_native_repair(&a.id, "owner", &result, true)
        .unwrap();
    assert_eq!(terminal.status, OperationStatus::Unknown);
    let result: RepairValidationOutcome =
        serde_json::from_value(terminal.outcome.unwrap()).unwrap();
    assert!(result.cleanup_recovery.is_empty());
    let summary: Value = serde_json::from_slice(
        &store
            .artifact(&result.artifacts["repair.validation_summary"])
            .unwrap(),
    )
    .unwrap();
    assert_eq!(summary["status"], "unknown");
}

#[test]
fn baseline_change_after_admission_denies_preparation_or_source_binding_atomically() {
    for prepared in [false, true] {
        let (_dir, mut store, a) = super::tests::admitted_source();
        store.admit_native_repair("repair", "owner", &a).unwrap();
        let original = store
            .native_reproduction_authorization(&a.authorization.reproduction_id)
            .unwrap();
        let mut pin = original.plan.snapshot.clone();
        pin.root = "/private/baseline".into();
        let baseline = FrozenPlan::new(original.plan)
            .unwrap()
            .reanchor_snapshot(&pin)
            .unwrap();
        let (binding, materialize) = {
            let tx = store.conn.unchecked_transaction().unwrap();
            let mut r = Reader::new();
            let b = bound(&tx, &a.id, &mut r).unwrap();
            authority::source::expected_source(&tx, &b, &baseline, &mut r).unwrap()
        };
        if prepared {
            store
                .begin_native_repair_preparation(&a.id, "owner")
                .unwrap();
        }
        store.conn.execute("INSERT INTO events(session_id,sequence,kind,payload) SELECT session_id,max(sequence)+1,'fixture_note','{}' FROM events WHERE session_id=(SELECT session_id FROM native_reproductions WHERE id=?1)",[&a.authorization.reproduction_id]).unwrap();
        if prepared {
            assert!(
                store
                    .bind_native_repair_source(
                        &a.id,
                        "owner",
                        baseline.plan(),
                        &binding,
                        &materialize
                    )
                    .is_err()
            );
            assert!(store.native_repair_bound_source(&a.id).unwrap().is_none());
        } else {
            assert!(
                store
                    .begin_native_repair_preparation(&a.id, "owner")
                    .is_err()
            );
            let count:u64=store.conn.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND kind='native_repair_preparation_started'",[&a.session_id],|r|r.get(0)).unwrap();
            assert_eq!(count, 0);
        }
    }
}

#[test]
fn intent_attachment_without_its_attribution_event_is_rejected() {
    let (_dir, mut store, a) = super::tests::admitted_source();
    store.admit_native_repair("repair", "owner", &a).unwrap();
    store.conn.execute("DELETE FROM events WHERE session_id=?1 AND kind='operation_artifact' AND json_extract(payload,'$.name')='native_repair.intent'",[&a.session_id]).unwrap();
    assert!(store.native_repair(&a.id).is_err());
    assert!(store.native_repair_by_command("repair").is_err());
    assert!(
        store
            .begin_native_repair_preparation(&a.id, "owner")
            .is_err()
    );
}

#[test]
fn unrelated_membership_probes_allow_routing_native_repair_cancellation() {
    let (_dir, mut store, a) = super::tests::admitted_source();
    store.admit_native_repair("repair", "owner", &a).unwrap();
    assert!(store.scan_by_session(&a.session_id).unwrap().is_none());
    assert!(store.review_by_session(&a.session_id).unwrap().is_none());
    assert!(
        store
            .native_reproduction_by_session(&a.session_id)
            .unwrap()
            .is_none()
    );
    let repair = store
        .native_repair_by_session(&a.session_id)
        .unwrap()
        .unwrap();
    assert!(
        store
            .stop_native_repair(&repair.id, "owner", ReviewCloseReason::Cancelled)
            .unwrap()
    );
    assert!(
        store
            .admit_command(&a.session_id, "infer", &json!({"kind":"inference"}))
            .is_err()
    );
}

#[test]
fn orphan_parent_artifact_witness_prevents_materialization_replay() {
    let (_dir, mut store, a, _, _) = prepared();
    store
        .begin_native_repair_candidate(&a.id, "owner", "candidate")
        .unwrap();
    store
        .conn
        .execute(
            "DELETE FROM events WHERE session_id=?1 AND kind='native_repair_candidate_started'",
            [&a.session_id],
        )
        .unwrap();
    store.conn.execute("DELETE FROM operation_artifacts WHERE operation_id=?1 AND name='native_repair.candidate.start'",[&a.operation_id]).unwrap();
    assert!(
        store
            .begin_native_repair_candidate(&a.id, "owner", "candidate")
            .is_err()
    );
    assert!(store.native_repair_read_snapshot(&a.id).is_err());
}
