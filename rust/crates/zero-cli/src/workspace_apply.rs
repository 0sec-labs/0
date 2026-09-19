//! Explicit offline host application. No Engine owner, provider or guest process.
use clap::Subcommand;
use serde_json::Value;
use std::{
    error::Error,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Debug, Clone, Subcommand)]
pub enum WorkspaceApplyCommand {
    /// Validate the bundle and check intended paths without writing the checkout.
    Preview {
        #[arg(long)]
        bundle: PathBuf,
        #[arg(long)]
        root: PathBuf,
    },
    /// Apply exact baseline changes, retaining originals in a new private journal.
    Run {
        #[arg(long)]
        bundle: PathBuf,
        #[arg(long)]
        root: PathBuf,
        #[arg(long)]
        journal: PathBuf,
    },
    /// Read historical journal receipts; does not assert current checkout contents.
    Status {
        #[arg(long)]
        journal: PathBuf,
    },
    /// Restore originals without replacing later user changes; retain recovery data.
    Rollback {
        #[arg(long)]
        journal: PathBuf,
    },
}

#[cfg(target_os = "linux")]
fn execute(command: &WorkspaceApplyCommand, cancel: &AtomicBool) -> Result<(Value, bool), String> {
    let cancelled = || cancel.load(Ordering::SeqCst);
    let (value, success) = match command {
        WorkspaceApplyCommand::Preview { bundle, root } => {
            let bundle = zero_workspace_host::Bundle::read(bundle)?;
            (
                serde_json::to_value(zero_workspace_host::preflight(root, &bundle)?),
                true,
            )
        }
        WorkspaceApplyCommand::Run {
            bundle,
            root,
            journal,
        } => {
            let status = zero_workspace_host::apply(bundle, root, journal, &cancelled)?;
            let success = status.phase == "completed";
            (serde_json::to_value(status), success)
        }
        WorkspaceApplyCommand::Status { journal } => (
            serde_json::to_value(zero_workspace_host::inspect_application(journal)?),
            true,
        ),
        WorkspaceApplyCommand::Rollback { journal } => {
            let status = zero_workspace_host::rollback(journal, &cancelled)?;
            let success = status.phase == "rolled_back";
            (serde_json::to_value(status), success)
        }
    };
    Ok((value.map_err(|e| e.to_string())?, success))
}
#[cfg(not(target_os = "linux"))]
fn execute(_: &WorkspaceApplyCommand, _: &AtomicBool) -> Result<(Value, bool), String> {
    Err("workspace application currently requires Linux".into())
}
pub async fn run(command: &WorkspaceApplyCommand) -> Result<bool, Box<dyn Error>> {
    let owned = command.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = cancel.clone();
    let mut worker = tokio::task::spawn_blocking(move || execute(&owned, &worker_cancel));
    let (result, interrupted) = tokio::select! {
        biased;
        result = &mut worker => (result?, false),
        _ = crate::server::shutdown_signal() => {
            cancel.store(true, Ordering::SeqCst);
            // Never drop an owned filesystem operation during a rename/sync.
            (worker.await?, true)
        }
    };
    let (mut report, success) = result.map_err(|error| {
        let detail = match command {
            WorkspaceApplyCommand::Run { journal, .. }
            | WorkspaceApplyCommand::Rollback { journal } => format!(
                "{error}; inspect retained journal if present: {}",
                journal.display()
            ),
            _ => error,
        };
        std::io::Error::other(detail)
    })?;
    report["cancellation_requested"] = interrupted.into();
    crate::write_json(&report, false).await?;
    Ok(success && !interrupted)
}
