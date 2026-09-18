use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "0sec-native",
    version,
    about = "Experimental native 0sec session and execution service"
)]
pub struct Args {
    /// Native state database (separate from the legacy TypeScript database).
    #[arg(long, global = true, default_value = ".0sec/native/state.db")]
    pub state: PathBuf,
    /// Docker executable path; useful for an explicitly selected local installation.
    #[arg(long, global = true)]
    pub docker_bin: Option<PathBuf>,
    /// Explicit smolvm executable; backend selection never falls back to Docker.
    #[arg(long, global = true)]
    pub smolvm_bin: Option<PathBuf>,
    /// Provider profiles; secrets are read from explicitly named environment variables.
    #[arg(long, global = true)]
    pub providers: Option<PathBuf>,
    /// Explicit trusted host harness configuration; never discovered from a project.
    #[arg(long, global = true)]
    pub harness_config: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Measure offline plugin fixtures; this does not promote production code.
    Evaluation {
        #[command(subcommand)]
        command: crate::evaluation::EvaluationCommand,
    },
    /// Read hosted service metadata with an explicitly named token environment variable.
    Hosted {
        #[arg(long, global = true)]
        host: Option<String>,
        #[arg(long, global = true, default_value = "0SEC_CLOUD_TOKEN")]
        token_env: String,
        #[command(subcommand)]
        command: crate::hosted::HostedCommand,
    },
    /// Inspect native prerequisites locally without opening the state database.
    Doctor {
        #[arg(long, default_value_t = 2000, value_parser = clap::value_parser!(u64).range(10..=30000))]
        timeout_ms: u64,
    },
    /// Render an existing report locally; this does not execute a security scan.
    Report {
        #[arg(long)]
        input: PathBuf,
        #[arg(long, value_enum, default_value = "json")]
        format: crate::report::ReportFormat,
    },
    /// Print the versioned application protocol JSON Schema.
    Schema,
    /// Generate a content-addressed execution snapshot manifest.
    Snapshot {
        #[command(subcommand)]
        command: SnapshotCommand,
    },
    /// Manage persisted native sessions.
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },
    /// Execute a JSON execution request in a session's isolated backend.
    Exec {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        request: PathBuf,
    },
    /// Run a pinned snapshot program on its explicitly selected backend.
    Sandbox {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        request: PathBuf,
    },
    /// Invoke one pinned plugin tool using explicit host grants and offline launch policy.
    PluginCall {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        plugin: String,
        #[arg(long)]
        tool: String,
        #[arg(long)]
        input: PathBuf,
    },
    /// Run one explicitly configured provider request with durable accounting.
    Infer {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        provider: String,
        #[arg(long)]
        reservation: u64,
        #[arg(long)]
        request: PathBuf,
    },
    /// Submit selected pinned source for structured, unverified hypotheses.
    SourceReview {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        request: PathBuf,
    },
    /// Run an experimental bounded model/tool workflow with a pinned offline snapshot.
    Agent {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        request: PathBuf,
    },
    /// Experimental line console; each nonblank stdin line starts one agent turn.
    Console {
        #[arg(long)]
        session: String,
        #[arg(long)]
        request: PathBuf,
    },
    /// Serve versioned NDJSON on stdin/stdout; initialize before other requests.
    AppServer,
}

#[derive(Debug, Subcommand)]
pub enum SessionCommand {
    /// Create a session pinned to the currently configured harness generation/epoch.
    CreatePinned {
        #[arg(long, default_value_t = 1_000_000)]
        budget_limit: u64,
    },
    Create {
        #[arg(long, default_value = "builtin")]
        generation: String,
        #[arg(long, default_value_t = 1_000_000)]
        budget_limit: u64,
    },
    List,
    Show {
        id: String,
    },
    Budget {
        id: String,
    },
    /// Record operator-reported billing for an unresolved operation without retrying it.
    ReconcileUsage {
        id: String,
        #[arg(long)]
        operation: String,
        #[arg(long)]
        charged: u64,
        #[arg(long)]
        evidence: String,
    },
    Events {
        id: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
        #[arg(long, default_value_t = 100)]
        limit: u32,
    },
}

#[derive(Debug, Subcommand)]
pub enum SnapshotCommand {
    /// Inspect a source directory and print its immutable content pin as JSON.
    Pin { root: PathBuf },
}
