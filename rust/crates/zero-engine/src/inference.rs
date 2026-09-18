use super::*;
use zero_protocol::model::{CompletionStatus, HostedCatalogPin, Rates, ResponsesRequest};
use zero_provider::ProviderClient;

#[derive(Clone)]
pub(super) struct Profile {
    pub(super) client: Arc<ProviderClient>,
    pub(super) rates: Rates,
}
impl Profile {
    pub(super) fn stamp(&self, payload: &mut serde_json::Value) -> Result<(), EngineError> {
        if let Some(pin) = self.client.hosted_catalog() {
            payload["hosted_catalog"] = serde_json::to_value(pin)?;
        }
        Ok(())
    }
    pub(super) fn validate(&self, request: &ResponsesRequest) -> Result<(), EngineError> {
        self.client
            .validate(request)
            .map_err(|e| EngineError::State(e.to_string()))
    }
}
/// Validate captured price/route/model authority without loading credentials or
/// consulting a mutable current catalog. Absence preserves historical BYOK.
pub(super) fn validate_hosted_payload(
    payload: &serde_json::Value,
    model: &str,
    max_output_tokens: u32,
) -> Result<(), EngineError> {
    let Some(value) = payload.get("hosted_catalog") else {
        return Ok(());
    };
    let pin: HostedCatalogPin = serde_json::from_value(value.clone())?;
    zero_provider::validate_hosted_pin(&pin).map_err(|e| EngineError::State(e.to_string()))?;
    let wire = payload
        .get("wire_api")
        .cloned()
        .unwrap_or_else(|| serde_json::json!("responses"));
    if payload["endpoint"] != pin.endpoint
        || payload["rates"] != serde_json::to_value(pin.rates)?
        || wire != serde_json::to_value(pin.wire_api)?
        || model != pin.model
        || max_output_tokens == 0
        || max_output_tokens > pin.max_output_tokens
    {
        return Err(EngineError::State(
            "retained hosted catalog binding mismatch".into(),
        ));
    }
    Ok(())
}
pub(super) fn validate_hosted_pair(
    parent: &serde_json::Value,
    child: &serde_json::Value,
    request: &ResponsesRequest,
) -> Result<(), EngineError> {
    if parent.get("hosted_catalog") != child.get("hosted_catalog") {
        return Err(EngineError::State(
            "retained hosted parent/child catalog mismatch".into(),
        ));
    }
    validate_hosted_payload(parent, &request.model, request.max_output_tokens)?;
    validate_hosted_payload(child, &request.model, request.max_output_tokens)
}
impl Engine {
    /// Configure an explicit route before admitting work. Credentials stay in memory.
    pub fn configure_provider(
        &self,
        name: &str,
        client: ProviderClient,
        rates: Rates,
    ) -> Result<(), EngineError> {
        if client.hosted_catalog().is_some() {
            return Err(EngineError::State(
                "hosted client requires explicit hosted profile configuration".into(),
            ));
        }
        self.configure_profile(name, client, rates)
    }
    pub fn configure_hosted_provider(
        &self,
        name: &str,
        client: ProviderClient,
        rates: Rates,
        pin: HostedCatalogPin,
    ) -> Result<(), EngineError> {
        zero_provider::validate_hosted_pin(&pin).map_err(|e| EngineError::State(e.to_string()))?;
        if client.endpoint_identity() != pin.endpoint
            || client.wire_api() != pin.wire_api
            || serde_json::to_value(rates)? != serde_json::to_value(pin.rates)?
            || client
                .hosted_catalog()
                .map(serde_json::to_value)
                .transpose()?
                != Some(serde_json::to_value(&pin)?)
        {
            return Err(EngineError::State(
                "hosted provider/catalog binding mismatch".into(),
            ));
        }
        self.configure_profile(name, client, rates)
    }
    fn configure_profile(
        &self,
        name: &str,
        client: ProviderClient,
        rates: Rates,
    ) -> Result<(), EngineError> {
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(EngineError::State("invalid provider profile name".into()));
        }
        let control = lock(&self.shared.control)?;
        if control.closing || !control.active.is_empty() {
            return Err(EngineError::State(
                "provider configuration requires an idle engine".into(),
            ));
        }
        let mut profiles = lock(&self.shared.providers)?;
        if profiles.contains_key(name) {
            return Err(EngineError::State(
                "provider profile already configured".into(),
            ));
        }
        profiles.insert(
            name.into(),
            Profile {
                client: Arc::new(client),
                rates,
            },
        );
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn infer(
        &self,
        session_id: String,
        command_id: String,
        provider: String,
        request: ResponsesRequest,
        reservation: u64,
        events: mpsc::Sender<ExecutionEvent>,
        progress_events: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<Reply, EngineError> {
        zero_provider::validate_request(&request).map_err(|e| EngineError::State(e.to_string()))?;
        if reservation == 0 {
            return Err(EngineError::State(
                "inference requires a nonzero budget reservation".into(),
            ));
        }
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            if control.closing {
                return Err(EngineError::State("engine is shutting down".into()));
            }
            if control
                .active
                .get(&session_id)
                .is_some_and(|active| active.command_id != command_id)
            {
                return Err(EngineError::State(
                    "session already has an active operation".into(),
                ));
            }
            if control.active.len() >= 64 && !control.active.contains_key(&session_id) {
                return Err(EngineError::State(
                    "engine active operation limit reached".into(),
                ));
            }
            let profile = lock(&self.shared.providers)?
                .get(&provider)
                .cloned()
                .ok_or_else(|| EngineError::State("provider profile is not configured".into()))?;
            profile.validate(&request)?;
            let mut payload = serde_json::json!({"kind":"responses_inference","provider":provider,"endpoint":profile.client.endpoint_identity(),"rates":profile.rates,"request":request,"reservation":reservation});
            // Existing default-Responses admissions keep their exact retry identity.
            if profile.client.wire_api() != zero_protocol::model::WireApi::Responses {
                payload["kind"] = serde_json::json!(match profile.client.wire_api() {
                    zero_protocol::model::WireApi::ChatCompletions => "chat_inference",
                    zero_protocol::model::WireApi::AnthropicMessages => "anthropic_inference",
                    zero_protocol::model::WireApi::Responses => unreachable!(),
                });
                payload["wire_api"] = serde_json::to_value(profile.client.wire_api())?;
            }
            profile.stamp(&mut payload)?;
            let mut store = lock(&self.shared.store)?;
            let admission = store.admit_command(&session_id, &command_id, &payload)?;
            if admission.duplicate {
                let completion = admission
                    .operation
                    .outcome
                    .clone()
                    .and_then(|value| serde_json::from_value(value).ok());
                return Ok(Reply::Inference {
                    operation: admission.operation,
                    completion,
                    duplicate: true,
                });
            }
            // All accounting records are durable before a request can leave this
            // process. A crash in this sequence is conservative: never replay it.
            let operation = store.begin_operation(&admission.operation.id, &self.shared.owner)?;
            if let Err(error) = store.reserve_budget(&session_id, &operation.id, reservation) {
                store.settle_operation(
                    &operation.id,
                    &self.shared.owner,
                    OperationStatus::Failed,
                    &serde_json::json!({"error":"budget reservation rejected"}),
                )?;
                return Err(error.into());
            }
            let cancel = CancellationToken::new();
            control.active.insert(
                session_id.clone(),
                Active {
                    command_id: command_id.clone(),
                    execution_id: command_id,
                    cancel: cancel.clone(),
                },
            );
            emit_admission(&events, &operation, &operation.command_id, &cancel);
            let shared = Arc::clone(&self.shared);
            let (sender, receiver) = oneshot::channel();
            let mut guard = WorkerGuard::new(shared, &session_id, &operation.id, cancel.clone());
            tokio::spawn(async move {
                let result = run_inference(
                    &guard.shared,
                    &session_id,
                    &operation.id,
                    profile,
                    request,
                    cancel,
                    progress_events,
                    None,
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
            .map_err(|_| EngineError::State("inference owner stopped before settlement".into()))?
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_inference(
    shared: &Arc<Shared>,
    session_id: &str,
    operation_id: &str,
    profile: Profile,
    request: ResponsesRequest,
    cancel: CancellationToken,
    events: Option<mpsc::Sender<ExecutionEvent>>,
    parent_operation: Option<&str>,
) -> Result<Reply, EngineError> {
    // A token cancelled before dispatch is positive evidence that this owner
    // never contacted the provider. Cancellation after this boundary remains
    // uncertain unless the provider returns final usage.
    if cancel.is_cancelled() {
        let mut store = lock(&shared.store)?;
        store.settle_budget(session_id, operation_id, 0)?;
        let operation = store.settle_operation(
            operation_id,
            &shared.owner,
            OperationStatus::Cancelled,
            &serde_json::json!({"reason":"cancelled_before_dispatch","external_effects_started":false}),
        )?;
        return Ok(Reply::Inference {
            operation,
            completion: None,
            duplicate: false,
        });
    }
    let rates = profile.rates;
    let progress = events.map(|events| {
        model_progress::forwarder(events, session_id, operation_id, parent_operation)
    });
    let result = tokio::spawn(async move {
        match progress {
            Some(progress) => {
                profile
                    .client
                    .complete_with_progress(&request, cancel, progress)
                    .await
            }
            None => profile.client.complete(&request, cancel).await,
        }
    })
    .await;
    let completion = match result {
        Ok(Ok(completion)) => completion,
        Ok(Err(error)) => {
            // Even HTTP/transport errors need explicit reconciliation before
            // releasing their reservation; do not assume remote billing is zero.
            let operation = lock(&shared.store)?.mark_operation_unknown(
                operation_id,
                &shared.owner,
                &error.to_string(),
            )?;
            return Ok(Reply::Inference {
                operation,
                completion: None,
                duplicate: false,
            });
        }
        Err(_) => {
            let operation = lock(&shared.store)?.mark_operation_unknown(
                operation_id,
                &shared.owner,
                "inference worker stopped before settlement",
            )?;
            return Ok(Reply::Inference {
                operation,
                completion: None,
                duplicate: false,
            });
        }
    };
    let mut store = lock(&shared.store)?;
    // Only final reported usage closes a reservation. Intermediate usage may
    // omit additional billed tokens, so incomplete streams retain the hold.
    if completion.status == CompletionStatus::Completed && completion.usage_is_final {
        if let Some(charge) = completion
            .usage
            .as_ref()
            .and_then(|usage| rates.charge(usage))
        {
            store.settle_budget(session_id, operation_id, charge)?;
        }
    }
    let status = match completion.status {
        CompletionStatus::Completed => OperationStatus::Succeeded,
        CompletionStatus::Failed => OperationStatus::Failed,
        CompletionStatus::Incomplete => OperationStatus::Unknown,
    };
    let outcome = serde_json::to_value(&completion)?;
    let operation = if status == OperationStatus::Unknown {
        store.mark_operation_unknown_with_outcome(operation_id, &shared.owner, &outcome)?
    } else {
        store.settle_operation(operation_id, &shared.owner, status, &outcome)?
    };
    Ok(Reply::Inference {
        operation,
        completion: Some(completion),
        duplicate: false,
    })
}
