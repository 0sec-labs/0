//! Explicit managed HTTP invocation. The controller owns uploads and final ingestion.
use clap::Args;
use std::{
    error::Error,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zero_cloud_compat::managed_scan;
use zero_protocol::{Command, Reply, managed_scan::ManagedScanGrant, scan::ScanSnapshot};

#[derive(Debug, Args)]
pub struct ManagedScanArgs {
    /// Private, versioned host dispatch grant. Never inferred from cloud environment variables.
    #[arg(long)]
    pub grant: PathBuf,
    /// Explicit durable native terminal file; its parent directory must exist.
    #[arg(long)]
    pub report: PathBuf,
}

pub async fn run(
    args: &crate::args::Args,
    options: &ManagedScanArgs,
) -> Result<u8, Box<dyn Error>> {
    if args.scan_profiles.is_some()
        || args.harness_config.is_some()
        || args.strategy_host.is_some()
        || args.docker_bin.is_some()
        || args.smolvm_bin.is_some()
        || args.hosted_model.is_some()
        || args.hosted_host.is_some()
        || args.hosted_token_env.is_some()
        || args.hosted_timeout_ms.is_some()
    {
        return Err("Managed HTTP accepts only its dispatch grant and explicit provider/HTTP credentials; runtime overrides are unsupported".into());
    }
    validate_report_path(args, options)?;
    let grant = read_grant(&options.grant).await?;
    let command_id = grant.command_id();
    if args.state.is_file() {
        if let Ok(store) = zero_store::Store::open_read_only(&args.state) {
            if let Some(record) = store.scan_by_command(&command_id)? {
                let retained = store
                    .scan_managed_grant(&record.id)?
                    .ok_or("Managed dispatch conflicts with an existing standalone scan")?;
                if serde_json::to_value(&retained)? != serde_json::to_value(&grant)? {
                    return Err(
                        "Managed dispatch conflicts with its immutable retained grant".into(),
                    );
                }
                drop(store);
                let mut snapshot = read_snapshot(&args.state, &record.id).await?;
                if matches!(
                    snapshot.controller_status,
                    zero_protocol::OperationStatus::Admitted
                        | zero_protocol::OperationStatus::Running
                ) {
                    // This explicit execution retry may recover a dead owner. The
                    // existing exclusive lock rejects a live owner before changes;
                    // epoch recovery never resumes the retained scan or refills holds.
                    let recovery = zero_engine::Engine::open(&args.state, None)?;
                    recovery.shutdown().await?;
                    drop(recovery);
                    snapshot = read_snapshot(&args.state, &record.id).await?;
                }
                return publish(&args.state, &options.report, &grant, snapshot, None).await;
            }
        }
    }
    if args.review_profiles.is_some() {
        return Err("Managed HTTP does not accept local review profiles".into());
    }
    let providers = match args.providers.as_deref() {
        Some(path) => crate::providers::load(path).await?,
        None => vec![],
    };
    let http = match args.http_profiles.as_deref() {
        Some(path) => crate::http_profiles::load(path).await?,
        None => vec![],
    };
    let signals = crate::scan::Signals::new()?;
    let engine = Arc::new(zero_engine::Engine::open(&args.state, None)?);
    engine.configure_scan(&grant.scan_profile_name, grant.scan_profile.clone())?;
    for (name, client, rates) in providers {
        engine.configure_provider(&name, client, rates)?;
    }
    for (name, client) in http {
        engine.configure_http(&name, client)?;
    }
    let (reply, interrupted) = crate::scan::execute(
        engine,
        Command::RunManagedScan {
            grant: Box::new(grant.clone()),
        },
        signals,
    )
    .await?;
    match reply {
        Reply::ScanRun { scan, .. } => {
            publish(&args.state, &options.report, &grant, scan, interrupted).await
        }
        Reply::Error { message, .. } => Err(format!(
            "Managed scan request failed: {}; no native terminal file or marker was published",
            crate::console::terminal_text(&message)
        )
        .into()),
        _ => Err("Unexpected managed scan reply".into()),
    }
}

async fn read_snapshot(state: &Path, id: &str) -> Result<ScanSnapshot, Box<dyn Error>> {
    let state = state.to_owned();
    let id = id.to_owned();
    Ok(tokio::task::spawn_blocking(move || zero_engine::read_scan_status(&state, &id)).await??)
}

async fn publish(
    state: &Path,
    destination: &Path,
    grant: &ManagedScanGrant,
    snapshot: ScanSnapshot,
    interrupted: Option<u8>,
) -> Result<u8, Box<dyn Error>> {
    if matches!(
        snapshot.controller_status,
        zero_protocol::OperationStatus::Running | zero_protocol::OperationStatus::Admitted
    ) {
        return Err("Managed scan is still active; inspect retained scan status before requesting a terminal publication".into());
    }
    let report = if snapshot.result.is_some() {
        let state = state.to_owned();
        let id = snapshot.scan.id.clone();
        // The separately validated metadata/accounting remain inspectable if the
        // full evidence closure is missing, corrupt or exceeds its read budget.
        tokio::task::spawn_blocking(move || zero_engine::read_scan_report(&state, &id))
            .await?
            .ok()
    } else {
        None
    };
    let code = interrupted.unwrap_or_else(|| {
        if report.is_none() {
            2
        } else {
            crate::scan::exit_code(&snapshot)
        }
    });
    let terminal = managed_scan::managed_terminal(grant, &snapshot, report.as_ref())?;
    let destination = destination.to_owned();
    let marker = tokio::task::spawn_blocking(move || {
        let file = managed_scan::write_managed_terminal(&destination, &terminal)?;
        managed_scan::result_marker(&terminal, &file)
    })
    .await??;
    // No legacy marker, event, report body, or upload shares this channel.
    let mut out = tokio::io::stdout();
    tokio::time::timeout(Duration::from_secs(5), async {
        out.write_all(marker.as_bytes()).await?;
        out.flush().await
    })
    .await
    .map_err(|_| "Managed terminal marker output deadline exceeded")??;
    Ok(code)
}

async fn read_grant(path: &Path) -> Result<ManagedScanGrant, Box<dyn Error>> {
    let read = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_NOFOLLOW);
        let file = options
            .open(path)
            .await
            .map_err(|_| "Cannot open private managed dispatch grant")?;
        let metadata = file.metadata().await?;
        if !metadata.is_file() {
            return Err("Managed dispatch grant must be a regular file".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != nix::unistd::geteuid().as_raw() || metadata.mode() & 0o077 != 0 {
                return Err("Managed dispatch grant must be owned by the current user and private (mode 0600)".into());
            }
        }
        let mut bytes = Vec::new();
        file.take((zero_protocol::managed_scan::MAX_MANAGED_GRANT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > zero_protocol::managed_scan::MAX_MANAGED_GRANT_BYTES {
            return Err("Managed dispatch grant exceeds the JSON byte limit".into());
        }
        let grant = managed_scan::parse_managed_grant(&bytes)
            .map_err(|_| "Invalid managed dispatch grant JSON, authority or bounds")?;
        Ok::<_, Box<dyn Error>>(grant)
    };
    tokio::select! {
        result=tokio::time::timeout(Duration::from_secs(5),read)=>result.map_err(|_|"Managed dispatch grant read deadline exceeded")?,
        _=crate::server::shutdown_signal()=>Err("Managed dispatch grant read interrupted".into()),
    }
}

fn validate_report_path(
    args: &crate::args::Args,
    options: &ManagedScanArgs,
) -> Result<(), Box<dyn Error>> {
    let filename = options
        .report
        .file_name()
        .ok_or("Managed report requires a file name")?;
    let parent = options
        .report
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let destination = parent.canonicalize()?.join(filename);
    if std::fs::symlink_metadata(&options.report)
        .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
    {
        return Err("Managed report destination must be a regular file or a new file".into());
    }
    let mut protected = vec![args.state.clone(), options.grant.clone()];
    for suffix in ["-wal", "-shm", "-journal", ".engine-lock"] {
        let mut path = args.state.as_os_str().to_os_string();
        path.push(suffix);
        protected.push(path.into());
    }
    protected.extend(
        args.providers
            .iter()
            .chain(args.http_profiles.iter())
            .chain(args.review_profiles.iter())
            .cloned(),
    );
    for path in protected {
        let resolved = path.canonicalize().ok().or_else(|| {
            Some(
                path.parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new("."))
                    .canonicalize()
                    .ok()?
                    .join(path.file_name()?),
            )
        });
        if resolved.as_ref() == Some(&destination) {
            return Err(
                "Managed report cannot replace native state or dispatch configuration".into(),
            );
        }
    }
    Ok(())
}
