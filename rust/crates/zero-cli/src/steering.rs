//! Read-only steering receipts; live sends use the already-owned app-server.
use clap::Subcommand;
use std::{error::Error, path::Path};
#[derive(Debug, Subcommand)]
pub enum SteeringCommand {
    /// Inspect Pending, Captured, or Undelivered messages without opening an engine owner.
    List {
        #[arg(long)]
        session: String,
        #[arg(long)]
        operation: String,
        #[arg(long, default_value_t = 0)]
        after_sequence: u64,
        #[arg(long,default_value_t=50,value_parser=clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },
}
pub async fn run(state: &Path, command: SteeringCommand) -> Result<bool, Box<dyn Error>> {
    let SteeringCommand::List {
        session,
        operation,
        after_sequence,
        limit,
    } = command;
    let state = state.to_owned();
    let task = tokio::task::spawn_blocking(move || {
        zero_engine::read_agent_steering(&state, &session, &operation, after_sequence, limit)
    });
    let messages = tokio::select! {
        result=tokio::time::timeout(std::time::Duration::from_secs(5),task)=>result.map_err(|_|"Steering read deadline exceeded")???,
        _=crate::server::shutdown_signal()=>return Err("Steering read interrupted".into()),
    };
    crate::write_json(&zero_protocol::Reply::AgentSteering { messages }, false).await?;
    Ok(true)
}
