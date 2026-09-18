use super::*;
use zero_protocol::{
    Operation,
    session::{OperationStatus, SessionEvent},
};

pub(super) fn configuration(
    store: &Store,
    id: &str,
) -> Result<(CampaignSnapshot, Configuration), EngineError> {
    let snapshot = store.campaign(id)?;
    let bytes = store.artifact_bounded(
        &snapshot.campaign.plan.controller_plan_sha256,
        2 * 1024 * 1024,
        &mut (2 * 1024 * 1024),
    )?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(error("strategy configuration exceeds bound"));
    }
    let config: Configuration = serde_json::from_slice(&bytes)?;
    config.plan.validate().map_err(error)?;
    render::validate_public_inputs(&config.plan)?;
    if hash(&serde_json::to_value(&config)?)? != snapshot.campaign.plan.controller_plan_sha256
        || snapshot.campaign.plan.baseline_sha256
            != hash(&serde_json::to_value(&config.plan.baseline)?)?
        || snapshot.campaign.plan.limits != config.plan.limits
        || snapshot.campaign.plan.expires_at_ms != config.plan.expires_at_ms
    {
        return Err(error("strategy configuration binding differs"));
    }
    Ok((snapshot, config))
}
pub(super) fn suite(config: &Configuration) -> Result<String, EngineError> {
    let mut scenarios: Vec<_> = config
        .plan
        .scenarios
        .iter()
        .filter(|s| s.lane == CampaignLane::Final)
        .collect();
    scenarios.sort_by(|a, b| a.id.cmp(&b.id));
    hash(&json!({"version":STRATEGY_ORACLE,"scenarios":scenarios}))
}
pub(super) fn pair(config: &Configuration) -> Result<String, EngineError> {
    hash(&serde_json::to_value(config)?)
}
pub(super) fn lane_name(lane: CampaignLane) -> &'static str {
    match lane {
        CampaignLane::Development => "development",
        CampaignLane::Final => "final",
    }
}
pub(super) fn phase_command(id: &str, lane: CampaignLane) -> String {
    format!("strategy-evaluation:{id}:{}", lane_name(lane))
}
pub(super) fn profile_name(id: &str, index: u32) -> String {
    format!("strategy_{id}_{index}")
}
pub(super) fn expected_payload(snapshot: &CampaignSnapshot, lane: CampaignLane) -> Value {
    json!({"kind":"strategy_evaluation","campaign_id":snapshot.campaign.id,"controller_plan_sha256":snapshot.campaign.plan.controller_plan_sha256,"lane":lane})
}
fn events(
    store: &Store,
    session: &str,
    budget: &mut usize,
) -> Result<Vec<SessionEvent>, EngineError> {
    let mut all = vec![];
    let mut after = 0;
    loop {
        let page = store.events_bounded(session, after, 256, budget)?;
        if page.is_empty() {
            break;
        }
        for e in page {
            after = e.sequence;
            all.push(e);
            if all.len() > 50000 {
                return Err(error("strategy journal count exceeds bound"));
            }
        }
    }
    Ok(all)
}
fn witness(op: &Operation, events: &[SessionEvent]) -> Result<(), EngineError> {
    let admissions: Vec<_> = events
        .iter()
        .filter(|e| e.kind == "command_admitted" && e.payload["id"] == op.id)
        .collect();
    if admissions.len() != 1
        || admissions[0].payload["payload"] != op.payload
        || admissions[0].payload["command_id"] != op.command_id
        || admissions[0].payload["session_id"] != op.session_id
    {
        return Err(error("strategy admission witness differs"));
    }
    if matches!(
        op.status,
        OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled
    ) {
        let settled: Vec<_> = events
            .iter()
            .filter(|e| e.kind == "operation_settled" && e.payload["id"] == op.id)
            .collect();
        if settled.len() != 1 || settled[0].payload != serde_json::to_value(op)? {
            return Err(error("strategy terminal witness differs"));
        }
    }
    Ok(())
}
pub(super) fn rows(
    store: &Store,
    snapshot: &CampaignSnapshot,
    config: &Configuration,
) -> Result<(Vec<StrategyCaseResult>, Vec<CampaignLane>), EngineError> {
    let mut budget = 64 * 1024 * 1024;
    let journal = events(store, &snapshot.campaign.journal_session_id, &mut budget)?;
    let schedule = render::schedule(&config.plan);
    let mut completed = vec![];
    let mut phases = BTreeMap::new();
    for lane in [CampaignLane::Development, CampaignLane::Final] {
        match store.get_operation_by_command_bounded(
            &snapshot.campaign.journal_session_id,
            &phase_command(&snapshot.campaign.id, lane),
            &mut budget,
        ) {
            Ok(op) => {
                if op.payload != expected_payload(snapshot, lane) {
                    return Err(error("strategy phase authority differs"));
                }
                witness(&op, &journal)?;
                if op.status == OperationStatus::Succeeded {
                    completed.push(lane);
                }
                phases.insert(lane_name(lane), op);
            }
            Err(zero_store::Error::NotFound(_)) => {}
            Err(e) => return Err(e.into()),
        }
    }
    let mut runs = vec![];
    let mut after = 0;
    loop {
        let page = store.campaign_runs(&snapshot.campaign.id, after, 32)?;
        for meta in page.runs {
            let run = store.campaign_run(&snapshot.campaign.id, &meta.id)?;
            budget = budget
                .checked_sub(serde_json::to_vec(&run)?.len())
                .ok_or_else(|| error("strategy run bindings exceed read budget"))?;
            runs.push(run);
            if runs.len() > 128 {
                return Err(error("strategy run count exceeds bound"));
            }
        }
        match page.next_after_sequence {
            Some(next) if next > after => after = next,
            Some(_) => return Err(error("strategy run cursor did not advance")),
            None => break,
        }
    }
    let mut result = vec![];
    let mut indices = std::collections::BTreeSet::new();
    for run in runs {
        let spec = &run.spec;
        let entry = schedule
            .get(spec.schedule_index as usize)
            .ok_or_else(|| error("strategy schedule index differs"))?;
        let scenario = &config.plan.scenarios[entry.scenario];
        let artifact = if entry.variant == CampaignVariant::Baseline {
            &config.plan.baseline
        } else {
            &config.plan.candidate
        };
        let request = render::request(
            &config.plan,
            artifact,
            scenario,
            &profile_name(&snapshot.campaign.id, entry.index),
        )?;
        if !indices.insert(entry.index)
            || spec.scenario_id != scenario.id
            || spec.lane != scenario.lane
            || spec.repeat_index != entry.repeat
            || spec.variant != entry.variant
            || spec.candidate_sha256 != hash(&serde_json::to_value(&config.plan.candidate)?)?
            || spec.suite_sha256 != suite(config)?
            || spec.evaluation_pair_sha256 != pair(config)?
            || serde_json::to_value(&spec.request)? != serde_json::to_value(&request)?
            || serde_json::to_value(&spec.provider_context)?
                != serde_json::to_value(&config.provider_context)?
            || serde_json::to_value(&spec.http_policy)?
                != serde_json::to_value(render::profile(
                    &spec.fixture_origin,
                    &config.plan.limits,
                )?)?
        {
            return Err(error("strategy scheduled run authority differs"));
        }
        let money = store.budget(&run.session_id)?;
        let mut row = StrategyCaseResult {
            schedule_index: entry.index,
            run_id: run.id.clone(),
            session_id: run.session_id.clone(),
            operation_id: run.operation_id.clone(),
            scenario_id: scenario.id.clone(),
            family: scenario.family.clone(),
            lane: scenario.lane,
            variant: entry.variant,
            repeat_index: entry.repeat,
            disposition: StrategyCaseDisposition::Incomplete,
            matched: false,
            supported_findings: 0,
            unsupported_claims: 0,
            observations: vec![],
            model_charged_micro_usd: money.charged,
            model_reserved_micro_usd: money.reserved,
            error: None,
        };
        let phase = phases
            .get(lane_name(scenario.lane))
            .ok_or_else(|| error("strategy run has no controller phase"))?;
        let clean: Vec<_> = journal
            .iter()
            .filter(|e| {
                e.payload["operation_id"] == phase.id
                    && e.payload["kind"] == "strategy_fixture_closed"
                    && e.payload["details"]["run_id"] == run.id
            })
            .collect();
        if clean.len() > 1 {
            return Err(error("duplicate fixture cleanup witness"));
        }
        if let Some(id) = &run.operation_id {
            let operation = store.get_operation_bounded(id, &mut budget)?;
            let history = events(store, &run.session_id, &mut budget)?;
            witness(&operation, &history)?;
            if operation.command_id != run.run_command_id
                || operation.payload["request"] != serde_json::to_value(&request)?
            {
                return Err(error("strategy actor request differs"));
            }
            let mut uncertain = false;
            for event in &history {
                if matches!(
                    event.kind.as_str(),
                    "agent_steering_enqueued" | "agent_input_queued" | "budget_reconciled"
                ) {
                    return Err(error(
                        "strategy run contains external input or reconciliation",
                    ));
                }
                if event.kind == "command_admitted" {
                    let child: Operation = serde_json::from_value(event.payload.clone())?;
                    let current = store.get_operation_bounded(&child.id, &mut budget)?;
                    witness(&current, &history)?;
                    uncertain |= matches!(
                        current.status,
                        OperationStatus::Unknown
                            | OperationStatus::Running
                            | OperationStatus::Admitted
                    );
                    if current.payload["kind"] == "agent_http"
                        && current.status == OperationStatus::Succeeded
                    {
                        let (_, outcome, body) = agent_http::checked_evidence(store, &current)?;
                        budget = budget
                            .checked_sub(body.len())
                            .ok_or_else(|| error("strategy HTTP evidence exceeds read bound"))?;
                        if let Some(response) = outcome.response {
                            let url = current.payload["request"]["url"]
                                .as_str()
                                .ok_or_else(|| error("strategy HTTP URL absent"))?;
                            let path = url
                                .strip_prefix(&spec.fixture_origin)
                                .filter(|p| p.starts_with('/'))
                                .ok_or_else(|| error("strategy HTTP origin differs"))?;
                            let expected = oracle::response(scenario, path);
                            if response.status != expected.0 || body != expected.1 {
                                return Err(error("strategy fixture evidence differs"));
                            }
                        }
                    }
                }
            }
            row.disposition = match operation.status {
                OperationStatus::Unknown => StrategyCaseDisposition::Unknown,
                OperationStatus::Cancelled => StrategyCaseDisposition::Cancelled,
                _ => StrategyCaseDisposition::Incomplete,
            };
            if uncertain {
                row.disposition = StrategyCaseDisposition::Unknown;
            } else if operation.status == OperationStatus::Succeeded
                && clean
                    .first()
                    .is_some_and(|e| e.payload["details"]["confirmed"] == true)
            {
                let result: AgentResult = serde_json::from_value(
                    operation
                        .outcome
                        .clone()
                        .ok_or_else(|| error("strategy actor outcome absent"))?,
                )?;
                if result.status == AgentStatus::Completed && result.web_review.is_some() {
                    let review = agent_web::load(store, &run.session_id, id)?;
                    let (supported, unsupported, observations) = oracle::finding_score(
                        store,
                        &run.session_id,
                        id,
                        scenario,
                        &spec.fixture_origin,
                        &review.review,
                    )?;
                    row.supported_findings = supported;
                    row.unsupported_claims = unsupported;
                    row.observations = observations;
                    row.matched = if scenario.positive {
                        supported == 1 && unsupported == 0
                    } else {
                        supported == 0 && unsupported == 0
                    };
                    row.disposition = StrategyCaseDisposition::Observed;
                }
            }
        } else if run.status == CampaignRunStatus::Unknown {
            row.disposition = StrategyCaseDisposition::Unknown;
        } else if run.status == CampaignRunStatus::Cancelled {
            row.disposition = StrategyCaseDisposition::Cancelled;
        }
        if row.disposition != StrategyCaseDisposition::Observed {
            row.error = Some("run_or_fixture_not_fully_observed".into());
        }
        result.push(row);
    }
    result.sort_by_key(|r| r.schedule_index);
    for lane in &completed {
        let phase = &phases[lane_name(*lane)];
        let selected: Vec<_> = result.iter().filter(|r| r.lane == *lane).collect();
        let count = schedule
            .iter()
            .filter(|e| config.plan.scenarios[e.scenario].lane == *lane)
            .count();
        if selected.len() != count {
            return Err(error("completed strategy phase matrix is incomplete"));
        }
        let attachments = store.operation_artifacts(&phase.id)?;
        let digest = attachments
            .get("strategy.matrix")
            .ok_or_else(|| error("strategy matrix artifact absent"))?;
        let bytes = store.artifact_bounded(digest, 1024 * 1024, &mut budget)?;
        if bytes.len() > 1024 * 1024
            || serde_json::from_slice::<Value>(&bytes)? != serde_json::to_value(&selected)?
            || phase.outcome.as_ref().and_then(|v| v.get("matrix_sha256")) != Some(&json!(digest))
        {
            return Err(error("strategy measured matrix witness differs"));
        }
    }
    Ok((result, completed))
}
pub(super) fn report(store: &Store, id: &str) -> Result<StrategyReport, EngineError> {
    let (snapshot, config) = configuration(store, id)?;
    let (rows, completed) = rows(store, &snapshot, &config)?;
    let (mut decision, mut reasons) = oracle::score(&config.plan, &rows, &completed);
    if snapshot.usage.model_reserved_micro_usd > 0
        || snapshot.usage.http_response_reserved_bytes > 0
        || snapshot.usage.active_runs > 0
        || snapshot.usage.unknown_runs > 0
    {
        decision = StrategyDecision::Inconclusive;
        reasons.push("campaign_has_unsettled_work".into());
    }
    if snapshot.usage.model_charged_micro_usd > config.plan.limits.model_micro_usd {
        decision = StrategyDecision::Inconclusive;
        reasons.push("actual_model_charge_exceeded_reserved_envelope".into());
    }
    let evidence_sha256 = hash(&serde_json::to_value(&rows)?)?;
    let mut report = StrategyReport {
        schema_version: 1,
        qualification: "qualification_only".into(),
        campaign_id: id.into(),
        plan_sha256: snapshot.campaign.plan_sha256,
        baseline_sha256: hash(&serde_json::to_value(&config.plan.baseline)?)?,
        candidate_sha256: hash(&serde_json::to_value(&config.plan.candidate)?)?,
        evaluator_version: STRATEGY_ORACLE.into(),
        renderer_version: STRATEGY_RENDERER.into(),
        suite_sha256: suite(&config)?,
        completed_lanes: completed,
        decision,
        reasons,
        case_results: rows,
        usage: snapshot.usage,
        evidence_sha256,
        report_sha256: String::new(),
    };
    report.report_sha256 = hash(&serde_json::to_value(&report)?)?;
    if serde_json::to_vec(&report)?.len() > 1024 * 1024 {
        return Err(error("strategy report exceeds 1 MiB"));
    }
    Ok(report)
}
