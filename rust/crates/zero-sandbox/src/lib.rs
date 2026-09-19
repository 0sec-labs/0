//! Explicit native backend selection. No pulls, fallback, or guest-selected host paths.
mod smol;
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use zero_executor::DockerExecutor;
pub use zero_protocol::sandbox::*;
use zero_protocol::{CleanupStatus, ExecutionEvent, ExecutionStatus};
use zero_smolvm::SmolvmConfig;

/// Nonblocking callback. Docker output is live; smolvm output is currently
/// delivered in bounded chunks after completion, never advertised as live.
pub type EventSink = Arc<dyn Fn(SandboxEvent) + Send + Sync>;
#[derive(Clone)]
pub struct SandboxExecutor {
    docker: DockerExecutor,
    smolvm: SmolvmConfig,
}
impl Default for SandboxExecutor {
    fn default() -> Self {
        Self::new()
    }
}
impl SandboxExecutor {
    pub fn new() -> Self {
        Self::with_backends(DockerExecutor::new(), SmolvmConfig::default())
    }
    pub fn with_backends(docker: DockerExecutor, smolvm: SmolvmConfig) -> Self {
        Self { docker, smolvm }
    }
    pub async fn execute(
        &self,
        request: SandboxRequest,
        cancel: CancellationToken,
        sink: EventSink,
    ) -> SandboxResult {
        self.execute_input(request, cancel, sink, None).await
    }

    /// Persistent transport is Docker-only; other backends fail before dispatch.
    pub async fn execute_interactive(
        &self,
        request: SandboxRequest,
        cancel: CancellationToken,
        sink: EventSink,
        input: zero_executor::InteractiveInput,
    ) -> SandboxResult {
        self.execute_input(request, cancel, sink, Some(input)).await
    }

    async fn execute_input(
        &self,
        request: SandboxRequest,
        cancel: CancellationToken,
        sink: EventSink,
        input: Option<zero_executor::InteractiveInput>,
    ) -> SandboxResult {
        let token = cancel.child_token();
        let _cancel_on_drop = token.clone().drop_guard();
        let executor = self.clone();
        let mut fallback = initial(&request);
        match tokio::spawn(async move { executor.run(request, token, sink, input).await }).await {
            Ok(result) => result,
            Err(error) => {
                fallback.error = Some(format!("sandbox supervisor failed: {error}"));
                fallback.cleanup = SandboxCleanup::Unknown {
                    reason: error.to_string(),
                    recovery: None,
                };
                fallback
            }
        }
    }
    async fn run(
        &self,
        request: SandboxRequest,
        cancel: CancellationToken,
        sink: EventSink,
        input: Option<zero_executor::InteractiveInput>,
    ) -> SandboxResult {
        let start = Instant::now();
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(request.timeout_ms.min(600000));
        let mut result = initial(&request);
        if let Err(error) = request.validate() {
            result.error = Some(error.to_string());
            return result;
        }
        if input.is_some() && !matches!(request.backend, SandboxBackend::Docker { .. }) {
            result.error = Some("interactive transport requires Docker".into());
            return result;
        }
        match &request.backend {
            SandboxBackend::Docker { image } => {
                let resolved = Arc::new(Mutex::new(None));
                let identity = resolved.clone();
                let image = image.clone();
                let events = Arc::new(move |event| match event {
                    // Engine/provider events are never emitted by the Docker primitive.
                    ExecutionEvent::Admitted { .. }
                    | ExecutionEvent::ModelProgress { .. }
                    | ExecutionEvent::OperatorQuestionRequested { .. }
                    | ExecutionEvent::ToolApprovalRequested { .. } => {}
                    ExecutionEvent::Sandbox { event } => sink(event),
                    ExecutionEvent::Started {
                        execution_id,
                        image_id,
                        ..
                    } => {
                        *identity.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some(image_id.clone());
                        sink(SandboxEvent::Started {
                            execution_id,
                            artifact: SandboxArtifact::Docker {
                                image_reference: image.clone(),
                                resolved_image_id: Some(image_id),
                            },
                        })
                    }
                    ExecutionEvent::Output {
                        execution_id,
                        sequence,
                        stream,
                        bytes,
                    } => sink(SandboxEvent::Output {
                        execution_id,
                        sequence,
                        stream,
                        bytes,
                    }),
                });
                let value = match input {
                    Some(input) => {
                        self.docker
                            .execute_interactive(request.docker_request(), cancel, events, input)
                            .await
                    }
                    None => {
                        self.docker
                            .execute(request.docker_request(), cancel, events)
                            .await
                    }
                };
                if let SandboxArtifact::Docker {
                    resolved_image_id, ..
                } = &mut result.artifact
                {
                    *resolved_image_id = resolved.lock().unwrap_or_else(|e| e.into_inner()).clone();
                }
                result.status = value.status;
                result.exit_code = value.exit_code;
                result.stdout = value.stdout;
                result.stderr = value.stderr;
                result.error = value.error;
                result.cleanup = match value.cleanup {
                    CleanupStatus::NotCreated => SandboxCleanup::NotCreated,
                    CleanupStatus::Confirmed => SandboxCleanup::Confirmed,
                    CleanupStatus::Unconfirmed { container_name } => SandboxCleanup::Unconfirmed {
                        recovery: SandboxRecovery::Docker {
                            container_name,
                            snapshot_dir: value.recovery_dir,
                        },
                    },
                };
            }
            SandboxBackend::Smolvm { .. } => {
                result = smol::run(request, &self.smolvm, cancel, sink, deadline).await
            }
        }
        result.duration_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
        result
    }
}
fn initial(request: &SandboxRequest) -> SandboxResult {
    SandboxResult {
        execution_id: request.execution_id.clone(),
        artifact: match &request.backend {
            SandboxBackend::Docker { image } => SandboxArtifact::Docker {
                image_reference: image.clone(),
                resolved_image_id: None,
            },
            SandboxBackend::Smolvm { archive_digest, .. } => SandboxArtifact::SmolvmArchive {
                digest: archive_digest.clone(),
            },
        },
        status: ExecutionStatus::Failed,
        exit_code: None,
        stdout: vec![],
        stderr: vec![],
        duration_ms: 0,
        cleanup: SandboxCleanup::NotCreated,
        error: None,
    }
}
fn append_error(result: &mut SandboxResult, error: String) {
    result.error = Some(match result.error.take() {
        Some(old) => format!("{old}; {error}"),
        None => error,
    });
    if result.status == ExecutionStatus::Exited {
        result.status = ExecutionStatus::Failed;
    }
}
