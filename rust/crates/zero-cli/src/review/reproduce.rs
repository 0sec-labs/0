//! Explicit host authorization; no provider or original checkout is opened.
use clap::{Args, ValueEnum};
use std::{error::Error, path::PathBuf, sync::Arc};
use zero_protocol::{
    OperationStatus, Reply, review_reproduction::ReviewReproductionPlan, verification::Disposition,
};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Format {
    Json,
    Terminal,
}
#[derive(Debug, Args)]
pub struct ReproduceArgs {
    /// Strict host authorization JSON (at most 1 MiB); includes independent frozen expectations.
    #[arg(long)]
    plan: PathBuf,
    #[arg(long)]
    command_id: Option<String>,
    #[arg(long, value_enum, default_value = "json")]
    format: Format,
}

pub(super) async fn inspect(
    state: &std::path::Path,
    reproduction: Option<&str>,
    command: Option<&str>,
    format: Format,
) -> Result<u8, Box<dyn Error>> {
    let state = state.to_owned();
    let reproduction = reproduction.map(str::to_owned);
    let command = command.map(str::to_owned);
    let reply = tokio::task::spawn_blocking(move || -> Result<Reply, String> {
        let key = match (reproduction, command) {
            (Some(id), None) => id,
            (None, Some(command)) => {
                zero_store::Store::open_read_only(&state)
                    .map_err(|e| e.to_string())?
                    .native_reproduction_by_command(&command)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Native reproduction command not found".to_owned())?
                    .id
            }
            _ => return Err("Select exactly one reproduction or command ID".into()),
        };
        zero_engine::read_review_reproduction(&state, &key).map_err(|e| e.to_string())
    })
    .await?
    .map_err(std::io::Error::other)?;
    output(&reply, format).await?;
    Ok(exit_code(&reply))
}

pub async fn run(args: &crate::args::Args, options: &ReproduceArgs) -> Result<u8, Box<dyn Error>> {
    let authorization = parse(&crate::providers::read_bounded(&options.plan).await?)?;
    let command = options
        .command_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if command.trim().is_empty() || command.len() > 256 || command.chars().any(char::is_control) {
        return Err("Invalid reproduction command ID".into());
    }
    let state = args.state.clone();
    let expected = authorization.clone();
    let key = command.clone();
    let retained = tokio::task::spawn_blocking(move || {
        zero_engine::read_review_reproduction_for_command(&state, &key, &expected)
    })
    .await??;
    if let Some(reply) = retained {
        output(&reply, options.format).await?;
        return Ok(exit_code(&reply));
    }
    if args.providers.is_some()
        || args.hosted_model.is_some()
        || args.hosted_host.is_some()
        || args.hosted_token_env.is_some()
        || args.hosted_timeout_ms.is_some()
        || args.http_profiles.is_some()
        || args.scan_profiles.is_some()
        || args.review_profiles.is_some()
        || args.harness_config.is_some()
        || args.strategy_host.is_some()
    {
        return Err("Review reproduction accepts its host plan and sandbox backend only; provider and other runtime profiles are unsupported".into());
    }
    let mut signals = crate::scan::Signals::new()?;
    let engine = Arc::new(zero_engine::Engine::open_with_backends(
        &args.state,
        args.docker_bin.clone(),
        args.smolvm_bin.clone(),
    )?);
    use tokio::io::AsyncWriteExt;
    let notice = format!(
        "Review reproduction command {}\n",
        crate::console::terminal_text(&command)
    );
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        tokio::io::stderr().write_all(notice.as_bytes()),
    )
    .await??;
    let (events, mut receiver) = tokio::sync::mpsc::channel(128);
    let drain = tokio::spawn(async move { while receiver.recv().await.is_some() {} });
    let worker = engine.clone();
    let mut task = tokio::spawn(async move {
        worker
            .reproduce_review(command, authorization, events)
            .await
    });
    let mut interrupted = None;
    let result = tokio::select! {
        result=&mut task=>result,
        code=signals.wait()=>{ interrupted=Some(code); engine.shutdown().await?; task.await }
    };
    engine.shutdown().await?;
    drain.await?;
    let reply = result??;
    output(&reply, options.format).await?;
    Ok(interrupted.unwrap_or_else(|| exit_code(&reply)))
}

