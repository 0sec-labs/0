//! Standalone host-selected acquisition. Does not open an Engine or spend model budget.
use clap::Subcommand;
use std::{error::Error, path::PathBuf};
use zero_protocol::source_acquisition::GitSource;

#[derive(Debug, Subcommand)]
pub enum SourceCommand {
    /// Acquire an explicit Git ref or npm version; publish source/ plus its receipt.
    Acquire {
        #[arg(
            long,
            required_unless_present_any = ["local_repository", "npm_package"],
            conflicts_with_all = ["local_repository", "npm_package"]
        )]
        url: Option<String>,
        /// Explicit local transport, independent from HTTPS URL acceptance.
        #[arg(long, required_unless_present_any = ["url", "npm_package"], conflicts_with_all = ["url", "npm_package"])]
        local_repository: Option<PathBuf>,
        #[arg(
            long = "ref",
            required_unless_present = "npm_package",
            conflicts_with = "npm_package"
        )]
        reference: Option<String>,
        /// Exact published package; no dependency installation or lifecycle scripts.
        #[arg(long, conflicts_with_all = ["url", "local_repository", "reference"], requires = "version")]
        npm_package: Option<String>,
        #[arg(long, requires = "npm_package")]
        version: Option<String>,
        /// Explicit registry base (defaults to the public npm registry).
        #[arg(long, requires = "npm_package")]
        registry: Option<String>,
        /// New absolute output directory; never replaces existing content.
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value = "/usr/bin/git", conflicts_with = "npm_package")]
        git_bin: PathBuf,
        #[arg(long, default_value_t=60_000, value_parser=clap::value_parser!(u64).range(1..=120_000))]
        timeout_ms: u64,
    },
}
pub async fn run(command: &SourceCommand) -> Result<u8, Box<dyn Error>> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = command;
        Err("Source acquisition currently requires Linux".into())
    }
    #[cfg(target_os = "linux")]
    {
        let SourceCommand::Acquire {
            url,
            local_repository,
            reference,
            npm_package,
            version,
            registry,
            output,
            git_bin,
            timeout_ms,
        } = command;
        let cancel = tokio_util::sync::CancellationToken::new();
        let worker_cancel = cancel.clone();
        let output = output.clone();
        let timeout_ms = *timeout_ms;
        let limits = zero_executor::SnapshotLimits {
            max_files: 4096,
            max_bytes: 64 * 1024 * 1024,
        };
        let npm = if let Some(package) = npm_package {
            Some(zero_executor::NpmRequest {
                source: zero_protocol::source_acquisition::NpmSource {
                    registry: registry
                        .clone()
                        .unwrap_or_else(|| "https://registry.npmjs.org/".into()),
                    package: package.clone(),
                    version: version.clone().ok_or("npm requires exact --version")?,
                },
                output: output.clone(),
                timeout_ms,
                limits,
            })
        } else {
            None
        };
        let git = if npm.is_none() {
            let source = match (url, local_repository) {
                (Some(url), None) => GitSource::Https { url: url.clone() },
                (None, Some(path)) => GitSource::Local {
                    path: path
                        .to_str()
                        .ok_or("Local repository path must be UTF-8")?
                        .into(),
                },
                _ => return Err("Choose exactly one source transport".into()),
            };
            Some(zero_executor::RepositoryRequest {
                source,
                reference: reference.clone().ok_or("Git requires --ref")?,
                output,
                git_binary: git_bin.clone(),
                timeout_ms,
                limits,
            })
        } else {
            None
        };
        let mut signals = crate::scan::Signals::new()?;
        let mut task = tokio::spawn(async move {
            if let Some(request) = npm {
                zero_executor::acquire_npm(request, worker_cancel)
                    .await
                    .map(zero_protocol::source_acquisition::SourceReceipt::Npm)
            } else {
                zero_executor::acquire_repository(git.ok_or("Git request absent")?, worker_cancel)
                    .await
                    .map(zero_protocol::source_acquisition::SourceReceipt::Git)
            }
        });
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
