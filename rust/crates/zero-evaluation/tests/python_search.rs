#![cfg(target_os = "linux")]
#[path = "support/python_fixture.rs"]
mod fixture;
use fixture::*;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use zero_evaluation::{PythonSearch, PythonSearchPlan, SearchStep};
fn plan(f: &Fixture) -> PythonSearchPlan {
    PythonSearchPlan {
        schema_version: 1,
        proposal: f.plan.clone(),
        max_rounds: 4,
        max_proposal_spend: 40,
        max_development_attempts: 8,
    }
}
fn record(
    f: &mut Fixture,
    s: &mut PythonSearch,
    name: &str,
    args: serde_json::Value,
    charge: u64,
) -> Result<SearchStep, zero_evaluation::Error> {
    let (command, request) = s.next_request()?.unwrap();
    let text = serde_json::to_string(&request).unwrap();
    assert!(!text.contains("HELDOUT_PRIVATE_SENTINEL"));
    assert!(!text.contains("NEGATIVE_PRIVATE_SENTINEL"));
    let op = f.infer_tool(&request, &command, name, args, charge);
    let sha = zero_evaluation::digest(
        &serde_json::to_vec(&serde_json::to_value(&request).unwrap()).unwrap(),
    );
    let witness = f
        .store
        .verify_python_search_inference(
            "fixture-owner",
            &f.context.session_id,
            &command,
            &op.id,
            &sha,
        )
        .unwrap();
    s.record_inference(witness)
}
async fn experiment(f: &mut Fixture, s: &mut PythonSearch, source: &str) {
    let step = record(
        f,
        s,
        "experiment_python_candidate",
        json!({"source_utf8":source,"rationale":"test hypothesis"}),
        3,
    )
    .unwrap();
    let SearchStep::Experiment { round } = step else {
        panic!("experiment expected")
    };
    let report = s
        .experiment(round, &f.grants, &f.runner, CancellationToken::new())
        .await
        .unwrap();
    assert!(report.completed);
    assert_eq!(report.settled, 2);
}
#[tokio::test]
async fn iterative_development_feedback_then_one_private_selection() {
    let mut f = Fixture::new();
    let before = f.source.current().unwrap();
    let root = f.dir.path().join("search");
    let mut s =
        PythonSearch::create(&root, &f.source, plan(&f), &f.grants, f.context.clone()).unwrap();
    experiment(&mut f, &mut s, CHEAT).await;
    experiment(&mut f, &mut s, CANDIDATE).await;
    let step = record(
        &mut f,
        &mut s,
        "submit_python_candidate",
        json!({"action":"propose","source_utf8":CANDIDATE,"rationale":"select measured source"}),
        3,
    )
    .unwrap();
    let SearchStep::Selected { claim } = step else {
        panic!("selection expected")
    };
    let witness = f
        .store
        .claim_python_holdout("fixture-owner", &claim)
        .unwrap();
    let report = s
        .evaluate(witness, &f.grants, &f.runner, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        report.decision,
        zero_evolution::EvaluationDecision::Eligible
    );
    assert!(s.next_request().is_err());
    drop(s);
    let report = PythonSearch::inspect(&root).unwrap();
    assert_eq!(report.phase, "completed");
    assert_eq!(report.rounds, 3);
    assert_eq!(report.charged, 9);
    assert_eq!(report.feedback.len(), 2);
    assert_eq!(report.development_attempts, 4);
    assert_eq!(f.source.current().unwrap(), before);
    PythonSearch::check_retry(&root, &plan(&f), &f.context, &f.grants).unwrap();
}
#[tokio::test]
async fn unmeasured_selection_and_final_charge_overrun_cannot_consume_holdout() {
    for overrun in [false, true] {
        let mut f = Fixture::new();
        let root = f.dir.path().join("search");
        let mut p = plan(&f);
        p.max_proposal_spend = 13;
        let mut s =
            PythonSearch::create(&root, &f.source, p, &f.grants, f.context.clone()).unwrap();
        if overrun {
            experiment(&mut f, &mut s, CANDIDATE).await;
        }
        assert!(
            record(
                &mut f,
                &mut s,
                "submit_python_candidate",
                json!({"action":"propose","source_utf8":CANDIDATE,"rationale":"select"}),
                if overrun { 11 } else { 3 }
            )
            .is_err()
        );
        if overrun {
            assert_eq!(s.phase().unwrap(), "budget_limit");
        }
        assert!(!root.join("evaluation").exists());
        let events = f.store.events(&f.context.session_id, 0, 1000).unwrap();
        assert!(!events.iter().any(|e| e.kind == "python_holdout_exposed"));
    }
}
#[tokio::test]
async fn stop_keeps_holdout_private_and_cap_prevents_another_provider_admission() {
    let mut f = Fixture::new();
    let root = f.dir.path().join("search");
    let mut s =
        PythonSearch::create(&root, &f.source, plan(&f), &f.grants, f.context.clone()).unwrap();
    experiment(&mut f, &mut s, CANDIDATE).await;
    assert!(matches!(
        record(
            &mut f,
            &mut s,
            "submit_python_candidate",
            json!({"action":"stop","reason":"enough public evidence; no selection"}),
            3
        )
        .unwrap(),
        SearchStep::Stop
    ));
    assert_eq!(PythonSearch::inspect(&root).unwrap().phase, "stopped");
    assert!(!root.join("evaluation").exists());
    assert!(s.next_request().is_err());
    let mut f = Fixture::new();
    let root = f.dir.path().join("search");
    let mut p = plan(&f);
    p.max_proposal_spend = 10;
    let mut s = PythonSearch::create(&root, &f.source, p, &f.grants, f.context.clone()).unwrap();
    experiment(&mut f, &mut s, CANDIDATE).await;
    assert!(s.next_request().unwrap().is_none());
    assert_eq!(s.phase().unwrap(), "budget_limit");
}
#[tokio::test]
async fn development_deadline_joins_and_forbids_further_calls() {
    let mut f = Fixture::new();
    let root = f.dir.path().join("search");
    let mut p = plan(&f);
    p.proposal.expires_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 1000;
    p.proposal.launch.timeout_ms = 15000;
    std::fs::write(f.dir.path().join("scenario.txt"), "cancel").unwrap();
    let mut s = PythonSearch::create(&root, &f.source, p, &f.grants, f.context.clone()).unwrap();
    let SearchStep::Experiment { round } = record(
        &mut f,
        &mut s,
        "experiment_python_candidate",
        json!({"source_utf8":CANDIDATE,"rationale":"test"}),
        3,
    )
    .unwrap() else {
        panic!()
    };
    let report = s
        .experiment(round, &f.grants, &f.runner, CancellationToken::new())
        .await
        .unwrap();
    assert!(!report.completed);
    assert_eq!(s.phase().unwrap(), "deadline");
    assert!(s.next_request().is_err());
    assert!(!f.dir.path().join("container.json").exists());
    assert_eq!(PythonSearch::inspect(&root).unwrap().phase, "deadline");
}

