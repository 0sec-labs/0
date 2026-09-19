use super::super::controller::{Active, Guard, Waiter, cleanup};
use super::*;
use futures_util::FutureExt;
use std::panic::AssertUnwindSafe;
fn current(shared: &Shared, c: &StrategySearchConfiguration) -> Result<(), EngineError> {
    let harness = lock(&shared.strategy_runtime)?;
    let capture = harness
        .as_ref()
        .ok_or_else(|| error("strategy runtime not configured"))?
        .strategy_capture()
        .map_err(error)?;
    if serde_json::to_value(capture)? != serde_json::to_value(&c.capture)? {
        return Err(error("search baseline registry capture changed"));
    }
    let profiles = lock(&shared.providers)?;
    let proposer = (c.plan.proposer.provider.clone(), c.proposer_context.clone());
    for (name, pin) in c
        .capture
        .authority
        .provider_context
        .iter()
        .map(|(n, p)| (n.clone(), p.clone()))
        .chain(std::iter::once(proposer))
    {
        let p = profiles
            .get(&name)
            .ok_or_else(|| error("search provider not configured"))?;
        let actual = CampaignProviderContext {
            endpoint: p.client.endpoint_identity().into(),
            wire_api: p.client.wire_api(),
            rates: p.rates,
            hosted_catalog: p.client.hosted_catalog().cloned(),
        };
        if serde_json::to_value(actual)? != serde_json::to_value(pin)? {
            return Err(error("search provider authority changed"));
        }
    }
    Ok(())
}
impl Engine {
    pub(crate) fn create_strategy_search(
        &self,
        command: String,
        plan: StrategySearchPlan,
    ) -> Result<Reply, EngineError> {
        {
            let store = lock(&self.shared.store)?;
            if let Some(old) = store.campaign_by_command(&command)? {
                let c = store.search_configuration(&old.id)?;
                if serde_json::to_value(&c.plan)? != serde_json::to_value(&plan)? {
                    return Err(error("search create retry differs"));
                }
                return Ok(Reply::StrategySearchCreated {
                    snapshot: store.search_snapshot(&old.id)?,
                    duplicate: true,
                });
            }
        }
        let control = lock(&self.shared.control)?;
        if control.closing {
            return Err(error("engine shutting down"));
        }
        let capture = lock(&self.shared.strategy_runtime)?
            .as_ref()
            .ok_or_else(|| error("strategy runtime not configured"))?
            .strategy_capture()
            .map_err(error)?;
        let profiles = lock(&self.shared.providers)?;
        let p = profiles
            .get(&plan.proposer.provider)
            .ok_or_else(|| error("search proposer profile not configured"))?;
        let proposer_context = CampaignProviderContext {
            endpoint: p.client.endpoint_identity().into(),
            wire_api: p.client.wire_api(),
            rates: p.rates,
            hosted_catalog: p.client.hosted_catalog().cloned(),
        };
        drop(profiles);
        let config = StrategySearchConfiguration {
            kind: "strategy_search".into(),
            schema_version: plan.schema_version,
            plan,
            capture,
            proposer_context,
        };
        validate(&config)?;
        current(&self.shared, &config)?;
        lock(&self.shared.providers)?
            .get(&config.plan.proposer.provider)
            .ok_or_else(|| error("proposer absent"))?
            .validate(&render_search_proposal(&config, 0, None).map_err(error)?)?;
        let mut store = lock(&self.shared.store)?;
        let (campaign, duplicate) = store.create_strategy_search(&command, &config)?;
        Ok(Reply::StrategySearchCreated {
            snapshot: store.search_snapshot(&campaign.id)?,
            duplicate,
        })
    }
    pub(crate) fn strategy_search_status(&self, campaign: String) -> Result<Reply, EngineError> {
        Ok(Reply::StrategySearchStatus {
            snapshot: lock(&self.shared.store)?.search_snapshot(&campaign)?,
        })
    }
    pub(crate) fn strategy_search_candidates(
        &self,
        campaign: String,
        after: u64,
        limit: u32,
    ) -> Result<Reply, EngineError> {
        Ok(Reply::StrategySearchCandidates {
            page: lock(&self.shared.store)?.search_candidates(&campaign, after, limit)?,
        })
    }
    pub(crate) fn strategy_search_candidate(
        &self,
        campaign: String,
        candidate: String,
    ) -> Result<Reply, EngineError> {
        let report = provenance::report(&*lock(&self.shared.store)?, &campaign)?;
        Ok(Reply::StrategySearchCandidate {
            candidate: report
                .evaluations
                .into_iter()
                .find(|e| e.evaluation.id == candidate)
                .ok_or_else(|| error("search candidate absent"))?,
        })
    }
    pub(crate) fn strategy_search_report(&self, campaign: String) -> Result<Reply, EngineError> {
        Ok(Reply::StrategySearchReport {
            report: provenance::report(&*lock(&self.shared.store)?, &campaign)?,
        })
    }
    pub(crate) fn cancel_strategy_search(&self, campaign: String) -> Result<Reply, EngineError> {
        let control = lock(&self.shared.control)?;
        let mut store = lock(&self.shared.store)?;
        store.search_configuration(&campaign)?;
        store.cancel_campaign(&campaign)?;
        if let Some(token) = control.strategy_campaigns.get(&campaign) {
            token.cancel();
        }
        Ok(Reply::StrategySearchCancelled {
            snapshot: store.search_snapshot(&campaign)?,
        })
    }
    pub(crate) async fn run_strategy_search(
        &self,
        campaign: String,
        events: mpsc::Sender<ExecutionEvent>,
        progress: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<Reply, EngineError> {
        let (rx, cancel) = {
            let mut control = lock(&self.shared.control)?;
            if control.closing {
                return Err(error("engine shutting down"));
            }
            let mut store = lock(&self.shared.store)?;
            let snapshot = store.search_snapshot(&campaign)?;
            let config = store.search_configuration(&campaign)?;
            validate(&config)?;
            match store.get_operation_by_command(
                &snapshot.campaign.campaign.journal_session_id,
                &command(&campaign),
            ) {
                Ok(op) => {
                    if op.payload != payload(&snapshot.campaign) {
                        return Err(error("search controller identity differs"));
                    }
                    if matches!(
                        op.status,
                        OperationStatus::Running | OperationStatus::Admitted
                    ) {
                        return Err(error("search already running"));
                    }
                    return Ok(Reply::StrategySearchReport {
                        report: provenance::report(&store, &campaign)?,
                    });
                }
                Err(zero_store::Error::NotFound(_)) => {}
                Err(e) => return Err(e.into()),
            }
            if snapshot.campaign.campaign.status != CampaignStatus::Open
                || now() >= config.plan.expires_at_ms
            {
                return Err(error("search closed or expired"));
            }
            if control.strategy_campaigns.contains_key(&campaign)
                || control.strategy_campaigns.len() >= 8
            {
                return Err(error("search active capacity exceeded"));
            }
            current(&self.shared, &config)?;
            let op = store
                .admit_owned_batch(
                    &snapshot.campaign.campaign.journal_session_id,
                    &self.shared.owner,
                    &[(command(&campaign), payload(&snapshot.campaign))],
                )?
                .remove(0);
            let cancel = CancellationToken::new();
            control
                .strategy_campaigns
                .insert(campaign.clone(), cancel.clone());
            let guard = Guard::new(
                self.shared.clone(),
                campaign.clone(),
                op.id.clone(),
                cancel.clone(),
            );
            let shared = self.shared.clone();
            let token = cancel.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let result =
                    worker(&shared, &campaign, &op, &config, &token, events, progress).await;
                let mut guard = guard;
                guard.settled = result.is_ok();
                drop(guard);
                let _ = tx.send(result);
            });
            (rx, cancel)
        };
        let mut waiter = Waiter {
            cancel,
            finished: false,
        };
        let result = rx
            .await
            .map_err(|_| error("search worker stopped without result"))?;
        waiter.finished = true;
        result
    }
}
#[allow(clippy::too_many_arguments)]
async fn worker(
    shared: &Arc<Shared>,
    campaign: &str,
    op: &Operation,
    c: &StrategySearchConfiguration,
    cancel: &CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    progress: Option<mpsc::Sender<ExecutionEvent>>,
) -> Result<Reply, EngineError> {
    let mut active = Active::default();
    let result = AssertUnwindSafe(run(
        shared,
        campaign,
        op,
        c,
        cancel,
        events,
        progress,
        &mut active,
    ))
    .catch_unwind()
    .await;
    let (reason, failed) = match result {
        Ok(Ok(reason)) => (reason, false),
        Ok(Err(_)) => ("search_stopped_by_authority_or_budget".into(), true),
        Err(_) => ("search_controller_panicked".into(), true),
    };
    let cancelled = cancel.is_cancelled();
    if failed || cancelled {
        cancel.cancel();
        lock(&shared.store)?.cancel_campaign(campaign)?;
    }
    let clean = cleanup(shared, &mut active).await;
    let mut store = lock(&shared.store)?;
    for (_, proposal) in store.search_proposals(campaign)? {
        if matches!(
            proposal.status,
            OperationStatus::Running | OperationStatus::Admitted
        ) {
            store.mark_operation_unknown(
                &proposal.id,
                &shared.owner,
                "owned search proposer ended without settlement",
            )?;
        }
    }
    let snapshot = store.search_snapshot(campaign)?;
    let uncertain = clean.is_err()
        || snapshot.unknown_proposals > 0
        || snapshot.active_proposals > 0
        || snapshot.campaign.usage.model_reserved_micro_usd > 0
        || snapshot.campaign.usage.http_response_reserved_bytes > 0
        || snapshot.campaign.usage.unknown_runs > 0
        || reason == "search_controller_panicked";
    if uncertain {
        store.mark_operation_unknown(&op.id, &shared.owner, "search has uncertain owned work")?;
    } else {
        let status = if cancelled {
            OperationStatus::Cancelled
        } else if failed {
            OperationStatus::Failed
        } else {
            OperationStatus::Succeeded
        };
        store.settle_operation(
            &op.id,
            &shared.owner,
            status,
            &json!({"qualification":if c.plan.schema_version==1{"development_only"}else{"adaptive_search_fixture"},"stop_reason":reason}),
        )?;
    }
    Ok(Reply::StrategySearchReport {
        report: provenance::report(&store, campaign)?,
    })
}
#[allow(clippy::too_many_arguments)]
async fn run(
    shared: &Arc<Shared>,
    campaign: &str,
    op: &Operation,
    c: &StrategySearchConfiguration,
    cancel: &CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    progress: Option<mpsc::Sender<ExecutionEvent>>,
    active: &mut Active,
) -> Result<String, EngineError> {
    for index in 0..c.plan.max_proposals {
        if cancel.is_cancelled() || now() >= c.plan.expires_at_ms {
            return Err(error("search cancelled or expired"));
        }
        current(shared, c)?;
        let (proposal, operation, req) = {
            let mut store = lock(&shared.store)?;
            let report = provenance::report(&store, campaign)?;
            if c.plan.schema_version == 1
                && report.evaluations.len() >= c.plan.max_candidates as usize
            {
                return Ok("candidate_limit_reached".into());
            }
            if report.usage.model_reserved_micro_usd > 0
                || report.usage.http_response_reserved_bytes > 0
                || report.usage.unknown_runs > 0
            {
                return Ok("unsettled_work".into());
            }
            let feedback = if index == 0 {
                None
            } else {
                Some(provenance::feedback(&report, index))
            };
            if feedback.as_ref().is_some_and(|v| {
                scenarios(c)
                    .iter()
                    .any(|s| render::has_marker(v, &s.marker))
            }) {
                return Err(error("private marker in proposal feedback"));
            }
            let digest = if let Some(v) = &feedback {
                Some(store.retain_operation_artifact(
                    &op.id,
                    &shared.owner,
                    &format!("search.feedback.{index}"),
                    &serde_json::to_vec(v)?,
                )?)
            } else {
                None
            };
            let req = render_search_proposal(c, index, feedback).map_err(error)?;
            lock(&shared.providers)?
                .get(&c.plan.proposer.provider)
                .ok_or_else(|| error("proposer absent"))?
                .validate(&req)?;
            let (p, o, duplicate) = store.admit_search_proposal(
                campaign,
                &shared.owner,
                index,
                &req,
                digest.as_deref(),
            )?;
            if duplicate {
                return Err(error("automatic proposer replay forbidden"));
            }
            (p, o, req)
        };
        let profile = lock(&shared.providers)?
            .get(&c.plan.proposer.provider)
            .cloned()
            .ok_or_else(|| error("proposer profile absent"))?;
        let inference = inference::run_inference(
            shared,
            &proposal.session_id,
            &operation.id,
            profile,
            req,
            cancel.child_token(),
            progress.clone(),
            Some(&op.id),
        );
        tokio::pin!(inference);
        tokio::select! {result=&mut inference=>{result?;},_=tokio::time::sleep(std::time::Duration::from_millis(c.plan.expires_at_ms.saturating_sub(now())))=>{cancel.cancel();inference.await?;}}
        let settled = lock(&shared.store)?.get_operation(&operation.id)?;
        if cancel.is_cancelled() {
            return Err(error("search cancelled"));
        }
        let output = match parsed(c, &settled) {
            Ok(value) => value,
            Err(_) => {
                if settled.status == OperationStatus::Unknown {
                    return Ok("unknown_proposal".into());
                }
                continue;
            }
        };
        match output {
            SearchProposalOutput::Stop { .. } => return Ok("model_chose_stop".into()),
            SearchProposalOutput::SelectFinal { evaluation_id, .. } => {
                let selected =
                    final_selection::select(shared, campaign, op, c, &proposal, &evaluation_id)?;
                let Some((selection, evaluation, advisory)) = selected else {
                    continue;
                };
                evaluate(
                    shared,
                    campaign,
                    op,
                    c,
                    &evaluation,
                    &advisory,
                    Some(&selection),
                    cancel,
                    events.clone(),
                    progress.clone(),
                    active,
                )
                .await?;
                if let Some(canary) = selection.canary_selection() {
                    let report = provenance::report(&*lock(&shared.store)?, campaign)?;
                    if report
                        .final_measurement
                        .as_ref()
                        .is_some_and(|r| r.decision == StrategyDecision::ImprovedForFixtureSuite)
                    {
                        evaluate(
                            shared,
                            campaign,
                            op,
                            c,
                            &evaluation,
                            &advisory,
                            Some(&canary),
                            cancel,
                            events.clone(),
                            progress.clone(),
                            active,
                        )
                        .await?;
                    }
                }
                return Ok("model_selected_final".into());
            }
            SearchProposalOutput::Propose { advisory, .. } => {
                if lock(&shared.store)?.search_evaluations(campaign)?.len()
                    >= c.plan.max_candidates as usize
                {
                    continue;
                }
                if advisory.advisory_utf8 == c.capture.advisory.advisory_utf8 {
                    continue;
                }
                let digest = hash(&serde_json::to_value(&advisory)?)?;
                if lock(&shared.store)?
                    .search_evaluations(campaign)?
                    .iter()
                    .any(|e| e.candidate_sha256 == digest)
                {
                    continue;
                }
                current(shared, c)?;
                let registration = lock(&shared.strategy_runtime)?
                    .as_mut()
                    .ok_or_else(|| error("strategy runtime absent"))?
                    .register_strategy_candidate(&c.capture.generation, &advisory)
                    .map_err(error)?;
                let (evaluation, duplicate) = lock(&shared.store)?.register_search_evaluation(
                    campaign,
                    &format!("search-pair:{campaign}:{index}"),
                    &proposal.id,
                    &registration.candidate_generation,
                    &advisory,
                )?;
                if duplicate {
                    return Err(error("automatic evaluation replay forbidden"));
                }
                evaluate(
                    shared,
                    campaign,
                    op,
                    c,
                    &evaluation,
                    &advisory,
                    None,
                    cancel,
                    events.clone(),
                    progress.clone(),
                    active,
                )
                .await?;
            }
        }
    }
    Ok("proposal_limit_reached".into())
}
#[allow(clippy::too_many_arguments)]
async fn evaluate(
    shared: &Arc<Shared>,
    campaign: &str,
    op: &Operation,
    c: &StrategySearchConfiguration,
    evaluation: &SearchEvaluation,
    advisory: &StrategyArtifact,
    selection: Option<&SearchFinalSelection>,
    cancel: &CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    progress: Option<mpsc::Sender<ExecutionEvent>>,
    active: &mut Active,
) -> Result<(), EngineError> {
    let canary = selection.is_some_and(|s| {
        c.plan.protected_canary.as_ref().is_some_and(|p| {
            hash(&search_final_suite_value(p)).ok().as_ref() == Some(&s.suite_sha256)
        })
    });
    let (cases, repeats, start) = if let Some(selection) = selection {
        let policy = if canary {
            c.plan.protected_canary.as_ref()
        } else {
            c.plan.protected_final.as_ref()
        }
        .ok_or_else(|| error("protected policy absent"))?;
        (&policy.scenarios, policy.repeats, selection.schedule_start)
    } else {
        (&c.plan.scenarios, c.plan.repeats, evaluation.schedule_start)
    };
    for entry in render::schedule_cases(cases, repeats) {
        if cancel.is_cancelled() || now() >= c.plan.expires_at_ms {
            return Err(error("search stopped"));
        }
        current(shared, c)?;
        let index = start + entry.index;
        active.fixture = Some(fixture::Fixture::bind().await?);
        let origin = active
            .fixture
            .as_ref()
            .ok_or_else(|| error("fixture absent"))?
            .origin
            .clone();
        let policy = zero_http::normalize_policy(
            search_fixture_profile(&origin, &c.plan.limits).map_err(error)?,
        )
        .map_err(error)?;
        let name = profile_name(campaign, index);
        active.profile = Some(name.clone());
        lock(&shared.http)?.insert(
            name.clone(),
            Arc::new(zero_http::Client::new(policy.clone(), None).map_err(error)?),
        );
        let scenario = &cases[entry.scenario];
        let artifact = if entry.variant == CampaignVariant::Baseline {
            &c.capture.advisory
        } else {
            advisory
        };
        let request = request(c, artifact, scenario, &name)?;
        let spec = CampaignRunSpec {
            candidate_sha256: evaluation.candidate_sha256.clone(),
            suite_sha256: if let Some(s) = selection {
                s.suite_sha256.clone()
            } else {
                hash(&serde_json::to_value(&c.plan.scenarios)?)?
            },
            evaluation_pair_sha256: if let Some(s) = selection {
                s.final_pair_sha256.clone()
            } else {
                evaluation.evaluation_pair_sha256.clone()
            },
            schedule_index: index,
            lane: scenario.lane,
            scenario_id: scenario.id.clone(),
            repeat_index: entry.repeat,
            variant: entry.variant,
            fixture_origin: origin,
            request: request.clone(),
            provider_context: c.capture.authority.provider_context.clone(),
            http_policy: policy,
            exposure_id: selection.map(|s| s.exposure_id.clone()),
        };
        let (run, duplicate) = if let Some(selection) = selection {
            lock(&shared.store)?.create_search_final_run(
                &selection.id,
                &format!("search-final-case:{campaign}:{index}"),
                &spec,
                &shared.owner,
            )?
        } else {
            lock(&shared.store)?.create_search_evaluation_run(
                &evaluation.id,
                &format!("search-case:{campaign}:{index}"),
                &spec,
                &shared.owner,
            )?
        };
        if duplicate {
            return Err(error("automatic actor replay forbidden"));
        }
        active.session = Some(run.session_id.clone());
        active
            .fixture
            .as_mut()
            .ok_or_else(|| error("fixture absent"))?
            .start(scenario.clone())?;
        let actor = agent::run_agent_shared(
            shared,
            run.session_id.clone(),
            run.run_command_id.clone(),
            request,
            events.clone(),
            progress.clone(),
            None,
        );
        tokio::pin!(actor);
        let result = tokio::select! {biased;_=cancel.cancelled()=>{lock(&shared.store)?.cancel_campaign(campaign)?;if let Some(root)=lock(&shared.control)?.active.get(&run.session_id){root.cancel.cancel();}actor.await},_=tokio::time::sleep(std::time::Duration::from_millis(c.plan.expires_at_ms.saturating_sub(now())))=>{cancel.cancel();lock(&shared.store)?.cancel_campaign(campaign)?;if let Some(root)=lock(&shared.control)?.active.get(&run.session_id){root.cancel.cancel();}actor.await},result=&mut actor=>result};
        if result.is_err() {
            let mut store = lock(&shared.store)?;
            let current = store.campaign_run(campaign, &run.id)?;
            if current.operation_id.is_none() && current.status == CampaignRunStatus::Pending {
                store.settle_campaign_run_without_root(
                    campaign,
                    &run.id,
                    &shared.owner,
                    if cancel.is_cancelled() {
                        CampaignRunStatus::Cancelled
                    } else {
                        CampaignRunStatus::Failed
                    },
                    "search actor admission failed",
                )?;
            }
        }
        let clean = cleanup(shared, active).await;
        lock(&shared.store)?.append_operation_event(
            &op.id,
            &shared.owner,
            "strategy_fixture_closed",
            &json!({"run_id":run.id,"schedule_index":index,"confirmed":clean.is_ok()}),
        )?;
        clean?;
        if lock(&shared.store)?.campaign_run(campaign, &run.id)?.status
            == CampaignRunStatus::Unknown
            || cancel.is_cancelled()
        {
            return Err(error("search actor outcome uncertain or cancelled"));
        }
    }
    let mut store = lock(&shared.store)?;
    let report = provenance::report(&store, campaign)?;
    let cases = if selection.is_some() {
        &if canary {
            report.canary_measurement.as_ref()
        } else {
            report.final_measurement.as_ref()
        }
        .ok_or_else(|| error("protected report absent"))?
        .cases
    } else {
        &report
            .evaluations
            .iter()
            .find(|e| e.evaluation.id == evaluation.id)
            .ok_or_else(|| error("evaluation absent"))?
            .cases
    };
    let name = if selection.is_some() {
        if canary {
            "search.canary.matrix"
        } else {
            "search.final.matrix"
        }
        .into()
    } else {
        format!("search.matrix.{}", evaluation.id)
    };
    let digest = store.retain_operation_artifact(
        &op.id,
        &shared.owner,
        &name,
        &serde_json::to_vec(cases)?,
    )?;
    if let Some(selection) = selection {
        store.append_operation_event(
            &op.id,
            &shared.owner,
            if canary {
                "strategy_search_canary_completed"
            } else {
                "strategy_search_final_completed"
            },
            &json!({"selection_id":selection.id,"matrix_sha256":digest}),
        )?;
    } else {
        store.append_operation_event(
            &op.id,
            &shared.owner,
            "strategy_search_evaluation_completed",
            &json!({"evaluation_id":evaluation.id,"matrix_sha256":digest}),
        )?;
    }
    Ok(())
}
