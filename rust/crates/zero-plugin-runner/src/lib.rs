//! Sandboxed one-shot and persistent plugin workers. Results remain untrusted data.
mod stage;
mod worker;
use std::path::{Path, PathBuf};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
pub use worker::*;
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
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Launch {
    pub backend: SandboxBackend,
    pub interpreter: Vec<String>,
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpus: f64,
    pub max_output_bytes: usize,
}
impl Launch {
    /// Pure profile validation via the sandbox's authoritative field checks.
    /// The synthetic index is never returned or dispatched as a snapshot permit.
    pub fn validate(&self) -> Result<(), Error> {
        if self.interpreter.is_empty()
            || self.interpreter.len() > 16
            || self
                .interpreter
                .iter()
                .any(|a| a.is_empty() || a.len() > 4096 || a.contains('\0'))
            || !(256..=zero_plugin::MAX_FRAME_BYTES).contains(&self.max_output_bytes)
        {
            return Err(Error::Rejected("invalid host launch profile"));
        }
        let digest = format!("sha256:{}", "0".repeat(64));
        SandboxRequest {
            execution_id: "profile-validation".into(),
            backend: self.backend.clone(),
            snapshot: zero_protocol::SnapshotPin {
                id: "profile-validation".into(),
                root: "/profile-validation".into(),
                digest: digest.clone(),
                files: vec![zero_protocol::SnapshotFile {
                    path: "entry".into(),
                    digest,
                    bytes: 0,
                }],
            },
            argv: self.interpreter.clone(),
            build_argv: None,
            stdin: None,
            timeout_ms: self.timeout_ms,
            memory_mb: self.memory_mb,
            cpus: self.cpus,
            max_output_bytes: self.max_output_bytes,
        }
        .validate()
        .map_err(|e| Error::Snapshot(e.to_string()))
    }
}
#[derive(Debug, Clone)]
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
    /// Only set after this preparation successfully created the absent path.
    pub owned_staging: Option<PathBuf>,
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
        let directory = match tempfile::Builder::new()
            .prefix(&format!("zero-plugin-{}-", call.lease().id))
            .tempdir()
        {
            Ok(dir) => {
                let path = dir.path().to_owned();
                drop(dir);
                path
            }
            Err(error) => {
                return Err(Box::new(RejectedCall {
                    call,
                    error: Error::Io(error),
                    owned_staging: None,
                }));
            }
        };
        self.prepare_in(harness, call, plugin, launch, &directory)
            .map(|p| p.start(cancel, sink))
    }
    /// The caller persists this absent, private attempt path BEFORE preparation.
    /// This method may stage bytes but never dispatches a guest. Existing paths reject.
    pub fn prepare_in(
        &self,
        harness: &Harness,
        call: PinnedCall,
        plugin: &str,
        launch: Launch,
        directory: &Path,
    ) -> Result<PreparedRun, Box<RejectedCall>> {
        let mut owned_staging = None;
        let prepare = (|| {
            let prepared = stage::prepare(harness, &call, plugin, &launch)?;
            if !directory.is_absolute() {
                return Err(Error::Rejected("staging path must be absolute"));
            }
            let parent = directory
                .parent()
                .ok_or(Error::Rejected("missing staging parent"))?;
            if std::fs::symlink_metadata(parent)?.file_type().is_symlink() {
                return Err(Error::Rejected("staging parent is a symlink"));
            }
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(directory)?;
            owned_staging = Some(directory.to_owned());
            stage::write(&call, prepared, launch, directory)
        })();
        match prepare {
            Ok(request) => Ok(PreparedRun {
                runner: self.clone(),
                call,
                request,
                directory: directory.to_owned(),
            }),
            // The caller owns the recorded attempt path and must reconcile any
            // partial staging. No backend has been launched on this path.
            Err(error) => Err(Box::new(RejectedCall {
                call,
                error,
                owned_staging,
            })),
        }
    }
}
/// Non-cloneable dispatch permit. Drop retains staging and lease for recovery.
pub struct PreparedRun {
    runner: Runner,
    call: PinnedCall,
    request: SandboxRequest,
    directory: PathBuf,
}
impl PreparedRun {
    pub fn call(&self) -> &PinnedCall {
        &self.call
    }
    pub fn staging_path(&self) -> &Path {
        &self.directory
    }
    pub fn execution_id(&self) -> &str {
        &self.request.execution_id
    }
    pub fn request_digest(&self) -> Result<String, Error> {
        Ok(zero_plugin::sha256(
            &serde_json::to_vec(&self.request).map_err(|_| Error::Rejected("request encoding"))?,
        ))
    }
    pub fn start(self, cancel: CancellationToken, sink: EventSink) -> RunningCall {
        let Self {
            runner,
            call,
            request,
            directory,
        } = self;
        let staging = directory.clone();
        let token = cancel.child_token();
        let worker_token = token.clone();
        let task = tokio::spawn(async move {
            let result = runner.sandbox.execute(request, worker_token, sink).await;
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
            let settled = matches!(
                result.cleanup,
                SandboxCleanup::Confirmed | SandboxCleanup::NotCreated
            );
            let staging_recovery = if settled && std::fs::remove_dir_all(&directory).is_ok() {
                None
            } else {
                Some(directory)
            };
            Outcome {
                call,
                sandbox: Some(result),
                reply,
                staging_recovery,
            }
        });
        RunningCall {
            task: Some(task),
            cancel: token,
            staging,
        }
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
