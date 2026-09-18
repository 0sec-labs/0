#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{path::Path, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::{Instant, timeout},
};
use tokio_util::sync::CancellationToken;
use zero_protocol::{ExecutionEvent, ExecutionStatus, OutputStream};

pub type EventSink = Arc<dyn Fn(ExecutionEvent) + Send + Sync>;

pub(crate) struct Captured {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: ExecutionStatus,
    pub error: Option<String>,
    pub spawned: bool,
}

pub(crate) fn environment(command: &mut Command) {
    command.env_clear();
    for key in [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
        "XDG_RUNTIME_DIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

#[cfg(unix)]
fn kill_group(pid: Option<u32>) -> Result<(), String> {
    use nix::{
        errno::Errno,
        sys::signal::{Signal, killpg},
        unistd::Pid,
    };
    if let Some(pid) = pid {
        match killpg(Pid::from_raw(pid as i32), Signal::SIGKILL) {
            Ok(()) | Err(Errno::ESRCH) => {}
            Err(e) => return Err(format!("cannot terminate launcher process group: {e}")),
        }
    }
    Ok(())
}
#[cfg(not(unix))]
fn kill_group(_: Option<u32>) -> Result<(), String> {
    Err("unsupported process-group platform".into())
}

#[cfg(unix)]
async fn observe_exit(pid: u32) -> Result<(), String> {
    use nix::{
        sys::wait::{Id, WaitPidFlag, WaitStatus, waitid},
        unistd::Pid,
    };
    loop {
        match waitid(
            Id::Pid(Pid::from_raw(pid as i32)),
            WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT,
        ) {
            Ok(WaitStatus::StillAlive) | Err(nix::errno::Errno::EINTR) => {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            Ok(_) => return Ok(()),
            Err(e) => return Err(format!("cannot observe owned launcher: {e}")),
        }
    }
}
#[cfg(not(unix))]
async fn observe_exit(_: u32) -> Result<(), String> {
    Err("unsupported process observation platform".into())
}
struct Group(Option<u32>);
impl Group {
    fn kill(&mut self) -> Result<(), String> {
        kill_group(self.0.take())
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

/// Output callbacks must be nonblocking; the caller owns transport backpressure.
pub(crate) async fn run(
    binary: &Path,
    args: &[String],
    input: &[u8],
    deadline: Instant,
    cancel: &CancellationToken,
    cap: usize,
    events: Option<(&str, &EventSink)>,
) -> Captured {
    let mut result = Captured {
        code: None,
        stdout: vec![],
        stderr: vec![],
        status: ExecutionStatus::Exited,
        error: None,
        spawned: false,
    };
    if cancel.is_cancelled() {
        result.status = ExecutionStatus::Cancelled;
        return result;
    }
    if Instant::now() >= deadline {
        result.status = ExecutionStatus::TimedOut;
        return result;
    }
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    environment(&mut command);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            result.status = ExecutionStatus::Failed;
            result.error = Some(format!("launcher spawn failed: {e}"));
            return result;
        }
    };
    result.spawned = true;
    let Some(pid) = child.id() else {
        result.status = ExecutionStatus::Failed;
        result.error = Some("spawned launcher identity unavailable".into());
        return result;
    };
    let mut group = Group(Some(pid));
    // Handles are guaranteed by the above pipe configuration.
    let (Some(mut stdout), Some(mut stderr), Some(mut stdin)) =
        (child.stdout.take(), child.stderr.take(), child.stdin.take())
    else {
        result.status = ExecutionStatus::Failed;
        result.error = Some("configured launcher pipes unavailable".into());
        return result;
    };
    let writer = async move {
        stdin.write_all(input).await?;
        stdin.shutdown().await
    };
    tokio::pin!(writer);
    let (mut out_open, mut err_open, mut writing, mut exited) = (true, true, true, false);
    let (mut out_buf, mut err_buf) = ([0u8; 8192], [0u8; 8192]);
    let mut sequence = 0;
    while out_open || err_open || !exited {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => { result.status = ExecutionStatus::Cancelled; break; }
            _ = tokio::time::sleep_until(deadline) => { result.status = ExecutionStatus::TimedOut; break; }
            observed = observe_exit(pid), if !exited => {
                if let Err(error) = observed {
                    group.0 = None;
                    result.status = ExecutionStatus::Failed;
                    result.error = Some(error);
                    break;
                }
                // WNOWAIT keeps the leader PID reserved until the final group
                // signal. Consume authority before reaping, never afterwards.
                if let Err(error) = group.kill() {
                    result.status = ExecutionStatus::Failed;
                    result.error = Some(error);
                    break;
                }
                exited = true;
                match child.wait().await {
                    Ok(status) => result.code = status.code(),
                    Err(e) => { result.status = ExecutionStatus::Failed; result.error = Some(format!("launcher wait failed: {e}")); }
                }
            }
            outcome = &mut writer, if writing => {
                writing = false;
                if let Err(e) = outcome {
                    if e.kind() != std::io::ErrorKind::BrokenPipe {
                        result.status = ExecutionStatus::Failed; result.error = Some(format!("stdin delivery failed: {e}")); break;
                    }
                }
            }
            read = stdout.read(&mut out_buf), if out_open => {
                match read {
                    Ok(0) => out_open = false,
                    Ok(n) => { if !collect(&mut result, &out_buf[..n], OutputStream::Stdout, cap, events, &mut sequence) { break; } }
                    Err(e) => { result.status = ExecutionStatus::Failed; result.error = Some(format!("stdout read failed: {e}")); break; }
                }
            }
            read = stderr.read(&mut err_buf), if err_open => {
                match read {
                    Ok(0) => err_open = false,
                    Ok(n) => { if !collect(&mut result, &err_buf[..n], OutputStream::Stderr, cap, events, &mut sequence) { break; } }
                    Err(e) => { result.status = ExecutionStatus::Failed; result.error = Some(format!("stderr read failed: {e}")); break; }
                }
            }
        }
    }
    if !exited {
        if let Err(error) = group.kill() {
            result.error = Some(error);
            result.status = ExecutionStatus::Failed;
        }
        let _ = child.start_kill();
        match timeout(Duration::from_secs(1), child.wait()).await {
            Ok(Ok(status)) => result.code = status.code(),
            _ => {
                result.error = Some("launcher reap not confirmed".into());
            }
        }
    }
    if result.status == ExecutionStatus::Exited && result.code.is_none() {
        result.status = ExecutionStatus::Failed;
        result
            .error
            .get_or_insert("launcher terminated by signal".into());
    }
    result
}

fn collect(
    result: &mut Captured,
    chunk: &[u8],
    stream: OutputStream,
    cap: usize,
    events: Option<(&str, &EventSink)>,
    sequence: &mut u64,
) -> bool {
    let output = if stream == OutputStream::Stdout {
        &mut result.stdout
    } else {
        &mut result.stderr
    };
    let keep = chunk.len().min(cap.saturating_sub(output.len()));
    output.extend_from_slice(&chunk[..keep]);
    if let Some((id, sink)) = events {
        if keep > 0 {
            *sequence += 1;
            let event = ExecutionEvent::Output {
                execution_id: id.into(),
                sequence: *sequence,
                stream,
                bytes: chunk[..keep].to_vec(),
            };
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(event))).is_err() {
                result.status = ExecutionStatus::Failed;
                result.error = Some("execution event callback panicked".into());
                return false;
            }
        }
    }
    if keep != chunk.len() {
        result.status = ExecutionStatus::OutputLimit;
        result.error = Some("output exceeded its byte limit".into());
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::{
        sys::wait::{Id, WaitPidFlag, WaitStatus, waitid},
        unistd::Pid,
    };
    #[tokio::test]
    async fn leader_stays_unreaped_until_group_signal_authority_is_consumed() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 7"])
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let mut group = Group(Some(pid));
        timeout(Duration::from_secs(2), observe_exit(pid))
            .await
            .unwrap()
            .unwrap();
        // A second WNOWAIT observation proves the leader is still waitable,
        // hence its PID cannot be reused before the group signal.
        assert!(matches!(
            waitid(
                Id::Pid(Pid::from_raw(pid as i32)),
                WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT
            )
            .unwrap(),
            WaitStatus::Exited(_, 7)
        ));
        group.kill().unwrap();
        assert!(group.0.is_none());
        assert_eq!(child.wait().await.unwrap().code(), Some(7));
        // Later teardown is a no-op, even after the PID becomes reusable.
        group.kill().unwrap();
    }
}
