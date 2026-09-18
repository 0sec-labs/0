mod args;
mod artifact;
mod console;
mod doctor;
mod evaluation;
mod framing;
mod harness;
mod hosted;
mod providers;
mod report;
mod server;
mod source_report;

use args::{Args, Command, SessionCommand, SnapshotCommand};
use clap::Parser;
use std::{error::Error, sync::Arc};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::sync::mpsc;
use zero_engine::Engine;
use zero_protocol::{Command as EngineCommand, MAX_FRAME_BYTES, Reply};

fn main() -> std::process::ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            eprintln!("0sec-native: cannot initialize async runtime");
            return std::process::ExitCode::from(2);
        }
    };
    let status = runtime.block_on(async {
        match run(Args::parse()).await {
            Ok(true) => std::process::ExitCode::SUCCESS,
            Ok(false) => std::process::ExitCode::from(1),
            Err(error) => {
                use tokio::io::AsyncWriteExt;
                let line = format!(
                    "0sec-native: {}\n",
                    console::terminal_text(&error.to_string())
                );
                let mut stderr = tokio::io::stderr();
                let _ = tokio::time::timeout(std::time::Duration::from_secs(1), async {
                    stderr.write_all(line.as_bytes()).await?;
                    stderr.flush().await
                })
                .await;
                std::process::ExitCode::from(2)
            }
        }
    });
    // Engine-owned effects have already settled or completed explicit shutdown.
    // Tokio's blocking stdio reads/writes cannot be interrupted when a parent
    // keeps a pipe open. Do not hang process exit waiting for those I/O tasks.
    runtime.shutdown_timeout(std::time::Duration::from_secs(1));
    status
}

