use super::*;
use zero_protocol::strategy_registry::{
    StrategyRegistryBinding, evaluator_descriptor, renderer_descriptor,
};
fn raw(bytes: &[u8]) -> String {
    format!("sha256:{}", zero_plugin::sha256(bytes))
}
pub(super) fn suite(c: &StrategySearchConfiguration) -> Result<String, EngineError> {
    let p = c
        .plan
        .protected_final
        .as_ref()
        .ok_or_else(|| error("Final policy absent"))?;
    let mut scenarios: Vec<_> = p.scenarios.iter().collect();
    scenarios.sort_by(|a, b| a.id.cmp(&b.id));
    hash(&json!({"version":STRATEGY_ORACLE,"scenarios":scenarios}))
}
pub(super) fn validate_policy(c: &StrategySearchConfiguration) -> Result<(), EngineError> {
    let Some(p) = &c.plan.protected_final else {
        return Ok(());
    };
    if !c
        .capture
        .authority
        .accepted_suite_sha256
        .contains(&suite(c)?)
        || p.minimum_gain < c.capture.authority.minimum_final_gain
        || c.plan.minimum_development_gain < c.capture.authority.minimum_development_gain
    {
        return Err(error(
            "Final suite or criteria differ from captured authority",
        ));
    }
    for protected in &p.scenarios {
        if c.plan.objective.contains(&protected.marker)
            || c.plan.proposer.instructions.contains(&protected.marker)
        {
            return Err(error("Final marker appears in proposer input"));
        }
        for development in &c.plan.scenarios {
            for path in [
                "/",
                development.resource_path.as_str(),
                development.control_path.as_str(),
                "/unknown",
            ] {
                if oracle::response(development, path)
                    .1
                    .windows(protected.marker.len())
                    .any(|b| b == protected.marker.as_bytes())
                {
                    return Err(error(
                        "Final marker appears in Development fixture response",
                    ));
                }
            }
        }
    }
    if let Some(canary) = &c.plan.protected_canary {
        if !c
            .capture
            .authority
            .accepted_suite_sha256
            .contains(&hash(&search_final_suite_value(canary))?)
            || canary.minimum_gain < c.capture.authority.minimum_final_gain
        {
            return Err(error("canary policy is not in captured host authority"));
        }
        for protected in &canary.scenarios {
            if c.plan.objective.contains(&protected.marker)
                || c.plan.proposer.instructions.contains(&protected.marker)
            {
                return Err(error("canary marker in proposer input"));
            }
            for prior in c.plan.scenarios.iter().chain(p.scenarios.iter()) {
                for path in [
                    "/",
                    prior.resource_path.as_str(),
                    prior.control_path.as_str(),
                    "/unknown",
                ] {
                    if oracle::response(prior, path)
                        .1
                        .windows(protected.marker.len())
                        .any(|b| b == protected.marker.as_bytes())
                    {
                        return Err(error("canary marker leaked by earlier fixture"));
                    }
                }
            }
        }
    }
    Ok(())
}
pub(super) fn binding(
    c: &StrategySearchConfiguration,
    e: &SearchEvaluation,
    b: &StrategyRegistryBinding,
) -> Result<(), EngineError> {
    if b.registry != c.capture.registry
        || b.baseline_generation != c.capture.generation
        || b.baseline_epoch != c.capture.epoch
        || b.baseline_state_sha256 != c.capture.state_sha256
        || b.baseline_advisory_sha256 != c.capture.advisory_sha256
        || b.host_policy_sha256 != c.capture.host_policy_sha256
        || b.candidate_generation != e.candidate_generation
        || b.candidate_advisory_sha256 != e.candidate_sha256
        || b.renderer_artifact_sha256 != raw(&renderer_descriptor())
        || b.evaluator_artifact_sha256 != raw(&evaluator_descriptor())
    {
        return Err(error(
            "selected registry binding differs from original capture",
        ));
    }
    Ok(())
}
pub(super) fn matrix(cases: &[StrategyCaseResult]) -> Result<String, EngineError> {
    Ok(raw(&serde_json::to_vec(cases)?))
}
#[allow(clippy::too_many_arguments)]
pub(super) fn select(
    shared: &Arc<Shared>,
    campaign: &str,
    op: &Operation,
    c: &StrategySearchConfiguration,
    proposal: &SearchProposal,
    evaluation_id: &str,
) -> Result<Option<(SearchFinalSelection, SearchEvaluation, StrategyArtifact)>, EngineError> {
    let control = lock(&shared.control)?;
    if control.closing {
        return Err(error("engine closing before Final selection"));
    }
    let (evaluation, advisory, digest) = {
        let store = lock(&shared.store)?;
        let report = provenance::report(&store, campaign)?;
        let Some(e) = report
            .evaluations
            .iter()
            .find(|e| e.evaluation.id == evaluation_id)
        else {
            return Ok(None);
        };
        if !e.improved
            || e.cases.iter().any(|r| {
                r.disposition != StrategyCaseDisposition::Observed
                    || r.model_reserved_micro_usd != 0
            })
        {
            return Ok(None);
        }
        let Some(SearchProposalOutput::Propose { advisory, .. }) = report
            .proposals
            .iter()
            .find(|p| p.proposal.id == e.evaluation.proposal_id)
            .and_then(|p| p.output.as_ref())
        else {
            return Err(error("selected proposal absent"));
        };
        let digest = store
            .operation_artifacts(&op.id)?
            .get(&format!("search.matrix.{}", e.evaluation.id))
            .cloned()
            .ok_or_else(|| error("selected Development matrix absent"))?;
        if digest != matrix(&e.cases)? {
            return Err(error("selected Development matrix differs"));
        }
        (e.evaluation.clone(), advisory.clone(), digest)
    };
    let mut configured = lock(&shared.strategy_runtime)?;
    let harness = configured
        .as_mut()
        .ok_or_else(|| error("strategy runtime absent"))?;
    let b = harness
        .strategy_binding(&evaluation.candidate_generation)
        .map_err(error)?;
    binding(c, &evaluation, &b)?;
    let (selection, duplicate) = harness
        .with_current_strategy_binding(&b, || {
            let mut store = shared
                .store
                .lock()
                .map_err(|_| zero_evolution::Error::Invalid("store poisoned".into()))?;
            store
                .select_search_final(
                    campaign,
                    &proposal.id,
                    &evaluation.id,
                    &b,
                    &digest,
                    &shared.owner,
                )
                .map_err(|e| zero_evolution::Error::Invalid(e.to_string()))
        })
        .map_err(error)?;
    if duplicate {
        return Err(error("automatic Final selection replay forbidden"));
    }
    Ok(Some((selection, evaluation, advisory)))
}
#[allow(clippy::too_many_arguments)]
pub(super) fn measure(
    store: &Store,
    c: &StrategySearchConfiguration,
    selection: &SearchFinalSelection,
    evaluation: &SearchEvaluationReport,
    proposals: &[SearchProposalResult],
    phase: &Operation,
    journal: &[zero_protocol::session::SessionEvent],
    runs: &[CampaignRun],
    consumed: &mut std::collections::BTreeSet<String>,
    budget: &mut usize,
    canary: bool,
) -> Result<SearchFinalReport, EngineError> {
    binding(c, &evaluation.evaluation, &selection.binding)?;
    if !evaluation.improved
        || selection.candidate_generation != evaluation.evaluation.candidate_generation
        || selection.candidate_sha256 != evaluation.evaluation.candidate_sha256
        || selection.baseline_sha256 != c.capture.advisory_sha256
        || selection.suite_sha256
            != if canary {
                hash(&search_final_suite_value(
                    c.plan
                        .protected_canary
                        .as_ref()
                        .ok_or_else(|| error("canary policy absent"))?,
                ))?
            } else {
                suite(c)?
            }
        || selection.development_matrix_sha256 != matrix(&evaluation.cases)?
    {
        return Err(error("Final selection Development proof differs"));
    }
    let selector = proposals
        .iter()
        .find(|p| p.proposal.id == selection.proposal_id)
        .ok_or_else(|| error("selector proposal absent"))?;
    if !matches!(&selector.output,Some(SearchProposalOutput::SelectFinal{evaluation_id,..}) if *evaluation_id==selection.evaluation_id)
        || proposals
            .iter()
            .any(|p| p.proposal.attempt_index > selector.proposal.attempt_index)
    {
        return Err(error(
            "selection action or terminal proposal frontier differs",
        ));
    }
    let advisory = match proposals
        .iter()
        .find(|p| p.proposal.id == evaluation.evaluation.proposal_id)
        .and_then(|p| p.output.as_ref())
    {
        Some(SearchProposalOutput::Propose { advisory, .. }) => advisory,
        _ => return Err(error("selected advisory absent")),
    };
    let policy = if canary {
        c.plan.protected_canary.as_ref()
    } else {
        c.plan.protected_final.as_ref()
    }
    .ok_or_else(|| error("protected policy absent"))?;
    let schedule = render::schedule_cases(&policy.scenarios, policy.repeats);
    if selection.run_count != schedule.len() as u32 {
        return Err(error("Final schedule differs"));
    }
    let mut cases = vec![];
    for run in runs.iter().filter(|r| {
        r.spec.schedule_index >= selection.schedule_start
            && r.spec.schedule_index < selection.schedule_start + selection.run_count
    }) {
        let spec = &run.spec;
        let entry = &schedule[(spec.schedule_index - selection.schedule_start) as usize];
        let scenario = &policy.scenarios[entry.scenario];
        let artifact = if entry.variant == CampaignVariant::Baseline {
            &c.capture.advisory
        } else {
            advisory
        };
        let expected = request(
            c,
            artifact,
            scenario,
            &profile_name(&selection.campaign_id, spec.schedule_index),
        )?;
        if !consumed.insert(run.id.clone())
            || spec.scenario_id != scenario.id
            || spec.lane
                != if canary {
                    CampaignLane::Canary
                } else {
                    CampaignLane::Final
                }
            || spec.repeat_index != entry.repeat
            || spec.variant != entry.variant
            || spec.candidate_sha256 != selection.candidate_sha256
            || spec.evaluation_pair_sha256 != selection.final_pair_sha256
            || spec.suite_sha256 != selection.suite_sha256
            || spec.exposure_id.as_deref() != Some(&selection.exposure_id)
            || serde_json::to_value(&spec.request)? != serde_json::to_value(&expected)?
            || serde_json::to_value(&spec.provider_context)?
                != serde_json::to_value(&c.capture.authority.provider_context)?
            || serde_json::to_value(&spec.http_policy)?
                != serde_json::to_value(
                    zero_http::normalize_policy(
                        search_fixture_profile(&spec.fixture_origin, &c.plan.limits)
                            .map_err(error)?,
                    )
                    .map_err(error)?,
                )?
        {
            return Err(error("Final case authority differs"));
        }
        cases.push(super::super::provenance::measure_run(
            store, run, scenario, &expected, phase, journal, budget,
        )?);
    }
    cases.sort_by_key(|r| r.schedule_index);
    let completed: Vec<_> = journal
        .iter()
        .filter(|e| {
            e.kind == "operation_detail"
                && e.payload["operation_id"] == phase.id
                && e.payload["kind"]
                    == if canary {
                        "strategy_search_canary_completed"
                    } else {
                        "strategy_search_final_completed"
                    }
        })
        .collect();
    if completed.len() > 1 {
        return Err(error("duplicate Final completion witness"));
    }
    let digest = if let Some(event) = completed.first() {
        let attachments = store.operation_artifacts(&phase.id)?;
        let d = attachments
            .get(if canary {
                "search.canary.matrix"
            } else {
                "search.final.matrix"
            })
            .ok_or_else(|| error("Final matrix artifact absent"))?;
        let bytes = store.artifact_bounded(d, 1024 * 1024, budget)?;
        if cases.len() != schedule.len()
            || event.payload["details"]["selection_id"] != selection.id
            || event.payload["details"]["matrix_sha256"] != *d
            || serde_json::from_slice::<Value>(&bytes)? != serde_json::to_value(&cases)?
        {
            return Err(error("Final matrix witness differs"));
        }
        Some(d.clone())
    } else {
        None
    };
    let score = if canary {
        oracle::score_protected_canary
    } else {
        oracle::score_protected_final
    };
    let (decision, reasons) = score(
        &policy.scenarios,
        policy.repeats,
        policy.minimum_gain,
        &cases,
        digest.is_some(),
    );
    Ok(SearchFinalReport {
        cases,
        decision,
        reasons,
        matrix_sha256: digest,
    })
}
