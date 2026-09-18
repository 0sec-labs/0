//! Qualified-profile smolvm batch adapter. No Docker/host fallback, registry
//! pulls, dynamic runtime upgrades, or claim of snapshot-program parity.
mod files;
mod process;
mod types;
use std::{
    collections::HashSet,
    path::{Component, Path},
    time::Duration,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
pub use types::*;

struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel()
    }
}
/// Cancellation and dropping this future signal the owned execution task; it
/// finishes teardown independently while the Tokio runtime remains alive.
pub async fn execute(
    request: SmolvmRequest,
    config: SmolvmConfig,
    cancel: CancellationToken,
) -> SmolvmResult {
    execute_owned(request, config, cancel, true).await
}

async fn execute_owned(
    request: SmolvmRequest,
    config: SmolvmConfig,
    cancel: CancellationToken,
    host: bool,
) -> SmolvmResult {
    let token = cancel.child_token();
    let guard = CancelOnDrop(token.clone());
    let fallback = result(&request);
    let task = tokio::spawn(run(request, config, token, host));
    let output = match task.await {
        Ok(v) => v,
        Err(e) => SmolvmResult {
            status: SmolvmStatus::Failed,
            cleanup: VmCleanup::Unknown {
                reason: e.to_string(),
            },
            error: Some(format!("smolvm supervisor failed: {e}; lifecycle unknown")),
            ..fallback
        },
    };
    drop(guard);
    output
}
fn result(r: &SmolvmRequest) -> SmolvmResult {
    SmolvmResult {
        execution_id: r.execution_id.clone(),
        archive_digest: r.archive_digest.clone(),
        status: SmolvmStatus::Failed,
        exit_code: None,
        stdout: vec![],
        stderr: vec![],
        cleanup: VmCleanup::NotCreated,
        duration_ms: 0,
        error: None,
    }
}
fn validate(r: &SmolvmRequest, host: bool) -> Result<(), String> {
    if r.execution_id.is_empty()
        || r.execution_id.len() > 128
        || !r
            .execution_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err("invalid execution id".into());
    }
    if r.archive_digest.len() != 71
        || !r.archive_digest.starts_with("sha256:")
        || !r.archive_digest.as_bytes()[7..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    {
        return Err("invalid archive SHA-256".into());
    }
    if r.argv.is_empty()
        || r.argv.len() > 128
        || r.argv[0].is_empty()
        || r.argv.iter().any(|v| v.contains('\0') || v.len() > 131072)
    {
        return Err("invalid bounded argv".into());
    }
    if !(100..=600000).contains(&r.timeout_ms)
        || !(32..=16384).contains(&r.memory_mb)
        || !(1..=16).contains(&r.cpus)
        || !(1..=64).contains(&r.storage_gb)
        || !(256..=16 * 1024 * 1024).contains(&r.max_output_bytes)
        || r.stdin.len() > 16 * 1024 * 1024
    {
        return Err("unsupported execution limits".into());
    }
    if host {
        if !cfg!(target_os = "linux") || nix::unistd::Uid::current().is_root() {
            return Err("smolvm requires non-root Linux".into());
        }
        std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm").map_err(|e|format!("KVM unavailable to current process: {e}; refresh already-granted groups if applicable"))?;
    }
    let mut targets = HashSet::new();
    for m in &r.mounts {
        let p = Path::new(&m.target);
        if !p.is_absolute()
            || m.target == "/"
            || m.target.contains([':', '\0'])
            || p.components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
            || m.target.split('/').any(|v| v == "." || v == "..")
            || m.target.contains("//")
            || m.target.ends_with('/')
            || !targets.insert(&m.target)
        {
            return Err("invalid or duplicate read-only mount target".into());
        }
    }
    Ok(())
}
async fn run(
    r: SmolvmRequest,
    mut config: SmolvmConfig,
    cancel: CancellationToken,
    host: bool,
) -> SmolvmResult {
    let start = Instant::now();
    let deadline = start + Duration::from_millis(r.timeout_ms.min(600000));
    let mut out = result(&r);
    if let Err(e) = validate(&r, host) {
        out.error = Some(e);
        return out;
    }
    if cancel.is_cancelled() {
        out.status = SmolvmStatus::Cancelled;
        return out;
    }
    // Explicit relative launcher paths must not change meaning under private cwd.
    for p in [&mut config.binary, &mut config.setpriv] {
        if !p.is_absolute() && p.components().count() > 1 {
            match std::fs::canonicalize(&p) {
                Ok(v) => *p = v,
                Err(e) => {
                    out.error = Some(e.to_string());
                    return out;
                }
            }
        }
    }
    let root = match files::private_root() {
        Ok(v) => v,
        Err(e) => {
            out.error = Some(e);
            return out;
        }
    };
    let attempt = async {
        // Persist controller-owned intent before any runtime invocation.
        let intent = serde_json::to_vec(&r).map_err(|e| e.to_string())?;
        tokio::fs::write(root.join("request.json"), intent)
            .await
            .map_err(|e| e.to_string())?;
        let v = process::capture(
            &config,
            &root,
            &["--version".into()],
            &[],
            deadline.min(Instant::now() + Duration::from_secs(5)),
            &cancel,
            4096,
            false,
        )
        .await;
        if v.status != SmolvmStatus::Exited
            || v.code != Some(0)
            || String::from_utf8_lossy(&v.out).trim() != "smolvm 1.14.6"
        {
            out.status = v.status;
            if out.status == SmolvmStatus::Exited {
                out.status = SmolvmStatus::Failed
            }
            return Err("smolvm 1.14.6 required; runtime version probe failed".into());
        }
        let archive = root.join("image.tar");
        let digest = files::copy_archive(&r.image_archive, &archive, &cancel, deadline).await?;
        if digest != r.archive_digest {
            return Err("smolvm archive identity mismatch".into());
        }
        let mut args = vec![
            "machine".into(),
            "run".into(),
            "--image".into(),
            archive.to_string_lossy().into_owned(),
            "--unprivileged".into(),
            "--user".into(),
            "1000:1000".into(),
            "--cpus".into(),
            r.cpus.to_string(),
            "--mem".into(),
            r.memory_mb.to_string(),
            "--storage".into(),
            r.storage_gb.to_string(),
            "--overlay".into(),
            "1".into(),
            "--interactive".into(),
        ];
        for mount in &r.mounts {
            let source = tokio::fs::canonicalize(&mount.source)
                .await
                .map_err(|e| e.to_string())?;
            let text = source.to_str().ok_or("mount path is not UTF-8")?;
            if text.contains(':')
                || !tokio::fs::metadata(&source)
                    .await
                    .map_err(|e| e.to_string())?
                    .is_dir()
            {
                return Err("mount source must be a directory without colon".into());
            }
            args.extend(["--volume".into(), format!("{text}:{}:ro", mount.target)]);
        }
        args.push("--".into());
        args.extend(r.argv.clone());
        let captured = process::capture(
            &config,
            &root,
            &args,
            &r.stdin,
            deadline,
            &cancel,
            r.max_output_bytes,
            true,
        )
        .await;
        out.status = captured.status;
        out.exit_code = captured.code;
        out.stdout = captured.out;
        out.stderr = captured.err;
        out.error = captured.error;
        if captured.spawned {
            out.cleanup = VmCleanup::Unconfirmed {
                recovery_dir: root.clone(),
            };
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(e) = attempt {
        out.error = Some(e);
        if cancel.is_cancelled() {
            out.status = SmolvmStatus::Cancelled
        } else if Instant::now() >= deadline {
            out.status = SmolvmStatus::TimedOut
        }
    }
    match files::cleanup(&root).await {
        Ok(()) => {
            if matches!(out.cleanup, VmCleanup::Unconfirmed { .. }) {
                out.cleanup = VmCleanup::Confirmed
            }
        }
        Err(e) => {
            out.cleanup = VmCleanup::Unconfirmed { recovery_dir: root };
            out.error = Some(match out.error {
                Some(old) => format!("{old}; {e}"),
                None => e,
            });
        }
    }
    out.duration_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
    out
}
#[cfg(test)]
mod tests;
