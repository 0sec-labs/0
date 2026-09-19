//! Offline no-replace export of private candidate generations; never host apply.
use clap::Args;
use std::{
    error::Error,
    path::{Path, PathBuf},
};
#[derive(Debug, Args)]
pub struct ExportArgs {
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub operation: String,
    #[arg(long)]
    pub output_dir: PathBuf,
}
pub async fn run(state: &Path, args: &ExportArgs) -> Result<bool, Box<dyn Error>> {
    let path = state.to_owned();
    let operation = args.operation.clone();
    let session = args.session.clone();
    let output = args.output_dir.clone();
    let mut work =
        tokio::task::spawn_blocking(move || export(&path, &session, &operation, &output));
    let receipt = tokio::select! {v=&mut work=>v?.map_err(std::io::Error::other)?,_ = crate::server::shutdown_signal()=>{let published=work.await?.map_err(std::io::Error::other)?;return Err(format!("Workspace export interrupted after complete publication: {published}").into());}};
    println!("{}", serde_json::to_string(&receipt)?);
    Ok(true)
}
fn export(
    database: &Path,
    session: &str,
    operation: &str,
    output: &Path,
) -> Result<serde_json::Value, String> {
    let store = zero_store::Store::open_read_only(database).map_err(|e| e.to_string())?;
    let state = store
        .workspace_state(operation)
        .map_err(|e| e.to_string())?;
    if state.actor.session_id != session {
        return Err("workspace export belongs to another session".into());
    }
    if matches!(
        state.actor.status,
        zero_protocol::OperationStatus::Running | zero_protocol::OperationStatus::Admitted
    ) {
        return Err("workspace export requires terminal actor state".into());
    }
    let mut tests = store
        .workspace_tests(operation)
        .map_err(|e| e.to_string())?;
    tests.extend(
        store
            .workspace_interactive_sessions(operation)
            .map_err(|e| e.to_string())?,
    );
    let bundle = serde_json::json!({"schema_version":1,"assessment":"unverified","session_id":session,"operation_id":operation,"actor_status":state.actor.status,"baseline_generation":zero_workspace::generation(&state.baseline)?,"final_generation":zero_workspace::generation(&state.current)?,"baseline":state.baseline.manifest,"current":state.current.manifest,"policy":state.policy,"changes":zero_workspace::changes(&state.baseline,&state.current)?,"edit_and_test_receipts":state.receipts,"tests":tests,"host_apply":"not_performed"});
    crate::archive_export::publish(output, &state.baseline, &state.current, &bundle)
}
