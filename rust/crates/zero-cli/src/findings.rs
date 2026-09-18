//! Operator triage is separate from source verification and behavioral evidence.
use clap::{Args, Subcommand};
use std::{error::Error, path::Path};
use zero_protocol::{Command, Reply, triage::SourceFindingStatus};

#[derive(Debug, Args)]
pub struct Target {
    #[arg(long)]
    session: String,
    /// Exact source-review operation ID in this session.
    #[arg(long)]
    operation: String,
}
#[derive(Debug, Args)]
pub struct Decision {
    #[command(flatten)]
    target: Target,
    /// Exact hypothesis ID; prefixes and implicit families are not accepted.
    #[arg(long)]
    hypothesis: String,
    /// Stable command identity for safe retries.
    #[arg(long)]
    command_id: String,
    /// Revision shown by findings list/show; zero for an untriaged hypothesis.
    #[arg(long)]
    expected_revision: u64,
    /// Operator note, at most 4096 UTF-8 bytes.
    #[arg(long, default_value = "")]
    note: String,
}
#[derive(Debug, Subcommand)]
pub enum FindingsCommand {
    /// List hypotheses and operator triage from one retained source review.
    List {
        #[command(flatten)]
        target: Target,
        /// Number of hypotheses already read from this immutable review.
        #[arg(long, default_value_t = 0)]
        offset: u32,
        #[arg(long, default_value_t = 32, value_parser = clap::value_parser!(u32).range(1..=32))]
        limit: u32,
    },
    /// Show one hypothesis with a bounded page of immutable triage decisions.
    Show {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        hypothesis: String,
        /// Return decisions strictly after this revision.
        #[arg(long, default_value_t = 0)]
        after_revision: u64,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },
    /// Accept for operator follow-up; does not verify the hypothesis.
    Accept(Decision),
    /// Suppress for operator triage; preserves all original evidence.
    Suppress(Decision),
    /// Return operator triage to new; preserves prior decision history.
    Reopen(Decision),
}

pub async fn run(state: &Path, command: FindingsCommand) -> Result<bool, Box<dyn Error>> {
    let reply = match command {
        FindingsCommand::List {
            target,
            offset,
            limit,
        } => {
            let path = state.to_owned();
            let findings = inspect(move || {
                zero_engine::read_source_findings(
                    &path,
                    &target.session,
                    &target.operation,
                    offset,
                    limit,
                )
            })
            .await?;
            Reply::SourceFindings { findings }
        }
        FindingsCommand::Show {
            target,
            hypothesis,
            after_revision,
            limit,
        } => {
            let path = state.to_owned();
            let (finding, history) = inspect(move || {
                zero_engine::read_source_finding(
                    &path,
                    &target.session,
                    &target.operation,
                    &hypothesis,
                    after_revision,
                    limit,
                )
            })
            .await?;
            Reply::SourceFinding { finding, history }
        }
        mutation => {
            let (decision, status) = match mutation {
                FindingsCommand::Accept(d) => (d, SourceFindingStatus::Accepted),
                FindingsCommand::Suppress(d) => (d, SourceFindingStatus::Suppressed),
                FindingsCommand::Reopen(d) => (d, SourceFindingStatus::New),
                _ => unreachable!(),
            };
            // This local journal action has no provider, plugin or backend prerequisite.
            let engine = zero_engine::Engine::open(state, None)?;
            let (events, _receiver) = tokio::sync::mpsc::channel(1);
            let reply = engine
                .handle(
                    Command::TriageSourceFinding {
                        session_id: decision.target.session,
                        command_id: decision.command_id,
                        source_operation_id: decision.target.operation,
                        hypothesis_id: decision.hypothesis,
                        status,
                        expected_revision: decision.expected_revision,
                        note: decision.note,
                    },
                    events,
                )
                .await;
            engine.shutdown().await?;
            reply
        }
    };
    let success = !matches!(reply, Reply::Error { .. });
    crate::write_json(&reply, false).await?;
    Ok(success)
}

async fn inspect<T: Send + 'static>(
    read: impl FnOnce() -> Result<T, zero_engine::EngineError> + Send + 'static,
) -> Result<T, Box<dyn Error>> {
    let task = tokio::task::spawn_blocking(read);
    tokio::select! {
        result = tokio::time::timeout(std::time::Duration::from_secs(5), task) =>
            Ok(result.map_err(|_| "Finding read deadline exceeded")???),
        _ = crate::server::shutdown_signal() => Err("Finding read interrupted".into()),
    }
}
