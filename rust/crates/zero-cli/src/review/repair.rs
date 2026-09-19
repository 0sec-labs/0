//! Explicit host authorization; no provider or original checkout is opened.
use clap::{Args, ValueEnum};
use std::{error::Error, path::PathBuf, sync::Arc};
use zero_protocol::{
    OperationStatus, Reply, repair::RepairValidationStatus, review_repair::ReviewRepairPlan,
};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Format {
    Json,
    Terminal,
}
#[derive(Debug, Args)]
pub struct RepairArgs {
    /// Strict host authorization JSON (at most 1 MiB); binds independently retained reproduction and exact replacement bytes.
    #[arg(long)]
    plan: PathBuf,
    #[arg(long)]
    command_id: Option<String>,
    #[arg(long, value_enum, default_value = "json")]
    format: Format,
}

pub(super) async fn inspect(
    state: &std::path::Path,
    repair: Option<&str>,
    command: Option<&str>,
    format: Format,
) -> Result<u8, Box<dyn Error>> {
    let state = state.to_owned();
    let repair = repair.map(str::to_owned);
    let command = command.map(str::to_owned);
    let reply = tokio::task::spawn_blocking(move || -> Result<Reply, String> {
        let key = resolve(&state, repair, command)?;
        zero_engine::read_review_repair(&state, &key).map_err(|e| e.to_string())
    })
    .await?
    .map_err(std::io::Error::other)?;
    output(&reply, format).await?;
    Ok(exit_code(&reply))
}

pub async fn run(args: &crate::args::Args, options: &RepairArgs) -> Result<u8, Box<dyn Error>> {
    let authorization = parse(&crate::providers::read_bounded(&options.plan).await?)?;
    let command = options
        .command_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if command.trim().is_empty() || command.len() > 256 || command.chars().any(char::is_control) {
        return Err("Invalid repair command ID".into());
    }
    let state = args.state.clone();
    let expected = authorization.clone();
    let key = command.clone();
    let retained = tokio::task::spawn_blocking(move || {
        zero_engine::read_review_repair_for_command(&state, &key, &expected)
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
        return Err("Review repair accepts its host plan and sandbox backend only; provider and other runtime profiles are unsupported".into());
    }
    let mut signals = crate::scan::Signals::new()?;
    let engine = Arc::new(zero_engine::Engine::open_with_backends(
        &args.state,
        args.docker_bin.clone(),
        args.smolvm_bin.clone(),
    )?);
    use tokio::io::AsyncWriteExt;
    let notice = format!(
        "Review repair command {}\n",
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
    let mut task =
        tokio::spawn(async move { worker.repair_review(command, authorization, events).await });
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

fn parse(bytes: &[u8]) -> Result<ReviewRepairPlan, Box<dyn Error>> {
    if bytes.len() > zero_protocol::MAX_FRAME_BYTES {
        return Err("Repair plan exceeds 1 MiB".into());
    }
    let plan: ReviewRepairPlan =
        serde_json::from_slice(bytes).map_err(|_| "Invalid strict review repair plan")?;
    plan.validate_envelope().map_err(std::io::Error::other)?;
    Ok(plan)
}
fn exit_code(reply: &Reply) -> u8 {
    match reply {
        Reply::SourceRepair {
            operation,
            result: Some(result),
            ..
        } if operation.status == OperationStatus::Succeeded
            && result.error.is_none()
            && result.cleanup_recovery.is_empty()
            && !result.vulnerability_reportable
            && result.status == RepairValidationStatus::ValidatedCandidateForPlan =>
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
    let Reply::SourceRepair {
        operation,
        result,
        duplicate,
    } = reply
    else {
        return Err("Unexpected native repair reply".into());
    };
    let assessment = result
        .as_ref()
        .map(|r| format!("{:?}", r.status))
        .unwrap_or_else(|| "no completed assessment".into());
    let phases = result
        .as_ref()
        .map(|r| r.phases.len().to_string())
        .unwrap_or_else(|| "not available without a retained terminal outcome".into());
    let key = operation.payload["repair_id"]
        .as_str()
        .unwrap_or("unavailable");
    super::write_output(&crate::console::terminal_text(&format!(
        "Native review repair {}\nSession {}; operation {} ({:?}); retained result {}\nAssessment: {}; retained validation phases {}\nValidatedCandidateForPlan means only the frozen host expectations were met for this private candidate. It does not verify a vulnerability, establish general repair safety, or modify the original source tree. Partial or absent observations establish no safety conclusion.\n",
        key, operation.session_id, operation.id, operation.status, duplicate, assessment, phases,
    ))).await
}

/// Complete independent validation before emitting any patch bytes.
pub(super) async fn export(
    state: &std::path::Path,
    repair: Option<&str>,
    command: Option<&str>,
    output_dir: Option<&std::path::Path>,
) -> Result<u8, Box<dyn Error>> {
    let state = state.to_owned();
    let repair = repair.map(str::to_owned);
    let command = command.map(str::to_owned);
    if let Some(output) = output_dir {
        let output = output.to_owned();
        let mut worker =
            tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
                let key = resolve(&state, repair, command)?;
                let retained = zero_engine::read_review_repair_bundle(&state, &key)
                    .map_err(|e| e.to_string())?;
                crate::archive_export::publish(
                    &output,
                    &retained.baseline,
                    &retained.current,
                    &retained.bundle,
                )
            });
        let (receipt, interrupted) = tokio::select! {
            result=&mut worker => (result?.map_err(std::io::Error::other)?,false),
            _=crate::server::shutdown_signal()=> (worker.await?.map_err(std::io::Error::other)?,true),
        };
        crate::write_json(&receipt, false).await?;
        return Ok(if interrupted { 130 } else { 0 });
    }
    let patch = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let key = resolve(&state, repair, command)?;
        zero_engine::read_review_repair_patch(&state, &key).map_err(|e| e.to_string())
    })
    .await?
    .map_err(std::io::Error::other)?;
    use tokio::io::AsyncWriteExt;
    let mut stdout = tokio::io::stdout();
    stdout.write_all(patch.as_bytes()).await?;
    stdout.flush().await?;
    Ok(0)
}

