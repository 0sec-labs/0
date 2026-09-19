#![cfg(target_os = "linux")]
#[path = "support/python_fixture.rs"]
mod fixture;
use fixture::*;
use tokio_util::sync::CancellationToken;
use zero_evaluation::{PythonEvolutionInspection, PythonProposal};
#[tokio::test]
async fn actual_python_code_improves_independent_fixtures_without_production_mutation() {
    let mut f = Fixture::new();
    let before = f.source.current().unwrap();
    let mut proposal = PythonProposal::create(
        &f.root(),
        &f.source,
        f.plan.clone(),
        &f.grants,
        f.context.clone(),
    )
    .unwrap();
    let request = proposal.request();
    let text = serde_json::to_string(&request).unwrap();
    assert!(text.contains("public-development"));
    assert!(!text.contains("HELDOUT_PRIVATE_SENTINEL"));
    assert!(!text.contains("NEGATIVE_PRIVATE_SENTINEL"));
    proposal.begin_proposal().unwrap();
    let op = f.infer(&request, CANDIDATE);
    let claim = proposal.record_inference(&op).unwrap().unwrap();
    let exposure = f
        .store
        .claim_python_holdout("fixture-owner", &claim)
        .unwrap();
    let report = proposal
        .evaluate(exposure, &f.grants, &f.runner, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        report.decision,
        zero_evolution::EvaluationDecision::Eligible,
        "{:?}",
        report.reasons
    );
    assert_eq!(report.attempted, 12);
    assert_eq!(report.settled, 12);
    let inspection = PythonProposal::inspect(&f.root()).unwrap();
    assert_eq!(inspection.phase, "completed");
    assert_eq!(
        inspection.source_sha256.as_deref(),
        Some(zero_evaluation::digest(CANDIDATE.as_bytes()).as_str())
    );
    let snapshot = std::fs::read_to_string(f.dir.path().join("snapshots.jsonl")).unwrap();
    assert!(!snapshot.contains("proposal.sqlite"));
    assert!(!snapshot.contains("evaluation.sqlite"));
    assert!(!snapshot.contains("state.sqlite"));
    assert_eq!(before, f.source.current().unwrap());
    assert!(
        f.source
            .generation(inspection.candidate.as_ref().unwrap())
            .is_err()
    );
    let calls = std::fs::read(f.dir.path().join("calls.jsonl")).unwrap();
    assert!(proposal.begin_proposal().is_err());
    PythonProposal::check_retry(&f.root(), &f.plan, &f.context, &f.grants).unwrap();
    assert_eq!(
        calls,
        std::fs::read(f.dir.path().join("calls.jsonl")).unwrap()
    );
}
#[tokio::test]
async fn development_only_cheating_cannot_pass_the_host_holdout() {
    let mut f = Fixture::new();
    let mut proposal = PythonProposal::create(
        &f.root(),
        &f.source,
        f.plan.clone(),
        &f.grants,
        f.context.clone(),
    )
    .unwrap();
    proposal.begin_proposal().unwrap();
    let op = f.infer(&proposal.request(), CHEAT);
    let claim = proposal.record_inference(&op).unwrap().unwrap();
    let exposure = f
        .store
        .claim_python_holdout("fixture-owner", &claim)
        .unwrap();
    let report = proposal
        .evaluate(exposure, &f.grants, &f.runner, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        report.decision,
        zero_evolution::EvaluationDecision::Rejected
    );
}
#[test]
fn protected_identity_ignores_labels_order_development_and_candidate_choices() {
    let f = Fixture::new();
    let identity = f.plan.suite_sha256().unwrap();
    let mut changed = f.plan.clone();
    changed.cases.reverse();
    for case in &mut changed.cases {
        case.id.push_str("-renamed");
        if case.lane == zero_evaluation::Lane::Development {
            case.expected = serde_json::json!({"answer":999});
        }
    }
    changed.scoring.minimum_development_gain = 0;
    changed.baseline = zero_evaluation::digest(b"other baseline");
    assert_eq!(changed.suite_sha256().unwrap(), identity);
    changed
        .cases
        .iter_mut()
        .find(|c| c.lane == zero_evaluation::Lane::HeldOut)
        .unwrap()
        .expected = serde_json::json!({"answer":999});
    assert_ne!(changed.suite_sha256().unwrap(), identity);
}
#[test]
fn interrupted_proposal_is_inspected_without_replay_and_host_intent_is_frozen() {
    let f = Fixture::new();
    let proposal = PythonProposal::create(
        &f.root(),
        &f.source,
        f.plan.clone(),
        &f.grants,
        f.context.clone(),
    )
    .unwrap();
    proposal.begin_proposal().unwrap();
    drop(proposal);
    let report: PythonEvolutionInspection = PythonProposal::inspect(&f.root()).unwrap();
    assert_eq!(report.phase, "proposal_running");
    assert!(report.operation_id.is_none());
    let mut changed = f.plan.clone();
    changed.objective.push_str("different");
    assert!(PythonProposal::check_retry(&f.root(), &changed, &f.context, &f.grants).is_err());
    assert!(!f.dir.path().join("calls.jsonl").exists());
    assert!(
        PythonProposal::create(
            &f.root(),
            &f.source,
            f.plan.clone(),
            &f.grants,
            f.context.clone()
        )
        .is_err()
    );
}
#[test]
fn model_cannot_change_manifest_or_self_certify() {
    let mut f = Fixture::new();
    let mut proposal = PythonProposal::create(
        &f.root(),
        &f.source,
        f.plan.clone(),
        &f.grants,
        f.context.clone(),
    )
    .unwrap();
    proposal.begin_proposal().unwrap();
    let mut operation = f.infer(&proposal.request(), CANDIDATE);
    operation.outcome.as_mut().unwrap()["content"][0]["arguments"]["eligible"] =
        serde_json::json!(true);
    assert!(proposal.record_inference(&operation).is_err());
    assert!(!f.dir.path().join("calls.jsonl").exists());
}
#[tokio::test]
#[ignore = "requires explicitly selected existing local Python Docker image; never pulls"]
async fn real_local_docker_python_code_qualification() {
    let image = std::env::var("ZERO_PYTHON_EVOLUTION_DOCKER_IMAGE")
        .expect("select existing immutable local image digest");
    let mut f = Fixture::new();
    f.plan.launch.backend = zero_protocol::sandbox::SandboxBackend::Docker { image };
    f.plan.launch.timeout_ms = 5000;
    let mut proposal = PythonProposal::create(
        &f.root(),
        &f.source,
        f.plan.clone(),
        &f.grants,
        f.context.clone(),
    )
    .unwrap();
    proposal.begin_proposal().unwrap();
    let op = f.infer(&proposal.request(), CANDIDATE);
    let claim = proposal.record_inference(&op).unwrap().unwrap();
    let exposure = f
        .store
        .claim_python_holdout("fixture-owner", &claim)
        .unwrap();
    let runner = zero_plugin_runner::Runner::new(zero_sandbox::SandboxExecutor::with_backends(
        zero_executor::DockerExecutor::default(),
        zero_smolvm::SmolvmConfig::default(),
    ));
    let report = proposal
        .evaluate(exposure, &f.grants, &runner, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        report.decision,
        zero_evolution::EvaluationDecision::Eligible,
        "{:?}",
        report.reasons
    );
    assert_eq!(report.settled, 12);
}

