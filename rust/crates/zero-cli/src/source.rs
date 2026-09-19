//! Standalone host-selected acquisition. Does not open an Engine or spend model budget.
use clap::Subcommand;
use std::{error::Error, path::PathBuf};
use zero_protocol::source_acquisition::GitSource;

#[derive(Debug, Subcommand)]
pub enum SourceCommand {
    /// Fetch one explicit Git ref and publish source/ plus an immutable receipt.
    Acquire {
        #[arg(
            long,
            required_unless_present = "local_repository",
            conflicts_with = "local_repository"
        )]
        url: Option<String>,
        /// Explicit local transport, independent from HTTPS URL acceptance.
        #[arg(long, required_unless_present = "url", conflicts_with = "url")]
        local_repository: Option<PathBuf>,
        #[arg(long = "ref")]
        reference: String,
        /// New absolute output directory; never replaces existing content.
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value = "/usr/bin/git")]
        git_bin: PathBuf,
        #[arg(long, default_value_t=60_000, value_parser=clap::value_parser!(u64).range(1..=120_000))]
        timeout_ms: u64,
    },
}
pub async fn run(command: &SourceCommand) -> Result<u8, Box<dyn Error>> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = command;
        Err("Repository acquisition currently requires Linux".into())
    }
    #[cfg(target_os = "linux")]
    {
        let SourceCommand::Acquire {
            url,
            local_repository,
            reference,
            output,
            git_bin,
            timeout_ms,
        } = command;
        let source = match (url, local_repository) {
            (Some(url), None) => GitSource::Https { url: url.clone() },
            (None, Some(path)) => GitSource::Local {
                path: path
                    .to_str()
                    .ok_or("Local repository path must be UTF-8")?
                    .into(),
            },
            _ => return Err("Choose exactly one HTTPS URL or explicit local repository".into()),
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        let worker_cancel = cancel.clone();
        let request = zero_executor::RepositoryRequest {
            source,
            reference: reference.clone(),
            output: output.clone(),
            git_binary: git_bin.clone(),
            timeout_ms: *timeout_ms,
            limits: zero_executor::SnapshotLimits {
                max_files: 4096,
                max_bytes: 64 * 1024 * 1024,
            },
        };
        let mut signals = crate::scan::Signals::new()?;
        let mut task =
            tokio::spawn(
                async move { zero_executor::acquire_repository(request, worker_cancel).await },
            );
        let result = tokio::select! {
            result=&mut task=>result?,
            code=signals.wait()=>{
                cancel.cancel();
                if let Err(error) = task.await? {
                    // Cancellation is not proof of cleanup. In particular keep
                    // the executor's retained scratch path visible for recovery.
                    eprintln!("Acquisition stopped: {}", diagnostic(&error));
                }
                return Ok(code);
            }
        }
        .map_err(std::io::Error::other)?;
        crate::write_json(&result, false).await?;
        Ok(0)
    }
}

#[cfg(target_os = "linux")]
fn diagnostic(error: &str) -> String {
    error
        .chars()
        .take(8192)
        .flat_map(char::escape_default)
        .collect()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn cleanup_uncertainty_retains_recovery_path_without_terminal_controls() {
        let message = "Git process cleanup unconfirmed; retained private directory /tmp/recovery";
        assert_eq!(super::diagnostic(message), message);
        let escaped = super::diagnostic("unconfirmed\n\u{1b}[31m/tmp/recovery");
        assert!(!escaped.contains('\n'));
        assert!(!escaped.contains('\u{1b}'));
        assert!(escaped.ends_with("/tmp/recovery"));
        assert!(super::diagnostic(&"x".repeat(9000)).len() <= 8192);
    }
}
