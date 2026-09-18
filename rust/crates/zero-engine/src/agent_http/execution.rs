//! Every physical hop waits for a durable permit; no lock crosses a network await.
use super::*;
use futures_util::future::BoxFuture;
use zero_http::{DispatchPermit, ExecutionHooks, HookError, HopIntent, HopObservation};
use zero_protocol::Operation;
struct Hooks {
    shared: Arc<Shared>,
    session: String,
    effect: String,
    account: String,
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
impl ExecutionHooks for Hooks {
    fn admit<'a>(
        &'a self,
        intent: &'a HopIntent,
    ) -> BoxFuture<'a, Result<DispatchPermit, HookError>> {
        Box::pin(async move {
            let value = serde_json::to_value(intent).map_err(|_| HookError::Unavailable)?;
            loop {
                let admission = {
                    let mut store = self
                        .shared
                        .store
                        .lock()
                        .map_err(|_| HookError::Unavailable)?;
                    store
                        .admit_http_hop(
                            &self.session,
                            &self.effect,
                            &self.shared.owner,
                            &self.account,
                            &value,
                            now(),
                        )
                        .map_err(|_| HookError::Rejected)?
                };
                match admission {
                    zero_store::HttpAdmission::Admitted { receipt } => {
                        return Ok(DispatchPermit { id: receipt });
                    }
                    zero_store::HttpAdmission::WaitUntil { unix_ms } => {
                        tokio::time::sleep(std::time::Duration::from_millis(
                            unix_ms.saturating_sub(now()).max(1),
                        ))
                        .await
                    }
                }
            }
        })
    }
    fn observe_headers<'a>(
        &'a self,
        permit: &'a DispatchPermit,
        status: u16,
        retry_after: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), HookError>> {
        Box::pin(async move {
            let time = now();
            let until = retry_after.and_then(|v| {
                let v = v.trim();
                v.parse::<u64>()
                    .ok()
                    .map(|s| time.saturating_add(s.saturating_mul(1000)))
                    .or_else(|| {
                        httpdate::parse_http_date(v)
                            .ok()
                            .and_then(|date| date.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
                    })
            });
            self.shared
                .store
                .lock()
                .map_err(|_| HookError::Unavailable)?
                .observe_http_headers(
                    &self.session,
                    &self.effect,
                    &self.shared.owner,
                    &permit.id,
                    status,
                    until,
                    time,
                )
                .map_err(|_| HookError::Unavailable)
        })
    }
    fn settle<'a>(
        &'a self,
        permit: &'a DispatchPermit,
        observation: &'a HopObservation,
    ) -> BoxFuture<'a, Result<(), HookError>> {
        Box::pin(async move {
            let value = serde_json::to_value(observation).map_err(|_| HookError::Unavailable)?;
            self.shared
                .store
                .lock()
                .map_err(|_| HookError::Unavailable)?
                .settle_http_hop(
                    &self.session,
                    &self.effect,
                    &self.shared.owner,
                    &permit.id,
                    &value,
                )
                .map_err(|_| HookError::Unavailable)
        })
    }
}
struct Guard<'a> {
    shared: &'a Shared,
    id: String,
    settled: bool,
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if !self.settled {
            if let Ok(mut store) = self.shared.store.lock() {
                let _ = store.mark_operation_unknown(
                    &self.id,
                    &self.shared.owner,
                    "HTTP owner ended without retained terminal evidence",
                );
            }
        }
    }
}
pub(crate) async fn execute_admitted(
    shared: &Arc<Shared>,
    operation: Operation,
    context: &Context,
    prepared: zero_http::PreparedRequest,
    cancel: CancellationToken,
) -> Result<Operation, EngineError> {
    if operation.status != OperationStatus::Running
        || operation.owner.as_deref() != Some(&shared.owner)
        || operation.payload["kind"] != "agent_http"
        || operation.payload["http_context"] != context.identity
        || operation.payload["request"] != serde_json::to_value(prepared.intent())?
    {
        return Err(error(
            "admitted HTTP effect differs from captured invocation",
        ));
    }
    let mut guard = Guard {
        shared,
        id: operation.id.clone(),
        settled: false,
    };
    {
        let mut store = lock(&shared.store)?;
        let setup = (|| {
            store.ensure_http_account(&operation.session_id, &context.identity)?;
            store.retain_operation_artifact(
                &operation.id,
                &shared.owner,
                "http.request",
                &serde_json::to_vec(prepared.intent())?,
            )?;
            Ok::<_, EngineError>(())
        })();
        if setup.is_err() {
            let failed = store.settle_operation(
                &operation.id,
                &shared.owner,
                OperationStatus::Failed,
                &json!({"error_code":"http_preparation_failed","external_effects_started":false}),
            )?;
            guard.settled = true;
            return Ok(failed);
        }
    }
    let hooks = Hooks {
        shared: Arc::clone(shared),
        session: operation.session_id.clone(),
        effect: operation.id.clone(),
        account: context.identity["account_id"]
            .as_str()
            .ok_or_else(|| error("HTTP account absent"))?
            .into(),
    };
    // Await the transport itself. Cancellation is handled inside its owned IO path.
    let outcome = context.client.execute(prepared, cancel, &hooks).await;
    let mut store = lock(&shared.store)?;
    let dispatches = store.read_http_dispatches(&operation.session_id, &operation.id)?;
    let status = receipt::status(&outcome, &dispatches);
    let retained = receipt::retain(&mut store, &operation, &shared.owner, outcome, &dispatches)?;
    let operation = if status == OperationStatus::Unknown {
        store.mark_operation_unknown_with_outcome(&operation.id, &shared.owner, &retained)?
    } else {
        store.settle_operation(&operation.id, &shared.owner, status, &retained)?
    };
    guard.settled = true;
    Ok(operation)
}
