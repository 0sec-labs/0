mod args;
mod doctor;
mod framing;
mod providers;
mod server;

use args::{Args, Command, SessionCommand, SnapshotCommand};
use clap::Parser;
use std::{error::Error, sync::Arc};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::sync::mpsc;
use zero_engine::Engine;
use zero_protocol::{Command as EngineCommand, MAX_FRAME_BYTES, Reply};

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run(Args::parse()).await {
        Ok(true) => std::process::ExitCode::SUCCESS,
        Ok(false) => std::process::ExitCode::from(1),
        Err(error) => {
            eprintln!("0sec-native: {error}");
            std::process::ExitCode::from(2)
        }
    }
}

async fn run(args: Args) -> Result<bool, Box<dyn Error>> {
    if matches!(args.command, Command::Schema) {
        println!(
            "{}",
            serde_json::to_string_pretty(&zero_protocol::schema())?
        );
        return Ok(true);
    }
    if let Command::Snapshot {
        command: SnapshotCommand::Pin { root },
    } = &args.command
    {
        let pin = zero_executor::pin_snapshot(root).map_err(std::io::Error::other)?;
        println!("{}", serde_json::to_string(&pin)?);
        return Ok(true);
    }
    if let Command::Doctor {
        timeout_ms,
        smolvm_bin,
    } = &args.command
    {
        return doctor::run(&args, *timeout_ms, smolvm_bin).await;
    }
    let engine = Arc::new(Engine::open(&args.state, args.docker_bin)?);
    if let Some(path) = args.providers {
        providers::configure(&engine, &path).await?;
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
    let command = match args.command {
        Command::Session { command } => match command {
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
        Command::Schema
        | Command::Snapshot { .. }
        | Command::Doctor { .. }
        | Command::AppServer => unreachable!(),
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
        | Reply::Agent { operation, .. } => {
            matches!(operation.status, zero_protocol::OperationStatus::Succeeded)
        }
        _ => true,
    };
    println!("{}", serde_json::to_string(&reply)?);
    Ok(success)
}
