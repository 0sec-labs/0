use super::*;
use futures_util::FutureExt;
use std::panic::AssertUnwindSafe;
use tokio::sync::oneshot;
fn providers(
    shared: &Shared,
    profile: &ScanProfile,
) -> Result<BTreeMap<String, CampaignProviderContext>, EngineError> {
    let configured = lock(&shared.providers)?;
    let mut names = vec![profile.provider.as_str()];
    if let Some(policy) = &profile.delegation_policy {
        names.extend(policy.roles.iter().map(|r| r.provider.as_str()));
    }
    names
        .into_iter()
        .map(|name| {
            let p = configured
                .get(name)
                .ok_or_else(|| error("scan provider profile is not configured"))?;
            Ok((
                name.into(),
                CampaignProviderContext {
                    endpoint: p.client.endpoint_identity().into(),
                    wire_api: p.client.wire_api(),
                    rates: p.rates,
                    hosted_catalog: p.client.hosted_catalog().cloned(),
                },
            ))
        })
        .collect()
}
impl Engine {
    pub(crate) async fn run_scan(
        &self,
        command: String,
        input_target: String,
        name: String,
        events: mpsc::Sender<ExecutionEvent>,
        progress: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<Reply, EngineError> {
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            {
                let store = lock(&self.shared.store)?;
                if let Some(scan) = store.scan_by_command(&command)? {
                    if scan.input_target != input_target || scan.profile_name != name {
                        return Err(error("scan command reused with changed target or profile"));
                    }
                    return Ok(Reply::ScanRun {
                        scan: provenance::snapshot(&store, &scan.id)?,
                        duplicate: true,
                    });
                }
            }
            validate_scan_target(&input_target).map_err(error)?;
            if control.closing {
                return Err(error("engine is shutting down"));
            }
            let profile = lock(&self.shared.scan_profiles)?
                .get(&name)
                .cloned()
                .ok_or_else(|| error("scan profile is not configured"))?;
            profile.validate().map_err(error)?;
            let target = lock(&self.shared.http)?
                .get(&profile.http_profile)
                .ok_or_else(|| error("scan HTTP profile is not configured"))?
                .normalize_target(&input_target)
                .map_err(error)?;
            let request = profile.request(&target).map_err(error)?;
            let provider = lock(&self.shared.providers)?
                .get(&profile.provider)
                .cloned()
                .ok_or_else(|| error("scan provider is not configured"))?;
            let provider_context = providers(&self.shared, &profile)?;
            let scan_id = uuid::Uuid::new_v4().to_string();
            let session_id = uuid::Uuid::new_v4().to_string();
            let controller_operation_id = uuid::Uuid::new_v4().to_string();
            let root_operation_id = uuid::Uuid::new_v4().to_string();
            let mut store = lock(&self.shared.store)?;
            let (mut root_payload, actor) = agent::prepare_actor(
                &self.shared,
                &store,
                &session_id,
                &format!("scan:{scan_id}:root"),
                request,
                provider,
                None,
                false,
            )?;
            root_payload["scan_template"] = serde_json::to_value(&actor.template)?;
            let admitted = store.admit_scan(
                &command,
                &self.shared.owner,
                &zero_store::ScanAdmission {
                    scan_id,
                    session_id,
                    controller_operation_id,
                    root_operation_id,
                    input_target,
                    target,
                    profile_name: name,
                    profile,
                    root_payload,
                    provider_context,
                },
            )?;
            if admitted.duplicate {
                return Ok(Reply::ScanRun {
                    scan: provenance::snapshot(&store, &admitted.scan.id)?,
                    duplicate: true,
                });
            }
            drop(store);
            let cancel = CancellationToken::new();
            control.active.insert(
                admitted.scan.session_id.clone(),
                Active {
                    command_id: admitted.root.command_id.clone(),
                    execution_id: admitted.root.command_id.clone(),
                    cancel: cancel.clone(),
                },
            );
            let mut guard = WorkerGuard::new(
                Arc::clone(&self.shared),
                &admitted.scan.session_id,
                &admitted.controller.id,
                cancel.clone(),
            );
            guard.track_operation(&admitted.root.id);
            emit_admission(&events, &admitted.root, &admitted.root.command_id, &cancel);
            let (tx, rx) = oneshot::channel();
            let shared = Arc::clone(&self.shared);
            tokio::spawn(async move {
                let mut guard = guard;
                let result = AssertUnwindSafe(execute(
                    &shared,
                    &admitted.scan,
                    actor,
                    cancel,
                    events,
                    progress,
                ))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err(error("scan worker panicked")));
                if result.is_ok() {
                    guard.settled = true;
                }
                drop(guard);
                let _ = tx.send(result);
            });
            rx
        };
        receiver
            .await
            .map_err(|_| error("scan worker ended without reply"))?
    }
}
async fn execute(
    shared: &Arc<Shared>,
    scan: &ScanRecord,
    actor: agent::PreparedActor,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    progress: Option<mpsc::Sender<ExecutionEvent>>,
) -> Result<Reply, EngineError> {
    let future = agent::run_actor(
        shared,
        &scan.session_id,
        &scan.root_operation_id,
        actor,
        cancel.clone(),
        events,
        progress,
    );
    tokio::pin!(future);
    let duration = std::time::Duration::from_millis(scan.deadline_at_ms.saturating_sub(now()));
    let result = tokio::select! {
        result=&mut future => result,
        _=tokio::time::sleep(duration) => {
            let stopped=lock(&shared.store).and_then(|mut store| Ok(store.request_scan_stop(&scan.id,&shared.owner,ScanCloseReason::Deadline)?));
            cancel.cancel();
            let finished=future.await;
            stopped?;
            finished
        },
        _=cancel.cancelled() => {
            let stopped=lock(&shared.store).and_then(|mut store| Ok(store.request_scan_stop(&scan.id,&shared.owner,ScanCloseReason::Cancelled)?));
            let finished=future.await;
            stopped?;
            finished
        }
    };
    if result.is_err() {
        let mut store = lock(&shared.store)?;
        let root = store.get_operation(&scan.root_operation_id)?;
        if root.status == OperationStatus::Running {
            store.mark_operation_unknown(
                &root.id,
                &shared.owner,
                "scan actor failed without terminal settlement",
            )?;
        }
    }
    let mut store = lock(&shared.store)?;
    if cancel.is_cancelled() {
        store.request_scan_stop(&scan.id, &shared.owner, ScanCloseReason::Cancelled)?;
    } else if now() >= scan.deadline_at_ms {
        store.request_scan_stop(&scan.id, &shared.owner, ScanCloseReason::Deadline)?;
    }
    let snapshot = store.scan_snapshot(&scan.id)?;
    let mut report = provenance::compose(&store, &snapshot, ScanReportKind::Retained, now())?;
    let encoded = if report.kind == ScanReportKind::Compact {
        None
    } else {
        encode(&report)?
    };
    let publication = match encoded {
        Some(bytes) => ScanPublication::Retained {
            report_sha256: store.retain_operation_artifact(
                &scan.controller_operation_id,
                &shared.owner,
                "scan.report",
                &bytes,
            )?,
        },
        None => {
            report.kind = ScanReportKind::Compact;
            report.web = None;
            let bytes =
                encode(&report)?.ok_or_else(|| error("compact scan report exceeds limit"))?;
            store.retain_operation_artifact(
                &scan.controller_operation_id,
                &shared.owner,
                "scan.compact",
                &bytes,
            )?;
            ScanPublication::ReportTooLarge
        }
    };
    let result = ScanResult {
        outcome: report.outcome,
        publication,
    };
    store.settle_operation(
        &scan.controller_operation_id,
        &shared.owner,
        OperationStatus::Succeeded,
        &serde_json::to_value(result)?,
    )?;
    Ok(Reply::ScanRun {
        scan: provenance::snapshot(&store, &scan.id)?,
        duplicate: false,
    })
}
