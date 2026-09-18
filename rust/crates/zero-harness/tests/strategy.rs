#![allow(clippy::unwrap_used)]
use serde_json::json;
use std::collections::BTreeMap;
use zero_evolution::{EvaluationDecision, EvaluationReceipt, Manifest, Registry};
use zero_harness::{Harness, HostGrants};
use zero_protocol::{
    strategy::{StrategyArtifact, StrategyReport},
    strategy_registry::*,
};
fn canonical(v: &impl serde::Serialize) -> Vec<u8> {
    serde_json::to_vec(&serde_json::to_value(v).unwrap()).unwrap()
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", zero_plugin::sha256(bytes))
}
fn authority() -> StrategyHostAuthority {
    serde_json::from_value(json!({"schema_version":1,"host":{"provider":"p","model":"m","instructions":"Fixed host instructions","max_turns":2,"reservation_per_turn":5,"max_hypotheses":2},"provider_context":{"p":{"endpoint":"http://localhost:9090/responses","wire_api":"responses","rates":{"input":1,"cached_input":1,"output":1}}},"http_profile_name":"runtime","http_policy":{"schema_version":1,"base_url":"http://localhost:8080/","in_scope":["localhost"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["GET","POST"],"allowed_headers":[],"limits":{"timeout_ms":1000,"max_request_body_bytes":100,"max_response_wire_bytes":100,"max_response_decoded_bytes":100,"max_request_header_bytes":1000,"max_request_headers":10,"max_response_header_bytes":1000,"max_response_headers":10,"max_dns_answers":8,"max_dns_cname_depth":4,"max_dns_queries":8},"rate":{"default":{"requests_per_interval":100,"interval_ms":1000,"burst":10},"per_host":{},"jitter_ms":0},"budget":{"max_requests":10,"max_request_body_bytes":1000,"max_response_decoded_bytes":1000}},"campaign_limits":{"model_micro_usd":100,"model_calls":20,"http_requests":10,"http_request_body_bytes":1000,"http_response_decoded_bytes":1000,"experiments":2,"runs":16,"max_parallel_runs":1},"accepted_suite_sha256":[digest(b"suite")],"minimum_development_gain":1,"minimum_final_gain":1,"canary_required":true})).unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    harness: Harness,
    grants: HostGrants,
    manifest: Manifest,
    generation: String,
}
impl Fixture {
    fn new() -> Self {
        Self::with_canary(true)
    }
    fn with_canary(canary: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut registry =
            Registry::open(dir.path().join("registry"), "v1", &json!({"retained":1})).unwrap();
        let engine = registry.put_artifact(b"engine").unwrap();
        let mut a = authority();
        a.canary_required = canary;
        let grants = HostGrants::with_strategy(BTreeMap::new(), a).unwrap();
        let policy = registry
            .put_artifact(&grants.artifact_bytes().unwrap())
            .unwrap();
        let advice = StrategyArtifact {
            schema_version: 1,
            advisory_utf8: "Inspect useful evidence".into(),
        };
        let artifact = registry.put_artifact(&canonical(&advice)).unwrap();
        let manifest = Manifest {
            engine_artifact: engine.clone(),
            components: BTreeMap::from([("strategy:advisory".into(), artifact)]),
            protocol_version: 1,
            state_schema: "v1".into(),
            compatible_state_schemas: vec![],
            configuration: strategy_configuration(),
            policy_artifact: policy,
        };
        let generation = registry.register_generation(&manifest).unwrap();
        assert!(
            registry
                .authorize_baseline(&generation, "generic shortcut")
                .is_err()
        );
        let harness = Harness::new(registry, engine);
        Self {
            dir,
            harness,
            grants,
            manifest,
            generation,
        }
    }
    fn open(&self) -> Registry {
        Registry::open(self.dir.path().join("registry"), "ignored", &json!({})).unwrap()
    }
    fn bootstrap(&mut self) -> StrategyBaselineInstallReceipt {
        self.harness
            .bootstrap_strategy(
                "install",
                &self.manifest,
                &self.grants,
                "host selected baseline",
            )
            .unwrap()
    }
}
#[test]
fn real_graph_bootstrap_capture_restart_candidate_and_generic_bypass() {
    let mut f = Fixture::new();
    assert!(f.harness.strategy_capture().is_err());
    let receipt = f.bootstrap();
    assert_eq!(receipt.activation_epoch, 1);
    assert_eq!(receipt.qualification, "trusted_unmeasured_baseline");
    let capture = f.harness.strategy_capture().unwrap();
    assert_eq!(capture.generation, f.generation);
    assert_eq!(capture.authority.http_profile_name, "runtime");
    let request = render_strategy_request(
        &capture.authority.host,
        &capture.advisory,
        "Operator task",
        "runtime",
        None,
    )
    .unwrap();
    assert!(request.instructions.contains("Inspect useful evidence"));
    assert!(request.instructions.starts_with("Fixed host instructions"));
    assert!(
        f.harness
            .bootstrap_strategy("install", &f.manifest, &f.grants, "changed reason")
            .is_err()
    );
    assert_eq!(f.bootstrap(), receipt);
    let candidate = f
        .harness
        .register_strategy_candidate(
            &f.generation,
            &StrategyArtifact {
                schema_version: 1,
                advisory_utf8: "Use controls too".into(),
            },
        )
        .unwrap();
    let binding = f
        .harness
        .strategy_binding(&candidate.candidate_generation)
        .unwrap();
    assert_eq!(binding.baseline_epoch, 1);
    let mut registry = f.open();
    let mut expected = f.manifest.clone();
    expected.components.insert(
        "strategy:advisory".into(),
        candidate.candidate_advisory_sha256.clone(),
    );
    assert_eq!(
        registry
            .generation(&candidate.candidate_generation)
            .unwrap(),
        expected
    );
    let evaluator = registry.put_artifact(b"self issued evaluator").unwrap();
    let evidence = registry.put_artifact(b"model says passed").unwrap();
    let fake = registry
        .record_evaluation(&EvaluationReceipt {
            candidate: candidate.candidate_generation.clone(),
            baseline: f.generation.clone(),
            evaluator_artifact: evaluator.clone(),
            policy_artifact: f.manifest.policy_artifact.clone(),
            evidence_artifacts: BTreeMap::from([("fake".into(), evidence)]),
            decision: EvaluationDecision::Eligible,
            observations: json!({"passed":true}),
        })
        .unwrap();
    assert!(
        registry
            .admit_eligibility(
                &candidate.candidate_generation,
                &fake,
                &f.generation,
                &evaluator,
                &f.manifest.policy_artifact
            )
            .is_err()
    );
    let mut reopened = Harness::new(registry, f.manifest.engine_artifact.clone());
    assert!(reopened.strategy_capture().is_err());
    assert_eq!(
        reopened.inspect_strategy_capture().unwrap().generation,
        f.generation
    );
    reopened.restore_current(&f.grants).unwrap();
    assert_eq!(
        reopened.strategy_capture().unwrap().advisory_sha256,
        capture.advisory_sha256
    );
}
#[test]
fn registry_identity_migration_preserves_state_and_missing_identity_fails_closed() {
    let f = Fixture::new();
    let before = f.open().current().unwrap();
    let conn = rusqlite_connection(&f);
    conn.execute_batch("DROP INDEX strategy_scope_suite;DROP TABLE strategy_bootstraps;DROP TABLE strategy_imports;DROP TABLE registry_identity;PRAGMA user_version=1;").unwrap();
    drop(conn);
    let legacy = Registry::open_read_only(f.dir.path().join("registry")).unwrap();
    assert_eq!(legacy.current().unwrap(), before);
    assert!(legacy.identity().is_err());
    drop(legacy);
    let migrated = f.open();
    assert_eq!(migrated.current().unwrap(), before);
    let id = migrated.identity().unwrap();
    drop(migrated);
    assert_eq!(f.open().identity().unwrap(), id);
    let conn = rusqlite_connection(&f);
    conn.execute("DELETE FROM registry_identity", []).unwrap();
    drop(conn);
    assert!(Registry::open(f.dir.path().join("registry"), "v1", &json!({})).is_err());
    assert!(Registry::open_read_only(f.dir.path().join("registry")).is_err());
}
fn rusqlite_connection(f: &Fixture) -> rusqlite::Connection {
    rusqlite::Connection::open(f.dir.path().join("registry")).unwrap()
}
fn import_fixture(
    f: &mut Fixture,
) -> (
    StrategyImportRequest,
    StrategyEvidenceDescriptor,
    BTreeMap<String, Vec<u8>>,
    StrategyReport,
) {
    f.bootstrap();
    let candidate = f
        .harness
        .register_strategy_candidate(
            &f.generation,
            &StrategyArtifact {
                schema_version: 1,
                advisory_utf8: "Check controls and corroborate claims".into(),
            },
        )
        .unwrap();
    let binding = f
        .harness
        .strategy_binding(&candidate.candidate_generation)
        .unwrap();
    // This unit test supplies the trusted host callback. Actual source/oracle proof is exercised by Engine's physical fixtures.
    let report:StrategyReport=serde_json::from_value(json!({"schema_version":1,"qualification":"qualification_only","campaign_id":"campaign","plan_sha256":digest(b"plan"),"baseline_sha256":binding.baseline_advisory_sha256,"candidate_sha256":binding.candidate_advisory_sha256,"evaluator_version":"local_web_marker_v1","renderer_version":"strategy_advisory_v1","suite_sha256":digest(b"suite"),"completed_lanes":["development","final"],"decision":"improved_for_fixture_suite","reasons":[],"case_results":[],"usage":{"model_reserved_micro_usd":0,"model_charged_micro_usd":10,"model_calls":2,"http_requests":2,"http_request_body_bytes":0,"http_response_reserved_bytes":0,"http_response_charged_bytes":10,"experiments":0,"runs":2,"active_runs":0,"unknown_runs":0},"evidence_sha256":digest(b"measured"),"report_sha256":digest(b"internal checksum")})).unwrap();
    let descriptor = StrategyEvidenceDescriptor {
        schema_version: 1,
        binding,
        campaign_id: "campaign".into(),
        snapshot_sha256: digest(b"trusted callback fixture snapshot"),
        report_sha256: digest(&canonical(&report)),
        suite_sha256: digest(b"suite"),
        pair_sha256: digest(b"pair"),
    };
    let root = digest(&canonical(&descriptor));
    let artifacts = BTreeMap::from([
        (root.clone(), canonical(&descriptor)),
        (
            descriptor.snapshot_sha256.clone(),
            b"trusted callback fixture snapshot".to_vec(),
        ),
        (descriptor.report_sha256.clone(), canonical(&report)),
    ]);
    (
        StrategyImportRequest {
            command_id: "import".into(),
            campaign_id: "campaign".into(),
            expected_evidence_sha256: root,
        },
        descriptor,
        artifacts,
        report,
    )
}
#[test]
fn import_is_atomic_idempotent_epoch_bound_and_evidence_cannot_be_deleted_before_activation() {
    let mut f = Fixture::with_canary(false);
    let (request, descriptor, artifacts, report) = import_fixture(&mut f);
    let mut registry = f.open();
    let before = registry.current().unwrap();
    let mut failed = false;
    let result = registry.import_strategy_evidence(&request, &descriptor, &artifacts, |read| {
        assert_eq!(
            read(&descriptor.snapshot_sha256)?,
            b"trusted callback fixture snapshot"
        );
        failed = true;
        Err(zero_evolution::Error::Invalid("verifier rejected".into()))
    });
    assert!(result.is_err());
    assert!(failed);
    assert!(
        registry
            .strategy_import_by_command(&request)
            .unwrap()
            .is_none()
    );
    assert!(
        registry
            .artifact(&request.expected_evidence_sha256)
            .is_err()
    );
    let conn = rusqlite_connection(&f);
    conn.execute_batch("CREATE TRIGGER import_fail BEFORE INSERT ON strategy_imports BEGIN SELECT RAISE(ABORT,'injected');END;").unwrap();
    assert!(
        registry
            .import_strategy_evidence(&request, &descriptor, &artifacts, |_| Ok(report.clone()))
            .is_err()
    );
    assert!(
        registry
            .artifact(&request.expected_evidence_sha256)
            .is_err()
    );
    conn.execute_batch("DROP TRIGGER import_fail;").unwrap();
    let imported = registry
        .import_strategy_evidence(&request, &descriptor, &artifacts, |_| Ok(report.clone()))
        .unwrap();
    assert!(!imported.duplicate);
    assert_eq!(imported.usability, StrategyEligibilityUsability::Current);
    assert_eq!(registry.current().unwrap(), before);
    let duplicate = registry
        .import_strategy_evidence(&request, &descriptor, &BTreeMap::new(), |_| {
            panic!("retry must not call evaluator")
        })
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.receipt, imported.receipt);
    let mut changed = request.clone();
    changed.campaign_id = "other".into();
    assert!(registry.strategy_import_by_command(&changed).is_err());
    let eligibility = imported.receipt.eligibility_sha256.clone();
    let preparation = registry
        .prepare_activation(
            &descriptor.binding.candidate_generation,
            &eligibility,
            &before,
            |m, s| {
                Ok(zero_evolution::PreparedState {
                    state_schema: m.state_schema.clone(),
                    state: s.state.clone(),
                })
            },
        )
        .unwrap();
    conn.execute(
        "DELETE FROM artifacts WHERE digest=?1",
        [&descriptor.snapshot_sha256],
    )
    .unwrap();
    assert!(registry.commit(&preparation.id).is_err());
    assert_eq!(registry.current().unwrap(), before);
    conn.execute(
        "INSERT INTO artifacts(digest,bytes) VALUES(?1,?2)",
        rusqlite::params![
            descriptor.snapshot_sha256,
            artifacts[&descriptor.snapshot_sha256]
        ],
    )
    .unwrap();
    let baseline_eligibility: String = conn
        .query_row(
            "SELECT eligibility_sha256 FROM strategy_bootstraps WHERE command_id='install'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let rollback = registry
        .prepare_rollback(&f.generation, &baseline_eligibility, &before, |m, s| {
            Ok(zero_evolution::PreparedState {
                state_schema: m.state_schema.clone(),
                state: s.state.clone(),
            })
        })
        .unwrap();
    registry.commit(&rollback.id).unwrap();
    let retry = registry
        .strategy_import_by_command(&request)
        .unwrap()
        .unwrap();
    assert_eq!(retry.usability, StrategyEligibilityUsability::StaleEpoch);
    assert!(
        registry
            .prepare_activation(
                &descriptor.binding.candidate_generation,
                &eligibility,
                &registry.current().unwrap(),
                |m, s| Ok(zero_evolution::PreparedState {
                    state_schema: m.state_schema.clone(),
                    state: s.state.clone()
                })
            )
            .is_err()
    );
}
#[test]
fn canary_requirement_is_not_fabricated_by_measured_import() {
    let mut f = Fixture::new();
    let (request, descriptor, artifacts, report) = import_fixture(&mut f);
    let mut registry = f.open();
    let result = registry
        .import_strategy_evidence(&request, &descriptor, &artifacts, |_| Ok(report))
        .unwrap();
    assert_eq!(
        result.usability,
        StrategyEligibilityUsability::MissingActivationPrerequisite
    );
    assert!(
        registry
            .prepare_activation(
                &descriptor.binding.candidate_generation,
                &result.receipt.eligibility_sha256,
                &registry.current().unwrap(),
                |m, s| Ok(zero_evolution::PreparedState {
                    state_schema: m.state_schema.clone(),
                    state: s.state.clone()
                })
            )
            .is_err()
    );
}

#[test]
fn protected_suite_cannot_qualify_another_pair_even_after_import_projection_deletion() {
    let mut f = Fixture::with_canary(false);
    let (request, descriptor, artifacts, report) = import_fixture(&mut f);
    let mut registry = f.open();
    registry
        .import_strategy_evidence(&request, &descriptor, &artifacts, |_| Ok(report.clone()))
        .unwrap();
    let candidate = f
        .harness
        .register_strategy_candidate(
            &f.generation,
            &StrategyArtifact {
                schema_version: 1,
                advisory_utf8: "Another candidate for the already exposed suite".into(),
            },
        )
        .unwrap();
    let mut second = descriptor.clone();
    second.binding = f
        .harness
        .strategy_binding(&candidate.candidate_generation)
        .unwrap();
    second.campaign_id = "another-source-campaign".into();
    second.pair_sha256 = digest(b"another pair");
    let mut second_report = report.clone();
    second_report.campaign_id = second.campaign_id.clone();
    second_report.candidate_sha256 = second.binding.candidate_advisory_sha256.clone();
    second.report_sha256 = digest(&canonical(&second_report));
    let root = digest(&canonical(&second));
    let second_artifacts = BTreeMap::from([
        (root.clone(), canonical(&second)),
        (second.report_sha256.clone(), canonical(&second_report)),
        (
            second.snapshot_sha256.clone(),
            artifacts[&second.snapshot_sha256].clone(),
        ),
    ]);
    let second_request = StrategyImportRequest {
        command_id: "another-import".into(),
        campaign_id: second.campaign_id.clone(),
        expected_evidence_sha256: root.clone(),
    };
    for remove_projection in [false, true] {
        if remove_projection {
            rusqlite_connection(&f)
                .execute(
                    "DELETE FROM strategy_imports WHERE command_id=?1",
                    [&request.command_id],
                )
                .unwrap();
        }
        let error = registry
            .import_strategy_evidence(&second_request, &second, &second_artifacts, |_| {
                panic!("exposed suite must reject before verifier")
            })
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("protected strategy suite already imported"),
            "{error}"
        );
        assert!(registry.artifact(&root).is_err());
    }
}

