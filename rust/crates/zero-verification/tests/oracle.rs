#![allow(clippy::unwrap_used, clippy::expect_used)]
use zero_protocol::{
    ExecutionStatus, SnapshotFile, SnapshotPin,
    sandbox::{SandboxArtifact, SandboxBackend, SandboxCleanup, SandboxRecovery, SandboxResult},
};
use zero_verification::*;
fn sha(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}
fn output(text: &[u8]) -> ExactOutput {
    ExactOutput {
        exit_code: 0,
        stdout: text.to_vec(),
        stderr: vec![],
    }
}
fn plan() -> Plan {
    let mut plan = Plan {
        schema_version: 1,
        oracle_version: ORACLE_VERSION.into(),
        hypothesis_id: "hypothesis-1".into(),
        source_bundle_digest: sha('a'),
        snapshot: SnapshotPin {
            id: "fixture".into(),
            root: "/snapshot".into(),
            digest: sha('b'),
            files: vec![SnapshotFile {
                path: "source.js".into(),
                digest: sha('c'),
                bytes: 1,
            }],
        },
        backend: SandboxBackend::Docker { image: sha('d') },
        limits: Limits {
            timeout_ms: 1000,
            memory_mb: 128,
            cpus: 0.5,
            max_output_bytes: 1024,
        },
        repeats: 2,
        cases: vec![
            Case {
                id: "attack".into(),
                mode: Mode::Attack,
                argv: vec!["node".into(), "source.js".into(), "attack".into()],
                stdin: None,
                expected: output(b"unsafe-observation\n"),
                safe_expected: Some(output(b"safe-observation\n")),
            },
            Case {
                id: "control".into(),
                mode: Mode::LegitimateControl,
                argv: vec!["node".into(), "source.js".into(), "legitimate".into()],
                stdin: Some("normal input".into()),
                expected: output(b"legitimate-output\n"),
                safe_expected: None,
            },
        ],
    };
    use sha2::{Digest, Sha256};
    let manifest: Vec<_> = plan
        .snapshot
        .files
        .iter()
        .map(|f| serde_json::json!({"bytes":f.bytes,"digest":f.digest,"path":f.path}))
        .collect();
    plan.snapshot.digest = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&manifest).unwrap())
    );
    plan
}
fn evidence(p: &FrozenPlan) -> Vec<Evidence> {
    let mut out = vec![];
    for case in &p.plan().cases {
        for repeat in 0..p.plan().repeats {
            let request = p
                .request(&case.id, repeat, &format!("{}-{repeat}", case.id))
                .unwrap();
            let artifact = match &p.plan().backend {
                SandboxBackend::Docker { image } => SandboxArtifact::Docker {
                    image_reference: image.clone(),
                    resolved_image_id: Some(image.clone()),
                },
                SandboxBackend::Smolvm { archive_digest, .. } => SandboxArtifact::SmolvmArchive {
                    digest: archive_digest.clone(),
                },
            };
            let result = SandboxResult {
                execution_id: request.execution_id.clone(),
                artifact,
                status: ExecutionStatus::Exited,
                exit_code: Some(case.expected.exit_code),
                stdout: case.expected.stdout.clone(),
                stderr: case.expected.stderr.clone(),
                duration_ms: 10,
                cleanup: SandboxCleanup::Confirmed,
                error: None,
            };
            out.push(Evidence {
                case_id: case.id.clone(),
                repeat,
                request,
                result,
            });
        }
    }
    out
}
#[test]
fn complete_host_frozen_observation_is_never_generic_reportability() {
    let p = FrozenPlan::new(plan()).unwrap();
    let rows = evidence(&p);
    let r = assess(&p, &rows).unwrap();
    assert_eq!(r.disposition, Disposition::ObservedForPlan);
    assert!(!r.vulnerability_reportable);
    assert_eq!(r.plan_digest, p.digest());
    assert_eq!(r.required_attempts, 4);
    assert!(r.evidence_digest.starts_with("sha256:"));
    assert_eq!(
        FrozenPlan::parse(&serde_json::to_vec(p.plan()).unwrap())
            .unwrap()
            .digest(),
        p.digest()
    );
    let mut changed = rows;
    changed[0].result.duration_ms += 1;
    assert_ne!(
        assess(&p, &changed).unwrap().evidence_digest,
        r.evidence_digest
    );
}
#[test]
fn forged_success_json_is_opaque_mismatching_output() {
    let p = FrozenPlan::new(plan()).unwrap();
    let mut rows = evidence(&p);
    for row in rows.iter_mut().filter(|r| r.case_id == "attack") {
        row.result.stdout =
            br#"{"verified":true,"vulnerable":true,"safe":true,"decision":"success"}"#.to_vec();
    }
    assert_eq!(
        assess(&p, &rows).unwrap().disposition,
        Disposition::NotObserved
    );
}
#[test]
fn every_request_field_and_observed_backend_identity_is_checked() {
    let p = FrozenPlan::new(plan()).unwrap();
    for field in [
        "image",
        "snapshot",
        "argv",
        "stdin",
        "limits",
        "build",
        "result_id",
        "request_id",
    ] {
        let mut rows = evidence(&p);
        let row = &mut rows[0];
        match field {
            "image" => {
                row.result.artifact = SandboxArtifact::Docker {
                    image_reference: sha('e'),
                    resolved_image_id: Some(sha('e')),
                }
            }
            "snapshot" => row.request.snapshot.digest = sha('e'),
            "argv" => row.request.argv.push("different".into()),
            "stdin" => row.request.stdin = Some("changed".into()),
            "limits" => row.request.memory_mb += 1,
            "build" => row.request.build_argv = Some(vec!["builder".into()]),
            "result_id" => row.result.execution_id = "unrelated".into(),
            "request_id" => row.request.execution_id = "unrelated".into(),
            _ => unreachable!(),
        }
        assert_eq!(
            assess(&p, &rows).unwrap().disposition,
            Disposition::Inconclusive,
            "{field}"
        );
    }
}
#[test]
fn missing_duplicate_cases_and_reused_execution_ids_fail_closed() {
    let p = FrozenPlan::new(plan()).unwrap();
    let rows = evidence(&p);
    assert_eq!(
        assess(&p, &rows[..3]).unwrap().disposition,
        Disposition::Inconclusive
    );
    let mut duplicate = rows.clone();
    duplicate[1] = duplicate[0].clone();
    assert_eq!(
        assess(&p, &duplicate).unwrap().disposition,
        Disposition::Inconclusive
    );
    let mut reused = rows;
    reused[1].request.execution_id = reused[0].request.execution_id.clone();
    reused[1].result.execution_id = reused[0].result.execution_id.clone();
    let r = assess(&p, &reused).unwrap();
    assert_eq!(r.disposition, Disposition::Inconclusive);
    assert!(r.reasons.contains(&Reason::ReusedExecutionIdentity));
}
#[test]
fn setup_and_truncation_never_count_as_successful_negative() {
    let p = FrozenPlan::new(plan()).unwrap();
    for kind in [
        "setup",
        "truncated",
        "over_cap",
        "not_created",
        "error",
        "missing_exit",
        "failed_zero",
    ] {
        let mut rows = evidence(&p);
        let r = &mut rows[0].result;
        match kind {
            "setup" => {
                r.status = ExecutionStatus::Failed;
                r.exit_code = None;
                r.error = Some("setup unavailable".into());
            }
            "truncated" => r.status = ExecutionStatus::OutputLimit,
            "over_cap" => r.stdout = vec![b'x'; 1025],
            "not_created" => r.cleanup = SandboxCleanup::NotCreated,
            "error" => r.error = Some("snapshot changed".into()),
            "missing_exit" => r.exit_code = None,
            "failed_zero" => r.status = ExecutionStatus::Failed,
            _ => unreachable!(),
        }
        assert_eq!(
            assess(&p, &rows).unwrap().disposition,
            Disposition::Inconclusive,
            "{kind}"
        );
    }
}
#[test]
fn expected_nonzero_exit_is_valid_observation_but_unexpected_stable_exit_is_negative() {
    let mut raw = plan();
    raw.cases[0].expected.exit_code = 7;
    let p = FrozenPlan::new(raw).unwrap();
    let mut rows = evidence(&p);
    for row in rows.iter_mut().filter(|r| r.case_id == "attack") {
        row.result.status = ExecutionStatus::Failed;
    }
    assert_eq!(
        assess(&p, &rows).unwrap().disposition,
        Disposition::ObservedForPlan
    );
    for row in rows.iter_mut().filter(|r| r.case_id == "attack") {
        row.result.exit_code = Some(9);
    }
    assert_eq!(
        assess(&p, &rows).unwrap().disposition,
        Disposition::NotObserved
    );
}
#[test]
fn cleanup_unknown_dominates_negative_and_cancelled() {
    let p = FrozenPlan::new(plan()).unwrap();
    let mut rows = evidence(&p);
    let r = &mut rows[0].result;
    r.status = ExecutionStatus::Cancelled;
    r.stdout = b"different".to_vec();
    r.cleanup = SandboxCleanup::Unconfirmed {
        recovery: SandboxRecovery::Docker {
            container_name: "owned".into(),
            snapshot_dir: None,
        },
    };
    assert_eq!(assess(&p, &rows).unwrap().disposition, Disposition::Unknown);
    rows[0].result.cleanup = SandboxCleanup::Unknown {
        reason: "worker panic".into(),
        recovery: None,
    };
    assert_eq!(assess(&p, &rows).unwrap().disposition, Disposition::Unknown);
}
#[test]
fn cancellation_before_image_resolution_and_incomplete_matrix_is_cancelled() {
    let p = FrozenPlan::new(plan()).unwrap();
    let mut rows = evidence(&p);
    rows.truncate(1);
    let r = &mut rows[0].result;
    r.status = ExecutionStatus::Cancelled;
    r.exit_code = None;
    r.cleanup = SandboxCleanup::NotCreated;
    r.stdout.clear();
    r.artifact = SandboxArtifact::Docker {
        image_reference: sha('d'),
        resolved_image_id: None,
    };
    assert_eq!(
        assess(&p, &rows).unwrap().disposition,
        Disposition::Cancelled
    );
}
#[test]
fn legitimate_control_failure_and_repeat_instability_are_inconclusive() {
    let p = FrozenPlan::new(plan()).unwrap();
    let mut rows = evidence(&p);
    for r in rows.iter_mut().filter(|r| r.case_id == "control") {
        r.result.stdout = b"broken legitimate behavior".to_vec();
    }
    assert_eq!(
        assess(&p, &rows).unwrap().disposition,
        Disposition::Inconclusive
    );
    let mut rows = evidence(&p);
    rows[0].result.stdout = b"changed one repeat".to_vec();
    let r = assess(&p, &rows).unwrap();
    assert_eq!(r.disposition, Disposition::Inconclusive);
    assert!(r.reasons.contains(&Reason::UnstableRepeatedOutput));
}
#[test]
fn strict_plan_bounds_safe_expectations_and_immutable_identity() {
    let raw = plan();
    let original = FrozenPlan::new(raw.clone()).unwrap();
    for kind in [
        "schema",
        "oracle",
        "repeats",
        "image",
        "duplicate",
        "same_safe",
        "control_safe",
        "expected_large",
        "no_attack",
    ] {
        let mut p = raw.clone();
        match kind {
            "schema" => p.schema_version = 2,
            "oracle" => p.oracle_version = "unknown".into(),
            "repeats" => p.repeats = 1,
            "image" => {
                p.backend = SandboxBackend::Docker {
                    image: "node:latest".into(),
                }
            }
            "duplicate" => p.cases[1].id = p.cases[0].id.clone(),
            "same_safe" => p.cases[0].safe_expected = Some(p.cases[0].expected.clone()),
            "control_safe" => p.cases[1].safe_expected = Some(output(b"new")),
            "expected_large" => p.cases[0].expected.stdout = vec![0; 1025],
            "no_attack" => {
                p.cases[0].mode = Mode::LegitimateControl;
                p.cases[0].safe_expected = None;
            }
            _ => unreachable!(),
        }
        assert!(FrozenPlan::new(p).is_err(), "{kind}");
    }
    let mut json = serde_json::to_value(&raw).unwrap();
    json["hostile_extra"] = true.into();
    assert!(FrozenPlan::parse(&serde_json::to_vec(&json).unwrap()).is_err());
    assert!(FrozenPlan::parse(&vec![b' '; MAX_PLAN_BYTES + 1]).is_err());
    let mut changed = raw;
    changed.cases[0].safe_expected = Some(output(b"different-safe"));
    assert_ne!(
        FrozenPlan::new(changed).unwrap().digest(),
        original.digest()
    );
}
#[test]
fn binary_stdout_and_stderr_remain_exact_and_microvm_is_backend_specific() {
    let mut raw = plan();
    raw.backend = SandboxBackend::Smolvm {
        image_archive: "/local/toolbox.tar".into(),
        archive_digest: sha('f'),
        storage_gb: 2,
    };
    raw.limits.cpus = 1.0;
    raw.cases[0].expected.stdout = vec![0, 255, 128];
    raw.cases[0].expected.stderr = vec![255];
    let p = FrozenPlan::parse(&serde_json::to_vec(&raw).unwrap()).unwrap();
    let mut rows = evidence(&p);
    assert_eq!(
        assess(&p, &rows).unwrap().disposition,
        Disposition::ObservedForPlan
    );
    rows[0].result.artifact = SandboxArtifact::SmolvmArchive { digest: sha('e') };
    assert_eq!(
        assess(&p, &rows).unwrap().disposition,
        Disposition::Inconclusive
    );
    raw.limits.cpus = 0.5;
    assert!(FrozenPlan::new(raw).is_err());
}

