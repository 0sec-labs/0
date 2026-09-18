//! Read-only journal inspection and explicit no-clobber artifact export.
use clap::Subcommand;
use serde_json::json;
use std::{
    error::Error,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Subcommand)]
pub enum ArtifactCommand {
    /// List immutable attachment names and content digests for one operation.
    List {
        #[arg(long)]
        session: String,
        #[arg(long)]
        operation: String,
    },
    /// Export one hash-checked attachment to a new private file.
    Export {
        #[arg(long)]
        session: String,
        #[arg(long)]
        operation: String,
        #[arg(long)]
        name: String,
        #[arg(long)]
        output: PathBuf,
    },
}
pub async fn run(state: &Path, command: &ArtifactCommand) -> Result<bool, Box<dyn Error>> {
    let (session, operation) = match command {
        ArtifactCommand::List { session, operation }
        | ArtifactCommand::Export {
            session, operation, ..
        } => (session, operation),
    };
    let store = zero_store::Store::open_read_only(state)?;
    if store.get_operation(operation)?.session_id != *session {
        return Err("Artifact operation belongs to another session".into());
    }
    let attachments = store.operation_artifacts(operation)?;
    let value = match command {
        ArtifactCommand::List { .. } => {
            json!({"session_id":session,"operation_id":operation,"artifacts":attachments})
        }
        ArtifactCommand::Export { name, output, .. } => {
            if output.to_str().is_none() {
                return Err("Artifact output path must be UTF-8 for its receipt".into());
            }
            let digest = attachments
                .get(name)
                .ok_or("Named operation artifact not found")?;
            let bytes = store.artifact(digest)?;
            let length = bytes.len();
            let output = output.to_owned();
            let path = output.clone();
            // Finish the private temporary write/rename rather than abandon a
            // writer on cancellation. No provider/guest/engine ownership exists.
            let mut writer = tokio::task::spawn_blocking(move || export(&path, &bytes));
            tokio::select! {
                result = &mut writer => result?.map_err(std::io::Error::other)?,
                _ = crate::server::shutdown_signal() => {
                    writer.await?.map_err(std::io::Error::other)?;
                    return Err("Artifact export interrupted after publishing the complete file".into());
                }
            }
            json!({"session_id":session,"operation_id":operation,"name":name,"digest":digest,"bytes":length,"output":output})
        }
    };
    crate::write_json(&value, false).await?;
    Ok(true)
}
fn export(output: &Path, bytes: &[u8]) -> Result<(), String> {
    if output.file_name().is_none() {
        return Err("Artifact output must name a new file".into());
    }
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Cannot create private artifact output")?;
    temporary
        .write_all(bytes)
        .map_err(|_| "Cannot write artifact output")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Cannot sync artifact output")?;
    temporary
        .persist_noclobber(output)
        .map_err(|_| "Artifact destination exists or cannot be published")?;
    // A failed parent sync is reported; a complete destination may already exist.
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Artifact published but directory sync failed")?;
    Ok(())
}
