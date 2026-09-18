//! Explicit local fixture evaluation, separate from production activation.
use clap::Subcommand;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use zero_harness::HostGrants;
use zero_plugin::{Capability, HostPolicy};

#[derive(Debug, Subcommand)]
pub enum EvaluationCommand {
    /// Execute a frozen paired fixture plan in a new private directory.
    Run {
        #[arg(long)]
        source_registry: PathBuf,
        #[arg(long)]
        plan: PathBuf,
        /// Explicit host policy map; never inferred from candidate artifacts.
        #[arg(long)]
        grants: PathBuf,
        #[arg(long)]
        output_dir: PathBuf,
    },
    /// Inspect durable counts and receipt without taking ownership or replaying work.
    Status {
        #[arg(long)]
        directory: PathBuf,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    enabled: bool,
    trusted: bool,
    grants: BTreeSet<Capability>,
}
async fn read(path: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
    // A stalled filesystem/FIFO must not prevent signal handling forever.
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(5), crate::providers::read_bounded(path)) =>
            result.map_err(|_| "Evaluation input deadline exceeded")?,
        _ = crate::server::shutdown_signal() => Err("Evaluation input interrupted".into()),
    }
}
pub async fn run(
    command: &EvaluationCommand,
    docker: Option<&Path>,
    smolvm: Option<&Path>,
) -> Result<bool, Box<dyn Error>> {
    let (value, success) = match command {
        EvaluationCommand::Run {
            source_registry,
            plan,
            grants,
            output_dir,
        } => {
            let plan: zero_evaluation::Plan = serde_json::from_slice(&read(plan).await?)
                .map_err(|_| "Invalid evaluation plan JSON")?;
            let policies: BTreeMap<String, Policy> =
                serde_json::from_slice(&read(grants).await?)
                    .map_err(|_| "Invalid evaluation host grants JSON")?;
            let grants = HostGrants::new(
                policies
                    .into_iter()
                    .map(|(name, p)| {
                        (
                            name,
                            HostPolicy {
                                enabled: p.enabled,
                                trusted: p.trusted,
                                grants: p.grants,
                            },
                        )
                    })
                    .collect(),
            );
            let source = zero_evolution::Registry::open_read_only(source_registry)?;
            let mut evaluation =
                zero_evaluation::Evaluation::create(output_dir, &source, plan, &grants)?;
            drop(source);
            let docker = docker
                .map(|p| zero_executor::DockerExecutor::with_binary(p.to_path_buf()))
                .unwrap_or_default();
            let mut config = zero_smolvm::SmolvmConfig::default();
            if let Some(binary) = smolvm {
                config.binary = binary.to_path_buf();
            }
            let runner = zero_plugin_runner::Runner::new(
                zero_sandbox::SandboxExecutor::with_backends(docker, config),
            );
            let cancel = CancellationToken::new();
            let work = evaluation.run(&runner, cancel.clone());
            tokio::pin!(work);
            // Never abandon the owned runner on signal: await cancellation and
            // its observed settlement/uncertainty before the process exits.
            let report = tokio::select! {
                result = &mut work => result?,
                _ = crate::server::shutdown_signal() => { cancel.cancel(); work.await? },
            };
            let success = report.decision == zero_evolution::EvaluationDecision::Eligible;
            (serde_json::to_value(report)?, success)
        }
        EvaluationCommand::Status { directory } => (
            serde_json::to_value(zero_evaluation::Evaluation::inspect(directory)?)?,
            true,
        ),
    };
    let output = format!("{}\n", serde_json::to_string(&value)?);
    let mut stdout = tokio::io::stdout();
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(5), async {
            stdout.write_all(output.as_bytes()).await?;
            stdout.flush().await
        }) => result.map_err(|_| "Evaluation output deadline exceeded")??,
        _ = crate::server::shutdown_signal() => return Err("Evaluation output interrupted".into()),
    }
    Ok(success)
}
