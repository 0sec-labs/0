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
    /// Explicit host-owned target HTTP profiles; credentials are named environment references.
    #[arg(long, global = true)]
    pub http_profiles: Option<PathBuf>,
    /// Explicit public profiles for standalone scoped HTTP scans.
    #[arg(long, global = true)]
    pub scan_profiles: Option<PathBuf>,
    /// Provider profiles; secrets are read from explicitly named environment variables.
    #[arg(long, global = true)]
    pub providers: Option<PathBuf>,
    /// Configure the hosted provider from this explicit catalog model ID.
    #[arg(long, global = true)]
    pub hosted_model: Option<String>,
    /// Hosted inference gateway; otherwise use the resolved credential host.
    #[arg(long, global = true, requires = "hosted_model")]
    pub hosted_host: Option<String>,
    /// Hosted token environment variable; defaults to 0SEC_CLOUD_TOKEN with private file fallback.
    #[arg(long, global = true, requires = "hosted_model")]
    pub hosted_token_env: Option<String>,
    /// Hosted inference deadline in milliseconds; defaults to 300000.
    #[arg(long, global = true, requires = "hosted_model", value_parser = clap::value_parser!(u64).range(1..=3_600_000))]
    pub hosted_timeout_ms: Option<u64>,
    /// Explicit host registry and authority for verified advisory strategy sessions.
    #[arg(long, global = true)]
    pub strategy_host: Option<PathBuf>,
    /// Explicit trusted host harness configuration; never discovered from a project.
    #[arg(long, global = true)]
    pub harness_config: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run or inspect a durable standalone HTTP scan; findings remain unverified.
    Scan(crate::scan::ScanArgs),
    /// Run bounded paired strategy qualification or inspect retained campaign evidence.
    Strategy {
        #[command(subcommand)]
        command: crate::strategy::StrategyCommand,
    },
    /// Inspect scoped web hypotheses/evidence or explicitly execute a frozen host verification plan.
    Web {
        #[command(subcommand)]
        command: crate::web::WebCommand,
    },
    /// Inspect retained, redacted target HTTP evidence without network or owner access.
    Http {
        #[command(subcommand)]
        command: crate::http_evidence::HttpCommand,
    },
    /// Inspect exact-invocation permissions without dispatching any tools.
    Approvals {
        #[command(subcommand)]
        command: crate::approvals::ApprovalsCommand,
    },
    /// Inspect durable operator questions without changing execution authority.
    Questions {
        #[command(subcommand)]
        command: crate::questions::QuestionsCommand,
    },
    /// Inspect durable steering history; live send is available in console/TUI/app-server.
    Steer {
        #[command(subcommand)]
        command: crate::steering::SteeringCommand,
    },
    /// Inspect retained source hypotheses and record operator triage.
    Findings {
        #[command(subcommand)]
        command: crate::findings::FindingsCommand,
    },
    /// Export a completed source review with unverified hypotheses and provenance.
    SourceReport {
        #[arg(long)]
        session: String,
        #[arg(long)]
        operation: String,
        /// Include an explicitly linked reproduction operation (repeatable).
        #[arg(long = "reproduction")]
        reproductions: Vec<String>,
        /// Include a repair; also select its baseline with --reproduction.
        #[arg(long = "repair")]
        repairs: Vec<String>,
        #[arg(long, value_enum, default_value = "json")]
        format: crate::source_report::SourceReportFormat,
    },
    /// Inspect or export retained operation bytes without taking engine ownership.
    Artifact {
        #[command(subcommand)]
        command: crate::artifact::ArtifactCommand,
    },
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
    /// Persist, inspect, cancel or explicitly run agent follow-ups.
    Queue {
        #[command(subcommand)]
        command: QueueCommand,
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
    /// Validate a private candidate and fresh reconstruction against a frozen plan.
    SourceRepair {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        request: PathBuf,
    },
    /// Observe an explicit frozen host plan against retained source-review evidence.
    SourceReproduce {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
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
    /// Interactive native terminal client backed by a separate app-server.
    Tui {
        #[arg(long)]
        session: Option<String>,
        /// Explicit agent authority profile; opening the UI never submits it.
        #[arg(long)]
        request: Option<PathBuf>,
        /// Budget units for explicitly created sessions; defaults to zero.
        #[arg(long, default_value_t = 0)]
        budget_limit: u64,
    },
    /// Experimental line console; nonblank lines are durably queued for serial agent turns.
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

#[derive(Debug, Subcommand)]
pub enum QueueCommand {
    /// Durably accept a follow-up without running it; configure its provider explicitly.
    Enqueue {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        request: PathBuf,
        #[arg(long)]
        after_input: Option<String>,
    },
    /// List queued input records in sequence order.
    List {
        #[arg(long)]
        session: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
    /// Cancel a pending input; this does not interrupt a running operation.
    Cancel {
        #[arg(long)]
        session: String,
        #[arg(long)]
        input: String,
    },
    /// Run an explicit queued input, or return its existing durable outcome.
    Run {
        #[arg(long)]
        session: String,
        #[arg(long)]
        input: String,
    },
}