#[test]
fn real_executor_snapshot_manifest_is_accepted_and_drift_rejects() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("z.js"), "source fixture").unwrap();
    std::fs::write(dir.path().join("a.js"), "second fixture").unwrap();
    let snapshot = zero_executor::pin_snapshot(dir.path()).unwrap();
    let mut raw = plan();
    raw.snapshot = snapshot.clone();
    let frozen = FrozenPlan::new(raw.clone()).unwrap();
    assert_eq!(frozen.plan().snapshot.digest, snapshot.digest);
    assert_eq!(
        frozen
            .request("attack", 0, "request-1")
            .unwrap()
            .snapshot
            .root,
        snapshot.root
    );
    raw.snapshot.files[0].bytes += 1;
    assert!(FrozenPlan::new(raw).is_err());
}

#[test]
fn content_addressed_source_hypothesis_id_is_supported() {
    let mut raw = plan();
    raw.hypothesis_id = sha('a');
    assert!(FrozenPlan::new(raw).is_ok());
}

#[test]
fn reanchored_archive_preserves_original_authority_and_requires_its_own_exact_requests() {
    let source = tempfile::tempdir().unwrap();
    std::fs::write(
        source.path().join("source.js"),
        b"retained original source\n",
    )
    .unwrap();
    let mut original = plan();
    original.snapshot = zero_executor::pin_snapshot(source.path()).unwrap();
    original.snapshot.id = "original-host-source-id".into();
    let logical = FrozenPlan::new(original).unwrap();
    let archive =
        zero_executor::capture_source_archive(&logical.plan().snapshot, &|| Ok(())).unwrap();
    source.close().unwrap();
    let (stage, staged) = zero_executor::stage_source_archive(&archive, &|| Ok(())).unwrap();
    assert_ne!(staged.id, logical.plan().snapshot.id);
    let execution = logical.reanchor_snapshot(&staged).unwrap();
    assert_ne!(logical.digest(), execution.digest());
    assert_eq!(execution.plan().snapshot.id, "original-host-source-id");
    assert_eq!(
        execution.plan().snapshot.digest,
        logical.plan().snapshot.digest
    );
    let mut expected = logical.plan().clone();
    expected.snapshot.root = staged.root.clone();
    assert_eq!(
        serde_json::to_vec(execution.plan()).unwrap(),
        serde_json::to_vec(&expected).unwrap()
    );
    logical.validate_reanchored(&execution).unwrap();
    zero_executor::verify_snapshot(&execution.plan().snapshot, &|| Ok(())).unwrap();
    let rows = evidence(&execution);
    let measured = assess(&execution, &rows).unwrap();
    assert_eq!(measured.disposition, Disposition::ObservedForPlan);
    assert_eq!(measured.plan_digest, execution.digest());
    assert!(!measured.vulnerability_reportable);
    let wrong_location = assess(&logical, &rows).unwrap();
    assert_eq!(wrong_location.disposition, Disposition::Inconclusive);
    assert!(
        wrong_location
            .reasons
            .contains(&Reason::RequestIdentityMismatch)
    );
    stage.remove().unwrap();
    // Read-only re-assessment needs retained identities, never either live path.
    logical.validate_reanchored(&execution).unwrap();
    assert_eq!(
        assess(&execution, &rows).unwrap().assessment_digest,
        measured.assessment_digest
    );
}

