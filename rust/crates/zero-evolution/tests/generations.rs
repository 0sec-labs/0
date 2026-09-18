use serde_json::{Value, json};
use std::collections::BTreeMap;
use zero_evolution::*;

fn open(path: &std::path::Path) -> Registry {
    Registry::open(path, "v1", &json!({"counter":0})).unwrap()
}
fn generation(reg: &mut Registry, label: &str, schema: &str, compatible: &[&str]) -> String {
    let engine = reg.put_artifact(label.as_bytes()).unwrap();
    let policy = reg.put_artifact(b"fixed-policy").unwrap();
    reg.register_generation(&Manifest {
        engine_artifact: engine,
        components: BTreeMap::new(),
        protocol_version: 1,
        state_schema: schema.into(),
        compatible_state_schemas: compatible.iter().map(|s| s.to_string()).collect(),
        configuration: json!({"label":label}),
        policy_artifact: policy,
    })
    .unwrap()
}
fn evaluated(reg: &mut Registry, candidate: &str, baseline: &str) -> (String, String) {
    let evaluator = reg.put_artifact(b"trusted-evaluator-build").unwrap();
    let evidence = reg.put_artifact(b"retained-results").unwrap();
    let policy = reg.generation(candidate).unwrap().policy_artifact;
    let receipt = reg
        .record_evaluation(&EvaluationReceipt {
            candidate: candidate.into(),
            baseline: baseline.into(),
            evaluator_artifact: evaluator.clone(),
            policy_artifact: policy.clone(),
            evidence_artifacts: BTreeMap::from([("results".into(), evidence)]),
            decision: EvaluationDecision::Eligible,
            observations: json!({"caller_report":"accepted"}),
        })
        .unwrap();
    let eligibility = reg
        .admit_eligibility(candidate, &receipt, baseline, &evaluator, &policy)
        .unwrap();
    (eligibility, receipt)
}
fn copy_state(
    manifest: &Manifest,
    current: &RuntimeState,
) -> std::result::Result<PreparedState, String> {
    Ok(PreparedState {
        state_schema: manifest.state_schema.clone(),
        state: current.state.clone(),
    })
}
fn bootstrap(reg: &mut Registry, name: &str, compatible: &[&str]) -> (String, String) {
    let id = generation(reg, name, "v1", compatible);
    let eligible = reg
        .authorize_baseline(&id, "operator-approved baseline, unmeasured")
        .unwrap();
    let state = reg.current().unwrap();
    let prepared = reg
        .prepare_activation(&id, &eligible, &state, copy_state)
        .unwrap();
    reg.commit(&prepared.id).unwrap();
    (id, eligible)
}

