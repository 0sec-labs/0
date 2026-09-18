use crate::{Attempt, Lane, Plan, Report, Result, Variant, digest};
use zero_evolution::EvaluationDecision;
pub(crate) fn score(run: &str, plan: &Plan, attempts: &[Attempt]) -> Result<Report> {
    let mut reasons = vec![];
    let complete = attempts.len() == plan.cases.len() * plan.repeats * 2
        && attempts
            .iter()
            .all(|a| a.state == "finished" && a.settled && a.output.is_some() && a.error.is_none());
    let mut gains = [0isize; 2];
    let mut stable = true;
    let mut regression = false;
    let mut negatives = true;
    let mut matrix = complete;
    for case in &plan.cases {
        let mut solved = [false; 2];
        for (v, variant) in [Variant::Baseline, Variant::Candidate]
            .into_iter()
            .enumerate()
        {
            let rows: Vec<_> = attempts
                .iter()
                .filter(|a| a.variant == variant && a.case_id == case.id)
                .collect();
            if rows.len() != plan.repeats
                || (0..plan.repeats).any(|r| rows.iter().filter(|a| a.repeat == r).count() != 1)
            {
                matrix = false;
                continue;
            }
            let first = rows[0].output.as_ref();
            stable &= rows.iter().all(|a| a.output.as_ref() == first);
            solved[v] = rows
                .iter()
                .all(|a| a.output.as_ref() == Some(&case.expected));
        }
        regression |= solved[0] && !solved[1];
        match case.lane {
            Lane::Development => gains[0] += isize::from(solved[1]) - isize::from(solved[0]),
            Lane::HeldOut => gains[1] += isize::from(solved[1]) - isize::from(solved[0]),
            Lane::NegativeControl => negatives &= solved[1],
        }
    }
    if !matrix {
        reasons.push("incomplete paired matrix, failed execution, or unsettled effects".into());
    }
    if !stable {
        reasons.push("repeat output instability".into());
    }
    if regression {
        reasons.push("previously solved case regressed".into());
    }
    if !negatives {
        reasons.push("candidate negative-control mismatch".into());
    }
    if gains[0] < (plan.scoring.minimum_development_gain as isize)
        || gains[1] < (plan.scoring.minimum_held_out_gain as isize)
    {
        reasons.push("insufficient distinct-case gain".into());
    }
    let decision = if !matrix || !stable {
        EvaluationDecision::Inconclusive
    } else if reasons.is_empty() {
        EvaluationDecision::Eligible
    } else {
        EvaluationDecision::Rejected
    };
    let mut report = Report {
        schema_version: 1,
        baseline: plan.baseline.clone(),
        candidate: plan.candidate.clone(),
        engine_artifact: plan.engine_artifact.clone(),
        run_id: run.into(),
        plan_digest: digest(&serde_json::to_vec(plan)?),
        scoring_policy_digest: digest(&serde_json::to_vec(&plan.scoring)?),
        host_policy_artifact: plan.host_policy_artifact.clone(),
        evaluator_artifact: plan.evaluator_artifact.clone(),
        decision,
        qualification:
            "offline_exact_json_fixture_only; no production activation or detector-quality claim"
                .into(),
        reasons,
        attempted: attempts.iter().filter(|a| a.state != "pending").count(),
        settled: attempts.iter().filter(|a| a.settled).count(),
        reserved_slots: attempts
            .iter()
            .filter(|a| a.state != "pending" && !a.settled)
            .count(),
        evidence_digest: digest(&serde_json::to_vec(attempts)?),
        receipt_digest: String::new(),
    };
    report.receipt_digest = digest(&serde_json::to_vec(&report)?);
    Ok(report)
}
