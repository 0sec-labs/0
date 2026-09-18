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
    /// Provider profiles; secrets are read from explicitly named environment variables.
    #[arg(long, global = true)]
    pub providers: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Inspect native prerequisites locally without opening the state database.
    Doctor {
        #[arg(long, default_value_t = 2000, value_parser = clap::value_parser!(u64).range(10..=30000))]
        timeout_ms: u64,
        #[arg(long, default_value = "smolvm")]
        smolvm_bin: PathBuf,
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
    /// Run an experimental bounded model/tool workflow with a pinned offline snapshot.
    Agent {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        request: PathBuf,
    },
    /// Serve versioned NDJSON on stdin/stdout; initialize before other requests.
    AppServer,
}

#[derive(Debug, Subcommand)]
pub enum SessionCommand {
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