fn parse(bytes: &[u8]) -> Result<ReviewReproductionPlan, Box<dyn Error>> {
    if bytes.len() > zero_protocol::MAX_FRAME_BYTES {
        return Err("Reproduction plan exceeds 1 MiB".into());
    }
    let plan: ReviewReproductionPlan =
        serde_json::from_slice(bytes).map_err(|_| "Invalid strict review reproduction plan")?;
    plan.validate_envelope().map_err(std::io::Error::other)?;
    Ok(plan)
}
fn exit_code(reply: &Reply) -> u8 {
    match reply {
        Reply::SourceReproduction {
            operation,
            result: Some(result),
            ..
        } if operation.status == OperationStatus::Succeeded
            && result.error.is_none()
            && result.assessment.as_ref().is_some_and(|a| {
                !a.vulnerability_reportable
                    && matches!(
                        a.disposition,
                        Disposition::ObservedForPlan | Disposition::NotObserved
                    )
            }) =>
        {
            0
        }
        _ => 2,
    }
}
async fn output(reply: &Reply, format: Format) -> Result<(), Box<dyn Error>> {
    if matches!(format, Format::Json) {
        return crate::write_json(reply, false).await;
    }
    let Reply::SourceReproduction {
        operation,
        result,
        duplicate,
    } = reply
    else {
        return Err("Unexpected native reproduction reply".into());
    };
    let disposition = result
        .as_ref()
        .and_then(|r| r.assessment.as_ref())
        .map(|a| format!("{:?}", a.disposition))
        .unwrap_or_else(|| "no completed assessment".into());
    let cases = result
        .as_ref()
        .map(|r| r.children.len().to_string())
        .unwrap_or_else(|| "not available without a retained terminal outcome".into());
    let key = operation.payload["reproduction_id"]
        .as_str()
        .unwrap_or("unavailable");
    super::write_output(&crate::console::terminal_text(&format!(
        "Native review reproduction {}\nSession {}; operation {} ({:?}); retained result {}\nAssessment: {}; admitted case executions {}\nObservedForPlan means only the frozen host expectations were met. This does not verify a vulnerability or establish reportability. Partial or absent observations establish no safety conclusion.\n",
        key,operation.session_id,operation.id,operation.status,duplicate,disposition,cases,
    ))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    #[test]
    fn route_requires_explicit_plan_and_rejects_review_or_model_arguments() {
        assert!(
            crate::args::Args::try_parse_from([
                "native",
                "review",
                "reproduce",
                "--plan",
                "host.json",
                "--command-id",
                "check"
            ])
            .is_ok()
        );
        for tail in [
            vec![],
            vec!["--plan", "host.json", "--profile", "p"],
            vec!["--plan", "host.json", "--prompt", "model authority"],
            vec!["--plan", "host.json", "--format", "html"],
        ] {
            assert!(
                crate::args::Args::try_parse_from(
                    [vec!["native", "review", "reproduce"], tail].concat()
                )
                .is_err()
            );
        }
        assert!(parse(br#"{"schema_version":1,"unexpected":true}"#).is_err());
        assert!(parse(&vec![b' '; zero_protocol::MAX_FRAME_BYTES + 1]).is_err());
    }
    #[test]
    fn inspection_requires_one_identity_and_no_plan() {
        for identity in ["--reproduction", "--command-id"] {
            assert!(
                crate::args::Args::try_parse_from([
                    "native",
                    "review",
                    "reproduction",
                    identity,
                    "id",
                    "--format",
                    "terminal"
                ])
                .is_ok()
            );
        }
        for tail in [
            vec![],
            vec!["--reproduction", "id", "--command-id", "command"],
            vec!["--command-id", "id", "--plan", "host.json"],
        ] {
            assert!(
                crate::args::Args::try_parse_from(
                    [vec!["native", "review", "reproduction"], tail].concat()
                )
                .is_err()
            );
        }
    }
}
