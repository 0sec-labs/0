use super::*;
pub(super) fn read(conn: &Connection, c: &Campaign, key: &str) -> Result<SearchEvaluation> {
    let (raw,seq):(String,u64)=conn.query_row("SELECT CASE WHEN length(CAST(record AS BLOB))<=1048576 THEN record END,sequence FROM strategy_search_evaluations WHERE campaign_id=?1 AND id=?2",params![c.id,key],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let e: SearchEvaluation = serde_json::from_str(&raw)?;
    if e.id != key
        || e.campaign_id != c.id
        || e.sequence != seq
        || e.config_sha256 != c.plan.controller_plan_sha256
        || e.baseline_sha256 != c.plan.baseline_sha256
    {
        return Err(bad("search evaluation identity differs"));
    }
    event(
        conn,
        &c.journal_session_id,
        seq,
        "strategy_search_evaluation_registered",
        &serde_json::to_value(&e)?,
    )?;
    let valid:bool=conn.query_row("SELECT command_id=?2 AND proposal_id=?3 AND candidate_generation=?4 AND schedule_start=?5 AND run_count=?6 FROM strategy_search_evaluations WHERE id=?1",params![key,e.command_id,e.proposal_id,e.candidate_generation,e.schedule_start,e.run_count],|r|r.get(0))?;
    if !valid {
        return Err(bad("evaluation projection differs"));
    }
    Ok(e)
}
pub(super) fn list(conn: &Connection, c: &Campaign) -> Result<Vec<SearchEvaluation>> {
    let mut q=conn.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM strategy_search_evaluations WHERE campaign_id=?1 ORDER BY schedule_start LIMIT 17")?;
    let ids = q
        .query_map([&c.id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let count:u64=conn.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND kind='strategy_search_evaluation_registered'",[&c.journal_session_id],|r|r.get(0))?;
    if ids.len() > 16 || count != ids.len() as u64 {
        return Err(bad("evaluation index omitted witness"));
    }
    let mut next = 0;
    ids.iter()
        .map(|key| {
            let e = read(conn, c, key)?;
            if e.schedule_start != next {
                return Err(bad("evaluation schedule gap"));
            }
            next = next
                .checked_add(e.run_count)
                .ok_or_else(|| bad("schedule overflow"))?;
            if next > 128 {
                return Err(bad("evaluation schedule exceeds bound"));
            }
            Ok(e)
        })
        .collect()
}
pub(in super::super) fn validate_run(
    conn: &Connection,
    c: &Campaign,
    spec: &CampaignRunSpec,
) -> Result<()> {
    let Some(config) = configuration(conn, c)? else {
        return Ok(());
    };
    if let Some(selected) = selection::raw(conn, c)? {
        return selection::validate_run(conn, c, &config, &selected, spec);
    }
    if proposals::list(conn, c)?.iter().any(|(_, o)| {
        matches!(
            o.status,
            OperationStatus::Running | OperationStatus::Unknown | OperationStatus::Admitted
        )
    }) {
        return Err(bad("proposal unresolved before evaluation"));
    }
    let evaluations = list(conn, c)?;
    let e = evaluations
        .iter()
        .find(|e| {
            spec.schedule_index >= e.schedule_start
                && spec.schedule_index < e.schedule_start + e.run_count
        })
        .ok_or_else(|| bad("run has no immutable evaluation slot"))?;
    let n = spec.schedule_index - e.schedule_start;
    let per_repeat = config.plan.scenarios.len() as u32 * 2;
    let repeat = n / per_repeat;
    let scenario = &config.plan.scenarios[((n % per_repeat) / 2) as usize];
    let variant = if (n % 2 == 0) == (repeat % 2 == 0) {
        CampaignVariant::Baseline
    } else {
        CampaignVariant::Candidate
    };
    let advice: StrategyArtifact = serde_json::from_slice(&artifact(
        conn,
        if variant == CampaignVariant::Baseline {
            &e.baseline_sha256
        } else {
            &e.candidate_sha256
        },
        256 * 1024,
    )?)?;
    let request = zero_protocol::strategy_registry::render_strategy_request(
        &config.capture.authority.host,
        &advice,
        &scenario.public_task,
        &format!("strategy_search_{}_{}", c.id, spec.schedule_index),
        None,
    )
    .map_err(|e| bad(&e.to_string()))?;
    let policy = zero_http::normalize_policy(
        search_fixture_profile(&spec.fixture_origin, &config.plan.limits)
            .map_err(|e| bad(&e.to_string()))?,
    )
    .map_err(|e| bad(&e.to_string()))?;
    if spec.lane != CampaignLane::Development
        || spec.exposure_id.is_some()
        || spec.repeat_index != repeat
        || spec.variant != variant
        || spec.scenario_id != scenario.id
        || spec.suite_sha256 != hash(&serde_json::to_value(&config.plan.scenarios)?)?
        || spec.evaluation_pair_sha256 != e.evaluation_pair_sha256
        || spec.candidate_sha256 != e.candidate_sha256
        || serde_json::to_value(&spec.request)? != serde_json::to_value(request)?
        || serde_json::to_value(&spec.provider_context)?
            != serde_json::to_value(&config.capture.authority.provider_context)?
        || serde_json::to_value(&spec.http_policy)? != serde_json::to_value(policy)?
    {
        return Err(bad(
            "search run differs from frozen pair schedule or authority",
        ));
    }
    Ok(())
}
fn proposed(op: &Operation) -> Result<StrategyArtifact> {
    if op.status != OperationStatus::Succeeded {
        return Err(bad("candidate proposal did not succeed"));
    }
    let completion: Completion = serde_json::from_value(
        op.outcome
            .clone()
            .ok_or_else(|| bad("proposal outcome absent"))?,
    )?;
    if completion.status != CompletionStatus::Completed
        || completion.error.is_some()
        || !completion.usage_is_final
        || completion.usage.is_none()
    {
        return Err(bad("proposal completion is not authoritative"));
    }
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|c| {
            if let Content::ToolCall {
                name, arguments, ..
            } = c
            {
                Some((name, arguments))
            } else {
                None
            }
        })
        .collect();
    if calls.len() != 1 || calls[0].0 != "submit_strategy_proposal" {
        return Err(bad("proposal must submit one native decision"));
    }
    let output: SearchProposalOutput = serde_json::from_value(calls[0].1.clone())?;
    output.validate().map_err(|e| bad(&e.to_string()))?;
    match output {
        SearchProposalOutput::Propose { advisory, .. } => Ok(advisory),
        _ => Err(bad("stop decision is not a candidate")),
    }
}
impl Store {
    pub fn search_evaluations(&self, campaign: &str) -> Result<Vec<SearchEvaluation>> {
        let tx = self.conn.unchecked_transaction()?;
        let c = original(&tx, campaign)?;
        required(&tx, &c)?;
        list(&tx, &c)
    }
    pub fn search_evaluation(&self, campaign: &str, key: &str) -> Result<SearchEvaluation> {
        let tx = self.conn.unchecked_transaction()?;
        let c = original(&tx, campaign)?;
        required(&tx, &c)?;
        read(&tx, &c, key)
    }
    pub fn search_candidates(
        &self,
        campaign: &str,
        after: u64,
        limit: u32,
    ) -> Result<SearchCandidatePage> {
        if !(1..=100).contains(&limit) {
            return Err(bad("candidate page limit1..100"));
        }
        let mut all = self.search_evaluations(campaign)?;
        all.retain(|e| e.sequence > after);
        let more = all.len() > limit as usize;
        all.truncate(limit as usize);
        let next = if more {
            all.last().map(|e| e.sequence)
        } else {
            None
        };
        Ok(SearchCandidatePage {
            candidates: all,
            next_after_sequence: next,
        })
    }
    pub fn register_search_evaluation(
        &mut self,
        campaign: &str,
        command: &str,
        proposal_id: &str,
        candidate_generation: &str,
        advisory: &StrategyArtifact,
    ) -> Result<(SearchEvaluation, bool)> {
        id(command)?;
        advisory.validate().map_err(|e| bad(&e.to_string()))?;
        if !zero_protocol::is_sha256(candidate_generation) {
            return Err(bad("candidate generation digest invalid"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let c = original(&tx, campaign)?;
        let config = required(&tx, &c)?;
        let candidates = list(&tx, &c)?;
        let candidate_sha256 = hash(&serde_json::to_value(advisory)?)?;
        if let Some(e) = candidates.iter().find(|e| e.command_id == command) {
            if e.proposal_id != proposal_id
                || e.candidate_generation != candidate_generation
                || e.candidate_sha256 != candidate_sha256
            {
                return Err(bad("candidate command reused"));
            }
            return Ok((e.clone(), true));
        }
        selection::unsealed(&tx, &c)?;
        open(&tx, campaign)?;
        if candidates.len() >= config.plan.max_candidates as usize
            || candidate_sha256 == c.plan.baseline_sha256
            || candidates
                .iter()
                .any(|e| e.candidate_sha256 == candidate_sha256)
        {
            return Err(bad("candidate limit or duplicate advisory"));
        }
        let p = proposals::list(&tx, &c)?;
        if p.last().is_none_or(|(p, _)| p.id != proposal_id) {
            return Err(bad("candidate must belong to the latest proposal"));
        }
        let (proposal, op) = p
            .iter()
            .find(|(p, _)| p.id == proposal_id)
            .ok_or_else(|| bad("candidate proposal absent"))?;
        if serde_json::to_value(proposed(op)?)? != serde_json::to_value(advisory)?
            || config
                .plan
                .scenarios
                .iter()
                .chain(
                    config
                        .plan
                        .protected_final
                        .iter()
                        .flat_map(|p| &p.scenarios)
                        .chain(
                            config
                                .plan
                                .protected_canary
                                .iter()
                                .flat_map(|p| &p.scenarios),
                        ),
                )
                .any(|s| advisory.advisory_utf8.contains(&s.marker))
        {
            return Err(bad("candidate does not match exact permitted proposal"));
        }
        let run_count = config.plan.scenarios.len() as u32 * config.plan.repeats * 2;
        let start = candidates
            .last()
            .map_or(0, |e| e.schedule_start + e.run_count);
        if start
            .checked_add(run_count)
            .is_none_or(|n| n > config.plan.limits.runs || n > 128)
        {
            return Err(Error::BudgetExceeded);
        }
        let seq = next(&tx, &c.journal_session_id)?;
        let e = SearchEvaluation {
            id: uuid::Uuid::new_v4().to_string(),
            campaign_id: campaign.into(),
            command_id: command.into(),
            proposal_id: proposal_id.into(),
            candidate_generation: candidate_generation.into(),
            candidate_sha256: candidate_sha256.clone(),
            baseline_sha256: c.plan.baseline_sha256.clone(),
            evaluation_pair_sha256: hash(
                &json!({"search_config_sha256":c.plan.controller_plan_sha256,"proposal_operation_id":proposal.operation_id,"candidate_generation":candidate_generation,"candidate_sha256":candidate_sha256}),
            )?,
            config_sha256: c.plan.controller_plan_sha256.clone(),
            schedule_start: start,
            run_count,
            sequence: seq,
        };
        for a in [advisory, &config.capture.advisory] {
            let bytes = encode(a)?;
            let digest = hash(&serde_json::to_value(a)?)?;
            tx.execute(
                "INSERT OR IGNORE INTO artifacts VALUES(?1,?2)",
                params![digest, bytes.as_bytes()],
            )?;
            if artifact(&tx, &digest, 256 * 1024)? != bytes.as_bytes() {
                return Err(bad("candidate artifact collision"));
            }
        }
        tx.execute(
            "INSERT INTO strategy_search_evaluations VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                e.id,
                campaign,
                command,
                proposal_id,
                candidate_generation,
                start,
                run_count,
                encode(&e)?,
                integer(seq)?
            ],
        )?;
        append(
            &tx,
            &c.journal_session_id,
            "strategy_search_evaluation_registered",
            &serde_json::to_value(&e)?,
        )?;
        tx.commit()?;
        Ok((e, false))
    }
    pub fn create_search_evaluation_run(
        &mut self,
        evaluation: &str,
        command: &str,
        spec: &CampaignRunSpec,
        owner: &str,
    ) -> Result<(CampaignRun, bool)> {
        let campaign:String=self.conn.query_row("SELECT CASE WHEN length(CAST(campaign_id AS BLOB))<=256 THEN campaign_id END FROM strategy_search_evaluations WHERE id=?1",[evaluation],|r|r.get(0))?;
        let e = self.search_evaluation(&campaign, evaluation)?;
        if spec.schedule_index < e.schedule_start
            || spec.schedule_index >= e.schedule_start + e.run_count
        {
            return Err(bad("evaluation run outside allocated range"));
        }
        self.create_campaign_run(&campaign, command, spec, owner)
    }
}
