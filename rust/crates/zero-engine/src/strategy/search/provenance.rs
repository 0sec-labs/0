use super::super::provenance as common;
use super::*;

pub(super) fn feedback(report: &StrategySearchReport, index: u32) -> Value {
    let proposals:Vec<_>=report.proposals.iter().filter(|p|p.proposal.attempt_index<index).map(|p|{
 let (action,candidate)=match &p.output{Some(SearchProposalOutput::Propose{advisory,..})=>(Some("propose"),hash(&serde_json::to_value(advisory).unwrap_or(Value::Null)).ok()),Some(SearchProposalOutput::Stop{..})=>(Some("stop"),None),None=>(None,None)};
 json!({"attempt_index":p.proposal.attempt_index,"operation_id":p.proposal.operation_id,"operation_status":p.operation_status,"action":action,"candidate_sha256":candidate,"error":p.error})}).collect();
    let evaluations:Vec<_>=report.evaluations.iter().filter(|e|report.proposals.iter().any(|p|p.proposal.id==e.evaluation.proposal_id&&p.proposal.attempt_index<index)).map(|e|{
 let cases:Vec<_>=e.cases.iter().map(|r|json!({"scenario_id":r.scenario_id,"family":r.family,"variant":r.variant,"repeat_index":r.repeat_index,"disposition":r.disposition,"matched":r.matched,"supported_findings":r.supported_findings,"unsupported_claims":r.unsupported_claims,"error":r.error})).collect();
 json!({"evaluation_id":e.evaluation.id,"candidate_sha256":e.evaluation.candidate_sha256,"improved":e.improved,"reasons":e.reasons,"cases":cases})}).collect();
    json!({"schema_version":1,"kind":"strategy_search_development_feedback","campaign_id":report.campaign_id,"config_sha256":report.config_sha256,"prior_attempts":index,"proposals":proposals,"evaluations":evaluations})
}
pub(super) fn report(store: &Store, id: &str) -> Result<StrategySearchReport, EngineError> {
    let mut budget = 64 * 1024 * 1024;
    store.search_evidence_preflight(id, &mut budget)?;
    let snapshot = store.search_snapshot(id)?;
    store.validate_session_admission_closure(&snapshot.campaign.campaign.journal_session_id)?;
    let config = store.search_configuration(id)?;
    validate(&config)?;
    let journal = common::events(
        store,
        &snapshot.campaign.campaign.journal_session_id,
        &mut budget,
    )?;
    if journal.iter().any(|e| e.kind == "campaign_exposed") {
        return Err(error("Development search contains protected exposure"));
    }
    let phase = match store.get_operation_by_command_bounded(
        &snapshot.campaign.campaign.journal_session_id,
        &command(id),
        &mut budget,
    ) {
        Ok(op) => {
            if op.payload != payload(&snapshot.campaign) {
                return Err(error("search controller identity differs"));
            }
            common::witness(&op, &journal)?;
            if op.status == OperationStatus::Unknown {
                store.validate_unknown_operation(&op)?;
            }
            Some(op)
        }
        Err(zero_store::Error::NotFound(_)) => None,
        Err(e) => return Err(e.into()),
    };
    let mut proposals = vec![];
    let mut proposal_operations = BTreeMap::new();
    for (p, op) in store.search_proposals(id)? {
        store.validate_session_admission_closure(&p.session_id)?;
        let history = common::events(store, &p.session_id, &mut budget)?;
        common::witness(&op, &history)?;
        let output = parsed(&config, &op);
        proposal_operations.insert(p.id.clone(), op.clone());
        proposals.push(SearchProposalResult {
            proposal: p,
            operation_status: op.status,
            output: output.as_ref().ok().cloned(),
            error: output.err().map(Into::into),
        });
    }
    let mut evaluations = vec![];
    let schedule = render::schedule_cases(&config.plan.scenarios, config.plan.repeats);
    let mut all_runs = vec![];
    let mut after = 0;
    loop {
        let page = store.campaign_runs(id, after, 32)?;
        for meta in page.runs {
            let run = store.campaign_run(id, &meta.id)?;
            store.validate_session_admission_closure(&run.session_id)?;
            all_runs.push(run);
            if all_runs.len() > 128 {
                return Err(error("search runs exceed bound"));
            }
        }
        match page.next_after_sequence {
            Some(next) if next > after => after = next,
            Some(_) => return Err(error("search run cursor differs")),
            None => break,
        }
    }
    let mut consumed = std::collections::BTreeSet::new();
    for evaluation in store.search_evaluations(id)? {
        let proposal = proposals
            .iter()
            .find(|p| p.proposal.id == evaluation.proposal_id)
            .ok_or_else(|| error("evaluation proposal absent"))?;
        let advisory = match &proposal.output {
            Some(SearchProposalOutput::Propose { advisory, .. }) => advisory,
            _ => return Err(error("evaluation has invalid proposal")),
        };
        if evaluation.run_count != schedule.len() as u32
            || evaluation.candidate_sha256 != hash(&serde_json::to_value(advisory)?)?
        {
            return Err(error("evaluation schedule or advisory differs"));
        }
        let mut cases = vec![];
        for run in all_runs.iter().filter(|r| {
            r.spec.schedule_index >= evaluation.schedule_start
                && r.spec.schedule_index < evaluation.schedule_start + evaluation.run_count
        }) {
            let i = run.spec.schedule_index - evaluation.schedule_start;
            let entry = &schedule[i as usize];
            let scenario = &config.plan.scenarios[entry.scenario];
            let artifact = if entry.variant == CampaignVariant::Baseline {
                &config.capture.advisory
            } else {
                advisory
            };
            let expected = request(
                &config,
                artifact,
                scenario,
                &profile_name(id, run.spec.schedule_index),
            )?;
            let spec = &run.spec;
            if !consumed.insert(run.id.clone())
                || spec.scenario_id != scenario.id
                || spec.lane != CampaignLane::Development
                || spec.exposure_id.is_some()
                || spec.repeat_index != entry.repeat
                || spec.variant != entry.variant
                || spec.candidate_sha256 != evaluation.candidate_sha256
                || spec.evaluation_pair_sha256 != evaluation.evaluation_pair_sha256
                || spec.suite_sha256 != hash(&serde_json::to_value(&config.plan.scenarios)?)?
                || serde_json::to_value(&spec.request)? != serde_json::to_value(&expected)?
                || serde_json::to_value(&spec.provider_context)?
                    != serde_json::to_value(&config.capture.authority.provider_context)?
                || serde_json::to_value(&spec.http_policy)?
                    != serde_json::to_value(
                        zero_http::normalize_policy(
                            search_fixture_profile(&spec.fixture_origin, &config.plan.limits)
                                .map_err(error)?,
                        )
                        .map_err(error)?,
                    )?
            {
                return Err(error("search run authority differs"));
            }
            cases.push(common::measure_run(
                store,
                run,
                scenario,
                &expected,
                phase.as_ref().ok_or_else(|| error("search phase absent"))?,
                &journal,
                &mut budget,
            )?);
        }
        cases.sort_by_key(|r| r.schedule_index);
        let done: Vec<_> = journal
            .iter()
            .filter(|e| {
                e.kind == "operation_detail"
                    && e.payload["kind"] == "strategy_search_evaluation_completed"
                    && e.payload["details"]["evaluation_id"] == evaluation.id
            })
            .collect();
        if done.len() > 1 {
            return Err(error("duplicate search matrix completion"));
        }
        let complete = if let Some(event) = done.first() {
            let phase = phase
                .as_ref()
                .ok_or_else(|| error("search controller absent"))?;
            let name = format!("search.matrix.{}", evaluation.id);
            let attachments = store.operation_artifacts(&phase.id)?;
            let digest = attachments
                .get(&name)
                .ok_or_else(|| error("search matrix attachment absent"))?;
            let bytes = store.artifact_bounded(digest, 1024 * 1024, &mut budget)?;
            if cases.len() != schedule.len()
                || event.payload["operation_id"] != phase.id
                || event.payload["details"]["matrix_sha256"] != *digest
                || serde_json::from_slice::<Value>(&bytes)? != serde_json::to_value(&cases)?
            {
                return Err(error("search measured matrix witness differs"));
            }
            true
        } else {
            false
        };
        let (improved, reasons) = oracle::score_development(
            &config.plan.scenarios,
            config.plan.repeats,
            config.plan.minimum_development_gain,
            &cases,
            complete,
        );
        evaluations.push(SearchEvaluationReport {
            evaluation,
            cases,
            improved,
            reasons,
        });
    }
    if consumed.len() != all_runs.len() {
        return Err(error("search contains unbound evaluation runs"));
    }
    let stop_reason = phase
        .as_ref()
        .and_then(|p| p.outcome.as_ref())
        .and_then(|v| v["stop_reason"].as_str())
        .map(Into::into);
    let mut report = StrategySearchReport {
        schema_version: 1,
        campaign_id: id.into(),
        config_sha256: snapshot.campaign.campaign.plan.controller_plan_sha256,
        qualification: "development_only".into(),
        proposals,
        evaluations,
        usage: snapshot.campaign.usage,
        stop_reason,
        report_sha256: String::new(),
    };
    for p in &report.proposals {
        let expected = if p.proposal.attempt_index == 0 {
            None
        } else {
            Some(feedback(&report, p.proposal.attempt_index))
        };
        if let Some(value) = &expected {
            let digest = p
                .proposal
                .feedback_sha256
                .as_deref()
                .ok_or_else(|| error("proposal feedback absent"))?;
            let bytes = store.artifact_bounded(digest, 512 * 1024, &mut budget)?;
            if bytes != serde_json::to_vec(value)? {
                return Err(error(
                    "proposal feedback differs from independent Development measurement",
                ));
            }
        }
        let op = proposal_operations
            .get(&p.proposal.id)
            .ok_or_else(|| error("proposal operation absent"))?;
        if op.payload["request"]
            != serde_json::to_value(
                render_search_proposal(&config, p.proposal.attempt_index, expected)
                    .map_err(error)?,
            )?
        {
            return Err(error("proposal retained request differs"));
        }
    }
    report.report_sha256 = hash(&serde_json::to_value(&report)?)?;
    if serde_json::to_vec(&report)?.len() > 2 * 1024 * 1024 {
        return Err(error("search report exceeds bound"));
    }
    Ok(report)
}
