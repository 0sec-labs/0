use crate::{SmolvmStatus, types::SmolvmConfig};
use nix::{
    sys::{
        signal::{Signal, killpg},
        wait::{Id, WaitPidFlag, WaitStatus, waitid},
    },
    unistd::Pid,
};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::{Instant, timeout},
};
use tokio_util::sync::CancellationToken;

pub(crate) struct Capture {
    pub code: Option<i32>,
    pub out: Vec<u8>,
    pub err: Vec<u8>,
    pub status: SmolvmStatus,
    pub error: Option<String>,
    pub spawned: bool,
}
struct Group(Option<u32>);
impl Group {
    fn kill(&mut self) -> Result<(), String> {
        // Consume authority BEFORE signalling/reaping: never signal this numeric
        // group again after its unreaped leader stops reserving the PID.
        if let Some(id) = self.0.take() {
            match killpg(Pid::from_raw(id as i32), Signal::SIGKILL) {
                Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
                Err(e) => return Err(format!("launcher group termination failed: {e}")),
            }
        }
        Ok(())
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}
// Observe without reaping. Tokio Child::wait would release the PID before the
// group signal, allowing reuse. The child remains owned until group teardown.
async fn observe_exit(pid: u32) -> Result<(), String> {
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
fn environment(cmd: &mut Command, root: &Path) {
    cmd.env_clear();
    for key in ["PATH", "LANG", "LC_ALL", "LC_CTYPE"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    for (key, sub) in [
        ("HOME", "h"),
        ("XDG_CACHE_HOME", "c"),
        ("XDG_DATA_HOME", "d"),
        ("XDG_CONFIG_HOME", "f"),
        ("XDG_RUNTIME_DIR", "r"),
        ("TMPDIR", "t"),
    ] {
        cmd.env(key, root.join(sub));
    }
    for key in ["SMOLVM_LIB_DIR", "SMOLVM_AGENT_ROOTFS"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, &value);
            if key == "SMOLVM_LIB_DIR" {
                cmd.env("LD_LIBRARY_PATH", value);
            }
        }
    }
}
fn banner(line: &[u8]) -> bool {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    line.strip_prefix(b"Starting ephemeral machine (vm-")
        .and_then(|v| v.strip_suffix(b")..."))
        .is_some_and(|v| {
            !v.is_empty()
                && v.iter()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        })
}
/// Owns launcher group until pipes and child settle. Guest banner is validation,
/// never authority for selecting a host process to signal.
#[allow(clippy::too_many_arguments)] // Internal bounded process primitive; each limit is explicit.
pub(crate) async fn capture(
    config: &SmolvmConfig,
    root: &Path,
    args: &[String],
    input: &[u8],
    deadline: Instant,
    cancel: &CancellationToken,
    cap: usize,
    require_banner: bool,
) -> Capture {
    let mut result = Capture {
        code: None,
        out: vec![],
        err: vec![],
        status: SmolvmStatus::Exited,
        error: None,
        spawned: false,
    };
    if cancel.is_cancelled() {
        result.status = SmolvmStatus::Cancelled;
        return result;
    }
    if Instant::now() >= deadline {
        result.status = SmolvmStatus::TimedOut;
        return result;
    }
    let mut cmd = Command::new(&config.setpriv);
    cmd.args(["--pdeathsig", "KILL", "--"])
        .arg(&config.binary)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    environment(&mut cmd, root);
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            result.status = SmolvmStatus::Failed;
            result.error = Some(format!("launcher spawn failed: {e}"));
            return result;
        }
    };
    result.spawned = true;
    let Some(pid) = child.id() else {
        result.status = SmolvmStatus::Failed;
        result.error = Some("spawned launcher identity unavailable".into());
        return result;
    };
    let mut group = Group(Some(pid));
    let (Some(mut out), Some(mut err), Some(mut stdin)) =
        (child.stdout.take(), child.stderr.take(), child.stdin.take())
    else {
        result.status = SmolvmStatus::Failed;
        result.error = Some("launcher pipes unavailable".into());
        return result;
    };
    let write = async move {
        stdin.write_all(input).await?;
        stdin.shutdown().await
    };
    tokio::pin!(write);
    let (mut out_open, mut err_open, mut writing, mut exited) = (true, true, true, false);
    let (mut ob, mut eb) = ([0; 8192], [0; 8192]);
    let mut prefix = Vec::new();
    let mut seen = !require_banner;
    while out_open || err_open || !exited {
        tokio::select! { biased;
            _=cancel.cancelled()=>{result.status=SmolvmStatus::Cancelled;break},
            _=tokio::time::sleep_until(deadline)=>{result.status=SmolvmStatus::TimedOut;break},
            value=observe_exit(pid),if !exited=>{
                if let Err(e)=value {group.0=None;result.status=SmolvmStatus::Failed;result.error=Some(e);break}
                if let Err(e)=group.kill(){result.status=SmolvmStatus::Failed;result.error=Some(e);break}
                exited=true;
                match child.wait().await {Ok(v)=>{result.code=v.code();if v.code().is_none(){result.status=SmolvmStatus::Failed;result.error=Some("launcher terminated by signal".into());}},Err(e)=>{result.status=SmolvmStatus::Failed;result.error=Some(e.to_string());break}}
            },
            value=&mut write,if writing=>{writing=false;if let Err(e)=value {if e.kind()!=std::io::ErrorKind::BrokenPipe{result.status=SmolvmStatus::Failed;result.error=Some(format!("stdin failed: {e}"));break}}},
            value=out.read(&mut ob),if out_open=>{match value {Ok(0)=>out_open=false,Ok(n)=>{let keep=n.min(cap.saturating_sub(result.out.len()));result.out.extend_from_slice(&ob[..keep]);if keep<n{result.status=SmolvmStatus::OutputLimit;break}},Err(e)=>{result.status=SmolvmStatus::Failed;result.error=Some(e.to_string());break}}},
            value=err.read(&mut eb),if err_open=>{match value {Ok(0)=>err_open=false,Ok(n)=>{
                let data=if !seen {prefix.extend_from_slice(&eb[..n]);if let Some(end)=prefix.iter().position(|b|*b==b'\n') {if end>4096||!banner(&prefix[..=end]){result.status=SmolvmStatus::Failed;result.error=Some("invalid smolvm ephemeral launch protocol".into());break}seen=true;prefix.split_off(end+1)} else {if prefix.len()>4096{result.status=SmolvmStatus::Failed;result.error=Some("smolvm launch banner exceeded limit".into());break}continue}}else{eb[..n].to_vec()};
                let keep=data.len().min(cap.saturating_sub(result.err.len()));result.err.extend_from_slice(&data[..keep]);if keep<data.len(){result.status=SmolvmStatus::OutputLimit;break}
            },Err(e)=>{result.status=SmolvmStatus::Failed;result.error=Some(e.to_string());break}}}
        }
    }
    // Also terminate descendants after ordinary child exit; a descendant can
    // outlive its parent or retain an inherited output pipe.
    if let Err(e) = group.kill() {
        result.status = SmolvmStatus::Failed;
        result.error = Some(e);
    }
    if !exited {
        match timeout(Duration::from_secs(3), child.wait()).await {
            Ok(Ok(v)) => result.code = v.code(),
            _ => {
                result
                    .error
                    .get_or_insert("launcher reap unconfirmed".into());
            }
        }
    }
    group.0 = None;
    if !seen && result.status == SmolvmStatus::Exited {
        result.status = SmolvmStatus::Failed;
        result.error = Some("smolvm exited without qualified launch banner".into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
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
