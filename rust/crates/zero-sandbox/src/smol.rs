use super::*;
use std::time::Duration;
use tokio::time::Instant;
use zero_executor::{stage_snapshot, verify_snapshot};
use zero_protocol::OutputStream;
use zero_smolvm::{ReadOnlyMount, SmolvmRequest, SmolvmStatus, VmCleanup};

fn check(cancel: &CancellationToken, deadline: Instant) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("sandbox cancelled during setup".into())
    } else if Instant::now() >= deadline {
        Err("sandbox deadline expired during setup".into())
    } else {
        Ok(())
    }
}
fn quote(argv: &[String]) -> String {
    argv.iter()
        .map(|v| format!("'{}'", v.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ")
}
fn script(request: &SandboxRequest) -> String {
    let mut text="set -eu\nwork=$(mktemp -d /tmp/0sec-work.XXXXXX)\ncd \"$work\"\ncp -R /snapshot/. .\nchmod -R u+rwX .\n".to_owned();
    if let Some(build) = &request.build_argv {
        text.push_str(&format!("{} >&2\n", quote(build)));
    }
    text.push_str(&format!("exec {}", quote(&request.argv)));
    text
}
pub(super) async fn run(
    request: SandboxRequest,
    config: &SmolvmConfig,
    cancel: CancellationToken,
    sink: EventSink,
    deadline: Instant,
) -> SandboxResult {
    let mut result = initial(&request);
    let pin = request.snapshot.clone();
    let token = cancel.clone();
    let stage = match tokio::task::spawn_blocking(move || {
        stage_snapshot(&pin, &|| check(&token, deadline))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|v| v)
    {
        Ok(stage) => stage,
        Err(error) => {
            result.error = Some(format!("snapshot staging failed: {error}"));
            if cancel.is_cancelled() {
                result.status = ExecutionStatus::Cancelled;
            } else if Instant::now() >= deadline {
                result.status = ExecutionStatus::TimedOut;
            }
            return result;
        }
    };
    let stage_path = stage.root().to_path_buf();
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u64;
    if cancel.is_cancelled() || remaining < 100 {
        result.status = if cancel.is_cancelled() {
            ExecutionStatus::Cancelled
        } else {
            ExecutionStatus::TimedOut
        };
    } else if let SandboxBackend::Smolvm {
        image_archive,
        archive_digest,
        storage_gb,
    } = &request.backend
    {
        let low = SmolvmRequest {
            execution_id: request.execution_id.clone(),
            image_archive: image_archive.clone(),
            archive_digest: archive_digest.clone(),
            argv: vec!["/bin/sh".into(), "-c".into(), script(&request)],
            stdin: request.stdin.as_deref().unwrap_or("").as_bytes().to_vec(),
            mounts: vec![ReadOnlyMount {
                source: stage.source(),
                target: "/snapshot".into(),
            }],
            timeout_ms: remaining,
            memory_mb: request.memory_mb,
            cpus: request.cpus as u16,
            storage_gb: *storage_gb,
            max_output_bytes: request.max_output_bytes,
        };
        let output = zero_smolvm::execute(low, config.clone(), cancel.clone()).await;
        result.status = match output.status {
            SmolvmStatus::Exited => ExecutionStatus::Exited,
            SmolvmStatus::Failed => ExecutionStatus::Failed,
            SmolvmStatus::Cancelled => ExecutionStatus::Cancelled,
            SmolvmStatus::TimedOut => ExecutionStatus::TimedOut,
            SmolvmStatus::OutputLimit => ExecutionStatus::OutputLimit,
        };
        result.exit_code = output.exit_code;
        result.stdout = output.stdout;
        result.stderr = output.stderr;
        result.error = output.error;
        result.cleanup = match output.cleanup {
            VmCleanup::NotCreated => SandboxCleanup::NotCreated,
            VmCleanup::Confirmed => SandboxCleanup::Confirmed,
            VmCleanup::Unconfirmed { recovery_dir } => SandboxCleanup::Unconfirmed {
                recovery: SandboxRecovery::Smolvm {
                    runtime_dir: Some(recovery_dir),
                    snapshot_dir: Some(stage_path.clone()),
                },
            },
            VmCleanup::Unknown { reason } => SandboxCleanup::Unknown {
                reason,
                recovery: Some(SandboxRecovery::Smolvm {
                    runtime_dir: None,
                    snapshot_dir: Some(stage_path.clone()),
                }),
            },
        };
    }
    // Verification receives a separate bounded finalization window just like
    // Docker. Cancellation never skips integrity evidence or confirmed teardown.
    let pin = request.snapshot;
    let verification_deadline = Instant::now() + Duration::from_secs(5);
    if let Err(error) = match tokio::task::spawn_blocking(move || {
        verify_snapshot(&pin, &|| {
            if Instant::now() >= verification_deadline {
                Err("snapshot recheck deadline".into())
            } else {
                Ok(())
            }
        })
    })
    .await
    {
        Ok(value) => value,
        Err(error) => Err(error.to_string()),
    } {
        append_error(
            &mut result,
            format!("post-execution snapshot verification failed: {error}"),
        );
    }
    if matches!(
        result.cleanup,
        SandboxCleanup::NotCreated | SandboxCleanup::Confirmed
    ) {
        if let Err(error) = stage.remove() {
            append_error(&mut result, format!("snapshot disposal failed: {error}"));
            result.cleanup = SandboxCleanup::Unconfirmed {
                recovery: SandboxRecovery::Smolvm {
                    runtime_dir: None,
                    snapshot_dir: Some(stage_path),
                },
            };
        }
    }
    // The current microVM adapter buffers; do not fabricate a Started or a live
    // streaming guarantee. Terminal raw bytes remain authoritative on sink error.
    if let Err(error) = deliver_output(&result, &sink) {
        append_error(&mut result, error);
    }
    result
}
fn deliver_output(result: &SandboxResult, sink: &EventSink) -> Result<(), String> {
    let mut sequence = 0;
    for (stream, bytes) in [
        (OutputStream::Stdout, &result.stdout),
        (OutputStream::Stderr, &result.stderr),
    ] {
        for bytes in bytes.chunks(8192) {
            sequence += 1;
            let event = SandboxEvent::Output {
                execution_id: result.execution_id.clone(),
                sequence,
                stream: stream.clone(),
                bytes: bytes.to_vec(),
            };
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(event))).is_err() {
                return Err("sandbox output callback panicked".into());
            }
        }
    }
    Ok(())
}