#[test]
fn restart_preserves_artifacts_receipts_eligibility_and_live_leases() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("registry.sqlite");
    let mut reg = open(&path);
    let (baseline, _) = bootstrap(&mut reg, "baseline", &[]);
    let lease = reg.acquire_active("worker").unwrap();
    let candidate = generation(&mut reg, "candidate", "v1", &[]);
    let (eligible, receipt) = evaluated(&mut reg, &candidate, &baseline);
    let original_receipt = reg.evaluation(&receipt).unwrap();
    let old = reg.current().unwrap();
    let prep = reg
        .prepare_activation(&candidate, &eligible, &old, copy_state)
        .unwrap();
    reg.commit(&prep.id).unwrap();
    assert_eq!(
        reg.lifecycle(&baseline).unwrap(),
        RuntimeLifecycle::Draining { leases: 1 }
    );
    drop(reg);
    let mut reg = Registry::open(&path, "ignored", &json!({"wrong":true})).unwrap();
    assert_eq!(reg.current().unwrap().generation, Some(candidate));
    assert_eq!(reg.current().unwrap().state, json!({"counter":0}));
    assert_eq!(reg.evaluation(&receipt).unwrap(), original_receipt);
    assert_eq!(
        reg.lifecycle(&baseline).unwrap(),
        RuntimeLifecycle::Draining { leases: 1 }
    );
    assert!(reg.release(&lease.id, "wrong").is_err());
    reg.release(&lease.id, "worker").unwrap();
    reg.release(&lease.id, "worker").unwrap();
    assert_eq!(
        reg.lifecycle(&baseline).unwrap(),
        RuntimeLifecycle::Inactive
    );
}
#[test]
fn failed_prepare_keeps_current_and_restart_cannot_commit_dead_readiness() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("registry.sqlite");
    let mut reg = open(&path);
    let (base, _) = bootstrap(&mut reg, "base", &[]);
    let candidate = generation(&mut reg, "next", "v2", &[]);
    let (eligible, _) = evaluated(&mut reg, &candidate, &base);
    let old = reg.current().unwrap();
    assert!(matches!(
        reg.prepare_activation(&candidate, &eligible, &old, |_, _| Err(
            "migration failed".into()
        )),
        Err(Error::Preparation(_))
    ));
    assert_eq!(reg.current().unwrap(), old);
    let prep = reg
        .prepare_activation(&candidate, &eligible, &old, |m, s| {
            let mut state = s.state.clone();
            state["counter"] = json!(1);
            Ok(PreparedState {
                state_schema: m.state_schema.clone(),
                state,
            })
        })
        .unwrap();
    assert_eq!(reg.current().unwrap(), old);
    drop(reg);
    let mut reg = open(&path);
    assert!(matches!(reg.commit(&prep.id), Err(Error::Conflict(_))));
    assert_eq!(reg.current().unwrap(), old);
}
#[test]
fn concurrent_activation_is_single_compare_and_swap() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("registry.sqlite");
    let mut reg = open(&path);
    let (base, _) = bootstrap(&mut reg, "base", &[]);
    let c1 = generation(&mut reg, "c1", "v1", &[]);
    let c2 = generation(&mut reg, "c2", "v1", &[]);
    let e1 = evaluated(&mut reg, &c1, &base).0;
    let e2 = evaluated(&mut reg, &c2, &base).0;
    let old = reg.current().unwrap();
    drop(reg);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let tasks: Vec<_> = [(c1, e1), (c2, e2)]
        .into_iter()
        .map(|(c, e)| {
            let path = path.clone();
            let barrier = barrier.clone();
            let old = old.clone();
            std::thread::spawn(move || {
                let mut reg = open(&path);
                let prepared = reg.prepare_activation(&c, &e, &old, copy_state).unwrap();
                barrier.wait();
                reg.commit(&prepared.id)
            })
        })
        .collect();
    let results: Vec<_> = tasks.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(Error::Conflict(_))))
            .count(),
        1
    );
    assert_eq!(open(&path).current().unwrap().epoch, 2);
}
#[test]
fn rollback_migrates_current_state_without_relabelling_old_evaluation() {
    let mut reg = Registry::open(":memory:", "v1", &json!({"counter":0})).unwrap();
    let (base, base_eligible) = bootstrap(&mut reg, "base", &["v2"]);
    let candidate = generation(&mut reg, "next", "v2", &[]);
    let (eligible, receipt) = evaluated(&mut reg, &candidate, &base);
    let receipt_before = reg.evaluation(&receipt).unwrap();
    let old = reg.current().unwrap();
    let p = reg
        .prepare_activation(&candidate, &eligible, &old, |m, _| {
            Ok(PreparedState {
                state_schema: m.state_schema.clone(),
                state: json!({"counter":42}),
            })
        })
        .unwrap();
    reg.commit(&p.id).unwrap();
    let current = reg.current().unwrap();
    let p = reg
        .prepare_rollback(&base, &base_eligible, &current, |m, s| {
            assert_eq!(s.state["counter"], 42);
            copy_state(m, s)
        })
        .unwrap();
    let restored = reg.commit(&p.id).unwrap();
    assert_eq!(restored.generation, Some(base));
    assert_eq!(restored.state, json!({"counter":42}));
    assert_eq!(restored.epoch, 3);
    assert_eq!(reg.evaluation(&receipt).unwrap(), receipt_before);
}
#[test]
fn bootstrap_and_evaluation_identity_cannot_bypass_eligibility() {
    let mut reg = Registry::open(":memory:", "v1", &json!(null)).unwrap();
    let extra = generation(&mut reg, "extra", "v1", &[]);
    let extra_permission = reg.authorize_baseline(&extra, "initial only").unwrap();
    let (base, base_permission) = bootstrap(&mut reg, "base", &[]);
    assert!(reg.authorize_baseline(&extra, "late bypass").is_err());
    let now = reg.current().unwrap();
    assert!(
        reg.prepare_activation(&extra, &extra_permission, &now, copy_state)
            .is_err()
    );
    assert!(
        reg.prepare_rollback(&extra, &extra_permission, &now, copy_state)
            .is_err()
    );
    let candidate = generation(&mut reg, "new", "v2", &[]);
    let (eligible, receipt) = evaluated(&mut reg, &candidate, &base);
    let report = reg.evaluation(&receipt).unwrap();
    assert!(
        reg.admit_eligibility(
            &candidate,
            &receipt,
            &base,
            "wrong-evaluator",
            &report.policy_artifact
        )
        .is_err()
    );
    let p = reg
        .prepare_activation(&candidate, &eligible, &now, copy_state)
        .unwrap();
    reg.commit(&p.id).unwrap();
    let now = reg.current().unwrap();
    assert!(
        reg.prepare_rollback(&base, &base_permission, &now, copy_state)
            .is_err()
    );
}
#[test]
fn json_bounds_and_foreign_databases_are_rejected() {
    let mut reg = Registry::open(":memory:", "v1", &json!(null)).unwrap();
    assert!(reg.put_artifact(&[]).is_err());
    let digest = reg.put_artifact(b"bytes").unwrap();
    assert_eq!(reg.put_artifact(b"bytes").unwrap(), digest);
    assert_eq!(reg.artifact(&digest).unwrap(), b"bytes");
    let huge = Value::String("x".repeat(MAX_JSON_BYTES));
    assert!(Registry::open(":memory:", "v1", &huge).is_err());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("foreign.sqlite");
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch("CREATE TABLE old(id TEXT)").unwrap();
    drop(c);
    assert!(Registry::open(path, "v1", &json!(null)).is_err());
}
