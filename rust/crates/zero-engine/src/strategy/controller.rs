use super::*;
use futures_util::FutureExt;
use std::panic::AssertUnwindSafe;
use tokio::sync::oneshot;
use zero_protocol::{Operation, session::OperationStatus};

fn provider_context(
    shared: &Shared,
    plan: &StrategyPlan,
) -> Result<BTreeMap<String, CampaignProviderContext>, EngineError> {
    let profiles = lock(&shared.providers)?;
    let mut names = vec![plan.host.provider.as_str()];
    if let Some(policy) = &plan.host.delegation_policy {
        names.extend(policy.roles.iter().map(|r| r.provider.as_str()));
    }
    let mut captured = BTreeMap::new();
    for name in names {
        let profile = profiles
            .get(name)
            .ok_or_else(|| error("strategy provider profile is not configured"))?;
        captured.insert(
            name.into(),
            CampaignProviderContext {
                endpoint: profile.client.endpoint_identity().into(),
                wire_api: profile.client.wire_api(),
                rates: profile.rates,
                hosted_catalog: profile.client.hosted_catalog().cloned(),
            },
        );
    }
    Ok(captured)
}
impl Engine {
    pub(crate) fn create_strategy_campaign(
        &self,
        command: String,
        plan: StrategyPlan,
    ) -> Result<Reply, EngineError> {
        self.create_strategy_campaign_inner(command, plan, None)
    }
    pub(crate) fn create_bound_strategy_campaign(
        &self,
        command: String,
        plan: StrategyPlan,
        candidate_generation: String,
    ) -> Result<Reply, EngineError> {
        self.create_strategy_campaign_inner(command, plan, Some(candidate_generation))
    }
    fn create_strategy_campaign_inner(
        &self,
        command: String,
        plan: StrategyPlan,
        candidate: Option<String>,
    ) -> Result<Reply, EngineError> {
        {
            let store = lock(&self.shared.store)?;
            if let Some(prior) = store.campaign_by_command(&command)? {
                let (snapshot, old) = provenance::configuration(&store, &prior.id)?;
                binding::match_retry(&old, candidate.as_deref())?;
                if serde_json::to_value(&old.plan)? != serde_json::to_value(&plan)? {
                    return Err(error("strategy create command reused with changed plan"));
                }
                return Ok(Reply::StrategyCampaignCreated {
                    campaign: snapshot,
                    duplicate: true,
                });
            }
        }
        plan.validate().map_err(error)?;
        render::validate_public_inputs(&plan)?;
        if plan.expires_at_ms <= now() {
            return Err(error("strategy campaign has expired"));
        }
        let control = lock(&self.shared.control)?;
        if control.closing {
            return Err(error("engine is shutting down"));
        }
        let mut config = Configuration {
            provider_context: provider_context(&self.shared, &plan)?,
            plan,
            registry_binding: None,
            registry_authority: None,
        };
        if let Some(candidate) = candidate {
            binding::configured(&self.shared, &mut config, &candidate)?;
        }
        let value = serde_json::to_value(&config)?;
        let bytes = serde_json::to_vec(&value)?;
        let public = CampaignPlan {
            schema_version: 1,
            controller_plan_sha256: hash(&value)?,
            baseline_sha256: hash(&serde_json::to_value(&config.plan.baseline)?)?,
            limits: config.plan.limits.clone(),
            expires_at_ms: config.plan.expires_at_ms,
        };
        let mut store = lock(&self.shared.store)?;
        let (campaign, duplicate) =
            store.create_campaign_with_artifact(&command, &public, &bytes)?;
        Ok(Reply::StrategyCampaignCreated {
            campaign: store.campaign(&campaign.id)?,
            duplicate,
        })
    }
    pub(crate) fn strategy_campaign_report(&self, campaign: String) -> Result<Reply, EngineError> {
        Ok(Reply::StrategyCampaignReport {
            report: provenance::report(&*lock(&self.shared.store)?, &campaign)?,
        })
    }
    pub(crate) fn strategy_development_feedback(
        &self,
        campaign: String,
    ) -> Result<Reply, EngineError> {
        Ok(Reply::StrategyDevelopmentFeedback {
            feedback: feedback(&*lock(&self.shared.store)?, &campaign)?,
        })
    }
    pub(crate) fn cancel_strategy_campaign(&self, campaign: String) -> Result<Reply, EngineError> {
        let control = lock(&self.shared.control)?;
        let snapshot = lock(&self.shared.store)?.cancel_campaign(&campaign)?;
        if let Some(token) = control.strategy_campaigns.get(&campaign) {
            token.cancel();
        }
        Ok(Reply::StrategyCampaignCancelled { snapshot })
    }
    pub(crate) async fn run_strategy_campaign(
        &self,
        campaign: String,
        lane: CampaignLane,
        events: mpsc::Sender<ExecutionEvent>,
        progress: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<Reply, EngineError> {
        let (receiver, cancel) = {
            let mut control = lock(&self.shared.control)?;
            if control.closing {
                return Err(error("engine is shutting down"));
            }
            let mut store = lock(&self.shared.store)?;
            let (snapshot, config) = provenance::configuration(&store, &campaign)?;
            let command = provenance::phase_command(&campaign, lane);
            match store.get_operation_by_command(&snapshot.campaign.journal_session_id, &command) {
                Ok(op) => {
                    if op.payload != provenance::expected_payload(&snapshot, lane) {
                        return Err(error("strategy phase identity differs"));
                    }
                    if matches!(
                        op.status,
                        OperationStatus::Admitted | OperationStatus::Running
                    ) {
                        return Err(error("strategy phase already active; observe status"));
                    }
                    return Ok(Reply::StrategyCampaignReport {
                        report: provenance::report(&store, &campaign)?,
                    });
                }
                Err(zero_store::Error::NotFound(_)) => {}
                Err(e) => return Err(e.into()),
            }
            if snapshot.campaign.status != CampaignStatus::Open
                || config.plan.expires_at_ms <= now()
            {
                return Err(error("strategy campaign is closed or expired"));
            }
            if control.strategy_campaigns.contains_key(&campaign) {
                return Err(error("strategy campaign already has an active phase"));
            }
            if control.strategy_campaigns.len() >= 8 {
                return Err(error("active strategy campaign limit reached"));
            }
            if lane == CampaignLane::Final {
                let report = provenance::report(&store, &campaign)?;
                if report
                    .usage
                    .model_charged_micro_usd
                    .saturating_add(config.plan.host.reservation_per_turn)
                    > config.plan.limits.model_micro_usd
                    || report.usage.model_reserved_micro_usd != 0
                    || report.usage.http_response_reserved_bytes != 0
                    || report.usage.active_runs != 0
                    || report.usage.unknown_runs != 0
                    || !report.completed_lanes.contains(&CampaignLane::Development)
                    || report
                        .case_results
                        .iter()
                        .filter(|r| r.lane == CampaignLane::Development)
                        .any(|r| {
                            r.disposition != StrategyCaseDisposition::Observed
                                || r.model_reserved_micro_usd != 0
                        })
                {
                    return Err(error(
                        "protected final requires completely observed development",
                    ));
                }
            }
            if serde_json::to_value(provider_context(&self.shared, &config.plan)?)?
                != serde_json::to_value(&config.provider_context)?
            {
                return Err(error(
                    "strategy provider route or price changed since creation",
                ));
            }
            let operation = store
                .admit_owned_batch(
                    &snapshot.campaign.journal_session_id,
                    &self.shared.owner,
                    &[(command, provenance::expected_payload(&snapshot, lane))],
                )?
                .remove(0);
            let cancel = CancellationToken::new();
            control
                .strategy_campaigns
                .insert(campaign.clone(), cancel.clone());
            let guard = Guard::new(
                self.shared.clone(),
                campaign.clone(),
                operation.id.clone(),
                cancel.clone(),
            );
            let (tx, rx) = oneshot::channel();
            let worker_cancel = cancel.clone();
            tokio::spawn(async move {
                let result = worker(
                    &guard.shared,
                    &campaign,
                    lane,
                    &operation,
                    &config,
                    worker_cancel,
                    events,
                    progress,
                )
                .await;
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
        let result = receiver
            .await
            .map_err(|_| error("strategy controller ended without result"))?;
        waiter.finished = true;
        result
    }
}
struct Waiter {
    cancel: CancellationToken,
    finished: bool,
}
impl Drop for Waiter {
    fn drop(&mut self) {
        if !self.finished {
            self.cancel.cancel();
        }
    }
}
struct Guard {
    shared: Arc<Shared>,
    campaign: String,
    operation: String,
    cancel: CancellationToken,
    settled: bool,
    _completion: WorkerCompletion,
}
impl Guard {
    fn new(
        shared: Arc<Shared>,
        campaign: String,
        operation: String,
        cancel: CancellationToken,
    ) -> Self {
        shared.workers.count.fetch_add(1, Ordering::AcqRel);
        let completion = WorkerCompletion(shared.workers.clone());
        Self {
            shared,
            campaign,
            operation,
            cancel,
            settled: false,
            _completion: completion,
        }
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if !self.settled {
            self.cancel.cancel();
            if let Ok(mut store) = self.shared.store.lock() {
                let _ = store.cancel_campaign(&self.campaign);
                let _ = store.mark_operation_unknown(
                    &self.operation,
                    &self.shared.owner,
                    "strategy controller ended without durable settlement",
                );
            }
        }
        if let Ok(mut control) = self.shared.control.lock() {
            control.strategy_campaigns.remove(&self.campaign);
        }
    }
}
#[derive(Default)]
struct Active {
    fixture: Option<fixture::Fixture>,
    session: Option<String>,
    profile: Option<String>,
}
async fn cleanup(shared: &Arc<Shared>, active: &mut Active) -> Result<(), EngineError> {
    if let Some(session) = active.session.take() {
        loop {
            let notified = shared.workers.changed.notified();
            let alive = {
                let control = lock(&shared.control)?;
                if let Some(root) = control.active.get(&session) {
                    root.cancel.cancel();
                    true
                } else {
                    false
                }
            };
            if !alive {
                break;
            }
            notified.await;
        }
    }
    let result = if let Some(fixture) = active.fixture.take() {
        fixture.finish().await
    } else {
        Ok(())
    };
    if let Some(profile) = active.profile.take() {
        lock(&shared.http)?.remove(&profile);
    }
    result
}
#[allow(clippy::too_many_arguments)]
async fn worker(
    shared: &Arc<Shared>,
    campaign: &str,
    lane: CampaignLane,
    operation: &Operation,
    config: &Configuration,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    progress: Option<mpsc::Sender<ExecutionEvent>>,
) -> Result<Reply, EngineError> {
    let mut active = Active::default();
    let result = AssertUnwindSafe(run_lane(
        shared,
        campaign,
        lane,
        operation,
        config,
        &cancel,
        events,
        progress,
        &mut active,
    ))
    .catch_unwind()
    .await;
    let stopped = match result {
        Ok(Ok(())) => None,
        Ok(Err(_)) => Some("strategy_phase_stopped"),
        Err(_) => Some("strategy_controller_panicked"),
    };
    if stopped.is_some() || cancel.is_cancelled() {
        cancel.cancel();
        let _ = lock(&shared.store)?.cancel_campaign(campaign);
    }
    let cleanup_result = cleanup(shared, &mut active).await;
    let mut store = lock(&shared.store)?;
    let (snapshot, current) = provenance::configuration(&store, campaign)?;
    let (rows, _) = provenance::rows(&store, &snapshot, &current)?;
    let selected: Vec<_> = rows.iter().filter(|r| r.lane == lane).collect();
    let bytes = serde_json::to_vec(&selected)?;
    let digest =
        store.retain_operation_artifact(&operation.id, &shared.owner, "strategy.matrix", &bytes)?;
    let uncertain = cleanup_result.is_err()
        || rows
            .iter()
            .any(|r| r.lane == lane && r.disposition == StrategyCaseDisposition::Unknown)
        || matches!(stopped, Some("strategy_controller_panicked"));
    if uncertain {
        store.mark_operation_unknown(
            &operation.id,
            &shared.owner,
            "strategy phase has uncertain actor or fixture completion",
        )?;
    } else {
        let status = if cancel.is_cancelled() {
            OperationStatus::Cancelled
        } else if stopped.is_some() {
            OperationStatus::Failed
        } else {
            OperationStatus::Succeeded
        };
        store.settle_operation(&operation.id,&shared.owner,status,&json!({"lane":lane,"matrix_sha256":digest,"stop_reason":stopped,"qualification":"qualification_only"}))?;
    }
    Ok(Reply::StrategyCampaignReport {
        report: provenance::report(&store, campaign)?,
    })
}
#[allow(clippy::too_many_arguments)]
async fn run_lane(
    shared: &Arc<Shared>,
    campaign: &str,
    lane: CampaignLane,
    operation: &Operation,
    config: &Configuration,
    cancel: &CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    progress: Option<mpsc::Sender<ExecutionEvent>>,
    active: &mut Active,
) -> Result<(), EngineError> {
    let finalist = hash(&serde_json::to_value(&config.plan.candidate)?)?;
    let suite = provenance::suite(config)?;
    let pair = provenance::pair(config)?;
    let exposure = if lane == CampaignLane::Final {
        Some(
            lock(&shared.store)?
                .create_campaign_exposure(
                    campaign,
                    &format!("strategy-exposure:{campaign}"),
                    &suite,
                    &pair,
                    &finalist,
                )?
                .0
                .id,
        )
    } else {
        None
    };
    for entry in render::schedule(&config.plan)
        .into_iter()
        .filter(|e| config.plan.scenarios[e.scenario].lane == lane)
    {
        if cancel.is_cancelled() || now() >= config.plan.expires_at_ms {
            return Err(error("strategy phase cancelled or expired"));
        }
        if serde_json::to_value(provider_context(shared, &config.plan)?)?
            != serde_json::to_value(&config.provider_context)?
        {
            return Err(error("strategy provider authority changed"));
        }
        active.fixture = Some(fixture::Fixture::bind().await?);
        let origin = active
            .fixture
            .as_ref()
            .ok_or_else(|| error("fixture absent"))?
            .origin
            .clone();
        let policy = render::profile(&origin, &config.plan.limits)?;
        let name = provenance::profile_name(campaign, entry.index);
        active.profile = Some(name.clone());
        let client = Arc::new(zero_http::Client::new(policy.clone(), None).map_err(error)?);
        lock(&shared.http)?.insert(name.clone(), client);
        let scenario = &config.plan.scenarios[entry.scenario];
        let artifact = if entry.variant == CampaignVariant::Baseline {
            &config.plan.baseline
        } else {
            &config.plan.candidate
        };
        let request = render::request(&config.plan, artifact, scenario, &name)?;
        let spec = CampaignRunSpec {
            candidate_sha256: finalist.clone(),
            suite_sha256: suite.clone(),
            evaluation_pair_sha256: pair.clone(),
            schedule_index: entry.index,
            lane,
            scenario_id: scenario.id.clone(),
            repeat_index: entry.repeat,
            variant: entry.variant,
            fixture_origin: origin,
            request: request.clone(),
            provider_context: config.provider_context.clone(),
            http_policy: policy,
            exposure_id: exposure.clone(),
        };
        let (run, duplicate) = lock(&shared.store)?.create_campaign_run(
            campaign,
            &format!("strategy-case:{campaign}:{}", entry.index),
            &spec,
            &shared.owner,
        )?;
        if duplicate {
            return Err(error(
                "strategy run already issued; automatic replay forbidden",
            ));
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
        let result = tokio::select! {biased;_=cancel.cancelled()=>{lock(&shared.store)?.cancel_campaign(campaign)?;if let Some(root)=lock(&shared.control)?.active.get(&run.session_id){root.cancel.cancel();}actor.await},_=tokio::time::sleep(std::time::Duration::from_millis(config.plan.expires_at_ms.saturating_sub(now())))=>{cancel.cancel();lock(&shared.store)?.cancel_campaign(campaign)?;if let Some(root)=lock(&shared.control)?.active.get(&run.session_id){root.cancel.cancel();}actor.await},result=&mut actor=>result};
        if result.is_err() {
            let mut store = lock(&shared.store)?;
            if store
                .campaign_run(campaign, &run.id)?
                .operation_id
                .is_none()
            {
                store.settle_campaign_run_without_root(
                    campaign,
                    &run.id,
                    &shared.owner,
                    if cancel.is_cancelled() {
                        CampaignRunStatus::Cancelled
                    } else {
                        CampaignRunStatus::Failed
                    },
                    "actor admission failed before root",
                )?;
            }
        }
        let clean = cleanup(shared, active).await;
        lock(&shared.store)?.append_operation_event(
            &operation.id,
            &shared.owner,
            "strategy_fixture_closed",
            &json!({"run_id":run.id,"schedule_index":entry.index,"confirmed":clean.is_ok()}),
        )?;
        clean?;
        let current = lock(&shared.store)?.campaign_run(campaign, &run.id)?;
        if current.status == CampaignRunStatus::Unknown {
            return Err(error("strategy actor outcome is unknown"));
        }
        if cancel.is_cancelled() {
            return Err(error("strategy phase cancelled"));
        }
    }
    Ok(())
}