#[test]
fn registry_schema_rejects_extra_columns_even_when_object_count_matches() {
    let f = Fixture::new();
    rusqlite_connection(&f)
        .execute_batch("ALTER TABLE strategy_imports ADD COLUMN ignored TEXT;")
        .unwrap();
    assert!(Registry::open_read_only(f.dir.path().join("registry")).is_err());
    assert!(Registry::open(f.dir.path().join("registry"), "v1", &json!({})).is_err());
}

#[test]
fn guarded_strategy_binding_runs_only_for_exact_current_epoch() {
    let mut f = Fixture::new();
    f.bootstrap();
    let candidate = f
        .harness
        .register_strategy_candidate(
            &f.generation,
            &StrategyArtifact {
                schema_version: 1,
                advisory_utf8: "Candidate guard test".into(),
            },
        )
        .unwrap();
    let binding = f
        .harness
        .strategy_binding(&candidate.candidate_generation)
        .unwrap();
    let mut calls = 0;
    let value = f
        .harness
        .with_current_strategy_binding(&binding, || {
            calls += 1;
            Ok(42)
        })
        .unwrap();
    assert_eq!((value, calls), (42, 1));
    let mut stale = binding.clone();
    stale.baseline_epoch += 1;
    assert!(
        f.harness
            .with_current_strategy_binding(&stale, || {
                calls += 1;
                Ok(())
            })
            .is_err()
    );
    assert_eq!(calls, 1);
    assert!(
        f.harness
            .with_current_strategy_binding(&binding, || Err::<(), _>(
                zero_evolution::Error::Invalid("callback failed".into())
            ))
            .is_err()
    );
    assert_eq!(
        f.harness
            .strategy_binding(&candidate.candidate_generation)
            .unwrap(),
        binding
    );
}