#[test]
fn forged_model_stop_requires_retained_stop_and_no_candidate() {
    for retained in [false, true] {
        let mut f = Fixture::new();
        let mut p = PythonProposal::create(
            &f.root(),
            &f.source,
            f.plan.clone(),
            &f.grants,
            f.context.clone(),
        )
        .unwrap();
        if retained {
            p.begin_proposal().unwrap();
            let op = f.infer(&p.request(), CANDIDATE);
            p.record_inference(&op).unwrap();
        }
        p.finish("model_stop").unwrap();
        assert!(PythonProposal::inspect(&f.root()).is_err());
    }
}
#[tokio::test]
async fn public_evaluate_enforces_deadline_and_joins_guest_cleanup() {
    let mut f = Fixture::new();
    f.plan.expires_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 800;
    f.plan.launch.timeout_ms = 15000;
    std::fs::write(f.dir.path().join("scenario.txt"), "cancel").unwrap();
    let mut p = PythonProposal::create(
        &f.root(),
        &f.source,
        f.plan.clone(),
        &f.grants,
        f.context.clone(),
    )
    .unwrap();
    p.begin_proposal().unwrap();
    let op = f.infer(&p.request(), CANDIDATE);
    let claim = p.record_inference(&op).unwrap().unwrap();
    let witness = f
        .store
        .claim_python_holdout("fixture-owner", &claim)
        .unwrap();
    let start = std::time::Instant::now();
    let report = p
        .evaluate(witness, &f.grants, &f.runner, CancellationToken::new())
        .await
        .unwrap();
    assert!(start.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(
        report.decision,
        zero_evolution::EvaluationDecision::Inconclusive
    );
    assert_eq!(
        PythonProposal::inspect(&f.root()).unwrap().phase,
        "deadline"
    );
    assert!(!f.dir.path().join("container.json").exists());
}

#[test]
fn copied_controller_and_recreated_root_cannot_reuse_captured_identity() {
    let f = Fixture::new();
    let p = PythonProposal::create(
        &f.root(),
        &f.source,
        f.plan.clone(),
        &f.grants,
        f.context.clone(),
    )
    .unwrap();
    let request = serde_json::to_vec(&p.request()).unwrap();
    drop(p);
    let moved = f.dir.path().join("moved");
    std::fs::rename(f.root(), &moved).unwrap();
    assert!(PythonProposal::inspect(&moved).is_err());
    let p = PythonProposal::create(
        &f.root(),
        &f.source,
        f.plan.clone(),
        &f.grants,
        f.context.clone(),
    )
    .unwrap();
    assert_ne!(request, serde_json::to_vec(&p.request()).unwrap());
}
