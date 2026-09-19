//! Explicit read-only export; stdout is exclusively patch bytes.
use clap::Args;
use std::{error::Error, path::Path};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Args)]
pub struct ExportArgs {
    #[arg(long)]
    pub session: String,
    /// Retained source-review operation.
    #[arg(long)]
    pub operation: String,
    /// Explicit baseline reproduction linked to the repair.
    #[arg(long)]
    pub reproduction: String,
    #[arg(long)]
    pub repair: String,
}

pub async fn run(state: &Path, args: &ExportArgs) -> Result<bool, Box<dyn Error>> {
    let state = state.to_owned();
    let (session, source, reproduction, repair) = (
        args.session.clone(),
        args.operation.clone(),
        args.reproduction.clone(),
        args.repair.clone(),
    );
    // Finish validation before emitting any patch bytes. No Engine owner, current
    // provider configuration, checkout or executor is opened.
    let patch = tokio::task::spawn_blocking(move || {
        zero_engine::read_source_repair_patch(&state, &session, &source, &reproduction, &repair)
            .map_err(|e| e.to_string())
    })
    .await?
    .map_err(std::io::Error::other)?;
    let mut stdout = tokio::io::stdout();
    stdout.write_all(patch.as_bytes()).await?;
    stdout.flush().await?;
    Ok(true)
}
