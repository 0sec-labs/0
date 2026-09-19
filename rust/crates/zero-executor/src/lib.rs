//! Native offline Docker snapshot execution. Linux/nonroot only. No host
//! fallback, image pulls, or abrupt-controller-death
//! cleanup guarantee. Event sinks must be nonblocking; capture remains bounded.
mod archive;
#[cfg(target_os = "linux")]
mod repository;
pub use archive::{capture_source_archive, stage_source_archive};
#[cfg(target_os = "linux")]
pub use repository::{RepositoryRequest, acquire_repository};
mod interactive;
mod process;
pub use interactive::{InteractiveInput, InteractiveSender, interactive_input};
mod snapshot;
pub use process::EventSink;
pub use snapshot::{
    SnapshotLimits, StagedSnapshot, capture_workspace, pin_snapshot, pin_snapshot_checked,
    snapshot_digest, stage_snapshot, verify_snapshot,
};

use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use zero_protocol::{
    CleanupStatus, ExecutionEvent, ExecutionRequest, ExecutionResult, ExecutionStatus, is_sha256,
};

#[derive(Debug, Clone)]
pub struct DockerExecutor {
    binary: PathBuf,
}
impl Default for DockerExecutor {
    fn default() -> Self {
        Self::new()
    }
}
impl DockerExecutor {
    pub fn new() -> Self {
        Self::with_binary(PathBuf::from("docker"))
    }
    pub fn with_binary(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub async fn execute(
        &self,
        request: ExecutionRequest,
        cancel: CancellationToken,
        sink: EventSink,
    ) -> ExecutionResult {
        self.execute_input(request, cancel, sink, None).await
    }

    /// Bounded duplex stdin; stdout is delivered through the existing event sink.
    /// The original deadline, aggregate output cap and daemon cleanup still apply.
    pub async fn execute_interactive(
        &self,
        request: ExecutionRequest,
        cancel: CancellationToken,
        sink: EventSink,
        input: InteractiveInput,
    ) -> ExecutionResult {
        self.execute_input(request, cancel, sink, Some(input)).await
    }

    async fn execute_input(
        &self,
        request: ExecutionRequest,
        cancel: CancellationToken,
        sink: EventSink,
        input: Option<InteractiveInput>,
    ) -> ExecutionResult {
        // Dropping a caller future requests cancellation, but does not drop the
        // lifecycle responsible for daemon cleanup. Runtime/process death remains
        // outside this guarantee; a live Tokio runtime must drain owned tasks.
        let token = cancel.child_token();
        let _cancel_on_drop = token.clone().drop_guard();
        let executor = self.clone();
        let execution_id = request.execution_id.clone();
        let name = format!("0sec-rust-{}", uuid::Uuid::new_v4());
        let failure_name = name.clone();
        match tokio::spawn(async move {
            executor
                .execute_owned(request, token, sink, name, input)
                .await
        })
        .await
        {
            Ok(result) => result,
            Err(error) => ExecutionResult {
                execution_id,
                status: ExecutionStatus::Failed,
                exit_code: None,
                stdout: vec![],
                stderr: vec![],
                duration_ms: 0,
                cleanup: CleanupStatus::Unconfirmed {
                    container_name: failure_name,
                },
                recovery_dir: None,
                error: Some(format!("execution supervisor failed: {error}")),
            },
        }
    }

    async fn execute_owned(
        &self,
        request: ExecutionRequest,
        cancel: CancellationToken,
        sink: EventSink,
        name: String,
        input: Option<InteractiveInput>,
    ) -> ExecutionResult {
        let start = Instant::now();
        let mut result = ExecutionResult {
            execution_id: request.execution_id.clone(),
            status: ExecutionStatus::Failed,
            exit_code: None,
            stdout: vec![],
            stderr: vec![],
            duration_ms: 0,
            cleanup: CleanupStatus::NotCreated,
            recovery_dir: None,
            error: None,
        };
        if let Err(error) = request.validate() {
            result.error = Some(error.to_string());
            return result;
        }
        if let Err(error) = supported_host() {
            result.error = Some(error);
            return result;
        }
        let deadline = start + Duration::from_millis(request.timeout_ms);
        let mut attempted_create = false;
        let mut created_id: Option<String> = None;
        let mut staged: Option<tempfile::TempDir> = None;
        let mut snapshot_checked = false;
        let phase: Result<(), String> = async {
            let pin = request.snapshot.clone();
            let token = cancel.clone();
            let staging = tokio::task::spawn_blocking(move || {
                check(&token, deadline)?;
                let stage = tempfile::Builder::new()
                    .prefix("0sec-rust-snapshot-")
                    .tempdir()
                    .map_err(|e| e.to_string())?;
                let source = stage.path().join("source");
                std::fs::create_dir(&source).map_err(|e| e.to_string())?;
                snapshot::verify_and_copy(&pin, Some(&source), &|| check(&token, deadline))?;
                Ok::<_, String>(stage)
            })
            .await
            .map_err(|e| e.to_string())??;
            staged = Some(staging);
            snapshot_checked = true;
            check(&cancel, deadline)?;
            let image = self
                .control(
                    &[
                        "image".into(),
                        "inspect".into(),
                        "--format".into(),
                        "{{.Id}}".into(),
                        request.image.clone(),
                    ],
                    deadline,
                    &cancel,
                )
                .await;
            control_ok(&image, "image inspect")?;
            let image_id = std::str::from_utf8(&image.stdout)
                .map_err(|_| "invalid image identity encoding")?
                .trim()
                .to_owned();
            if !is_sha256(&image_id) {
                return Err("Docker did not return an immutable image identity".into());
            }
            if is_sha256(&request.image) && request.image != image_id {
                return Err("Docker image identity mismatch".into());
            }
            let source = staged
                .as_ref()
                .ok_or("missing staged snapshot")?
                .path()
                .join("source");
            let args = create_args(&request, &name, &image_id, &source)?;
            let create = self
                .control(
                    &args,
                    deadline.min(Instant::now() + Duration::from_secs(30)),
                    &cancel,
                )
                .await;
            attempted_create = create.spawned;
            control_ok(&create, "create")?;
            let id = std::str::from_utf8(&create.stdout)
                .map_err(|_| "invalid container identity encoding")?
                .trim()
                .to_owned();
            if id.len() != 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("Docker did not return a full container identity".into());
            }
            created_id = Some(id.clone());
            let event = ExecutionEvent::Started {
                execution_id: request.execution_id.clone(),
                image_id,
                container_id: id.clone(),
            };
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(event))).is_err() {
                return Err("execution event callback panicked".into());
            }
            let args = vec![
                "start".into(),
                "--attach".into(),
                "--interactive".into(),
                id,
            ];
            let guest = process::run_input(
                &self.binary,
                &args,
                request.stdin.as_deref().unwrap_or("").as_bytes(),
                input,
                deadline,
                &cancel,
                request.max_output_bytes,
                Some((&request.execution_id, &sink)),
            )
            .await;
            result.status = guest.status;
            result.exit_code = guest.code;
            result.stdout = guest.stdout;
            result.stderr = guest.stderr;
            result.error = guest.error;
            Ok(())
        }
        .await;
        if let Err(error) = phase {
            result.status = if cancel.is_cancelled() {
                ExecutionStatus::Cancelled
            } else if Instant::now() >= deadline {
                ExecutionStatus::TimedOut
            } else {
                ExecutionStatus::Failed
            };
            result.error = Some(error);
        }
        if attempted_create {
            result.cleanup = self.cleanup(&name, created_id.as_deref()).await;
            if matches!(result.cleanup, CleanupStatus::Unconfirmed { .. }) {
                append_error(
                    &mut result,
                    "container removal not confirmed; retained recovery state",
                );
                if result.status == ExecutionStatus::Exited {
                    result.status = ExecutionStatus::Failed;
                }
                if let Some(stage) = staged.take() {
                    result.recovery_dir = Some(stage.keep().to_string_lossy().into_owned());
                }
            }
        }
        if snapshot_checked {
            let pin = request.snapshot.clone();
            let verification_deadline = Instant::now() + Duration::from_secs(5);
            let verified = tokio::task::spawn_blocking(move || {
                snapshot::verify_and_copy(&pin, None, &|| {
                    if Instant::now() >= verification_deadline {
                        Err("post-execution snapshot verification timed out".into())
                    } else {
                        Ok(())
                    }
                })
            })
            .await;
            match verified {
                Ok(Ok(())) => {}
                other => {
                    append_error(
                        &mut result,
                        &format!("post-execution snapshot verification failed: {other:?}"),
                    );
                    if result.status == ExecutionStatus::Exited {
                        result.status = ExecutionStatus::Failed;
                    }
                }
            }
        }
        result.duration_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
        result
    }

    async fn control(
        &self,
        args: &[String],
        deadline: Instant,
        cancel: &CancellationToken,
    ) -> process::Captured {
        process::run(
            &self.binary,
            args,
            &[],
            deadline.min(Instant::now() + Duration::from_secs(5)),
            cancel,
            65536,
            None,
        )
        .await
    }

    async fn cleanup(&self, name: &str, id: Option<&str>) -> CleanupStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        let token = CancellationToken::new();
        let target = id.unwrap_or(name);
        let remove = self
            .control(
                &["rm".into(), "--force".into(), target.into()],
                deadline,
                &token,
            )
            .await;
        let acknowledged = control_ok(&remove, "rm").is_ok()
            && std::str::from_utf8(&remove.stdout).is_ok_and(|s| s.trim() == target);
        let listing = self
            .control(
                &[
                    "container".into(),
                    "ls".into(),
                    "--all".into(),
                    "--filter".into(),
                    format!("label=io.0sec.execution={name}"),
                    "--format".into(),
                    "{{.ID}}".into(),
                ],
                deadline,
                &token,
            )
            .await;
        // Without a successful create response the daemon may still complete an
        // interrupted create after our cleanup. Empty listing is not proof then.
        if id.is_some()
            && acknowledged
            && control_ok(&listing, "container ls").is_ok()
            && listing.stdout.iter().all(u8::is_ascii_whitespace)
        {
            CleanupStatus::Confirmed
        } else {
            CleanupStatus::Unconfirmed {
                container_name: name.into(),
            }
        }
    }
}