#[test]
fn typed_full_search_import_checks_whole_account_and_retries_without_source() {
    use zero_protocol::strategy_search::{SearchFinalSelection, StrategySearchReport};
    let mut f = Fixture::with_canary(false);
    let (_, fixed, _, _) = import_fixture(&mut f);
    let binding = fixed.binding;
    let config = digest(b"search config");
    let selection:SearchFinalSelection=serde_json::from_value(json!({"schema_version":1,"id":"selection","campaign_id":"campaign","proposal_id":"selector","evaluation_id":"evaluation","candidate_generation":binding.candidate_generation,"candidate_sha256":binding.candidate_advisory_sha256,"baseline_sha256":binding.baseline_advisory_sha256,"config_sha256":config,"development_matrix_sha256":digest(b"dev matrix"),"binding":binding,"suite_sha256":digest(b"suite"),"final_pair_sha256":digest(b"final pair"),"schedule_start":8,"run_count":1,"exposure_id":"exposure","sequence":40})).unwrap();
    let case = json!({"schedule_index":0,"run_id":"trusted-host-case","session_id":"case-session","operation_id":null,"scenario_id":"positive","family":"p","lane":"development","variant":"candidate","repeat_index":0,"disposition":"observed","matched":true,"supported_findings":1,"unsupported_claims":0,"observations":[],"model_charged_micro_usd":1,"model_reserved_micro_usd":0,"error":null});
    // This tests installer mechanics behind the trusted callback boundary. Engine
    // physical tests provide the full independently reconstructed source matrix.
    let report:StrategySearchReport=serde_json::from_value(json!({"schema_version":2,"campaign_id":"campaign","config_sha256":config,"qualification":"adaptive_search_fixture","proposals":[],"evaluations":[{"evaluation":{"id":"evaluation","campaign_id":"campaign","command_id":"pair","proposal_id":"proposal","candidate_generation":binding.candidate_generation,"candidate_sha256":binding.candidate_advisory_sha256,"baseline_sha256":binding.baseline_advisory_sha256,"evaluation_pair_sha256":digest(b"dev pair"),"config_sha256":config,"schedule_start":0,"run_count":1,"sequence":10},"cases":[case],"improved":true,"reasons":[]}],"usage":{"model_reserved_micro_usd":0,"model_charged_micro_usd":2,"model_calls":2,"http_requests":2,"http_request_body_bytes":0,"http_response_reserved_bytes":0,"http_response_charged_bytes":10,"experiments":0,"runs":2,"active_runs":0,"unknown_runs":0},"stop_reason":"model_selected_final","report_sha256":digest(b"internal checksum"),"selection":selection,"final_measurement":{"cases":[case],"decision":"improved_for_fixture_suite","reasons":[],"matrix_sha256":digest(b"final matrix")}})).unwrap();
    let descriptor = StrategySearchEvidenceDescriptor {
        schema_version: 2,
        binding,
        campaign_id: "campaign".into(),
        snapshot_sha256: digest(b"trusted snapshot"),
        report_sha256: digest(&canonical(&report)),
        suite_sha256: digest(b"suite"),
        pair_sha256: digest(b"final pair"),
        config_sha256: config,
        selection_sha256: digest(&canonical(&selection)),
    };
    let artifacts_for = |d: &StrategySearchEvidenceDescriptor, r: &StrategySearchReport| {
        BTreeMap::from([
            (digest(&canonical(d)), canonical(d)),
            (d.report_sha256.clone(), canonical(r)),
            (d.snapshot_sha256.clone(), b"trusted snapshot".to_vec()),
        ])
    };
    let request_for = |d: &StrategySearchEvidenceDescriptor| StrategyImportRequest {
        command_id: "import-search".into(),
        campaign_id: "campaign".into(),
        expected_evidence_sha256: digest(&canonical(d)),
    };
    let mut registry = f.open();
    let mut unresolved = report.clone();
    unresolved.usage.unknown_runs = 1;
    let mut bad = descriptor.clone();
    bad.report_sha256 = digest(&canonical(&unresolved));
    assert!(
        registry
            .import_strategy_search_evidence(
                &request_for(&bad),
                &bad,
                &artifacts_for(&bad, &unresolved),
                |_| Ok(unresolved)
            )
            .is_err()
    );
    let request = request_for(&descriptor);
    let imported = registry
        .import_strategy_search_evidence(
            &request,
            &descriptor,
            &artifacts_for(&descriptor, &report),
            |_| Ok(report),
        )
        .unwrap();
    assert_eq!(
        imported.receipt.qualification,
        "measured_adaptive_search_fixture"
    );
    let again = registry
        .import_strategy_search_evidence(&request, &descriptor, &BTreeMap::new(), |_| {
            panic!("exact retry must not request source")
        })
        .unwrap();
    assert!(again.duplicate);
    assert_eq!(again.receipt, imported.receipt);
    assert_eq!(
        registry
            .strategy_import_receipt(&imported.receipt_sha256)
            .unwrap()
            .receipt,
        imported.receipt
    );
    assert_eq!(registry.current().unwrap().generation, Some(f.generation));
}
