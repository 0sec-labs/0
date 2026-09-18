//! Durable source discovery: preparation and model claims never imply reproduction.
use super::*;
use serde_json::json;
use zero_protocol::{
    model::CompletionStatus,
    source::{SourceReviewOutcome, SourceReviewRequest},
};
fn state(error: impl std::fmt::Display) -> EngineError {
    EngineError::State(error.to_string())
}
impl Engine {
    pub(super) async fn review_source(
        &self,
        session: String,
        command: String,
        request: SourceReviewRequest,
        events: mpsc::Sender<ExecutionEvent>,
        progress_events: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<Reply, EngineError> {
        if request.reservation == 0 {
            return Err(state("source review requires nonzero reservation"));
        }
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            if control.closing {
                return Err(state("engine is shutting down"));
            }
            if control
                .active
                .get(&session)
                .is_some_and(|a| a.command_id != command)
                || (control.active.len() >= 64 && !control.active.contains_key(&session))
            {
                return Err(state("session busy or active operation limit reached"));
            }
            let profile = lock(&self.shared.providers)?
                .get(&request.provider)
                .cloned()
                .ok_or_else(|| state("provider profile is not configured"))?;
            profile
                .client
                .validate_policy(&request.model, 8192)
                .map_err(state)?;
            let mut payload = json!({"kind":"source_hypothesis_review","request":request,"endpoint":profile.client.endpoint_identity(),"wire_api":profile.client.wire_api(),"rates":profile.rates});
            profile.stamp(&mut payload)?;
            let operation = {
                let mut store = lock(&self.shared.store)?;
                let admitted = store.admit_command(&session, &command, &payload)?;
                if admitted.duplicate {
                    let result = admitted
                        .operation
                        .outcome
                        .clone()
                        .and_then(|v| serde_json::from_value(v).ok());
                    return Ok(Reply::SourceReview {
                        operation: admitted.operation,
                        result,
                        duplicate: true,
                    });
                }
                store.begin_operation(&admitted.operation.id, &self.shared.owner)?
            };
            let cancel = CancellationToken::new();
            control.active.insert(
                session.clone(),
                Active {
                    command_id: command.clone(),
                    execution_id: command,
                    cancel: cancel.clone(),
                },
            );
            emit_admission(&events, &operation, &operation.command_id, &cancel);
            let shared = self.shared.clone();
            let (sender, receiver) = oneshot::channel();
            let mut guard = WorkerGuard::new(shared, &session, &operation.id, cancel.clone());
            tokio::spawn(async move {
                let result = run(
                    &guard.shared,
                    &session,
                    &operation.id,
                    request,
                    profile,
                    cancel,
                    progress_events,
                )
                .await;
                guard.settled = result.is_ok();
                drop(guard);
                let _ = sender.send(result);
            });
            receiver
        };
        receiver
            .await
            .map_err(|_| state("source review owner stopped before settlement"))?
    }
}
fn settle(
    shared: &Shared,
    parent: &str,
    outcome: SourceReviewOutcome,
    status: OperationStatus,
) -> Result<Reply, EngineError> {
    let value = serde_json::to_value(&outcome)?;
    let mut store = lock(&shared.store)?;
    let operation = if status == OperationStatus::Unknown {
        store.mark_operation_unknown_with_outcome(parent, &shared.owner, &value)?
    } else {
        store.settle_operation(parent, &shared.owner, status, &value)?
    };
    Ok(Reply::SourceReview {
        operation,
        result: Some(outcome),
        duplicate: false,
    })
}
fn retain(
    shared: &Shared,
    parent: &str,
    outcome: &mut SourceReviewOutcome,
    name: &str,
    bytes: &[u8],
) -> Result<(), EngineError> {
    let digest =
        lock(&shared.store)?.retain_operation_artifact(parent, &shared.owner, name, bytes)?;
    outcome.artifacts.insert(name.into(), digest);
    Ok(())
}
async fn run(
    shared: &Arc<Shared>,
    session: &str,
    parent: &str,
    request: SourceReviewRequest,
    profile: inference::Profile,
    cancel: CancellationToken,
    events: Option<mpsc::Sender<ExecutionEvent>>,
) -> Result<Reply, EngineError> {
    let mut outcome = SourceReviewOutcome {
        review: None,
        artifacts: Default::default(),
        inference_operation: None,
        external_effects_started: false,
        error: None,
    };
    if cancel.is_cancelled() {
        return settle(shared, parent, outcome, OperationStatus::Cancelled);
    }
    // Blocking verification owns its staging to completion. Cancellation cannot
    // abandon this task or race cleanup; shutdown waits for the bounded copy.
    let model = request.model;
    let source = request.source;
    let prepared = match tokio::task::spawn_blocking(move || {
        zero_source::prepare(&source).and_then(|review| review.request(&model))
    })
    .await
    {
        Ok(Ok(value)) => value,
        error => {
            outcome.error = Some(match error {
                Ok(Err(e)) => e.to_string(),
                Err(e) => format!("source preparation worker failed: {e}"),
                _ => unreachable!(),
            });
            return settle(shared, parent, outcome, OperationStatus::Failed);
        }
    };
    if cancel.is_cancelled() {
        return settle(shared, parent, outcome, OperationStatus::Cancelled);
    }
    // Persist both portable bytes and exact provider request before admission of
    // any provider effect. Events contain attachment identity, never source text.
    let retained = (|| {
        profile.client.validate(prepared.request()).map_err(state)?;
        retain(
            shared,
            parent,
            &mut outcome,
            "source.bundle",
            &prepared.bundle().to_bytes().map_err(state)?,
        )?;
        retain(
            shared,
            parent,
            &mut outcome,
            "source.request",
            &prepared.request_bytes().map_err(state)?,
        )
    })();
    if let Err(error) = retained {
        outcome.error = Some(error.to_string());
        return settle(shared, parent, outcome, OperationStatus::Failed);
    }
    if cancel.is_cancelled() {
        return settle(shared, parent, outcome, OperationStatus::Cancelled);
    }
    let child = {
        let mut store = lock(&shared.store)?;
        let mut payload = json!({"parent_operation":parent,"kind":"source_review_inference","request_artifact":outcome.artifacts.get("source.request"),"endpoint":profile.client.endpoint_identity(),"wire_api":profile.client.wire_api(),"rates":profile.rates});
        profile.stamp(&mut payload)?;
        let admission = store.admit_command(session, &format!("{parent}:model:0"), &payload)?;
        if admission.duplicate {
            return Err(state(
                "source provider child already admitted; recovery required",
            ));
        }
        store.begin_operation(&admission.operation.id, &shared.owner)?
    };
    outcome.inference_operation = Some(child.id.clone());
    let mut child_guard = ChildGuard {
        shared,
        operation: child.id.clone(),
        settled: false,
    };
    let reservation = lock(&shared.store)?.reserve_budget(session, &child.id, request.reservation);
    if let Err(error) = reservation {
        lock(&shared.store)?.settle_operation(
            &child.id,
            &shared.owner,
            OperationStatus::Failed,
            &json!({"error":"budget reservation rejected"}),
        )?;
        child_guard.settled = true;
        outcome.error = Some(error.to_string());
        return settle(shared, parent, outcome, OperationStatus::Failed);
    }
    if cancel.is_cancelled() {
        let mut store = lock(&shared.store)?;
        store.settle_budget(session, &child.id, 0)?;
        store.settle_operation(
            &child.id,
            &shared.owner,
            OperationStatus::Cancelled,
            &json!({"external_effects_started":false}),
        )?;
        drop(store);
        child_guard.settled = true;
        return settle(shared, parent, outcome, OperationStatus::Cancelled);
    }
    outcome.external_effects_started = true;
    let provider_request = prepared.request().clone();
    let client = profile.client.clone();
    let token = cancel.clone();
    let progress =
        events.map(|events| model_progress::forwarder(events, session, &child.id, Some(parent)));
    let completion = match tokio::spawn(async move {
        match progress {
            Some(progress) => {
                client
                    .complete_with_progress(&provider_request, token, progress)
                    .await
            }
            None => client.complete(&provider_request, token).await,
        }
    })
    .await
    {
        Ok(Ok(completion)) => completion,
        error => {
            outcome.error = Some(match error {
                Ok(Err(e)) => e.to_string(),
                Err(e) => format!("provider worker failed: {e}"),
                _ => unreachable!(),
            });
            lock(&shared.store)?.mark_operation_unknown(
                &child.id,
                &shared.owner,
                outcome.error.as_deref().unwrap_or("provider uncertain"),
            )?;
            child_guard.settled = true;
            return settle(shared, parent, outcome, OperationStatus::Unknown);
        }
    };
    if completion.status == CompletionStatus::Completed && completion.usage_is_final {
        if let Some(charge) = completion
            .usage
            .as_ref()
            .and_then(|u| profile.rates.charge(u))
        {
            lock(&shared.store)?.settle_budget(session, &child.id, charge)?;
        }
    }
    retain(
        shared,
        parent,
        &mut outcome,
        "source.completion",
        &serde_json::to_vec(&completion)?,
    )?;
    let child_status = match completion.status {
        CompletionStatus::Completed => OperationStatus::Succeeded,
        CompletionStatus::Failed => OperationStatus::Failed,
        CompletionStatus::Incomplete => OperationStatus::Unknown,
    };
    let child_result = json!({"completion_artifact":outcome.artifacts.get("source.completion"),"usage":completion.usage,"usage_is_final":completion.usage_is_final});
    {
        let mut store = lock(&shared.store)?;
        if child_status == OperationStatus::Unknown {
            store.mark_operation_unknown_with_outcome(&child.id, &shared.owner, &child_result)?;
        } else {
            store.settle_operation(&child.id, &shared.owner, child_status, &child_result)?;
        }
    }
    child_guard.settled = true;
    if child_status != OperationStatus::Succeeded {
        outcome.error = completion
            .error
            .or(Some("provider did not complete".into()));
        return settle(shared, parent, outcome, child_status);
    }
    if cancel.is_cancelled() {
        return settle(shared, parent, outcome, OperationStatus::Cancelled);
    }
    match prepared.accept(&completion) {
        Ok(review) => {
            retain(
                shared,
                parent,
                &mut outcome,
                "source.review",
                &zero_source::review_result_bytes(&review).map_err(state)?,
            )?;
            outcome.review = Some(review);
            settle(shared, parent, outcome, OperationStatus::Succeeded)
        }
        Err(error) => {
            outcome.error = Some(error.to_string());
            settle(shared, parent, outcome, OperationStatus::Failed)
        }
    }
}
struct ChildGuard<'a> {
    shared: &'a Shared,
    operation: String,
    settled: bool,
}
impl Drop for ChildGuard<'_> {
    fn drop(&mut self) {
        if !self.settled {
            if let Ok(mut store) = self.shared.store.lock() {
                let _ = store.mark_operation_unknown(
                    &self.operation,
                    &self.shared.owner,
                    "source provider child stopped before durable settlement",
                );
            }
        }
    }
}
