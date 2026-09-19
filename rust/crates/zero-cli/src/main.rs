mod approvals;
mod args;
mod artifact;
mod console;
mod doctor;
mod evaluation;
mod findings;
mod framing;
mod harness;
mod history;
mod hosted;
mod hosted_provider;
mod http_evidence;
mod http_profiles;
mod managed_scan;
mod providers;
mod questions;
mod repair_export;
mod report;
mod review;
mod review_profiles;
mod scan;
mod scan_profiles;
mod server;
mod source_report;
mod steering;
mod strategy;
mod strategy_host;
mod strategy_registry;
mod strategy_search;
mod timeline;
mod tui;
mod web;

use args::{Args, Command, QueueCommand, SessionCommand, SnapshotCommand};
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
        match dispatch(Args::parse()).await {
            Ok(code) => std::process::ExitCode::from(code),
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

async fn dispatch(args: Args) -> Result<u8, Box<dyn Error>> {
    if let Command::ManagedHttp(options) = &args.command {
        return managed_scan::run(&args, options).await;
    }
    if let Command::Review(options) = &args.command {
        return review::run(&args, options).await;
    }
    if let Command::Scan(options) = &args.command {
        return scan::run(&args, options).await;
    }
    run(args).await.map(|success| u8::from(!success))
}

async fn run(args: Args) -> Result<bool, Box<dyn Error>> {
    if let Command::History(options) = &args.command {
        return history::run(&args.state, options).await;
    }
    if let Command::Timeline(options) = &args.command {
        return timeline::run(&args.state, options).await;
    }
    if let Command::Session {
        command: SessionCommand::Budget { id },
    } = &args.command
    {
        let path = args.state.clone();
        let session = id.clone();
        let budget =
            tokio::task::spawn_blocking(move || zero_engine::read_session_budget(&path, &session))
                .await??;
        write_json(&Reply::SessionBudget { budget }, false).await?;
        return Ok(true);
    }
    let mut strategy_dispatch = None;
    if let Command::Strategy { command } = &args.command {
        if command.requires_dispatch() {
            strategy_dispatch = Some(strategy::command(command).await?);
        } else {
            return strategy::readonly(&args.state, command).await;
        }
    }
    let mut web_dispatch = None;
    if let Command::Web { command } = &args.command {
        if command.requires_dispatch() {
            web_dispatch = Some(web::command(command).await?);
        } else {
            return web::readonly(&args.state, command).await;
        }
    }

    if let Command::Tui {
        session,
        request,
        budget_limit,
    } = &args.command
    {
        return tui::run(&args, session.clone(), request.as_deref(), *budget_limit).await;
    }
    if let Command::Http { command } = args.command {
        return http_evidence::run(&args.state, command).await;
    }
    if let Command::Approvals { command } = args.command {
        return approvals::run(&args.state, command).await;
    }
    if let Command::Questions { command } = args.command {
        return questions::run(&args.state, command).await;
    }
    if let Command::Steer { command } = args.command {
        return steering::run(&args.state, command).await;
    }
    if let Command::Findings { command } = args.command {
        return findings::run(&args.state, command).await;
    }
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
    if let Command::SourceRepairExport(command) = &args.command {
        return repair_export::run(&args.state, command).await;
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
    questions::preflight(&args.state, &args.command).await?;
    let http_profiles = match args.http_profiles.as_deref() {
        Some(path) => http_profiles::load(path).await?,
        None => Vec::new(),
    };
    let scan_profiles = match args.scan_profiles.as_deref() {
        Some(path) => scan_profiles::load(path).await?,
        None => Vec::new(),
    };
    let review_profiles = match args.review_profiles.as_deref() {
        Some(path) => review_profiles::load(path).await?,
        None => Vec::new(),
    };
    let engine = Arc::new(Engine::open_with_backends(
        &args.state,
        args.docker_bin,
        args.smolvm_bin,
    )?);
    for (name, profile) in review_profiles {
        engine.configure_review(&name, profile)?;
    }
    for (name, profile) in scan_profiles {
        engine.configure_scan(&name, profile)?;
    }
    for (name, client) in http_profiles {
        engine.configure_http(&name, client)?;
    }
    if let Some(path) = args.providers {
        providers::configure(&engine, &path).await?;
    }
    if let Some(model) = args.hosted_model {
        hosted_provider::configure(
            &engine,
            &model,
            args.hosted_host.as_deref(),
            args.hosted_token_env
                .as_deref()
                .unwrap_or("0SEC_CLOUD_TOKEN"),
            args.hosted_timeout_ms.unwrap_or(300_000),
        )
        .await?;
    }
    if let Some(path) = args.harness_config {
        harness::configure(&engine, &path).await?;
    }
    if let Some(path) = args.strategy_host {
        strategy_host::configure(&engine, &path).await?;
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
        Command::Strategy { .. } => strategy_dispatch
            .take()
            .ok_or("Strategy dispatch intent unavailable")?,
        Command::Web { .. } => web_dispatch
            .take()
            .ok_or("Web dispatch intent unavailable")?,
        Command::Queue { command } => match command {
            QueueCommand::Enqueue {
                session,
                command_id,
                request,
                after_input,
            } => {
                let bytes = tokio::select! {
                    result = tokio::time::timeout(std::time::Duration::from_secs(5), providers::read_bounded(&request)) => result.map_err(|_| "Queue input deadline exceeded")??,
                    _ = server::shutdown_signal() => return Err("Queue input interrupted".into()),
                };
                EngineCommand::QueueAgent {
                    session_id: session,
                    command_id,
                    request: serde_json::from_slice(&bytes)
                        .map_err(|_| "Invalid queued agent request JSON")?,
                    after_input,
                }
            }
            QueueCommand::List {
                session,
                after,
                limit,
            } => EngineCommand::AgentQueue {
                session_id: session,
                after_sequence: after,
                limit,
            },
            QueueCommand::Cancel { session, input } => EngineCommand::CancelQueuedAgent {
                session_id: session,
                input_id: input,
            },
            QueueCommand::Run { session, input } => {
                questions::unattended_queue(&args.state, &session, &input)?;
                EngineCommand::RunQueuedAgent {
                    session_id: session,
                    input_id: input,
                }
            }
        },
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
            let request: zero_protocol::agent::AgentRequest =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid agent request JSON")?;
            if (request.operator_questions || request.tool_approval_policy.is_some())
                && !questions::cached_agent_request(&args.state, &session, &command_id, &request)
            {
                return Err(
                    "interactive-policy agent requires app-server, console or tui for answers or tool approval"
                        .into(),
                );
            }
            EngineCommand::RunAgent {
                session_id: session,
                command_id,
                request,
            }
        }
        Command::Http { .. }
        | Command::Approvals { .. }
        | Command::Questions { .. }
        | Command::Steer { .. }
        | Command::Findings { .. }
        | Command::SourceReport { .. }
        | Command::SourceRepairExport(_)
        | Command::Schema
        | Command::Snapshot { .. }
        | Command::Doctor { .. }
        | Command::AppServer
        | Command::Console { .. }
        | Command::Tui { .. }
        | Command::Hosted { .. }
        | Command::Report { .. }
        | Command::Evaluation { .. }
        | Command::Artifact { .. }
        | Command::Review(_)
        | Command::Scan(_)
        | Command::ManagedHttp(_)
        | Command::History(_)
        | Command::Timeline(_) => unreachable!(),
    };
    let strategy_run = matches!(
        &command,
        EngineCommand::RunStrategyCampaign { .. } | EngineCommand::RunStrategySearch { .. }
    );
    let mut interrupted = false;
    let (events, mut event_rx) = mpsc::channel(128);
    // One-shot commands reserve stdout for their final JSON result.
    let drain = tokio::spawn(async move { while event_rx.recv().await.is_some() {} });
    let task_engine = engine.clone();
    let mut operation = tokio::spawn(async move { task_engine.handle(command, events).await });
    let reply = tokio::select! {
        reply = &mut operation => reply?,
        _ = server::shutdown_signal() => {
            interrupted = true;
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
        | Reply::WebVerification { operation, .. }
        | Reply::Plugin { operation, .. } => {
            matches!(operation.status, zero_protocol::OperationStatus::Succeeded)
        }
        _ => true,
    };
    write_json(&reply, false).await?;
    Ok(success && !(strategy_run && interrupted))
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
