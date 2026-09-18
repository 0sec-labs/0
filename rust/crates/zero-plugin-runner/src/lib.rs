//! Single-call offline plugin subprocesses. Results remain untrusted data.
mod stage;
use std::path::{Path, PathBuf};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use zero_harness::{Harness, PinnedCall};
use zero_plugin::{Call, Decoder, Frame, RpcError};
use zero_protocol::{
    ExecutionStatus,
    sandbox::{SandboxBackend, SandboxCleanup, SandboxRequest, SandboxResult},
};
use zero_sandbox::{EventSink, SandboxExecutor};
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("plugin runner rejected request: {0}")]
    Rejected(&'static str),
    #[error("plugin staging: {0}")]
    Io(#[from] std::io::Error),
    #[error("plugin data: {0}")]
    Plugin(#[from] zero_plugin::Error),
    #[error("plugin snapshot: {0}")]
    Snapshot(String),
    #[error("sandbox did not settle successfully")]
    Unsettled,
}
/// Caller-owned fixed profile; never populated from a guest frame or tool input.
#[derive(Clone)]
pub struct Launch {
    pub backend: SandboxBackend,
    pub interpreter: Vec<String>,
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpus: f64,
    pub max_output_bytes: usize,
}
#[derive(Debug)]
pub enum UntrustedReply {
    Result(serde_json::Value),
    Error(RpcError),
}
pub struct Outcome {
    pub call: PinnedCall,
    pub sandbox: Option<SandboxResult>,
    pub reply: Result<UntrustedReply, Error>,
    /// Preserved whenever cleanup is uncertain (also discoverable from RunningCall).
    pub staging_recovery: Option<PathBuf>,
}
impl Outcome {
    /// Only a bookkeeping precondition. Caller must also establish any broker
    /// effects have settled before calling Harness::complete_settled.
    pub fn backend_settled(&self) -> bool {
        self.staging_recovery.is_none()
            && self.sandbox.as_ref().is_none_or(|r| {
                matches!(
                    r.cleanup,
                    SandboxCleanup::NotCreated | SandboxCleanup::Confirmed
                )
            })
    }
}
pub struct RejectedCall {
    pub call: PinnedCall,
    pub error: Error,
}
pub struct RunningCall {
    task: Option<JoinHandle<Outcome>>,
    cancel: CancellationToken,
    staging: PathBuf,
}
impl Drop for RunningCall {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
impl RunningCall {
    pub fn staging_path(&self) -> &Path {
        &self.staging
    }
    /// Dropping this future cancels the worker but never aborts its owned task.
    /// Lost outcomes retain their durable lease for explicit fenced recovery.
    pub async fn wait(mut self) -> Result<Outcome, tokio::task::JoinError> {
        // The only caller consumes self, so this Option is present by construction.
        match self.task.take() {
            Some(task) => task.await,
            None => unreachable!("single-use wait"),
        }
    }
}
#[derive(Clone)]
pub struct Runner {
    sandbox: SandboxExecutor,
}
impl Runner {
    pub fn new(sandbox: SandboxExecutor) -> Self {
        Self { sandbox }
    }
    pub fn start(
        &self,
        harness: &Harness,
        call: PinnedCall,
        plugin: &str,
        launch: Launch,
        cancel: CancellationToken,
        sink: EventSink,
    ) -> Result<RunningCall, Box<RejectedCall>> {
        let prepared = match stage::prepare(harness, &call, plugin, &launch) {
            Ok(v) => v,
            Err(error) => return Err(Box::new(RejectedCall { call, error })),
        };
        let directory = match tempfile::Builder::new()
            .prefix(&format!("zero-plugin-{}-", call.lease().id))
            .tempdir()
        {
            Ok(v) => v.keep(),
            Err(error) => {
                return Err(Box::new(RejectedCall {
                    call,
                    error: Error::Io(error),
                }));
            }
        };
        // Keep first, dispose only after explicit settlement. Panic/unwind cannot
        // delete a source tree while a sandbox's owned worker still reads it.
        let staging = directory.clone();
        let token = cancel.child_token();
        let worker_token = token.clone();
        let sandbox = self.sandbox.clone();
        let task = tokio::spawn(async move {
            let request = stage::write(&call, prepared, launch, &directory);
            let (result, reply) = match request {
                Ok(request) => {
                    let result = sandbox.execute(request, worker_token, sink).await;
                    let reply = if result.status == ExecutionStatus::Exited
                        && result.exit_code == Some(0)
                        && matches!(
                            result.cleanup,
                            SandboxCleanup::Confirmed | SandboxCleanup::NotCreated
                        ) {
                        parse_reply(&result.stdout)
                    } else {
                        Err(Error::Unsettled)
                    };
                    (Some(result), reply)
                }
                Err(error) => (None, Err(error)),
            };
            let settled = result.as_ref().is_none_or(|r| {
                matches!(
                    r.cleanup,
                    SandboxCleanup::Confirmed | SandboxCleanup::NotCreated
                )
            });
            let staging_recovery = if settled && std::fs::remove_dir_all(&directory).is_ok() {
                None
            } else {
                Some(directory)
            };
            Outcome {
                call,
                sandbox: result,
                reply,
                staging_recovery,
            }
        });
        Ok(RunningCall {
            task: Some(task),
            cancel: token,
            staging,
        })
    }
}
fn parse_reply(bytes: &[u8]) -> Result<UntrustedReply, Error> {
    let mut decoder = Decoder::new();
    let mut frame = None;
    let mut extra = false;
    decoder.feed(bytes, |value| {
        if frame.is_some() {
            extra = true;
        } else {
            frame = Some(value);
        }
    })?;
    decoder.finish()?;
    if extra {
        return Err(Error::Rejected("more than one RPC frame"));
    }
    match frame {
        Some(Frame::Result { id: 1, result }) => Ok(UntrustedReply::Result(result)),
        Some(Frame::Error { id: 1, error }) => Ok(UntrustedReply::Error(error)),
        _ => Err(Error::Rejected(
            "expected one matching result/error; callbacks forbidden",
        )),
    }
}
fn input(call: &PinnedCall) -> Result<String, Error> {
    let bytes = Frame::Request {
        id: 1,
        call: Call {
            tool: call.invocation().tool.clone(),
            input: call.invocation().input.clone(),
        },
    }
    .encode()?;
    String::from_utf8(bytes).map_err(|_| Error::Rejected("invalid encoded request"))
}
