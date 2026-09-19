//! One owned local-source investigation over an explicitly host-captured pin.
//! Local path capture is cancellable frontend preflight, before this admission.
use super::*;
use futures_util::FutureExt;
use std::{
    collections::{BTreeMap, BTreeSet},
    panic::AssertUnwindSafe,
};
use zero_protocol::{SnapshotPin, campaign::CampaignProviderContext, review::*};
fn error(value: impl std::fmt::Display) -> EngineError {
    EngineError::State(value.to_string())
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn providers(
    shared: &Shared,
    profile: &ReviewProfile,
) -> Result<BTreeMap<String, CampaignProviderContext>, EngineError> {
    let configured = lock(&shared.providers)?;
    let mut names = BTreeSet::from([profile.provider.as_str()]);
    names.extend(
        profile
            .delegation_policy
            .iter()
            .flat_map(|p| p.roles.iter().map(|r| r.provider.as_str())),
    );
    names
        .into_iter()
        .map(|name| {
            let p = configured
                .get(name)
                .ok_or_else(|| error("review provider profile is not configured"))?;
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
    pub fn configure_review(&self, name: &str, profile: ReviewProfile) -> Result<(), EngineError> {
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(error("invalid review profile name"));
        }
        profile.validate().map_err(error)?;
        let control = lock(&self.shared.control)?;
        if control.closing || !control.active.is_empty() {
            return Err(error("review configuration requires an idle engine"));
        }
        let mut profiles = lock(&self.shared.review_profiles)?;
        if profiles.contains_key(name) {
            return Err(error("review profile is already configured"));
        }
        profiles.insert(name.into(), profile);
        Ok(())
    }
    pub(crate) fn review_status(&self, key: &str) -> Result<Reply, EngineError> {
        Ok(Reply::ReviewStatus {
            review: lock(&self.shared.store)?.review_snapshot(key)?,
        })
    }
    pub(crate) fn review_report(&self, key: &str) -> Result<Reply, EngineError> {
        let view = lock(&self.shared.store)?.review_read_snapshot(key)?;
        Ok(Reply::ReviewReport {
            report: review_read::compose(&view, key)?,
        })
    }
    pub(crate) fn cancel_review(&self, key: &str) -> Result<Reply, EngineError> {
        let control = lock(&self.shared.control)?;
        let mut store = lock(&self.shared.store)?;
        let review = store.review_record(key)?;
        let accepted =
            store.request_review_stop(key, &self.shared.owner, ReviewCloseReason::Cancelled)?;
        if accepted {
            if let Some(active) = control.active.get(&review.session_id) {
                active.cancel.cancel();
            }
        }
        Ok(Reply::ReviewCancelled {
            review_id: key.into(),
            accepted,
        })
    }
    pub(crate) async fn run_review(
        &self,
        command: String,
        input_path: String,
        name: String,
        snapshot: SnapshotPin,
        workspace_selection: Option<zero_protocol::workspace::WorkspaceSelectionReceipt>,
        events: mpsc::Sender<ExecutionEvent>,
        progress: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<Reply, EngineError> {
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            {
                let store = lock(&self.shared.store)?;
                if let Some(record) = store.review_by_command(&command)? {
                    if record.input_path != input_path || record.profile_name != name {
                        return Err(error("review command reused with changed path or profile"));
                    }
                    return Ok(Reply::ReviewRun {
                        review: store.review_snapshot(&record.id)?,
                        duplicate: true,
                    });
                }
            }
            if control.closing {
                return Err(error("engine is shutting down"));
            }
            if control.active.len() >= 64 {
                return Err(error("engine active operation limit reached"));
            }
            let profile = lock(&self.shared.review_profiles)?
                .get(&name)
                .cloned()
                .ok_or_else(|| error("review profile is not configured"))?;
            let id = uuid::Uuid::new_v4().to_string();
            let session = uuid::Uuid::new_v4().to_string();
            let controller = uuid::Uuid::new_v4().to_string();
            let root = uuid::Uuid::new_v4().to_string();
            let request = profile
                .request_with_selection(snapshot.clone(), &root, workspace_selection.as_ref())
                .map_err(error)?;
            let provider = lock(&self.shared.providers)?
                .get(&profile.provider)
                .cloned()
                .ok_or_else(|| error("review provider is not configured"))?;
            let provider_context = providers(&self.shared, &profile)?;
            let mut store = lock(&self.shared.store)?;
            let (mut payload, actor) = agent::prepare_actor(
                &self.shared,
                &store,
                &session,
                &format!("review:{id}:root"),
                request,
                provider,
                None,
                false,
            )?;
            payload["review_template"] = serde_json::to_value(&actor.template)?;
            let admission = zero_store::ReviewAdmission {
                workspace_selection,
                review_id: id,
                session_id: session,
                controller_operation_id: controller,
                root_operation_id: root,
                input_path,
                canonical_path: snapshot.root.clone(),
                profile_name: name,
                profile,
                snapshot,
                root_payload: payload,
                provider_context,
            };
            let admitted = store.admit_review(&command, &self.shared.owner, &admission)?;
            if admitted.duplicate {
                return Ok(Reply::ReviewRun {
                    review: store.review_snapshot(&admitted.review.id)?,
                    duplicate: true,
                });
            }
            drop(store);
            let cancel = CancellationToken::new();
            control.active.insert(
                admitted.review.session_id.clone(),
                Active {
                    command_id: admitted.root.command_id.clone(),
                    execution_id: admitted.root.command_id.clone(),
                    cancel: cancel.clone(),
                },
            );
            let mut guard = WorkerGuard::new(
                Arc::clone(&self.shared),
                &admitted.review.session_id,
                &admitted.controller.id,
                cancel.clone(),
            );
            guard.track_operation(&admitted.root.id);
            emit_admission(&events, &admitted.root, &admitted.root.command_id, &cancel);
            let (tx, rx) = oneshot::channel();
            let shared = Arc::clone(&self.shared);
            tokio::spawn(async move {
                let result = AssertUnwindSafe(execute(
                    &shared,
                    &admitted.review,
                    actor,
                    cancel,
                    events,
                    progress,
                ))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err(error("review worker panicked")));
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
            .map_err(|_| error("review worker ended without reply"))?
    }
}
async fn execute(
    shared: &Arc<Shared>,
    review: &ReviewRecord,
    actor: agent::PreparedActor,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    progress: Option<mpsc::Sender<ExecutionEvent>>,
) -> Result<Reply, EngineError> {
    let future = agent::run_actor(
        shared,
        &review.session_id,
        &review.root_operation_id,
        actor,
        cancel.clone(),
        events,
        progress,
    );
    tokio::pin!(future);
    let duration = std::time::Duration::from_millis(review.deadline_at_ms.saturating_sub(now()));
    let result = tokio::select! {
        result=&mut future=>result,
        _=tokio::time::sleep(duration)=>{
            let stopped=lock(&shared.store).and_then(|mut s|Ok(s.request_review_stop(&review.id,&shared.owner,ReviewCloseReason::Deadline)?));
            cancel.cancel();let result=future.await;stopped?;result
        },
        _=cancel.cancelled()=>{
            let stopped=lock(&shared.store).and_then(|mut s|Ok(s.request_review_stop(&review.id,&shared.owner,ReviewCloseReason::Cancelled)?));
            let result=future.await;stopped?;result
        }
    };
    let mut store = lock(&shared.store)?;
    if cancel.is_cancelled() {
        store.request_review_stop(&review.id, &shared.owner, ReviewCloseReason::Cancelled)?;
    } else if now() >= review.deadline_at_ms {
        store.request_review_stop(&review.id, &shared.owner, ReviewCloseReason::Deadline)?;
    }
    let mut root = store.get_operation(&review.root_operation_id)?;
    if root.status == OperationStatus::Running {
        root = store.mark_operation_unknown(
            &root.id,
            &shared.owner,
            if result.is_err() {
                "review actor failed without terminal settlement"
            } else {
                "review actor returned without terminal settlement"
            },
        )?;
    }
    // Controller success means its owned lifecycle drained. The root and source
    // disposition remain separate; Unknown/failed actors never become success.
    store.settle_operation(&review.controller_operation_id,&shared.owner,OperationStatus::Succeeded,
        &serde_json::json!({"schema_version":1,"review_id":review.id,"root_operation_id":root.id,"root_status":root.status}))?;
    Ok(Reply::ReviewRun {
        review: store.review_snapshot(&review.id)?,
        duplicate: false,
    })
}