fn check(cancel: &CancellationToken, deadline: Instant) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("execution cancelled".into())
    } else if Instant::now() >= deadline {
        Err("execution timed out".into())
    } else {
        Ok(())
    }
}

fn append_error(result: &mut ExecutionResult, message: &str) {
    if let Some(error) = &mut result.error {
        error.push_str("; ");
        error.push_str(message);
    } else {
        result.error = Some(message.into());
    }
}

fn control_ok(result: &process::Captured, operation: &str) -> Result<(), String> {
    if result.status == ExecutionStatus::Exited && result.code == Some(0) {
        return Ok(());
    }
    Err(format!(
        "Docker {operation} failed ({:?}, exit {:?}): {} {}",
        result.status,
        result.code,
        result.error.as_deref().unwrap_or(""),
        String::from_utf8_lossy(&result.stderr)
    ))
}

fn supported_host() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if nix::unistd::Uid::current().is_root() {
            return Err("snapshot execution requires a nonroot Linux host user".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("offline Docker snapshot execution is qualified only on nonroot Linux".into())
    }
}

fn quote(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| format!("'{}'", arg.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn create_args(
    request: &ExecutionRequest,
    name: &str,
    image: &str,
    source: &Path,
) -> Result<Vec<String>, String> {
    let source = source.to_str().ok_or("staging path must be UTF-8")?;
    if source.contains([',', '\0']) {
        return Err("staging path cannot contain a Docker mount separator".into());
    }
    #[cfg(unix)]
    let (uid, gid) = (
        nix::unistd::Uid::current().as_raw(),
        nix::unistd::Gid::current().as_raw(),
    );
    #[cfg(not(unix))]
    let (uid, gid) = (0, 0);
    let mut script = "set -eu\nmkdir -p /workspace\ncd /workspace\ncp -R /snapshot/. /workspace/\nchmod -R u+rwX /workspace\n".to_owned();
    if let Some(build) = &request.build_argv {
        script.push_str(&format!("{} >&2\n", quote(build)));
    }
    script.push_str(&format!("exec {}", quote(&request.argv)));
    Ok(vec![
        "create".into(),
        "--name".into(),
        name.into(),
        "--label".into(),
        format!("io.0sec.execution={name}"),
        "--pull".into(),
        "never".into(),
        "--interactive".into(),
        "--init".into(),
        "--read-only".into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--security-opt".into(),
        "no-new-privileges:true".into(),
        "--pids-limit".into(),
        "64".into(),
        "--memory".into(),
        format!("{}m", request.memory_mb),
        "--memory-swap".into(),
        format!("{}m", request.memory_mb),
        "--cpus".into(),
        request.cpus.to_string(),
        "--network".into(),
        "none".into(),
        "--user".into(),
        format!("{uid}:{gid}"),
        "--workdir".into(),
        "/workspace".into(),
        "--mount".into(),
        format!("type=bind,src={source},dst=/snapshot,ro"),
        "--tmpfs".into(),
        format!(
            "/workspace:rw,nosuid,nodev,mode=0700,uid={uid},gid={gid},size={}m",
            request.memory_mb
        ),
        "--tmpfs".into(),
        "/tmp:rw,noexec,nosuid,nodev,size=64m".into(),
        // The retained argv is host authority. An image ENTRYPOINT must not
        // intercept it or bypass the controlled workspace/bootstrap script.
        "--entrypoint".into(),
        "/bin/sh".into(),
        image.into(),
        "-c".into(),
        script,
    ])
}