#[tokio::test]
async fn public_success_does_not_self_certify_private_eligibility_or_allow_more_search() {
    let mut f = Fixture::new();
    let root = f.dir.path().join("search");
    let mut search =
        PythonSearch::create(&root, &f.source, plan(&f), &f.grants, f.context.clone()).unwrap();
    experiment(&mut f, &mut search, CHEAT).await;
    let SearchStep::Selected { claim } = record(
        &mut f,
        &mut search,
        "submit_python_candidate",
        json!({"action":"propose","source_utf8":CHEAT,"rationale":"public cases passed"}),
        3,
    )
    .unwrap() else {
        panic!()
    };
    let witness = f
        .store
        .claim_python_holdout("fixture-owner", &claim)
        .unwrap();
    let report = search
        .evaluate(witness, &f.grants, &f.runner, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        report.decision,
        zero_evolution::EvaluationDecision::Rejected
    );
    assert!(search.next_request().is_err());
    assert_eq!(PythonSearch::inspect(&root).unwrap().rounds, 2);
}

#[test]
fn inspection_reconstructs_entire_frozen_request_not_only_history_hashes() {
    for field in [
        "model",
        "instructions",
        "max_output_tokens",
        "tools",
        "baseline_source_utf8",
        "development_examples",
        "plugin_contract",
    ] {
        let f = Fixture::new();
        let root = f.dir.path().join("search");
        let mut search =
            PythonSearch::create(&root, &f.source, plan(&f), &f.grants, f.context.clone()).unwrap();
        let (_, request) = search.next_request().unwrap().unwrap();
        PythonSearch::inspect(&root).unwrap();
        let mut request = serde_json::to_value(request).unwrap();
        match field {
            "model" | "instructions" => request[field] = json!("changed host policy"),
            "max_output_tokens" => request[field] = json!(1),
            "tools" => request["tools"][0]["parameters"] = json!({"type":"object"}),
            _ => {
                let mut input: serde_json::Value = serde_json::from_str(
                    request["input"][0]["content"][0]["text"].as_str().unwrap(),
                )
                .unwrap();
                input[field] = json!("changed frozen input");
                request["input"][0]["content"][0]["text"] = json!(input.to_string());
            }
        }
        let sha = zero_evaluation::digest(&serde_json::to_vec(&request).unwrap());
        let conn = rusqlite::Connection::open(root.join("search.sqlite")).unwrap();
        conn.execute(
            "UPDATE rounds SET request=?1,request_sha=?2 WHERE idx=0",
            rusqlite::params![request.to_string(), sha],
        )
        .unwrap();
        assert!(PythonSearch::inspect(&root).is_err(), "{field}");
    }
}
#[test]
fn missing_operation_is_inspectable_only_as_final_unfinished_or_failed_round() {
    let f = Fixture::new();
    let root = f.dir.path().join("search");
    let mut search =
        PythonSearch::create(&root, &f.source, plan(&f), &f.grants, f.context.clone()).unwrap();
    search.next_request().unwrap().unwrap();
    let conn = rusqlite::Connection::open(root.join("search.sqlite")).unwrap();
    for phase in [
        "inference_running",
        "inference_failed",
        "cancelled",
        "deadline",
    ] {
        conn.execute("UPDATE search SET phase=?1", [phase]).unwrap();
        PythonSearch::inspect(&root).unwrap();
    }
    for phase in [
        "ready",
        "completed",
        "stopped",
        "selected",
        "proposal_settled",
        "experiment_ready",
    ] {
        conn.execute("UPDATE search SET phase=?1", [phase]).unwrap();
        assert!(PythonSearch::inspect(&root).is_err(), "{phase}");
    }
    conn.execute("UPDATE search SET phase='inference_running'", [])
        .unwrap();
    conn.execute("INSERT INTO rounds(idx,command,request,request_sha) SELECT 1,command||':successor',request,request_sha FROM rounds WHERE idx=0",[]).unwrap();
    assert!(PythonSearch::inspect(&root).is_err());
}
#[test]
fn inspection_requires_original_accounting_witness_even_when_operation_projection_matches() {
    let mut f = Fixture::new();
    let root = f.dir.path().join("search");
    let mut search =
        PythonSearch::create(&root, &f.source, plan(&f), &f.grants, f.context.clone()).unwrap();
    record(
        &mut f,
        &mut search,
        "submit_python_candidate",
        json!({"action":"stop","reason":"done"}),
        3,
    )
    .unwrap();
    PythonSearch::inspect(&root).unwrap();
    let conn = rusqlite::Connection::open(&f.context.state_database).unwrap();
    conn.execute("DELETE FROM events WHERE kind='budget_settled'", [])
        .unwrap();
    assert!(PythonSearch::inspect(&root).is_err());
}
