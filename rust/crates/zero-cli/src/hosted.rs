//! Read-only hosted metadata with explicit environment/legacy credential resolution.
#[path = "credentials.rs"]
mod credentials;
use clap::Subcommand;
use std::{error::Error, time::Duration};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use zero_cloud_client::CloudClient;

#[derive(Debug, Subcommand)]
pub enum HostedCommand {
    Health,
    Models,
    Account,
    Usage,
}

pub async fn run(
    host: Option<&str>,
    token_env: &str,
    command: &HostedCommand,
) -> Result<bool, Box<dyn Error>> {
    let credentials = credentials::resolve(host, token_env).await?;
    let client = CloudClient::new(
        &credentials.host,
        &credentials.token,
        Duration::from_secs(30),
        1024 * 1024,
    )?;
    let cancel = CancellationToken::new();
    let request = async {
        match command {
            HostedCommand::Health => client.ping_health(cancel.clone()).await.and_then(|v| {
                serde_json::to_value(v).map_err(|_| zero_cloud_client::CloudError::InvalidResponse)
            }),
            HostedCommand::Models => client.inference_models(cancel.clone()).await.and_then(|v| {
                serde_json::to_value(v).map_err(|_| zero_cloud_client::CloudError::InvalidResponse)
            }),
            HostedCommand::Account => {
                client
                    .inference_account(cancel.clone())
                    .await
                    .and_then(|v| {
                        serde_json::to_value(v)
                            .map_err(|_| zero_cloud_client::CloudError::InvalidResponse)
                    })
            }
            HostedCommand::Usage => client.inference_usage(cancel.clone()).await.and_then(|v| {
                serde_json::to_value(v).map_err(|_| zero_cloud_client::CloudError::InvalidResponse)
            }),
        }
    };
    tokio::pin!(request);
    let reply = tokio::select! {
        reply=&mut request=>reply,
        _=crate::server::shutdown_signal()=>{cancel.cancel();request.await},
    };
    match reply {
        Ok(value) => {
            let line = format!("{}\n", serde_json::to_string(&value)?);
            let mut stdout = tokio::io::stdout();
            tokio::time::timeout(Duration::from_secs(1), async {
                stdout.write_all(line.as_bytes()).await?;
                stdout.flush().await
            })
            .await
            .map_err(|_| "Hosted output deadline exceeded")??;
            Ok(true)
        }
        Err(error) => {
            let line = format!("0sec-native hosted: {error}\n");
            let mut stderr = tokio::io::stderr();
            let _ = tokio::time::timeout(Duration::from_secs(1), async {
                stderr.write_all(line.as_bytes()).await?;
                stderr.flush().await
            })
            .await;
            Ok(false)
        }
    }
}
