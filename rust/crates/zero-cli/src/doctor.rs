//! Local, bounded prerequisites only. Never opens or migrates the state database.
use crate::{args::Args, providers};
use serde::Serialize;
use std::{error::Error, path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

#[derive(Serialize)]
struct Check {
    name: &'static str,
    status: &'static str,
    detail: &'static str,
}
#[derive(Serialize)]
struct Report {
    version: u32,
    engine_version: &'static str,
    platform: &'static str,
    architecture: &'static str,
    checks: Vec<Check>,
    scope: &'static str,
}

// Never return raw process output/errors: executables may emit credentials.
async fn probe(binary: &Path, args: &[&str], timeout: Duration, expected: Option<&str>) -> bool {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return false;
    };
    let result = tokio::time::timeout(timeout, async {
        let mut bytes = Vec::new();
        stdout.take(4097).read_to_end(&mut bytes).await?;
        if bytes.len() > 4096 {
            return Ok::<_, std::io::Error>(false);
        }
        let status = child.wait().await?;
        Ok(status.success()
            && expected.is_none_or(|text| String::from_utf8_lossy(&bytes).trim() == text))
    })
    .await;
    // Also reap an overproducing or timed out direct process before returning.
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill().await;
    }
    matches!(result, Ok(Ok(true)))
}

fn state_parent_writable(path: &Path) -> bool {
    // Probe the nearest existing ancestor without creating the requested directory.
    // An existing state file is inspected only, never opened or migrated.
    if path.exists()
        && std::fs::metadata(path).map_or(true, |m| !m.is_file() || m.permissions().readonly())
    {
        return false;
    }
    let mut parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    while !parent.exists() {
        parent = parent
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
    }
    tempfile::NamedTempFile::new_in(parent).is_ok()
}

pub async fn run(args: &Args, timeout_ms: u64, smolvm: &Path) -> Result<bool, Box<dyn Error>> {
    let timeout = Duration::from_millis(timeout_ms);
    let docker = args
        .docker_bin
        .as_deref()
        .unwrap_or_else(|| Path::new("docker"));
    let (docker_version, docker_context, docker_server, smolvm_version) = tokio::join!(
        probe(docker, &["--version"], timeout, None),
        probe(docker, &["context", "show"], timeout, None),
        probe(
            docker,
            &["version", "--format", "{{.Server.Version}}"],
            timeout,
            None
        ),
        probe(smolvm, &["--version"], timeout, Some("smolvm 1.14.6")),
    );
    let mut checks = vec![Check {
        name: "native_engine",
        status: "ok",
        detail: "native executable available; no Node/Bun requirement",
    }];
    let state_ok = state_parent_writable(&args.state);
    checks.push(Check {
        name: "state_parent",
        status: if state_ok { "ok" } else { "error" },
        detail: if state_ok {
            "temporary writability probe passed; database not opened"
        } else {
            "state target or nearest existing parent is not writable"
        },
    });
    let providers_ok = match &args.providers {
        None => {
            checks.push(Check {
                name: "providers",
                status: "not_configured",
                detail: "no explicit provider profile file; credential validity unverified",
            });
            true
        }
        Some(path) => match providers::load(path).await {
            Ok(profiles) if !profiles.is_empty() => {
                checks.push(Check{name:"providers",status:"ok",detail:"profile syntax, limits and named credential presence valid; no network authentication attempted"});
                true
            }
            _ => {
                checks.push(Check{name:"providers",status:"error",detail:"provider profiles invalid, empty, unreadable or named credential unavailable"});
                false
            }
        },
    };
    for (name, ok, detail) in [
        (
            "docker_client",
            docker_version,
            "selected Docker executable version probe",
        ),
        (
            "docker_context",
            docker_context,
            "selected Docker context availability probe",
        ),
        (
            "docker_server",
            docker_server,
            "selected Docker server version availability probe",
        ),
        (
            "smolvm_version",
            smolvm_version,
            "requires exactly smolvm 1.14.6; archive provenance not verified",
        ),
    ] {
        checks.push(Check {
            name,
            status: if ok { "ok" } else { "unavailable" },
            detail,
        });
    }
    let nonroot = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("Uid:")).map(str::to_owned))
        .and_then(|s| {
            s.split_whitespace()
                .nth(2)
                .and_then(|n| n.parse::<u32>().ok())
        })
        .is_some_and(|uid| uid != 0);
    let platform_ok = cfg!(target_os = "linux") && nonroot;
    checks.push(Check {
        name: "smolvm_host",
        status: if platform_ok { "ok" } else { "unavailable" },
        detail: "qualified runtime requires non-root Linux",
    });
    let kvm_ok = cfg!(target_os = "linux")
        && std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/kvm")
            .is_ok();
    checks.push(Check {
        name: "kvm_access",
        status: if kvm_ok { "ok" } else { "unavailable" },
        detail: "read/write device access only; virtualization ioctls and guest boot not tested",
    });
    let success = state_ok
        && providers_ok
        && args
            .docker_bin
            .as_ref()
            .is_none_or(|_| docker_version && docker_context && docker_server);
    let report = Report {
        version: 1,
        engine_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        checks,
        scope: "prerequisites only; no paid calls, image pulls, installs, provisioning or database migration",
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(success)
}