async fn run(args: Args) -> Result<bool, Box<dyn Error>> {
    if let Command::SourceReport {
        session,
        operation,
        reproductions,
        repairs,
        format,
    } = &args.command
    {
        return source_report::run(
            &args.state,
            session,
            operation,
            reproductions,
            repairs,
            *format,
        )
        .await;
    }
    if let Command::Artifact { command } = &args.command {
        return artifact::run(&args.state, command).await;
    }
    if let Command::Evaluation { command } = &args.command {
        return evaluation::run(
            command,
            args.docker_bin.as_deref(),
            args.smolvm_bin.as_deref(),
        )
        .await;
    }
    if matches!(args.command, Command::Schema) {
        write_json(&zero_protocol::schema(), true).await?;
        return Ok(true);
    }
    if let Command::Report { input, format } = &args.command {
        return report::run(input, *format).await;
    }
    if let Command::Snapshot {
        command: SnapshotCommand::Pin { root },
    } = &args.command
    {
        let pin = zero_executor::pin_snapshot(root).map_err(std::io::Error::other)?;
        write_json(&pin, false).await?;
        return Ok(true);
    }
    if let Command::Hosted {
        host,
        token_env,
        command,
    } = &args.command
    {
        return hosted::run(host.as_deref(), token_env, command).await;
    }
    if let Command::Doctor { timeout_ms } = &args.command {
        let smolvm = args
            .smolvm_bin
            .as_deref()
            .unwrap_or_else(|| std::path::Path::new("smolvm"));
        return doctor::run(&args, *timeout_ms, smolvm).await;
    }
    let engine = Arc::new(Engine::open_with_backends(
        &args.state,
        args.docker_bin,
        args.smolvm_bin,
    )?);
    if let Some(path) = args.providers {
        providers::configure(&engine, &path).await?;
    }
    if let Some(path) = args.harness_config {
        harness::configure(&engine, &path).await?;
    }
    if matches!(args.command, Command::AppServer) {
        server::serve(
            engine,
            BufReader::new(tokio::io::stdin()),
            tokio::io::stdout(),
        )
        .await?;
        return Ok(true);
    }
    if let Command::Console { session, request } = &args.command {
        let bytes = providers::read_bounded(request).await?;
        let profile = serde_json::from_slice(&bytes).map_err(|_| "Invalid console profile JSON")?;
        return console::run(engine, session.clone(), profile).await;
    }
    let command = match args.command {
        Command::Session { command } => match command {
            SessionCommand::CreatePinned { budget_limit } => {
                EngineCommand::SessionCreatePinned { budget_limit }
            }
            SessionCommand::Create {
                generation,
                budget_limit,
            } => EngineCommand::SessionCreate {
                generation,
                budget_limit,
            },
            SessionCommand::List => EngineCommand::SessionList,
            SessionCommand::Show { id } => EngineCommand::SessionGet { session_id: id },
            SessionCommand::Budget { id } => EngineCommand::SessionBudget { session_id: id },
            SessionCommand::ReconcileUsage {
                id,
                operation,
                charged,
                evidence,
            } => EngineCommand::ReconcileUsage {
                session_id: id,
                operation_id: operation,
                charged,
                evidence,
            },
            SessionCommand::Events { id, after, limit } => EngineCommand::SessionEvents {
                session_id: id,
                after_sequence: after,
                limit,
            },
        },
        Command::Exec {
            session,
            command_id,
            request,
        } => {
            let mut bytes = Vec::new();
            tokio::fs::File::open(request)
                .await?
                .take((MAX_FRAME_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > MAX_FRAME_BYTES {
                return Err("Execution request exceeds the frame byte limit".into());
            }
            EngineCommand::Execute {
                session_id: session,
                command_id,
                request: serde_json::from_slice(&bytes)?,
            }
        }
        Command::Sandbox {
            session,
            command_id,
            request,
        } => {
            let bytes = providers::read_bounded(&request).await?;
            EngineCommand::RunSandbox {
                session_id: session,
                command_id,
                request: serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid sandbox request JSON")?,
            }
        }
        Command::PluginCall {
            session,
            command_id,
            plugin,
            tool,
            input,
        } => {
            let bytes = providers::read_bounded(&input).await?;
            EngineCommand::RunPlugin {
                session_id: session,
                command_id,
                plugin,
                tool,
                input: serde_json::from_slice(&bytes).map_err(|_| "Invalid plugin input JSON")?,
            }
        }
        Command::Infer {
            session,
            command_id,
            provider,
            reservation,
            request,
        } => {
            let bytes = providers::read_bounded(&request).await?;
            EngineCommand::Infer {
                session_id: session,
                command_id,
                provider,
                reservation,
                request: serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid inference request JSON")?,
            }
        }
        Command::SourceRepair {
            session,
            command_id,
            request,
        } => {
            let bytes = tokio::select! {
                result = tokio::time::timeout(std::time::Duration::from_secs(5), providers::read_bounded(&request)) =>
                    result.map_err(|_| "Source repair input deadline exceeded")??,
                _ = server::shutdown_signal() => return Err("Source repair input interrupted".into()),
            };
            EngineCommand::ValidateSourceRepair {
                session_id: session,
                command_id,
                request: serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid source repair request JSON")?,
            }
        }
        Command::SourceReproduce {
            session,
            command_id,
            request,
        } => {
            let bytes = tokio::select! {
                result = tokio::time::timeout(std::time::Duration::from_secs(5), providers::read_bounded(&request)) =>
                    result.map_err(|_| "Source reproduction input deadline exceeded")??,
                _ = server::shutdown_signal() => return Err("Source reproduction input interrupted".into()),
            };
            EngineCommand::ReproduceSource {
                session_id: session,
                command_id,
                request: serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid source reproduction request JSON")?,
            }
        }
        Command::SourceReview {
            session,
            command_id,
            request,
        } => {
            let bytes = tokio::select! {
                result = tokio::time::timeout(std::time::Duration::from_secs(5), providers::read_bounded(&request)) =>
                    result.map_err(|_| "Source review input deadline exceeded")??,
                _ = server::shutdown_signal() => return Err("Source review input interrupted".into()),
            };
            EngineCommand::ReviewSource {
                session_id: session,
                command_id,
                request: serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid source review request JSON")?,
            }
        }
        Command::Agent {
            session,
            command_id,
            request,
        } => {
            let bytes = providers::read_bounded(&request).await?;
            EngineCommand::RunAgent {
                session_id: session,
                command_id,
                request: serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid agent request JSON")?,
            }
        }
        Command::SourceReport { .. }
        | Command::Schema
        | Command::Snapshot { .. }
        | Command::Doctor { .. }
        | Command::AppServer
        | Command::Console { .. }
        | Command::Hosted { .. }
        | Command::Report { .. }
        | Command::Evaluation { .. }
        | Command::Artifact { .. } => unreachable!(),
    };
    let (events, mut event_rx) = mpsc::channel(128);
    // One-shot commands reserve stdout for their final JSON result.
    let drain = tokio::spawn(async move { while event_rx.recv().await.is_some() {} });
    let task_engine = engine.clone();
    let mut operation = tokio::spawn(async move { task_engine.handle(command, events).await });
    let reply = tokio::select! {
        reply = &mut operation => reply?,
        _ = server::shutdown_signal() => {
            engine.shutdown().await?;
            operation.await?
        }
    };
    engine.shutdown().await?;
    drain.await?;
    let success = match &reply {
        Reply::Error { .. } => false,
        Reply::Execution { operation, .. }
        | Reply::Inference { operation, .. }
        | Reply::Agent { operation, .. }
        | Reply::Sandbox { operation, .. }
        | Reply::SourceReproduction { operation, .. }
        | Reply::SourceRepair { operation, .. }
        | Reply::SourceReview { operation, .. }
        | Reply::Plugin { operation, .. } => {
            matches!(operation.status, zero_protocol::OperationStatus::Succeeded)
        }
        _ => true,
    };
    write_json(&reply, false).await?;
    Ok(success)
}

// Owned engine work has settled before one-shot output starts. Slow readers may
// prevent delivery, but cannot hold the process or its signal handler forever.
async fn write_json(value: &impl serde::Serialize, pretty: bool) -> Result<(), Box<dyn Error>> {
    use tokio::io::AsyncWriteExt;
    let mut bytes = if pretty {
        serde_json::to_vec_pretty(value)?
    } else {
        serde_json::to_vec(value)?
    };
    bytes.push(b'\n');
    let mut stdout = tokio::io::stdout();
    tokio::select! {
        result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            stdout.write_all(&bytes).await?;
            stdout.flush().await
        }) => result.map_err(|_| "JSON output deadline exceeded")??,
        _ = server::shutdown_signal() => return Err("JSON output interrupted".into()),
    }
    Ok(())
}