#[test]
fn reanchoring_rejects_changed_file_bytes_digests_paths_order_membership_and_invalid_roots() {
    let mut original = plan();
    original.snapshot.files.push(SnapshotFile {
        path: "z.js".into(),
        digest: sha('e'),
        bytes: 2,
    });
    original.snapshot.digest = zero_executor::snapshot_digest(&original.snapshot.files).unwrap();
    let logical = FrozenPlan::new(original).unwrap();
    for mutation in 0..12 {
        let mut staged = logical.plan().snapshot.clone();
        staged.root = "/new-private/source".into();
        match mutation {
            0 => staged.digest = sha('f'),
            1 => staged.files[0].digest = sha('f'),
            2 => staged.files[0].bytes += 1,
            3 => staged.files[0].path = "other.js".into(),
            4 => staged.files.swap(0, 1),
            5 => {
                staged.files.pop();
            }
            6 => staged.files.push(SnapshotFile {
                path: "extra.js".into(),
                digest: sha('f'),
                bytes: 3,
            }),
            7 => staged.root = "relative/source".into(),
            8 => staged.root.clear(),
            9 => staged.root = "/source\0hidden".into(),
            10 => staged.root = "/source,mount-option".into(),
            _ => staged.root = format!("/{}", "x".repeat(MAX_PLAN_BYTES)),
        }
        assert!(
            logical.reanchor_snapshot(&staged).is_err(),
            "mutation {mutation}"
        );
    }
}

