//! Read-only hosted metadata with explicit environment/legacy credential resolution.
#[path = "credentials.rs"]
pub(crate) mod credentials;
#[path = "hosted_login.rs"]
mod login;
#[path = "hosted_logout.rs"]
mod logout;
use clap::Subcommand;
use std::{error::Error, time::Duration};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use zero_cloud_client::CloudClient;

#[derive(Debug, Subcommand)]
pub enum HostedCommand {
    /// Display a browser sign-in URL, poll, and save credentials privately after approval.
    Login {
        /// Absolute credential file; default HOME/.0sec/cloud.env.
        #[arg(long)]
        credentials: Option<std::path::PathBuf>,
        #[arg(long, default_value_t = 300_000, value_parser = clap::value_parser!(u64).range(1..=300_000))]
        timeout_ms: u64,
        /// Import a token from this environment variable without browser/network access.
        #[arg(long)]
        token_from_env: Option<String>,
    },
    /// Remove saved credentials; environment tokens and remote sessions remain active.
    Logout {
        /// Remove only this explicit file; default removes both legacy credential stores.
        #[arg(long)]
        credentials: Option<std::path::PathBuf>,
    },
    #[command(alias = "status")]
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
    if let HostedCommand::Login {
        credentials,
        timeout_ms,
        token_from_env,
    } = command
    {
        return login::run(
            host,
            token_env,
            credentials.as_deref(),
            *timeout_ms,
            token_from_env.as_deref(),
        )
        .await;
    }
    if let HostedCommand::Logout { credentials } = command {
        return logout::run(credentials.as_deref(), token_env).await;
    }
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
            HostedCommand::Login { .. } | HostedCommand::Logout { .. } => unreachable!(),
            HostedCommand::Health => client.ping_health(cancel.clone()).await.and_then(|v| {
                serde_json::to_string(&v)
                    .map_err(|_| zero_cloud_client::CloudError::InvalidResponse)
            }),
            HostedCommand::Models => client.inference_models(cancel.clone()).await.and_then(|v| {
                serde_json::to_string(&v)
                    .map_err(|_| zero_cloud_client::CloudError::InvalidResponse)
            }),
            HostedCommand::Account => {
                client
                    .inference_account(cancel.clone())
                    .await
                    .and_then(|v| {
                        serde_json::to_string(&v)
                            .map_err(|_| zero_cloud_client::CloudError::InvalidResponse)
                    })
            }
            HostedCommand::Usage => client.inference_usage(cancel.clone()).await.and_then(|v| {
                serde_json::to_string(&v)
                    .map_err(|_| zero_cloud_client::CloudError::InvalidResponse)
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
            let line = format!("{value}\n");
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
