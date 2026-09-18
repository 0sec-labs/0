use super::*;
use zero_protocol::{
    session::OperationStatus,
    web::{WebCitationPart, WebReviewResult},
};
pub(super) fn response(scenario: &StrategyScenario, path: &str) -> (u16, Vec<u8>) {
    if path == "/" {
        return (
            200,
            serde_json::to_vec(
                &json!({"resources":[scenario.resource_path,scenario.control_path]}),
            )
            .unwrap_or_default(),
        );
    }
    if path == scenario.resource_path {
        return (
            200,
            if scenario.positive {
                format!("fixture resource: {}", scenario.marker).into_bytes()
            } else {
                b"fixture resource: no private data".to_vec()
            },
        );
    }
    if path == scenario.control_path {
        return (200, b"fixture control: public data only".to_vec());
    }
    (404, b"fixture route not found".to_vec())
}
pub(super) fn finding_score(
    store: &Store,
    session: &str,
    root: &str,
    scenario: &StrategyScenario,
    origin: &str,
    review: &WebReviewResult,
) -> Result<(u32, u32, Vec<StrategyObservation>), EngineError> {
    let mut supported = 0u32;
    let mut unsupported = 0u32;
    let mut observations = BTreeMap::new();
    for hypothesis in &review.hypotheses {
        let mut matched = false;
        for citation in &hypothesis.claim.citations {
            let effect = store.get_operation(&citation.operation_id)?;
            if effect.session_id != session
                || effect.status != OperationStatus::Succeeded
                || !agent_web::owns_evidence(store, root, &effect.id)?
            {
                return Err(error("strategy citation ownership differs"));
            }
            let (manifest, result, body) = agent_http::checked_evidence(store, &effect)?;
            let observed = result
                .response
                .ok_or_else(|| error("strategy citation response absent"))?;
            if result.disposition != zero_http::HttpDisposition::CompleteResponse {
                return Err(error("strategy cited incomplete response"));
            }
            let url = effect.payload["request"]["url"]
                .as_str()
                .ok_or_else(|| error("strategy HTTP URL absent"))?;
            let path = url
                .strip_prefix(origin)
                .filter(|p| p.starts_with('/'))
                .ok_or_else(|| error("strategy response not from issued fixture origin"))?;
            let expected = response(scenario, path);
            if observed.status != expected.0 || body != expected.1 {
                return Err(error("retained target evidence contradicts frozen fixture"));
            }
            observations.insert(
                effect.id.clone(),
                StrategyObservation {
                    operation_id: effect.id,
                    response_manifest_sha256: citation.response_manifest_sha256.clone(),
                    retained_body_sha256: manifest["body"]["sha256"]
                        .as_str()
                        .ok_or_else(|| error("strategy body hash absent"))?
                        .into(),
                },
            );
            if scenario.positive
                && hypothesis.claim.category == "fixture_disclosure"
                && path == scenario.resource_path
            {
                if let WebCitationPart::Body { offset, length } = citation.part {
                    let start = usize::try_from(offset).map_err(error)?;
                    let end = start
                        .checked_add(length as usize)
                        .ok_or_else(|| error("strategy citation overflow"))?;
                    let cited = body
                        .get(start..end)
                        .ok_or_else(|| error("strategy citation outside body"))?;
                    matched |= cited
                        .windows(scenario.marker.len())
                        .any(|v| v == scenario.marker.as_bytes());
                }
            }
        }
        if matched {
            supported = 1;
        } else {
            unsupported = unsupported.saturating_add(1);
        }
    }
    Ok((supported, unsupported, observations.into_values().collect()))
}
pub(super) fn score(
    plan: &StrategyPlan,
    rows: &[StrategyCaseResult],
    completed: &[CampaignLane],
) -> (StrategyDecision, Vec<String>) {
    score_cases(
        &plan.scenarios,
        plan.repeats,
        rows,
        &[CampaignLane::Development, CampaignLane::Final],
        completed,
        [plan.minimum_development_gain, plan.minimum_final_gain],
    )
}
pub(super) fn score_development(
    scenarios: &[StrategyScenario],
    repeats: u32,
    minimum: u32,
    rows: &[StrategyCaseResult],
    complete: bool,
) -> (bool, Vec<String>) {
    let completed = if complete {
        vec![CampaignLane::Development]
    } else {
        vec![]
    };
    let (decision, reasons) = score_cases(
        scenarios,
        repeats,
        rows,
        &[CampaignLane::Development],
        &completed,
        [minimum, 0],
    );
    (
        decision == StrategyDecision::ImprovedForFixtureSuite,
        reasons,
    )
}
pub(super) fn score_protected_final(
    scenarios: &[StrategyScenario],
    repeats: u32,
    minimum: u32,
    rows: &[StrategyCaseResult],
    complete: bool,
) -> (StrategyDecision, Vec<String>) {
    score_cases(
        scenarios,
        repeats,
        rows,
        &[CampaignLane::Final],
        if complete {
            &[CampaignLane::Final]
        } else {
            &[]
        },
        [0, minimum],
    )
}
fn score_cases(
    scenarios: &[StrategyScenario],
    repeats: u32,
    rows: &[StrategyCaseResult],
    required: &[CampaignLane],
    completed: &[CampaignLane],
    minimum: [u32; 2],
) -> (StrategyDecision, Vec<String>) {
    let mut reasons = vec![];
    let expected = scenarios.len() * repeats as usize * 2;
    let mut complete =
        rows.len() == expected && required.iter().all(|lane| completed.contains(lane));
    if required.contains(&CampaignLane::Final) && !completed.contains(&CampaignLane::Final) {
        reasons.push("protected_final_not_run".into());
    }
    let mut stable = true;
    let mut regression = false;
    let mut negative = true;
    let mut gain = [0i32; 2];
    for scenario in scenarios {
        let mut solved = [false; 2];
        for (v, variant) in [CampaignVariant::Baseline, CampaignVariant::Candidate]
            .iter()
            .enumerate()
        {
            let attempts: Vec<_> = rows
                .iter()
                .filter(|r| r.scenario_id == scenario.id && r.variant == *variant)
                .collect();
            if attempts.len() != repeats as usize
                || (0..repeats)
                    .any(|repeat| attempts.iter().filter(|r| r.repeat_index == repeat).count() != 1)
            {
                complete = false;
                continue;
            }
            if attempts.iter().any(|r| {
                r.disposition != StrategyCaseDisposition::Observed
                    || r.model_reserved_micro_usd != 0
            }) {
                complete = false;
            }
            stable &= attempts.iter().all(|r| {
                (r.matched, r.supported_findings, r.unsupported_claims)
                    == (
                        attempts[0].matched,
                        attempts[0].supported_findings,
                        attempts[0].unsupported_claims,
                    )
            });
            solved[v] = attempts
                .iter()
                .all(|r| r.matched && r.unsupported_claims == 0);
        }
        regression |= solved[0] && !solved[1];
        if scenario.positive {
            gain[usize::from(scenario.lane == CampaignLane::Final)] +=
                i32::from(solved[1]) - i32::from(solved[0]);
        } else {
            negative &= solved[1];
        }
    }
    if !complete {
        reasons.push("incomplete_pair_or_unsettled_evidence".into());
    }
    if !stable {
        reasons.push("repeat_instability".into());
    }
    if regression {
        reasons.push("baseline_capability_regression".into());
    }
    if !negative {
        reasons.push("unsupported_negative_case_claim".into());
    }
    if rows
        .iter()
        .any(|r| r.variant == CampaignVariant::Candidate && r.unsupported_claims > 0)
    {
        reasons.push("candidate_unsupported_claim".into());
    }
    if required.iter().any(|lane| {
        let i = usize::from(*lane == CampaignLane::Final);
        gain[i] < minimum[i] as i32
    }) {
        reasons.push("insufficient_distinct_case_gain".into());
    }
    let decision = if !complete || !stable {
        StrategyDecision::Inconclusive
    } else if reasons.is_empty() {
        StrategyDecision::ImprovedForFixtureSuite
    } else {
        StrategyDecision::NotImproved
    };
    (decision, reasons)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_candidate_claim_cannot_hide_behind_another_positive_gain() {
        let scenarios: Vec<_> = [CampaignLane::Development, CampaignLane::Final]
            .into_iter()
            .flat_map(|lane| {
                (0..3).map(move |n| StrategyScenario {
                    id: format!("{lane:?}{n}"),
                    family: format!("{lane:?}{n}"),
                    lane,
                    public_task: "Investigate".into(),
                    resource_path: "/resource".into(),
                    control_path: "/control".into(),
                    marker: format!("private-{lane:?}-{n}"),
                    positive: n < 2,
                })
            })
            .collect();
        let plan = StrategyPlan {
            schema_version: 1,
            renderer_version: STRATEGY_RENDERER.into(),
            oracle_version: STRATEGY_ORACLE.into(),
            baseline: StrategyArtifact {
                schema_version: 1,
                advisory_utf8: "baseline".into(),
            },
            candidate: StrategyArtifact {
                schema_version: 1,
                advisory_utf8: "candidate".into(),
            },
            host: StrategyHost {
                provider: "fixture".into(),
                model: "fixture".into(),
                instructions: "Investigate".into(),
                max_turns: 3,
                reservation_per_turn: 5,
                max_hypotheses: 2,
                web_experiment_policy: None,
                delegation_policy: None,
                context_policy: None,
            },
            scenarios,
            repeats: 2,
            limits: CampaignLimits {
                model_micro_usd: 1000,
                model_calls: 128,
                http_requests: 128,
                http_request_body_bytes: 1024,
                http_response_decoded_bytes: 1048576,
                experiments: 0,
                runs: 24,
                max_parallel_runs: 1,
            },
            expires_at_ms: 100000,
            minimum_development_gain: 1,
            minimum_final_gain: 1,
        };
        assert!(plan.validate().is_ok());
        let mut rows = vec![];
        for scenario in &plan.scenarios {
            for variant in [CampaignVariant::Baseline, CampaignVariant::Candidate] {
                for repeat in 0..2 {
                    let supported = u32::from(
                        variant == CampaignVariant::Candidate && scenario.id.ends_with('0'),
                    );
                    let unsupported = u32::from(
                        variant == CampaignVariant::Candidate && scenario.id.ends_with('1'),
                    );
                    rows.push(StrategyCaseResult {
                        schedule_index: rows.len() as u32,
                        run_id: "run".into(),
                        session_id: "session".into(),
                        operation_id: Some("root".into()),
                        scenario_id: scenario.id.clone(),
                        family: scenario.family.clone(),
                        lane: scenario.lane,
                        variant,
                        repeat_index: repeat,
                        disposition: StrategyCaseDisposition::Observed,
                        matched: !scenario.positive || supported == 1,
                        supported_findings: supported,
                        unsupported_claims: unsupported,
                        observations: vec![],
                        model_charged_micro_usd: 2,
                        model_reserved_micro_usd: 0,
                        error: None,
                    });
                }
            }
        }
        let (decision, reasons) = score(
            &plan,
            &rows,
            &[CampaignLane::Development, CampaignLane::Final],
        );
        assert_eq!(decision, StrategyDecision::NotImproved);
        assert!(reasons.iter().any(|r| r == "candidate_unsupported_claim"));
        for row in &mut rows {
            row.unsupported_claims = 0;
        }
        assert_eq!(
            score(
                &plan,
                &rows,
                &[CampaignLane::Development, CampaignLane::Final]
            )
            .0,
            StrategyDecision::ImprovedForFixtureSuite
        );
    }
}