#[test]
fn retained_relocation_rejects_other_valid_plan_authority_and_expectation_changes() {
    let logical = FrozenPlan::new(plan()).unwrap();
    let mut staged = logical.plan().snapshot.clone();
    staged.root = "/new-private/source".into();
    let execution = logical.reanchor_snapshot(&staged).unwrap();
    for mutation in 0..18 {
        let mut changed = execution.plan().clone();
        match mutation {
            0 => changed.snapshot.id = "replacement-source-id".into(),
            1 => changed.hypothesis_id = "different-hypothesis".into(),
            2 => changed.source_bundle_digest = sha('f'),
            3 => changed.backend = SandboxBackend::Docker { image: sha('e') },
            4 => changed.limits.timeout_ms += 1,
            5 => changed.limits.memory_mb += 1,
            6 => changed.limits.cpus = 1.0,
            7 => changed.limits.max_output_bytes += 1,
            8 => changed.repeats += 1,
            9 => changed.cases[0].argv.push("changed-argument".into()),
            10 => changed.cases[0].stdin = Some("changed-input".into()),
            11 => changed.cases[0].expected.exit_code = 1,
            12 => changed.cases[0].expected.stdout.push(b'!'),
            13 => changed.cases[0].expected.stderr.push(b'!'),
            14 => changed.cases[0]
                .safe_expected
                .as_mut()
                .unwrap()
                .stdout
                .push(b'!'),
            15 => changed.cases[0].id = "changed-case".into(),
            16 => changed.cases.swap(0, 1),
            _ => {
                changed.cases[0].mode = Mode::LegitimateControl;
                changed.cases[0].safe_expected = None;
                changed.cases[1].mode = Mode::Attack;
            }
        }
        let changed = FrozenPlan::new(changed).unwrap();
        assert!(
            logical.validate_reanchored(&changed).is_err(),
            "mutation {mutation}"
        );
    }
}