fn resolve(
    state: &std::path::Path,
    repair: Option<String>,
    command: Option<String>,
) -> Result<String, String> {
    match (repair, command) {
        (Some(id), None) => Ok(id),
        (None, Some(command)) => zero_store::Store::open_read_only(state)
            .map_err(|e| e.to_string())?
            .native_repair_by_command(&command)
            .map_err(|e| e.to_string())?
            .map(|record| record.id)
            .ok_or_else(|| "Native repair command not found".into()),
        _ => Err("Select exactly one repair or command ID".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn host_repair_routes_require_explicit_authority_and_identity() {
        assert!(
            crate::args::Args::try_parse_from([
                "native",
                "review",
                "repair",
                "--plan",
                "host.json",
                "--command-id",
                "repair"
            ])
            .is_ok()
        );
        for tail in [
            vec![],
            vec!["--plan", "host.json", "--profile", "p"],
            vec!["--plan", "host.json", "--prompt", "x"],
            vec!["--plan", "host.json", "--format", "html"],
        ] {
            assert!(
                crate::args::Args::try_parse_from(
                    [vec!["native", "review", "repair"], tail].concat()
                )
                .is_err()
            );
        }
        for route in ["repair-report", "repair-export"] {
            for selector in ["--repair", "--command-id"] {
                assert!(
                    crate::args::Args::try_parse_from(["native", "review", route, selector, "id"])
                        .is_ok()
                );
            }
            for tail in [
                vec![],
                vec!["--repair", "id", "--command-id", "c"],
                vec!["--repair", "id", "--plan", "host.json"],
            ] {
                assert!(
                    crate::args::Args::try_parse_from(
                        [vec!["native", "review", route], tail].concat()
                    )
                    .is_err()
                );
            }
        }
        assert!(parse(br#"{"schema_version":1,"unexpected":true}"#).is_err());
        assert!(parse(&vec![b' '; zero_protocol::MAX_FRAME_BYTES + 1]).is_err());
    }
}
