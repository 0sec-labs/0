//! Isolated Git process supervision. No shell, ambient config or credentials.
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, time::Instant};
use tokio_util::sync::CancellationToken;

pub(super) async fn run(
    binary: &Path,
    args: &[String],
    private: &Path,
    local: bool,
    deadline: Instant,
    cancel: &CancellationToken,
    cap: usize,
) -> Result<Vec<u8>, String> {
    run_inner(
        binary,
        args,
        private,
        local,
        deadline,
        cancel,
        cap,
        crate::process::Group::kill,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_inner(
    binary: &Path,
    args: &[String],
    private: &Path,
    local: bool,
    deadline: Instant,
    cancel: &CancellationToken,
    cap: usize,
    mut kill: impl FnMut(&mut crate::process::Group) -> Result<(), String> + Send,
) -> Result<Vec<u8>, String> {
    super::check(cancel, deadline)?;
    let mut command = Command::new("/usr/bin/prlimit");
    command
        .args([
            "--fsize=134217728",
            "--as=805306368",
            "--cpu=60",
            "--core=0",
            "--",
        ])
        .arg(binary);
    command
        .args(args)
        .current_dir(private)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", private)
        .env("XDG_CONFIG_HOME", private)
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "/bin/false")
        .env("SSH_ASKPASS", "/bin/false")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_ALLOW_PROTOCOL", if local { "file" } else { "https" })
        .env("GIT_PROTOCOL_FROM_USER", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    // prlimit execs Git in the same process identity. Limits propagate to
    // every helper without unsafe pre_exec code in the multithreaded host.
    let mut child = command.spawn().map_err(|_| "Git launcher failed")?;
    let pid = child.id().ok_or("Git launcher identity absent")?;
    let mut group = crate::process::Group::new(pid);
    let mut stdout = child.stdout.take().ok_or("Git stdout absent")?;
    let mut stderr = child.stderr.take().ok_or("Git stderr absent")?;
    let mut out = Vec::new();
    let mut err_bytes = 0usize;
    let (mut out_open, mut err_open, mut exited) = (true, true, false);
    let (mut ob, mut eb) = ([0u8; 65536], [0u8; 8192]);
    let mut status = None;
    let mut failure = None;
    let mut cleanup_unknown = false;
    while out_open || err_open || !exited {
        tokio::select! { biased;
            _=cancel.cancelled()=>{ failure=Some("Git acquisition cancelled");break; }
            _=tokio::time::sleep_until(deadline)=>{ failure=Some("Git acquisition deadline exceeded");break; }
            observed=crate::process::observe_exit(pid), if !exited=>{
                if observed.is_err() {cleanup_unknown=true;failure=Some("Git child observation failed");break;}
                // WNOWAIT reserves the leader identity until the final group
                // signal, so descendants cannot survive a successful parent.
                if kill(&mut group).is_err() {cleanup_unknown=true;failure=Some("Git process-group cleanup failed");break;}
                match child.wait().await {
                    Ok(value)=>status=Some(value),
                    Err(_)=>{cleanup_unknown=true;failure=Some("Git child reap failed");break;}
                }
                exited=true;
            }
            read=stdout.read(&mut ob), if out_open=>match read {
                Ok(0)=>out_open=false,
                Ok(n)=>{if n>cap.saturating_sub(out.len()) {failure=Some("Git stdout exceeds bound");break;}out.extend_from_slice(&ob[..n]);},
                Err(_)=>{failure=Some("Git stdout failed");break;}
            },
            read=stderr.read(&mut eb), if err_open=>match read {
                Ok(0)=>err_open=false,
                Ok(n)=>{err_bytes+=n;if err_bytes>65536 {failure=Some("Git stderr exceeds bound");break;}},
                Err(_)=>{failure=Some("Git stderr failed");break;}
            },
        }
    }
    if !exited {
        let killed = kill(&mut group);
        let _ = child.start_kill();
        let reaped = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        cleanup_unknown |= killed.is_err() || !matches!(reaped, Ok(Ok(_)));
    }
    if cleanup_unknown {
        return Err("Git process cleanup unconfirmed".into());
    }
    if let Some(error) = failure {
        return Err(error.into());
    }
    if !status.is_some_and(|s| s.success()) {
        return Err("Git command failed (diagnostics withheld)".into());
    }
    super::check(cancel, deadline)?;
    Ok(out)
}

use std::os::unix::process::CommandExt;

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn first_group_kill_failure_cannot_be_erased_by_consumed_identity() {
        let d = tempfile::tempdir().unwrap();
        let mut attempts = 0;
        let result = run_inner(
            Path::new("/usr/bin/git"),
            &["--version".into()],
            d.path(),
            true,
            Instant::now() + Duration::from_secs(3),
            &CancellationToken::new(),
            4096,
            |group| {
                attempts += 1;
                // Terminate the real fixture but inject the kernel-error result.
                // Like Group::kill on error, this consumes the PID authority.
                group.kill()?;
                if attempts == 1 {
                    Err("injected signal failure".into())
                } else {
                    Ok(())
                }
            },
        )
        .await;
        assert_eq!(attempts, 2);
        assert_eq!(result.unwrap_err(), "Git process cleanup unconfirmed");
    }
}
