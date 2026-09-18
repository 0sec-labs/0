//! Read-only redacted target evidence. No target/profile/DNS access occurs here.
use base64::{Engine, engine::general_purpose::STANDARD};
use clap::Subcommand;
use serde_json::json;
use std::{error::Error, path::Path, time::Duration};
#[derive(Debug, Subcommand)]
pub enum HttpCommand {
    /// Validate one retained HTTP operation; this never replays the target request.
    Show {
        #[arg(long)]
        session: String,
        #[arg(long)]
        operation: String,
        /// Include exact retained redacted body bytes in base64, never a raw-secret body.
        #[arg(long)]
        evidence: bool,
    },
}
pub async fn run(path: &Path, command: HttpCommand) -> Result<bool, Box<dyn Error>> {
    let path = path.to_owned();
    let HttpCommand::Show {
        session,
        operation,
        evidence,
    } = command;
    let task = tokio::task::spawn_blocking(move || {
        let retained = zero_engine::read_http_operation(&path, &session, &operation)?;
        let mut out = json!({"session_id":session,"operation_id":operation,"retained":retained,"evidence_representation":"redacted target observation; not a verification or safety verdict"});
        if evidence {
            let bytes = zero_engine::read_http_evidence(&path, &session, &operation)?;
            out["body"] =
                json!({"encoding":"base64","bytes":bytes.len(),"data":STANDARD.encode(&bytes)});
        }
        Ok::<_, zero_engine::EngineError>(out)
    });
    let value = tokio::select! {result=tokio::time::timeout(Duration::from_secs(5),task)=>result.map_err(|_|"HTTP evidence read deadline exceeded")???,_=crate::server::shutdown_signal()=>return Err("HTTP evidence read interrupted".into())};
    crate::write_json(&value, false).await?;
    Ok(true)
}
