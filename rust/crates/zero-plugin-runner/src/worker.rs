//! Persistent sandbox workers with host-mediated, generation-bound callbacks.
use crate::*;
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot},
    time::{Instant, timeout},
};
use zero_harness::{BrokerPin, InvocationIssuer};
use zero_plugin::{Capability, Schema, WorkerDecoder, WorkerFrame};
use zero_protocol::{
    OutputStream,
    sandbox::{SandboxArtifact, SandboxEvent},
};

/// The trusted host maps operation names to required grants, schemas and code.
/// Worker frames cannot choose their own capability or handler.
pub struct CapabilityHandler {
    pub capability: Capability,
    pub parameters: Schema,
    pub handler: Arc<dyn HostCapability>,
}
/// Only constructed after captured grant and host schema validation.
pub struct AuthorizedCapability {
    pin: BrokerPin,
    operation: String,
    input: Value,
    request_id: u64,
}
impl AuthorizedCapability {
    pub fn pin(&self) -> &BrokerPin {
        &self.pin
    }
    pub fn operation(&self) -> &str {
        &self.operation
    }
    pub fn input(&self) -> &Value {
        &self.input
    }
    pub fn request_id(&self) -> u64 {
        self.request_id
    }
}
/// Settlement is a trusted host assertion, never a field supplied by the guest.
pub struct CapabilityOutcome {
    pub reply: Result<Value, RpcError>,
    pub settled: bool,
}
/// Adapters must enforce their own target/spend policy and join child effects on
/// cancellation. Declared plugin grants alone never authorize a paid operation.
pub trait HostCapability: Send + Sync {
    fn invoke(
        &self,
        request: AuthorizedCapability,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = CapabilityOutcome> + Send + 'static>>;
}
/// Owned uncertain work is returned for reconciliation; dropping never aborts
/// effects or releases the durable generation lease.
pub struct PendingCapability {
    task: JoinHandle<CapabilityOutcome>,
    cancel: CancellationToken,
}
impl PendingCapability {
    pub async fn wait(self) -> Result<CapabilityOutcome, tokio::task::JoinError> {
        self.task.await
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
}
#[derive(Clone)]
pub struct WorkerLimits {
    pub max_calls: usize,
    pub max_callbacks: usize,
    pub broker_drain_ms: u64,
}
impl Default for WorkerLimits {
    fn default() -> Self {
        Self {
            max_calls: 32,
            max_callbacks: 128,
            broker_drain_ms: 1000,
        }
    }
}
pub struct WorkerCallOutcome {
    pub call: PinnedCall,
    pub reply: Option<UntrustedReply>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerStatus {
    Completed,
    Cancelled,
    TimedOut,
    Failed,
    Unknown,
}
pub struct WorkerOutcome {
    pub status: WorkerStatus,
    pub calls: Vec<WorkerCallOutcome>,
    pub sandbox: SandboxResult,
    pub error: Option<String>,
    pub staging_recovery: Option<PathBuf>,
    pub pending_capability: Option<PendingCapability>,
    broker_settled: bool,
}
impl WorkerOutcome {
    /// Required before explicit Harness::complete_settled; not a security verdict.
    pub fn backend_settled(&self) -> bool {
        self.broker_settled
            && self.pending_capability.is_none()
            && self.staging_recovery.is_none()
            && matches!(
                self.sandbox.cleanup,
                SandboxCleanup::Confirmed | SandboxCleanup::NotCreated
            )
    }
}
struct Submission {
    call: PinnedCall,
    reply: oneshot::Sender<Result<UntrustedReply, String>>,
}
/// A live reply is provisional until the worker and every callback have settled.
pub struct WorkerReply(oneshot::Receiver<Result<UntrustedReply, String>>);
impl WorkerReply {
    pub async fn wait(self) -> Result<UntrustedReply, String> {
        self.0
            .await
            .unwrap_or_else(|_| Err("worker terminated before reply".into()))
    }
}
pub struct RunningWorker {
    task: Option<JoinHandle<WorkerOutcome>>,
    sender: Option<mpsc::Sender<Submission>>,
    cancel: CancellationToken,
    staging: PathBuf,
    pin: BrokerPin,
    issuer: InvocationIssuer,
    plugin: String,
    admitted: usize,
    max_calls: usize,
}
impl Drop for RunningWorker {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
impl RunningWorker {
    pub fn staging_path(&self) -> &Path {
        &self.staging
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
    /// Separate durable lease per call, exact generation/epoch/plugin, one waiting
    /// slot. Rejection returns the unused call to its owner.
    pub fn submit(
        &mut self,
        harness: &Harness,
        call: PinnedCall,
    ) -> Result<WorkerReply, Box<RejectedCall>> {
        let valid = call.issuer_identity() == self.issuer
            && harness.validate_reply(&call, &call.pin()).is_ok()
            && call.pin().generation == self.pin.generation
            && call.pin().plugin_manifest == self.pin.plugin_manifest
            && call.graph().plugin_digest(&self.plugin) == Some(self.pin.plugin_manifest.as_str())
            && self.admitted < self.max_calls
            && !self.cancel.is_cancelled();
        if !valid {
            return Err(Box::new(RejectedCall {
                call,
                error: Error::Rejected("worker invocation pin or limit"),
                owned_staging: None,
            }));
        }
        let (tx, rx) = oneshot::channel();
        let submission = Submission { call, reply: tx };
        let Some(sender) = &self.sender else {
            return Err(Box::new(RejectedCall {
                call: submission.call,
                error: Error::Rejected("worker closed"),
                owned_staging: None,
            }));
        };
        match sender.try_send(submission) {
            Ok(()) => {
                self.admitted += 1;
                Ok(WorkerReply(rx))
            }
            Err(e) => Err(Box::new(RejectedCall {
                call: e.into_inner().call,
                error: Error::Rejected("worker queue closed or full"),
                owned_staging: None,
            })),
        }
    }
    /// Close admission, drain accepted calls, request shutdown and join cleanup.
    pub async fn finish(mut self) -> Result<WorkerOutcome, tokio::task::JoinError> {
        self.sender.take();
        self.task.take().expect("single-use join").await
    }
}
impl Runner {
    /// Persistent Docker worker at a caller-recorded absent staging path.
    #[allow(clippy::too_many_arguments)]
    pub fn start_worker_in(
        &self,
        harness: &Harness,
        call: PinnedCall,
        plugin: &str,
        launch: Launch,
        limits: WorkerLimits,
        handlers: BTreeMap<String, CapabilityHandler>,
        directory: &Path,
        cancel: CancellationToken,
        sink: EventSink,
    ) -> Result<(RunningWorker, WorkerReply), Box<RejectedCall>> {
        let mut owned_staging = None;
        let prepared = (|| {
            if !matches!(launch.backend, SandboxBackend::Docker { .. }) {
                return Err(Error::Rejected("persistent workers require Docker"));
            }
            if !(1..=64).contains(&limits.max_calls)
                || !(1..=1024).contains(&limits.max_callbacks)
                || !(1..=5000).contains(&limits.broker_drain_ms)
                || handlers.len() > 32
            {
                return Err(Error::Rejected("worker limits"));
            }
            for (name, handler) in &handlers {
                WorkerFrame::CapabilityRequest {
                    call_id: 1,
                    id: 1,
                    operation: name.clone(),
                    input: serde_json::json!({}),
                }
                .encode()?;
                handler.parameters.validate()?;
            }
            let prepared = stage::prepare_mode(harness, &call, plugin, &launch, true)?;
            if !directory.is_absolute()
                || directory.parent().is_none()
                || std::fs::symlink_metadata(directory.parent().expect("checked"))?
                    .file_type()
                    .is_symlink()
            {
                return Err(Error::Rejected("invalid worker staging parent"));
            }
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(directory)?;
            owned_staging = Some(directory.to_owned());
            let mut request = stage::write(&call, prepared, launch, directory)?;
            request.stdin = None;
            Ok(request)
        })();
        let request = match prepared {
            Ok(r) => r,
            Err(error) => {
                return Err(Box::new(RejectedCall {
                    call,
                    error,
                    owned_staging,
                }));
            }
        };
        let (sender, receiver) = mpsc::channel(1);
        let (reply, first) = oneshot::channel();
        let pin = call.pin();
        let issuer = call.issuer_identity();
        let token = cancel.child_token();
        let task_token = token.clone();
        let staging = directory.to_owned();
        let task_staging = staging.clone();
        let sandbox = self.sandbox.clone();
        let max_calls = limits.max_calls;
        let task = tokio::spawn(async move {
            supervise(
                sandbox,
                request,
                Submission { call, reply },
                receiver,
                limits,
                handlers,
                task_staging,
                task_token,
                sink,
            )
            .await
        });
        Ok((
            RunningWorker {
                task: Some(task),
                sender: Some(sender),
                cancel: token,
                staging,
                pin,
                issuer,
                plugin: plugin.into(),
                admitted: 1,
                max_calls,
            },
            WorkerReply(first),
        ))
    }
}
struct Session {
    input: zero_executor::InteractiveSender,
    frames: mpsc::Receiver<Vec<u8>>,
    decoder: WorkerDecoder,
    ready: VecDeque<WorkerFrame>,
    cancel: CancellationToken,
    deadline: Instant,
    callbacks: usize,
    last_callback: u64,
    broker_settled: bool,
    pending: Option<PendingCapability>,
}
impl Session {
    async fn send(&self, frame: WorkerFrame) -> Result<(), String> {
        let bytes = frame.encode().map_err(|e| e.to_string())?;
        tokio::select! {biased;
            _=self.cancel.cancelled()=>Err("worker cancelled".into()),
            _=tokio::time::sleep_until(self.deadline)=>Err("worker deadline".into()),
            r=self.input.send(bytes)=>r.map_err(str::to_owned),
        }
    }
    async fn frame(&mut self) -> Result<WorkerFrame, String> {
        loop {
            if self.cancel.is_cancelled() {
                return Err("worker cancelled".into());
            }
            if Instant::now() >= self.deadline {
                return Err("worker deadline".into());
            }
            if let Some(frame) = self.ready.pop_front() {
                return Ok(frame);
            }
            let bytes = tokio::select! {biased;
                _=self.cancel.cancelled()=>return Err("worker cancelled".into()),
                _=tokio::time::sleep_until(self.deadline)=>return Err("worker deadline".into()),
                v=self.frames.recv()=>v.ok_or("worker output closed")?,
            };
            let mut overflow = false;
            self.decoder
                .feed(&bytes, |v| {
                    if self.ready.len() >= 16 {
                        overflow = true;
                    } else {
                        self.ready.push_back(v);
                    }
                })
                .map_err(|e| e.to_string())?;
            if overflow {
                return Err("worker frame burst exceeds bound".into());
            }
        }
    }
    async fn invoke(
        &mut self,
        call: &PinnedCall,
        id: u64,
        handlers: &BTreeMap<String, CapabilityHandler>,
        limits: &WorkerLimits,
    ) -> Result<UntrustedReply, String> {
        self.send(WorkerFrame::Invoke {
            id,
            call: Call {
                tool: call.invocation().tool.clone(),
                input: call.invocation().input.clone(),
            },
        })
        .await?;
        loop {
            match self.frame().await? {
                WorkerFrame::Result { id: r, result } if r == id => {
                    return Ok(UntrustedReply::Result(result));
                }
                WorkerFrame::Error { id: r, error } if r == id => {
                    return Ok(UntrustedReply::Error(error));
                }
                WorkerFrame::CapabilityRequest {
                    call_id,
                    id: r,
                    operation,
                    input,
                } if call_id == id => {
                    if r <= self.last_callback || self.callbacks >= limits.max_callbacks {
                        return Err("capability replay or limit".into());
                    }
                    self.last_callback = r;
                    self.callbacks += 1;
                    let handler = handlers.get(&operation).filter(|h| {
                        call.invocation().capabilities.contains(&h.capability)
                            && h.parameters.accepts(&input).is_ok()
                    });
                    let Some(handler) = handler else {
                        self.send(WorkerFrame::CapabilityError {
                            call_id,
                            id: r,
                            error: RpcError {
                                code: -32602,
                                message: "capability denied".into(),
                            },
                        })
                        .await?;
                        continue;
                    };
                    let token = self.cancel.child_token();
                    let task_token = token.clone();
                    let request = AuthorizedCapability {
                        pin: call.pin(),
                        operation,
                        input,
                        request_id: r,
                    };
                    let handler = handler.handler.clone();
                    // Callback construction and polling both occur in the owned task.
                    let mut task =
                        tokio::spawn(async move { handler.invoke(request, task_token).await });
                    let result = tokio::select! {biased;
                        _=self.cancel.cancelled()=>None,
                        _=tokio::time::sleep_until(self.deadline)=>None,
                        v=&mut task=>Some(v),
                    };
                    let result = if let Some(result) = result {
                        result
                    } else {
                        token.cancel();
                        match timeout(Duration::from_millis(limits.broker_drain_ms), &mut task)
                            .await
                        {
                            Ok(result) => result,
                            Err(_) => {
                                self.broker_settled = false;
                                self.pending = Some(PendingCapability {
                                    task,
                                    cancel: token,
                                });
                                return Err("capability teardown unknown".into());
                            }
                        }
                    };
                    let result = match result {
                        Ok(v) => v,
                        Err(_) => {
                            self.broker_settled = false;
                            return Err("capability task failed; settlement unknown".into());
                        }
                    };
                    if !result.settled {
                        self.broker_settled = false;
                        return Err("capability settlement unknown".into());
                    }
                    let frame = match result.reply {
                        Ok(result) => WorkerFrame::CapabilityResult {
                            call_id,
                            id: r,
                            result,
                        },
                        Err(error) => WorkerFrame::CapabilityError {
                            call_id,
                            id: r,
                            error,
                        },
                    };
                    self.send(frame).await?;
                }
                _ => return Err("unexpected worker frame or correlation".into()),
            }
        }
    }
}
#[allow(clippy::too_many_arguments)]
async fn supervise(
    sandbox: SandboxExecutor,
    request: SandboxRequest,
    first: Submission,
    mut receiver: mpsc::Receiver<Submission>,
    limits: WorkerLimits,
    handlers: BTreeMap<String, CapabilityHandler>,
    directory: PathBuf,
    cancel: CancellationToken,
    sink: EventSink,
) -> WorkerOutcome {
    let _cancel_on_drop = cancel.clone().drop_guard();
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let (input, input_rx) = zero_executor::interactive_input();
    let (output, frames) = mpsc::channel(16);
    let overflow = Arc::new(AtomicBool::new(false));
    let failed = overflow.clone();
    let fail_cancel = cancel.clone();
    let events: EventSink = Arc::new(move |event| {
        if let SandboxEvent::Output {
            stream: OutputStream::Stdout,
            bytes,
            ..
        } = &event
        {
            if output.try_send(bytes.clone()).is_err() {
                failed.store(true, Ordering::Release);
                fail_cancel.cancel();
            }
        }
        sink(event);
    });
    let failure_id = request.execution_id.clone();
    let failure_image = match &request.backend {
        SandboxBackend::Docker { image } => image.clone(),
        _ => unreachable!("validated Docker worker"),
    };
    let task_token = cancel.clone();
    let task = tokio::spawn(async move {
        sandbox
            .execute_interactive(request, task_token, events, input_rx)
            .await
    });
    let mut session = Session {
        input,
        frames,
        decoder: WorkerDecoder::default(),
        ready: VecDeque::new(),
        cancel: cancel.clone(),
        deadline,
        callbacks: 0,
        last_callback: 0,
        broker_settled: true,
        pending: None,
    };
    let mut calls = Vec::new();
    let mut error = match session.frame().await {
        Ok(WorkerFrame::Ready { version: 1 }) => None,
        Ok(_) => Some("expected worker ready".into()),
        Err(e) => Some(e),
    };
    let mut next = Some(first);
    while let Some(submission) = next.take() {
        let reply = if error.is_none() {
            session
                .invoke(&submission.call, calls.len() as u64 + 1, &handlers, &limits)
                .await
        } else {
            Err(error.clone().expect("present"))
        };
        if let Err(e) = &reply {
            error = Some(e.clone());
        }
        let retained = reply.as_ref().ok().cloned();
        let _ = submission.reply.send(reply);
        calls.push(WorkerCallOutcome {
            call: submission.call,
            reply: retained,
        });
        if error.is_some() {
            break;
        }
        next = tokio::select! {biased;
            _=cancel.cancelled()=>{error=Some("worker cancelled".into());None},
            _=tokio::time::sleep_until(deadline)=>{error=Some("worker deadline".into());None},
            frame=session.frame()=>{error=Some(format!("unsolicited worker frame: {}",frame.err().unwrap_or_else(||"unexpected frame".into())));None},
            v=receiver.recv()=>v,
        };
    }
    receiver.close();
    while let Some(submission) = receiver.recv().await {
        let _ = submission
            .reply
            .send(Err("worker closed before dispatch".into()));
        calls.push(WorkerCallOutcome {
            call: submission.call,
            reply: None,
        });
    }
    if error.is_none() {
        if let Err(e) = session.send(WorkerFrame::Shutdown).await {
            error = Some(e);
        }
    }
    let deadline_expired = Instant::now() >= deadline;
    let cancellation_requested = cancel.is_cancelled();
    if error.is_some() {
        cancel.cancel();
    }
    drop(session.input);
    // Never abort sandbox cleanup to make a timeout appear settled.
    let sandbox = match task.await {
        Ok(result) => result,
        Err(e) => {
            return WorkerOutcome {
                status: WorkerStatus::Unknown,
                calls,
                sandbox: SandboxResult {
                    execution_id: failure_id,
                    status: ExecutionStatus::Failed,
                    exit_code: None,
                    stdout: vec![],
                    stderr: vec![],
                    duration_ms: 0,
                    artifact: SandboxArtifact::Docker {
                        image_reference: failure_image,
                        resolved_image_id: None,
                    },
                    cleanup: SandboxCleanup::Unknown {
                        reason: e.to_string(),
                        recovery: None,
                    },
                    error: Some(e.to_string()),
                },
                error: Some("sandbox join unknown".into()),
                staging_recovery: Some(directory),
                pending_capability: session.pending,
                broker_settled: false,
            };
        }
    };
    if overflow.load(Ordering::Acquire) {
        error = Some("worker output queue overflow".into());
    }
    let mut all = WorkerDecoder::default();
    let mut frames = 0usize;
    if all.feed(&sandbox.stdout, |_| frames += 1).is_err()
        || all.finish().is_err()
        || !session.ready.is_empty()
    {
        error = Some("worker final framing invalid".into());
    }
    let expected = 1 + calls.iter().filter(|c| c.reply.is_some()).count() + session.callbacks;
    if frames != expected {
        error.get_or_insert("worker emitted unconsumed frames".into());
    }
    if sandbox.status != ExecutionStatus::Exited || sandbox.exit_code != Some(0) {
        error.get_or_insert("worker did not exit successfully".into());
    }
    let settled = matches!(
        sandbox.cleanup,
        SandboxCleanup::Confirmed | SandboxCleanup::NotCreated
    );
    let staging_recovery = if settled && session.broker_settled && session.pending.is_none() {
        match std::fs::remove_dir_all(&directory) {
            Ok(()) => None,
            Err(_) => Some(directory),
        }
    } else {
        Some(directory)
    };
    let status = if !settled
        || !session.broker_settled
        || session.pending.is_some()
        || staging_recovery.is_some()
    {
        WorkerStatus::Unknown
    } else if deadline_expired || sandbox.status == ExecutionStatus::TimedOut {
        WorkerStatus::TimedOut
    } else if cancellation_requested && !overflow.load(Ordering::Acquire) {
        WorkerStatus::Cancelled
    } else if error.is_some() {
        WorkerStatus::Failed
    } else {
        WorkerStatus::Completed
    };
    WorkerOutcome {
        status,
        calls,
        sandbox,
        error,
        staging_recovery,
        pending_capability: session.pending,
        broker_settled: session.broker_settled,
    }
}
