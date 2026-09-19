use super::*;
use std::{future::Future, pin::Pin};
use zero_plugin::{Capability, RpcError, Schema};
use zero_plugin_runner::{
    AuthorizedCapability, CapabilityHandler, CapabilityOutcome, HostCapability,
};

pub(super) struct Broker {
    pub shared: Arc<Shared>,
    pub worker: String,
    pub request: AgentRequest,
    pub source: Option<Arc<agent_source::Context>>,
    pub http: Option<agent_http::Context>,
    pub events: mpsc::Sender<ExecutionEvent>,
}
impl HostCapability for Broker {
    fn invoke(
        &self,
        request: AuthorizedCapability,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = CapabilityOutcome> + Send + 'static>> {
        let this = Self {
            shared: self.shared.clone(),
            worker: self.worker.clone(),
            request: self.request.clone(),
            source: self.source.clone(),
            http: self.http.clone(),
            events: self.events.clone(),
        };
        Box::pin(async move {
            let callback = (|| {
                let operation: PluginHostOperation =
                    serde_json::from_value(json!(request.operation()))?;
                Ok::<_, EngineError>(lock(&this.shared.store)?.admit_plugin_callback(
                    &this.worker,
                    &this.shared.owner,
                    &request.pin().lease_id,
                    request.request_id(),
                    operation,
                    request.input(),
                )?)
            })();
            let callback = match callback {
                Ok(v) => v,
                Err(e) => return failed(e.to_string(), true),
            };
            let result = this.run(&callback, request, &cancel).await;
            let (status, output, settled) = match result {
                Ok((value, true)) => (OperationStatus::Succeeded, json!({"output":value}), true),
                Ok((value, false)) => (OperationStatus::Failed, json!({"output":value}), true),
                Err(e) => (
                    OperationStatus::Unknown,
                    json!({"error":e.to_string()}),
                    false,
                ),
            };
            let saved = (|| {
                let mut store = lock(&this.shared.store)?;
                if settled {
                    store.settle_operation(&callback.id, &this.shared.owner, status, &output)?;
                } else {
                    store.mark_operation_unknown_with_outcome(
                        &callback.id,
                        &this.shared.owner,
                        &output,
                    )?;
                }
                Ok::<_, EngineError>(())
            })();
            if let Err(e) = saved {
                return failed(e.to_string(), false);
            }
            if status == OperationStatus::Succeeded {
                CapabilityOutcome {
                    reply: Ok(output["output"].clone()),
                    settled,
                }
            } else {
                failed(serde_json::to_string(&output).unwrap_or_default(), settled)
            }
        })
    }
}
fn failed(message: String, settled: bool) -> CapabilityOutcome {
    // Error text is bounded before crossing the guest transport.
    let message = message.chars().take(2048).collect();
    CapabilityOutcome {
        reply: Err(RpcError {
            code: -32001,
            message,
        }),
        settled,
    }
}
impl Broker {
    async fn run(
        &self,
        callback: &Operation,
        request: AuthorizedCapability,
        cancel: &CancellationToken,
    ) -> Result<(Value, bool), EngineError> {
        if request.operation() != "http_request" {
            let context = self
                .source
                .clone()
                .ok_or_else(|| error("source authority absent"))?;
            if cancel.is_cancelled() {
                return Ok((json!({"error":"cancelled before source access"}), false));
            }
            if let Err(e) = lock(&self.shared.store)?
                .begin_plugin_callback_effect(&callback.id, &self.shared.owner)
            {
                return Ok((json!({"error":e.to_string()}), false));
            }
            let name = request.operation().to_owned();
            let args = request.input().clone();
            let output = tokio::task::spawn_blocking(move || {
                let definitions = agent_source::definitions();
                agent_source::invoke(
                    &context,
                    &name,
                    args,
                    definitions.iter().find(|t| t.name == name),
                )
            })
            .await
            .map_err(error)?;
            return Ok(match output {
                Ok(v) => (v, true),
                Err(e) => (json!({"error":e.to_string()}), false),
            });
        }
        let context = self
            .http
            .as_ref()
            .ok_or_else(|| error("HTTP authority absent"))?;
        let prepared = match context.prepare(request.input().clone()) {
            Ok(v) => v,
            Err(e) => return Ok((json!({"error":e.to_string()}), false)),
        };
        let mut approval = None;
        let operation = if agent_approvals::required(&self.request, "http_request") {
            let effect = agent_approvals::Effect::Http {
                context: context.clone(),
                request: prepared.clone(),
            };
            match agent_approvals::admit_callback(
                &self.shared,
                callback,
                &effect,
                cancel,
                &self.events,
            )
            .await?
            {
                agent_approvals::ApprovalAdmission::Ready(value) => {
                    let op = value.operation.clone();
                    approval = Some(value);
                    op
                }
                agent_approvals::ApprovalAdmission::Finished(
                    agent_approvals::ResultKind::Output(v),
                ) => return Ok((json!({"denied":v}), false)),
                agent_approvals::ApprovalAdmission::Finished(
                    agent_approvals::ResultKind::Cancelled,
                ) => return Ok((json!({"error":"cancelled before HTTP dispatch"}), false)),
                agent_approvals::ApprovalAdmission::Finished(_) => {
                    return Err(error("HTTP approval did not settle"));
                }
            }
        } else {
            if cancel.is_cancelled() {
                return Ok((json!({"error":"cancelled before HTTP admission"}), false));
            }
            lock(&self.shared.store)?
                .admit_plugin_callback_http(&callback.id, &self.shared.owner)?
        };
        let operation = agent_http::execute_admitted(
            &self.shared,
            operation,
            context,
            prepared,
            cancel.clone(),
        )
        .await?;
        if operation.status == OperationStatus::Unknown {
            return Err(error("HTTP callback outcome uncertain"));
        }
        let success = operation.status == OperationStatus::Succeeded;
        let output = agent_http::validate_receipt(&*lock(&self.shared.store)?, &operation)?;
        if let Some(approval) = approval {
            approval.finish(&self.shared, operation, cancel)?;
        }
        Ok((
            serde_json::from_str(&output).unwrap_or(Value::String(output)),
            success,
        ))
    }
}
fn string(max: u32) -> Schema {
    Schema::String { max_length: max }
}
fn object(properties: Vec<(&str, Schema)>, required: &[&str]) -> Schema {
    Schema::Object {
        properties: properties.into_iter().map(|(k, v)| (k.into(), v)).collect(),
        required: required.iter().map(|s| (*s).into()).collect(),
        additional_properties: false,
    }
}
pub(super) fn handlers(
    broker: Arc<Broker>,
    policy: &PluginWorkerPolicy,
) -> BTreeMap<String, CapabilityHandler> {
    policy
        .operations
        .iter()
        .map(|operation| {
            let integer = |max| Schema::Integer {
                minimum: 1,
                maximum: max,
            };
            let schema = match operation {
                PluginHostOperation::ListSourceFiles => object(
                    vec![
                        ("prefix", string(4096)),
                        ("after_path", string(4096)),
                        ("max_results", integer(32)),
                    ],
                    &["max_results"],
                ),
                PluginHostOperation::ReadSourceLines => object(
                    vec![
                        ("path", string(4096)),
                        ("start_line", integer(u32::MAX.into())),
                        ("end_line", integer(u32::MAX.into())),
                    ],
                    &["path", "start_line", "end_line"],
                ),
                PluginHostOperation::SearchSourceText => object(
                    vec![
                        ("query", string(256)),
                        ("mode", string(16)),
                        ("case_sensitive", Schema::Boolean),
                        ("prefix", string(4096)),
                        ("max_results", integer(200)),
                    ],
                    &["query", "max_results"],
                ),
                // Header credentials are injected by the original private HTTP client.
                // This initial worker adapter accepts no guest-selected headers.
                PluginHostOperation::HttpRequest => object(
                    vec![
                        ("url", string(8192)),
                        ("method", string(16)),
                        ("body", string(65536)),
                        ("headers", object(vec![], &[])),
                    ],
                    &["url"],
                ),
            };
            (
                operation.name().to_owned(),
                CapabilityHandler {
                    capability: if *operation == PluginHostOperation::HttpRequest {
                        Capability::Network
                    } else {
                        Capability::FilesystemRead
                    },
                    parameters: schema,
                    handler: broker.clone(),
                },
            )
        })
        .collect()
}
