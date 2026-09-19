use super::*;
use zero_protocol::{strategy::StrategyCaseResult, strategy_registry::StrategyRegistryBinding};
fn captured(s: &SearchFinalSelection, cfg: &StrategySearchConfiguration) -> bool {
    let b = &s.binding;
    let c = &cfg.capture;
    b.registry == c.registry
        && b.baseline_generation == c.generation
        && b.baseline_epoch == c.epoch
        && b.baseline_state_sha256 == c.state_sha256
        && b.baseline_advisory_sha256 == c.advisory_sha256
        && b.host_policy_sha256 == c.host_policy_sha256
        && b.candidate_generation == s.candidate_generation
        && b.candidate_advisory_sha256 == s.candidate_sha256
}
pub(super) fn raw(conn: &Connection, c: &Campaign) -> Result<Option<SearchFinalSelection>> {
    let row:Option<(String,u64)>=conn.query_row("SELECT CASE WHEN length(CAST(record AS BLOB))<=65536 THEN record END,sequence FROM strategy_search_selections WHERE campaign_id=?1",[&c.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let witnesses: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='strategy_search_final_selected'",
        [&c.journal_session_id],
        |r| r.get(0),
    )?;
    let Some((raw, seq)) = row else {
        if witnesses != 0 {
            return Err(bad("selection projection missing"));
        }
        return Ok(None);
    };
    let s: SearchFinalSelection = serde_json::from_str(&raw)?;
    if witnesses != 1
        || s.sequence != seq
        || s.campaign_id != c.id
        || s.config_sha256 != c.plan.controller_plan_sha256
        || s.schema_version != 1
    {
        return Err(bad("selection identity differs"));
    }
    event(
        conn,
        &c.journal_session_id,
        seq,
        "strategy_search_final_selected",
        &serde_json::to_value(&s)?,
    )?;
    let valid:bool=conn.query_row("SELECT id=?2 AND proposal_id=?3 AND evaluation_id=?4 AND exposure_id=?5 FROM strategy_search_selections WHERE campaign_id=?1",params![c.id,s.id,s.proposal_id,s.evaluation_id,s.exposure_id],|r|r.get(0))?;
    if !valid {
        return Err(bad("selection metadata projection differs"));
    }
    Ok(Some(s))
}
pub(super) fn check_exposure(
    conn: &Connection,
    c: &Campaign,
    cfg: &StrategySearchConfiguration,
) -> Result<()> {
    let rows: u64 = conn.query_row(
        "SELECT count(*) FROM campaign_exposures WHERE campaign_id=?1",
        [&c.id],
        |r| r.get(0),
    )?;
    let events: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='campaign_exposed'",
        [&c.journal_session_id],
        |r| r.get(0),
    )?;
    match raw(conn, c)? {
        None => {
            if rows != 0 || events != 0 {
                return Err(bad("search exposure lacks selection"));
            }
        }
        Some(s) => {
            let policy = cfg
                .plan
                .protected_final
                .as_ref()
                .ok_or_else(|| bad("selection without Final policy"))?;
            let exposed = read::exposure(conn, &c.id, &s.exposure_id)?;
            if rows != 1 + u64::from(s.canary.is_some())
                || events != 1 + u64::from(s.canary.is_some())
                || !captured(&s, cfg)
                || s.suite_sha256 != hash(&search_final_suite_value(policy))?
                || s.suite_sha256 != exposed.suite_sha256
                || s.final_pair_sha256 != exposed.evaluation_pair_sha256
                || s.candidate_sha256 != exposed.finalist_sha256
                || exposed.sequence >= s.sequence
            {
                return Err(bad("selection exposure authority differs"));
            }
            if let Some(canary) = &s.canary {
                let exposed = read::exposure(conn, &c.id, &canary.exposure_id)?;
                if exposed.suite_sha256 != canary.suite_sha256
                    || exposed.evaluation_pair_sha256 != canary.pair_sha256
                    || exposed.finalist_sha256 != s.candidate_sha256
                    || exposed.sequence >= s.sequence
                {
                    return Err(bad("canary exposure differs from sealed commitment"));
                }
            }
        }
    }
    Ok(())
}
pub(super) fn unsealed(conn: &Connection, c: &Campaign) -> Result<()> {
    if raw(conn, c)?.is_some() {
        return Err(bad("search sealed for protected Final"));
    }
    Ok(())
}
fn parsed_selector(op: &Operation) -> Result<String> {
    if op.status != OperationStatus::Succeeded {
        return Err(bad("selector not succeeded"));
    }
    let result: Completion = serde_json::from_value(
        op.outcome
            .clone()
            .ok_or_else(|| bad("selector outcome absent"))?,
    )?;
    if result.status != CompletionStatus::Completed
        || result.error.is_some()
        || !result.usage_is_final
        || result.usage.is_none()
    {
        return Err(bad("selector usage or completion uncertain"));
    }
    let calls: Vec<_> = result
        .content
        .iter()
        .filter_map(|v| {
            if let Content::ToolCall {
                name, arguments, ..
            } = v
            {
                Some((name, arguments))
            } else {
                None
            }
        })
        .collect();
    if calls.len() != 1 || calls[0].0 != "submit_strategy_proposal" {
        return Err(bad("selector requires one native call"));
    }
    let output: SearchProposalOutput = serde_json::from_value(calls[0].1.clone())?;
    output.validate().map_err(|e| bad(&e.to_string()))?;
    match output {
        SearchProposalOutput::SelectFinal { evaluation_id, .. } => Ok(evaluation_id),
        _ => Err(bad("proposal is not an explicit Final selection")),
    }
}
fn matrix(
    conn: &Connection,
    c: &Campaign,
    p: &SearchProposal,
    e: &SearchEvaluation,
    digest: &str,
) -> Result<()> {
    let bytes = artifact(conn, digest, 1024 * 1024)?;
    let cases: Vec<StrategyCaseResult> = serde_json::from_slice(&bytes)?;
    if cases.len() != e.run_count as usize
        || cases.iter().any(|r| {
            r.lane != CampaignLane::Development
                || r.disposition != zero_protocol::strategy::StrategyCaseDisposition::Observed
                || r.model_reserved_micro_usd != 0
        })
    {
        return Err(bad("selected Development matrix incomplete"));
    }
    let linked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM operation_artifacts a JOIN operations o ON o.id=a.operation_id WHERE o.session_id=?1 AND o.command_id=?2 AND a.name=?3 AND a.digest=?4)",params![c.journal_session_id,format!("strategy-search:{}",c.id),format!("search.matrix.{}",e.id),digest],|r|r.get(0))?;
    let (detail_bytes, largest): (u64, u64) = conn.query_row(
        "SELECT COALESCE(sum(length(CAST(payload AS BLOB))),0),COALESCE(max(length(CAST(payload AS BLOB))),0) FROM events WHERE session_id=?1 AND kind='operation_detail' AND sequence<?2",
        params![c.journal_session_id, integer(p.sequence)?], |r| Ok((r.get(0)?, r.get(1)?)))?;
    if detail_bytes > 64 * 1024 * 1024 || largest > 1024 * 1024 {
        return Err(bad("Development matrix witness exceeds read bound"));
    }
    let count:u64=conn.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND kind='operation_detail' AND sequence<?2 AND json_extract(payload,'$.kind')='strategy_search_evaluation_completed' AND json_extract(payload,'$.details.evaluation_id')=?3 AND json_extract(payload,'$.details.matrix_sha256')=?4",params![c.journal_session_id,integer(p.sequence)?,e.id,digest],|r|r.get(0))?;
    if !linked || count != 1 {
        return Err(bad("Development matrix was not witnessed before selector"));
    }
    Ok(())
}
fn validated(
    conn: &Connection,
    c: &Campaign,
    cfg: &StrategySearchConfiguration,
    s: &SearchFinalSelection,
) -> Result<()> {
    if !captured(s, cfg) {
        return Err(bad("selection does not match original registry capture"));
    }
    let pairs = evaluations::list(conn, c)?;
    let e = pairs
        .iter()
        .find(|e| e.id == s.evaluation_id)
        .ok_or_else(|| bad("selected evaluation absent"))?;
    let ps = proposals::list(conn, c)?;
    let (p, op) = ps
        .last()
        .filter(|(p, _)| p.id == s.proposal_id)
        .ok_or_else(|| bad("selected proposal is not last immutable attempt"))?;
    if parsed_selector(op)? != e.id
        || s.candidate_generation != e.candidate_generation
        || s.candidate_sha256 != e.candidate_sha256
        || s.baseline_sha256 != e.baseline_sha256
        || s.schedule_start != pairs.last().map_or(0, |e| e.schedule_start + e.run_count)
    {
        return Err(bad("selection evaluation or global range differs"));
    }
    let policy = cfg
        .plan
        .protected_final
        .as_ref()
        .ok_or_else(|| bad("protected policy absent"))?;
    if s.run_count != policy.scenarios.len() as u32 * policy.repeats * 2
        || s.schedule_start
            .checked_add(s.run_count)
            .is_none_or(|n| n > cfg.plan.limits.runs || n > 128)
        || s.final_pair_sha256
            != hash(
                &json!({"config_sha256":s.config_sha256,"evaluation_id":e.id,"candidate_generation":e.candidate_generation,"candidate_sha256":e.candidate_sha256,"suite_sha256":s.suite_sha256,"binding":s.binding}),
            )?
    {
        return Err(bad("Final matrix authority differs"));
    }
    match (&cfg.plan.protected_canary, &s.canary) {
        (None, None) => {}
        (Some(policy), Some(k)) => {
            let suite = hash(&search_final_suite_value(policy))?;
            let pair = hash(
                &json!({"kind":"independent_canary","final_pair_sha256":s.final_pair_sha256,"suite_sha256":suite}),
            )?;
            if k.suite_sha256 != suite
                || k.pair_sha256 != pair
                || suite == s.suite_sha256
                || k.exposure_id == s.exposure_id
                || k.schedule_start != s.schedule_start + s.run_count
                || k.run_count != policy.scenarios.len() as u32 * policy.repeats * 2
                || k.schedule_start
                    .checked_add(k.run_count)
                    .is_none_or(|n| n > cfg.plan.limits.runs || n > 128)
            {
                return Err(bad("canary commitment differs from captured policy"));
            }
        }
        _ => return Err(bad("canary policy/commitment mismatch")),
    }
    matrix(conn, c, p, e, &s.development_matrix_sha256)?;
    Ok(())
}
pub(super) fn validate_run(
    conn: &Connection,
    c: &Campaign,
    cfg: &StrategySearchConfiguration,
    s: &SearchFinalSelection,
    spec: &CampaignRunSpec,
) -> Result<()> {
    validated(conn, c, cfg, s)?;
    let canary = spec.lane == CampaignLane::Canary;
    let derived = if canary {
        Some(
            s.canary_selection()
                .ok_or_else(|| bad("canary not committed"))?,
        )
    } else {
        None
    };
    let s = derived.as_ref().unwrap_or(s);
    if canary {
        let selected = raw(conn, c)?.ok_or_else(|| bad("selection absent"))?;
        let count: u32 = conn.query_row("SELECT count(*) FROM campaign_runs WHERE campaign_id=?1 AND schedule_index>=?2 AND schedule_index<?3", params![c.id,selected.schedule_start,selected.schedule_start+selected.run_count], |r| r.get(0))?;
        // Full independent scoring is engine-owned; storage requires the entire
        // prior schedule and its immutable completion before fresh canary roots.
        let completed: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='operation_detail' AND json_extract(payload,'$.kind')='strategy_search_final_completed')", [&c.journal_session_id], |r| r.get(0))?;
        let usage = read::usage(conn, c)?;
        if count != selected.run_count
            || !completed
            || usage.active_runs != 0
            || usage.unknown_runs != 0
            || usage.model_reserved_micro_usd != 0
            || usage.http_response_reserved_bytes != 0
        {
            return Err(bad("canary requires completed Final matrix"));
        }
    }
    if spec.schedule_index < s.schedule_start
        || spec.schedule_index >= s.schedule_start + s.run_count
    {
        return Err(bad("sealed search forbids new Development work"));
    }
    let policy = if canary {
        cfg.plan.protected_canary.as_ref()
    } else {
        cfg.plan.protected_final.as_ref()
    }
    .ok_or_else(|| bad("protected policy absent"))?;
    let n = spec.schedule_index - s.schedule_start;
    let per = policy.scenarios.len() as u32 * 2;
    let repeat = n / per;
    let scenario = &policy.scenarios[((n % per) / 2) as usize];
    let variant = if (n % 2 == 0) == (repeat % 2 == 0) {
        CampaignVariant::Baseline
    } else {
        CampaignVariant::Candidate
    };
    let a: StrategyArtifact = serde_json::from_slice(&artifact(
        conn,
        if variant == CampaignVariant::Baseline {
            &s.baseline_sha256
        } else {
            &s.candidate_sha256
        },
        256 * 1024,
    )?)?;
    let request = zero_protocol::strategy_registry::render_strategy_request(
        &cfg.capture.authority.host,
        &a,
        &scenario.public_task,
        &format!("strategy_search_{}_{}", c.id, spec.schedule_index),
        None,
    )
    .map_err(|e| bad(&e.to_string()))?;
    let http = zero_http::normalize_policy(
        search_fixture_profile(&spec.fixture_origin, &cfg.plan.limits)
            .map_err(|e| bad(&e.to_string()))?,
    )
    .map_err(|e| bad(&e.to_string()))?;
    if spec.lane
        != if canary {
            CampaignLane::Canary
        } else {
            CampaignLane::Final
        }
        || spec.exposure_id.as_deref() != Some(&s.exposure_id)
        || spec.repeat_index != repeat
        || spec.variant != variant
        || spec.scenario_id != scenario.id
        || spec.suite_sha256 != s.suite_sha256
        || spec.evaluation_pair_sha256 != s.final_pair_sha256
        || spec.candidate_sha256 != s.candidate_sha256
        || serde_json::to_value(&spec.request)? != serde_json::to_value(request)?
        || serde_json::to_value(&spec.http_policy)? != serde_json::to_value(http)?
        || serde_json::to_value(&spec.provider_context)?
            != serde_json::to_value(&cfg.capture.authority.provider_context)?
    {
        return Err(bad("Final run differs from sealed authority"));
    }
    Ok(())
}
impl Store {
    pub fn search_final_selection(&self, campaign: &str) -> Result<Option<SearchFinalSelection>> {
        let tx = self.conn.unchecked_transaction()?;
        let c = original(&tx, campaign)?;
        let cfg = required(&tx, &c)?;
        let selection = raw(&tx, &c)?;
        if let Some(s) = &selection {
            validated(&tx, &c, &cfg, s)?;
        }
        Ok(selection)
    }
    pub fn select_search_final(
        &mut self,
        campaign: &str,
        proposal_id: &str,
        evaluation_id: &str,
        binding: &StrategyRegistryBinding,
        development_matrix_sha256: &str,
        owner: &str,
    ) -> Result<(SearchFinalSelection, bool)> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let c = original(&tx, campaign)?;
        let cfg = required(&tx, &c)?;
        if let Some(s) = raw(&tx, &c)? {
            validated(&tx, &c, &cfg, &s)?;
            if s.proposal_id != proposal_id
                || s.evaluation_id != evaluation_id
                || s.binding != *binding
                || s.development_matrix_sha256 != development_matrix_sha256
            {
                return Err(bad("Final selection exact retry differs"));
            }
            return Ok((s, true));
        }
        require_epoch(&tx, owner)?;
        open(&tx, campaign)?;
        let policy = cfg
            .plan
            .protected_final
            .as_ref()
            .ok_or_else(|| bad("Final action not authorized"))?;
        let usage = read::usage(&tx, &c)?;
        if usage.active_runs != 0
            || usage.unknown_runs != 0
            || usage.model_reserved_micro_usd != 0
            || usage.http_response_reserved_bytes != 0
            || usage
                .model_charged_micro_usd
                .checked_add(cfg.capture.authority.host.reservation_per_turn)
                .is_none_or(|n| n > cfg.plan.limits.model_micro_usd)
            || usage.model_calls >= u64::from(cfg.plan.limits.model_calls)
        {
            return Err(bad(
                "Final selection requires known work and first-root budget",
            ));
        }
        let ps = proposals::list(&tx, &c)?;
        if ps.iter().any(|(_, o)| {
            matches!(
                o.status,
                OperationStatus::Admitted | OperationStatus::Running | OperationStatus::Unknown
            )
        }) {
            return Err(bad("proposal work is uncertain"));
        }
        let (p, op) = ps
            .last()
            .filter(|(p, o)| p.id == proposal_id && o.owner.as_deref() == Some(owner))
            .ok_or_else(|| bad("selector is not latest owned attempt"))?;
        if parsed_selector(op)? != evaluation_id {
            return Err(bad("selector chose another evaluation"));
        }
        let pairs = evaluations::list(&tx, &c)?;
        let e = pairs
            .iter()
            .find(|e| e.id == evaluation_id)
            .ok_or_else(|| bad("selected evaluation missing"))?;
        for e in &pairs {
            let count:u32=tx.query_row("SELECT count(*) FROM campaign_runs WHERE campaign_id=?1 AND schedule_index>=?2 AND schedule_index<?3",params![c.id,e.schedule_start,e.schedule_start+e.run_count],|r|r.get(0))?;
            if count != e.run_count {
                return Err(bad("prior Development schedule incomplete"));
            }
        }
        let suite = hash(&search_final_suite_value(policy))?;
        let used:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM campaign_exposures WHERE suite_sha256=?1) OR EXISTS(SELECT 1 FROM events WHERE kind='campaign_exposed' AND json_extract(payload,'$.suite_sha256')=?1)",[&suite],|r|r.get(0))?;
        if used {
            return Err(bad("protected suite already exposed"));
        }
        let mut s = SearchFinalSelection {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            campaign_id: campaign.into(),
            proposal_id: proposal_id.into(),
            evaluation_id: evaluation_id.into(),
            candidate_generation: e.candidate_generation.clone(),
            candidate_sha256: e.candidate_sha256.clone(),
            baseline_sha256: e.baseline_sha256.clone(),
            config_sha256: c.plan.controller_plan_sha256.clone(),
            development_matrix_sha256: development_matrix_sha256.into(),
            binding: binding.clone(),
            suite_sha256: suite,
            final_pair_sha256: String::new(),
            schedule_start: pairs.last().map_or(0, |e| e.schedule_start + e.run_count),
            run_count: policy.scenarios.len() as u32 * policy.repeats * 2,
            exposure_id: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
            canary: None,
        };
        s.final_pair_sha256 = hash(
            &json!({"config_sha256":s.config_sha256,"evaluation_id":e.id,"candidate_generation":e.candidate_generation,"candidate_sha256":e.candidate_sha256,"suite_sha256":s.suite_sha256,"binding":s.binding}),
        )?;
        if let Some(policy) = &cfg.plan.protected_canary {
            let suite = hash(&search_final_suite_value(policy))?;
            let used: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM campaign_exposures WHERE suite_sha256=?1) OR EXISTS(SELECT 1 FROM events WHERE kind='campaign_exposed' AND json_extract(payload,'$.suite_sha256')=?1)", [&suite], |r| r.get(0))?;
            if used {
                return Err(bad("canary corpus already exposed"));
            }
            s.canary = Some(SearchCanaryCommitment {
                pair_sha256: hash(
                    &json!({"kind":"independent_canary","final_pair_sha256":s.final_pair_sha256,"suite_sha256":suite}),
                )?,
                suite_sha256: suite,
                schedule_start: s.schedule_start + s.run_count,
                run_count: policy.scenarios.len() as u32 * policy.repeats * 2,
                exposure_id: uuid::Uuid::new_v4().to_string(),
            });
        }
        validated(&tx, &c, &cfg, &s)?;
        matrix(&tx, &c, p, e, development_matrix_sha256)?;
        let exposure = CampaignExposure {
            id: s.exposure_id.clone(),
            campaign_id: campaign.into(),
            command_id: format!("search-final:{campaign}"),
            suite_sha256: s.suite_sha256.clone(),
            evaluation_pair_sha256: s.final_pair_sha256.clone(),
            finalist_sha256: s.candidate_sha256.clone(),
            sequence: next(&tx, &c.journal_session_id)?,
        };
        tx.execute(
            "INSERT INTO campaign_exposures VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                exposure.id,
                campaign,
                exposure.command_id,
                exposure.suite_sha256,
                exposure.evaluation_pair_sha256,
                encode(&exposure)?,
                integer(exposure.sequence)?
            ],
        )?;
        append(
            &tx,
            &c.journal_session_id,
            "campaign_exposed",
            &serde_json::to_value(&exposure)?,
        )?;
        if let Some(k) = &s.canary {
            let exposure = CampaignExposure {
                id: k.exposure_id.clone(),
                campaign_id: campaign.into(),
                command_id: format!("search-canary:{campaign}"),
                suite_sha256: k.suite_sha256.clone(),
                evaluation_pair_sha256: k.pair_sha256.clone(),
                finalist_sha256: s.candidate_sha256.clone(),
                sequence: next(&tx, &c.journal_session_id)?,
            };
            tx.execute(
                "INSERT INTO campaign_exposures VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    exposure.id,
                    campaign,
                    exposure.command_id,
                    exposure.suite_sha256,
                    exposure.evaluation_pair_sha256,
                    encode(&exposure)?,
                    integer(exposure.sequence)?
                ],
            )?;
            append(
                &tx,
                &c.journal_session_id,
                "campaign_exposed",
                &serde_json::to_value(&exposure)?,
            )?;
        }
        s.sequence = next(&tx, &c.journal_session_id)?;
        tx.execute(
            "INSERT INTO strategy_search_selections VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                campaign,
                s.id,
                proposal_id,
                evaluation_id,
                s.exposure_id,
                encode(&s)?,
                integer(s.sequence)?
            ],
        )?;
        append(
            &tx,
            &c.journal_session_id,
            "strategy_search_final_selected",
            &serde_json::to_value(&s)?,
        )?;
        tx.commit()?;
        Ok((s, false))
    }
    pub fn create_search_final_run(
        &mut self,
        selection_id: &str,
        command: &str,
        spec: &CampaignRunSpec,
        owner: &str,
    ) -> Result<(CampaignRun, bool)> {
        let campaign:String=self.conn.query_row("SELECT CASE WHEN length(CAST(campaign_id AS BLOB))<=256 THEN campaign_id END FROM strategy_search_selections WHERE id=?1",[selection_id],|r|r.get(0))?;
        let s = self
            .search_final_selection(&campaign)?
            .ok_or_else(|| bad("Final selection absent"))?;
        if s.id != selection_id {
            return Err(bad("Final selection differs"));
        }
        self.create_campaign_run(&campaign, command, spec, owner)
    }
}
