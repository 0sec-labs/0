//! Local source capture and private staging drain before engine ownership.
//! Preparation has its own deadline: min(profile.deadline_ms, 60 seconds).
//! The durable investigation deadline begins only at engine admission.
use crate::scan::{Format, Signals};
use clap::{Args, Subcommand};
use std::{
    error::Error,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use zero_protocol::workspace::{
    WorkspaceSelectionMode, WorkspaceSelectionPolicy, WorkspaceSelectionReceipt,
};
use zero_protocol::{
    Command, OperationStatus, Reply, SnapshotPin,
    agent::AgentStatus,
    review::{ReviewCloseReason, ReviewReport, ReviewSnapshot},
};
mod acquisition;
mod repair;
mod reproduce;

#[derive(Debug, Args)]
#[command(args_conflicts_with_subcommands = true, subcommand_negates_reqs = true)]
pub struct ReviewArgs {
    /// Local source directory. Capture is limited to 4096 files and 64 MiB;
    /// preparation uses min(profile deadline, 60 s), before the run deadline.
    #[arg(required = true)]
    pub path: Option<String>,
    #[arg(long, required = true)]
    pub profile: Option<String>,
    #[arg(long)]
    pub command_id: Option<String>,
    /// Explicit canonical acquisition receipt; retained as host-selected provenance.
    #[arg(long)]
    pub acquisition_receipt: Option<PathBuf>,
    #[arg(long, value_enum, default_value = "terminal")]
    pub format: Format,
    #[command(subcommand)]
    pub command: Option<ReviewCommand>,
}
#[derive(Debug, Subcommand)]
pub enum ReviewCommand {
    /// Validate an exact private repair against the retained independent reproduction.
    Repair(repair::RepairArgs),
    /// Independently inspect retained repair evidence without ownership or a plan file.
    RepairReport {
        #[arg(
            long,
            required_unless_present = "command_id",
            conflicts_with = "command_id"
        )]
        repair: Option<String>,
        #[arg(long, required_unless_present = "repair", conflicts_with = "repair")]
        command_id: Option<String>,
        #[arg(long, value_enum, default_value = "json")]
        format: repair::Format,
    },
    /// Export an independently validated retained repair as unified patch bytes on stdout.
    RepairExport {
        #[arg(
            long,
            required_unless_present = "command_id",
            conflicts_with = "command_id"
        )]
        repair: Option<String>,
        #[arg(long, required_unless_present = "repair", conflicts_with = "repair")]
        command_id: Option<String>,
    },
    /// Execute a separately host-authorized frozen reproduction from retained source.
    Reproduce(reproduce::ReproduceArgs),
    /// Independently inspect retained reproduction evidence without ownership or a plan file.
    Reproduction {
        #[arg(
            long,
            required_unless_present = "command_id",
            conflicts_with = "command_id"
        )]
        reproduction: Option<String>,
        #[arg(
            long,
            required_unless_present = "reproduction",
            conflicts_with = "reproduction"
        )]
        command_id: Option<String>,
        #[arg(long, value_enum, default_value = "json")]
        format: reproduce::Format,
    },
    /// Inspect lifecycle and budget holds without source, configuration or ownership.
    Show {
        #[arg(
            long,
            required_unless_present = "command_id",
            conflicts_with = "command_id"
        )]
        review: Option<String>,
        #[arg(long, required_unless_present = "review", conflicts_with = "review")]
        command_id: Option<String>,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
    /// Render retained source claims, or an explicitly partial review report.
    Report {
        #[arg(
            long,
            required_unless_present = "command_id",
            conflicts_with = "command_id"
        )]
        review: Option<String>,
        #[arg(long, required_unless_present = "review", conflicts_with = "review")]
        command_id: Option<String>,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
}

pub async fn run(args: &crate::args::Args, options: &ReviewArgs) -> Result<u8, Box<dyn Error>> {
    if let Some(command) = &options.command {
        if let ReviewCommand::Reproduce(options) = command {
            return reproduce::run(args, options).await;
        }
        if let ReviewCommand::Repair(options) = command {
            return repair::run(args, options).await;
        }
        return readonly(&args.state, command).await;
    }
    let input_path = options
        .path
        .as_ref()
        .ok_or("Review source path is required")?
        .clone();
    let profile_name = options
        .profile
        .as_ref()
        .ok_or("Review profile is required")?
        .clone();
    let command_id = options
        .command_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if !crate::review_profiles::valid_name(&profile_name)
        || command_id.trim().is_empty()
        || command_id.len() > 256
        || command_id.contains('\0')
    {
        return Err("Invalid review profile name or command ID".into());
    }
    let acquisition_selector = options
        .acquisition_receipt
        .as_deref()
        .map(acquisition::selector)
        .transpose()?;
    // The retained caller identity precedes all current source/configuration reads.
    if args.state.is_file() {
        if let Ok(store) = zero_store::Store::open_read_only(&args.state) {
            if let Some(record) = store.review_by_command(&command_id)? {
                if record.input_path != input_path
                    || record.profile_name != profile_name
                    || record.acquisition_receipt.as_ref().map(|v| &v.input_path)
                        != acquisition_selector.as_ref()
                {
                    return Err(
                        "Review command identity conflicts with retained path, profile or acquisition receipt selector".into(),
                    );
                }
                drop(store);
                let state = args.state.clone();
                let id = record.id;
                let review = tokio::task::spawn_blocking(move || {
                    zero_engine::read_review_status(&state, &id)
                })
                .await??;
                let code = exit_code(&review);
                output_run(
                    &args.state,
                    &Reply::ReviewRun {
                        review,
                        duplicate: true,
                    },
                    options.format,
                )
                .await?;
                return Ok(code);
            }
        }
    }
    if args.http_profiles.is_some()
        || args.scan_profiles.is_some()
        || args.harness_config.is_some()
        || args.strategy_host.is_some()
    {
        return Err(
            "Local review does not accept HTTP, scan, plugin or strategy runtime configuration"
                .into(),
        );
    }
    let profiles = crate::review_profiles::load(
        args.review_profiles
            .as_deref()
            .ok_or("Local review requires --review-profiles")?,
    )
    .await?;
    let profile = profiles
        .iter()
        .find(|(name, _)| name == &profile_name)
        .map(|(_, profile)| profile)
        .ok_or("Unknown review profile")?;
    let deadline_ms = profile.deadline_ms.min(60_000);
    let selection_mode = profile.workspace_selection;
    let providers = match args.providers.as_deref() {
        Some(path) => crate::providers::load(path).await?,
        None => vec![],
    };
    let mut signals = Signals::new()?;
    let CapturedSource {
        snapshot,
        stage,
        receipt,
        acquisition_receipt,
    } = match capture(
        PathBuf::from(&input_path),
        args.state.clone(),
        selection_mode,
        acquisition_selector,
        deadline_ms,
        &mut signals,
    )
    .await?
    {
        Capture::Pinned(source) => *source,
        Capture::Interrupted(code) => return Ok(code),
    };
    let engine = Arc::new(zero_engine::Engine::open_with_backends(
        &args.state,
        args.docker_bin.clone(),
        args.smolvm_bin.clone(),
    )?);
    for (name, profile) in profiles {
        engine.configure_review(&name, profile)?;
    }
    for (name, client, rates) in providers {
        engine.configure_provider(&name, client, rates)?;
    }
    if let Some(model) = &args.hosted_model {
        crate::hosted_provider::configure(
            &engine,
            model,
            args.hosted_host.as_deref(),
            args.hosted_token_env
                .as_deref()
                .unwrap_or("0SEC_CLOUD_TOKEN"),
            args.hosted_timeout_ms.unwrap_or(300_000),
        )
        .await?;
    }
    let notice = format!(
        "Review command {}\n",
        crate::console::terminal_text(&command_id)
    );
    tokio::time::timeout(
        Duration::from_secs(1),
        tokio::io::stderr().write_all(notice.as_bytes()),
    )
    .await
    .map_err(|_| "Review notice deadline exceeded")??;
    let (reply, interrupted) = crate::scan::execute(
        engine,
        Command::RunReview {
            command_id,
            input_path,
            profile: profile_name,
            snapshot: Box::new(snapshot),
            workspace_selection: Some(receipt),
            acquisition_receipt: acquisition_receipt.map(Box::new),
        },
        signals,
    )
    .await?;
    // The engine independently stages every actor/sandbox source. This private
    // preflight copy was never guest-mounted and can go once the owner drains.
    drop(stage);
    let code = match &reply {
        Reply::ReviewRun { review, .. } => interrupted.unwrap_or_else(|| exit_code(review)),
        Reply::Error { .. } => {
            crate::write_json(&reply, false).await?;
            return Ok(interrupted.unwrap_or(2));
        }
        _ => return Err("Unexpected review reply".into()),
    };
    output_run(&args.state, &reply, options.format).await?;
    Ok(code)
}

/// Unlike executor stages, this frontend-only copy is never mounted in a guest.
/// Own it immediately after staging so cancellation, conversion errors and even
/// a discarded blocking-worker result remove the private directory.
struct PreflightStage(Option<zero_executor::StagedSnapshot>);
impl Drop for PreflightStage {
    fn drop(&mut self) {
        if let Some(stage) = self.0.take() {
            let _ = stage.remove();
        }
    }
}
struct CapturedSource {
    snapshot: SnapshotPin,
    stage: PreflightStage,
    receipt: WorkspaceSelectionReceipt,
    acquisition_receipt: Option<zero_protocol::source_acquisition::AcquisitionReceiptInput>,
}
enum Capture {
    Pinned(Box<CapturedSource>),
    Interrupted(u8),
}
async fn capture(
    path: PathBuf,
    state: PathBuf,
    mode: WorkspaceSelectionMode,
    acquisition_selector: Option<String>,
    deadline_ms: u64,
    signals: &mut Signals,
) -> Result<Capture, Box<dyn Error>> {
    let cancel = CancellationToken::new();
    let worker_cancel = cancel.clone();
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    let mut worker = tokio::task::spawn_blocking(move || {
        let check = || {
            if worker_cancel.is_cancelled() {
                Err("Review source preparation cancelled".into())
            } else if Instant::now() >= deadline {
                Err("Review source preparation deadline exceeded".into())
            } else {
                Ok(())
            }
        };
        check()?;
        let canonical = std::fs::canonicalize(&path)
            .map_err(|error| format!("Cannot resolve review source directory: {error}"))?;
        check()?;
        let acquisition_receipt = acquisition_selector
            .map(|selector| acquisition::load(selector, &canonical, &check))
            .transpose()?;
        let policy = workspace_policy(&canonical, &state, mode, &check)?;
        let (staged, snapshot, receipt) = zero_executor::capture_workspace(
            &canonical,
            &policy,
            zero_executor::SnapshotLimits {
                max_files: 4096,
                max_bytes: 64 * 1024 * 1024,
            },
            &check,
        )?;
        let stage = PreflightStage(Some(staged));
        if let Some(input) = &acquisition_receipt {
            input.validate_capture(&snapshot, &receipt.original_root)?;
            acquisition::validate_modes(input, &snapshot, &check)?;
        }
        check()?;
        Ok::<_, String>(CapturedSource {
            snapshot,
            stage,
            receipt,
            acquisition_receipt,
        })
    });
    tokio::select! {
        result = &mut worker => Ok(Capture::Pinned(Box::new(result?.map_err(std::io::Error::other)?))),
        code = signals.wait() => {
            cancel.cancel();
            // Blocking filesystem work is cooperative; never detach it or open
            // the engine while capture may still read the authorized source.
            let _ = worker.await?;
            Ok(Capture::Interrupted(code))
        },
        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
            cancel.cancel();
            let _ = worker.await?;
            Err("Review source preparation deadline exceeded".into())
        }
    }
}
/// Resolve only existing ancestors; never create state during source selection.
/// If control paths would resolve inside the source, require their spelling and
/// ancestors to be unambiguous so exclusions describe the actual database.
fn workspace_policy(
    root: &Path,
    state: &Path,
    mode: WorkspaceSelectionMode,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<WorkspaceSelectionPolicy, String> {
    use std::path::Component;
    if mode == WorkspaceSelectionMode::FullTree {
        return Ok(WorkspaceSelectionPolicy::FullTree);
    }
    check()?;
    let absolute = if state.is_absolute() {
        state.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(state)
    };
    let mut ancestor = absolute.clone();
    let mut missing = Vec::new();
    loop {
        check()?;
        match std::fs::symlink_metadata(&ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .ok_or("Cannot resolve native state path")?
                        .to_owned(),
                );
                if !ancestor.pop() {
                    return Err("Cannot resolve native state path".into());
                }
            }
            Err(error) => return Err(format!("Cannot inspect native state path: {error}")),
        }
    }
    let mut resolved = std::fs::canonicalize(&ancestor)
        .map_err(|error| format!("Cannot resolve native state path: {error}"))?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    check()?;
    let Ok(relative) = resolved.strip_prefix(root) else {
        return Ok(WorkspaceSelectionPolicy::FullTree);
    };
    if relative.as_os_str().is_empty() {
        return Err("Native state must name a file, not the reviewed directory".into());
    }
    let mut prefix = PathBuf::new();
    for component in absolute.components() {
        check()?;
        if component == Component::ParentDir {
            return Err("In-source native state paths cannot contain parent traversal".into());
        }
        prefix.push(component);
        match std::fs::symlink_metadata(&prefix) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(
                    "In-source native state paths cannot use symlinked files or ancestors".into(),
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("Cannot inspect native state path: {error}")),
        }
    }
    let relative = relative.to_str().ok_or("Native state path must be UTF-8")?;
    if relative
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("In-source native state path must be canonical".into());
    }
    Ok(WorkspaceSelectionPolicy::ExcludeNativeState {
        state_relative_path: relative.into(),
    })
}
fn exit_code(review: &ReviewSnapshot) -> u8 {
    if review.close_reason == Some(ReviewCloseReason::Cancelled) {
        return 130;
    }
    if review.controller_status == OperationStatus::Succeeded
        && review.root_status == OperationStatus::Succeeded
        && review.close_reason.is_none()
        && review.budget.reserved == 0
        && review.agent_result.as_ref().is_some_and(|r| {
            r.status == AgentStatus::Completed
                && r.source_review.as_ref().is_some_and(|s| s.review.is_some())
        })
    {
        let high = review
            .agent_result
            .as_ref()
            .and_then(|r| r.source_review.as_ref())
            .and_then(|s| s.review.as_ref())
            .is_some_and(|r| {
                r.hypotheses.iter().any(|h| {
                    matches!(
                        h.claim.claimed_severity,
                        zero_protocol::source::ClaimedSeverity::High
                            | zero_protocol::source::ClaimedSeverity::Critical
                    )
                })
            });
        u8::from(high)
    } else {
        2
    }
}
async fn readonly(path: &Path, command: &ReviewCommand) -> Result<u8, Box<dyn Error>> {
    let state = path.to_owned();
    match command {
        ReviewCommand::Repair(_) => {
            return Err("Repair requires the owned execution route".into());
        }
        ReviewCommand::RepairReport {
            repair,
            command_id,
            format,
        } => {
            return repair::inspect(&state, repair.as_deref(), command_id.as_deref(), *format)
                .await;
        }
        ReviewCommand::RepairExport { repair, command_id } => {
            return repair::export(&state, repair.as_deref(), command_id.as_deref()).await;
        }
        ReviewCommand::Reproduce(_) => {
            return Err("Reproduction requires the owned execution route".into());
        }
        ReviewCommand::Reproduction {
            reproduction,
            command_id,
            format,
        } => {
            return reproduce::inspect(
                &state,
                reproduction.as_deref(),
                command_id.as_deref(),
                *format,
            )
            .await;
        }
        ReviewCommand::Show {
            review,
            command_id,
            format,
        } => {
            let id = resolve_id(&state, review.as_deref(), command_id.as_deref())?;
            let review =
                tokio::task::spawn_blocking(move || zero_engine::read_review_status(&state, &id))
                    .await??;
            if matches!(format, Format::Json) {
                crate::write_json(&Reply::ReviewStatus { review }, false).await?;
            } else {
                output_text(&snapshot_text(&review), *format).await?;
            }
        }
        ReviewCommand::Report {
            review,
            command_id,
            format,
        } => {
            let id = resolve_id(&state, review.as_deref(), command_id.as_deref())?;
            let report =
                tokio::task::spawn_blocking(move || zero_engine::read_review_report(&state, &id))
                    .await??;
            output_report(&report, *format).await?;
        }
    }
    Ok(0)
}
fn resolve_id(
    state: &Path,
    review: Option<&str>,
    command: Option<&str>,
) -> Result<String, Box<dyn Error>> {
    match (review, command) {
        (Some(id), None) => Ok(id.to_owned()),
        (None, Some(command)) => zero_store::Store::open_read_only(state)?
            .review_by_command(command)?
            .map(|record| record.id)
            .ok_or_else(|| "Review command not found".into()),
        _ => Err("Exactly one review ID or command ID is required".into()),
    }
}
async fn output_run(path: &Path, reply: &Reply, format: Format) -> Result<(), Box<dyn Error>> {
    if matches!(format, Format::Json) {
        return crate::write_json(reply, false).await;
    }
    let Reply::ReviewRun { review, .. } = reply else {
        return Err("Unexpected review output".into());
    };
    let state = path.to_owned();
    let id = review.review.id.clone();
    let report =
        tokio::task::spawn_blocking(move || zero_engine::read_review_report(&state, &id)).await??;
    output_report(&report, format).await
}
fn snapshot_text(s: &ReviewSnapshot) -> String {
    let units = match s.currency {
        zero_protocol::scan::ScanCurrency::Usd => "micro-USD",
        zero_protocol::scan::ScanCurrency::Units => "units",
    };
    let scope = match &s.review.workspace_selection {
        Some(receipt) => format!(
            "Workspace root: {}\nSelection policy: {}\nConfigured exclusion rules (including absent paths): {}\nSelected source: {} files, {} bytes\n",
            receipt.original_root,
            match receipt.policy {
                WorkspaceSelectionPolicy::FullTree => "full tree",
                WorkspaceSelectionPolicy::ExcludeNativeState { .. } =>
                    "exclude configured native state files",
            },
            if receipt.exclusions.is_empty() {
                "none (full tree)".into()
            } else {
                receipt.exclusions.join(", ")
            },
            receipt.file_count,
            receipt.bytes
        ),
        None => "Snapshot capture without a workspace selection receipt; original workspace scope not recorded.\n".into(),
    };
    crate::console::terminal_text(&format!(
        "{scope}Local source review {}\nController {:?}; actor {:?}; host stop {:?}\nSource {}\nSnapshot {}\nSession {}; root {}\nObserved at {} ms, journal sequence {}\nModel budget: {} charged, {} held, {} limit ({}; host-declared rates)\nAgent result: {}\nAll hypotheses remain unverified. Security conclusion: not established. Empty or partial results do not establish safety.\n",
        s.review.id,
        s.controller_status,
        s.root_status,
        s.close_reason,
        s.review.input_path,
        s.review.snapshot_sha256,
        s.review.session_id,
        s.review.root_operation_id,
        s.observed_at_ms,
        s.observed_sequence,
        s.budget.charged,
        s.budget.reserved,
        s.budget.limit,
        units,
        s.agent_result
            .as_ref()
            .map(|r| format!("{:?}", r.status))
            .unwrap_or_else(|| "no retained terminal result".into())
    ))
}
async fn output_report(report: &ReviewReport, format: Format) -> Result<(), Box<dyn Error>> {
    if matches!(format, Format::Json) {
        return crate::write_json(
            &Reply::ReviewReport {
                report: report.clone(),
            },
            false,
        )
        .await;
    }
    let header = snapshot_text(&report.review);
    let Some(source) = &report.source else {
        return output_text(&format!("{header}No retained structured source submission; review is partial or stopped without submission.\n"), format).await;
    };
    let rendered = zero_report::render_source_report(
        source,
        match format {
            Format::Html => zero_report::SourceReportFormat::Html,
            _ => zero_report::SourceReportFormat::Markdown,
        },
    )?;
    let output = match format {
        Format::Html => rendered.replacen(
            "<body>",
            &format!("<body><pre>{}</pre>", escape_html(&header)),
            1,
        ),
        Format::Markdown => format!("# Local source review\n\n{}\n{rendered}", indent(&header)),
        _ => crate::console::terminal_text(&format!("{header}\n{rendered}")),
    };
    write_output(&output).await
}
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn indent(s: &str) -> String {
    s.lines().map(|line| format!("    {line}\n")).collect()
}
async fn output_text(text: &str, format: Format) -> Result<(), Box<dyn Error>> {
    let clean = crate::console::terminal_text(text);
    let output = match format {
        Format::Html => format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'\"><title>Local source review</title></head><body><pre>{}</pre></body></html>\n",
            escape_html(&clean)
        ),
        Format::Markdown => format!("# Local source review\n\n{}", indent(&clean)),
        _ => clean,
    };
    write_output(&output).await
}
async fn write_output(text: &str) -> Result<(), Box<dyn Error>> {
    if text.len() > 32 * 1024 * 1024 {
        return Err("Review display exceeds 32 MiB".into());
    }
    let mut out = tokio::io::stdout();
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(5), async { out.write_all(text.as_bytes()).await?; out.flush().await }) => result.map_err(|_| "Review output deadline exceeded")??,
        _ = crate::server::shutdown_signal() => return Err("Review output interrupted".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    #[test]
    fn review_requires_source_and_profile_and_inspection_requires_one_identity() {
        for argv in [
            vec!["native", "review"],
            vec!["native", "review", "/tmp/source"],
            vec!["native", "review", "--profile", "p"],
            vec!["native", "review", "show"],
            vec![
                "native",
                "review",
                "show",
                "--review",
                "r",
                "--command-id",
                "c",
            ],
            vec![
                "native",
                "review",
                "report",
                "--review",
                "r",
                "--profile",
                "p",
            ],
            vec![
                "native",
                "review",
                "/tmp/source",
                "--profile",
                "p",
                "--target",
                "https://example.test",
            ],
        ] {
            assert!(
                crate::args::Args::try_parse_from(&argv).is_err(),
                "{argv:?}"
            );
        }
        for argv in [
            vec!["native", "review", "/tmp/source", "--profile", "p"],
            vec!["native", "review", "show", "--review", "r"],
            vec!["native", "review", "show", "--command-id", "c"],
            vec![
                "native",
                "review",
                "report",
                "--command-id",
                "c",
                "--format",
                "html",
            ],
        ] {
            assert!(crate::args::Args::try_parse_from(&argv).is_ok(), "{argv:?}");
        }
    }
    #[test]
    fn exit_status_never_treats_high_claim_partial_or_held_result_as_clean_completion() {
        let mut snapshot: ReviewSnapshot = serde_json::from_value(serde_json::json!({
            "review":{"schema_version":1,"id":"r","command_id":"c","session_id":"s","controller_operation_id":"controller","root_operation_id":"root","input_path":"/source","canonical_path":"/source","snapshot_sha256":"pin","profile_name":"p","intent_sha256":"intent","profile_sha256":"profile","created_at_ms":1,"deadline_at_ms":2,"sequence":1},
            "agent_result":{"status":"completed","text":"","turns":1,"tool_calls":1,"error":null,
                "source_review":{"review":{"version":1,"bundle_sha256":"bundle","snapshot_sha256":"pin","request_sha256":"request","completion_sha256":"response","model":"m","provider_response_id":null,"submission_call_id":"call","hypotheses":[{"id":"h","state":"unverified","claim":{"title":"Claim","claimed_severity":"high","explanation":"Unverified","citations":[]}}]},"artifacts":{},"inference_operation":null,"external_effects_started":true,"error":null}},
            "controller_status":"succeeded","root_status":"succeeded","close_reason":null,
            "budget":{"limit":100,"charged":2,"reserved":0},"currency":"units","observed_sequence":5,"observed_at_ms":2
        })).unwrap();
        assert_eq!(exit_code(&snapshot), 1);
        snapshot.budget.reserved = 10;
        assert_eq!(exit_code(&snapshot), 2);
        snapshot.budget.reserved = 0;
        snapshot.controller_status = OperationStatus::Unknown;
        assert_eq!(exit_code(&snapshot), 2);
        snapshot.controller_status = OperationStatus::Succeeded;
        snapshot
            .agent_result
            .as_mut()
            .unwrap()
            .source_review
            .as_mut()
            .unwrap()
            .review
            .as_mut()
            .unwrap()
            .hypotheses
            .clear();
        assert_eq!(exit_code(&snapshot), 0);
        snapshot.agent_result.as_mut().unwrap().source_review = None;
        assert_eq!(exit_code(&snapshot), 2);
        snapshot.close_reason = Some(ReviewCloseReason::Cancelled);
        assert_eq!(exit_code(&snapshot), 130);
    }
    #[test]
    fn workspace_policy_resolves_actual_state_without_creating_it_and_rejects_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("source");
        std::fs::create_dir(&root).unwrap();
        let mode = WorkspaceSelectionMode::ExcludeNativeState;
        let check = || Ok(());
        let state = root.join("private/native.sqlite");
        assert!(
            matches!(workspace_policy(&root, &state, mode, &check).unwrap(),
            WorkspaceSelectionPolicy::ExcludeNativeState { state_relative_path } if state_relative_path == "private/native.sqlite")
        );
        assert!(
            !root.join("private").exists(),
            "selection must not create state ancestors"
        );
        assert!(matches!(
            workspace_policy(&root, &dir.path().join("external.db"), mode, &check).unwrap(),
            WorkspaceSelectionPolicy::FullTree
        ));
        assert!(matches!(
            workspace_policy(&root, &state, WorkspaceSelectionMode::FullTree, &check).unwrap(),
            WorkspaceSelectionPolicy::FullTree
        ));
        std::fs::create_dir(root.join("private")).unwrap();
        assert!(workspace_policy(&root, &root.join("private/../native.db"), mode, &check).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("private"), root.join("alias")).unwrap();
            assert!(workspace_policy(&root, &root.join("alias/native.db"), mode, &check).is_err());
            std::fs::write(root.join("private/existing.db"), b"not opened").unwrap();
            std::os::unix::fs::symlink(root.join("private/existing.db"), root.join("alias.db"))
                .unwrap();
            assert!(workspace_policy(&root, &root.join("alias.db"), mode, &check).is_err());
        }
    }
    #[tokio::test]
    async fn capture_enforces_deadline_and_byte_bounds_and_preserves_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.rs");
        std::fs::write(&path, b"fn main() {}\n").unwrap();
        let mut signals = Signals::new().unwrap();
        assert!(
            capture(
                dir.path().to_owned(),
                dir.path().join(".0sec/state.db"),
                WorkspaceSelectionMode::ExcludeNativeState,
                None,
                0,
                &mut signals
            )
            .await
            .is_err()
        );
        let Capture::Pinned(pin) = capture(
            dir.path().to_owned(),
            dir.path().join(".0sec/state.db"),
            WorkspaceSelectionMode::ExcludeNativeState,
            None,
            1000,
            &mut signals,
        )
        .await
        .unwrap() else {
            panic!("unexpected signal")
        };
        assert_eq!(pin.snapshot.files.len(), 1);
        let private_root = PathBuf::from(&pin.snapshot.root);
        assert!(!private_root.starts_with(dir.path()));
        assert_eq!(
            std::fs::read(private_root.join("app.rs")).unwrap(),
            b"fn main() {}\n"
        );
        // Creating state under the user's original root cannot invalidate the
        // captured private snapshot or mutate the original application source.
        std::fs::create_dir(dir.path().join(".0sec")).unwrap();
        std::fs::write(dir.path().join(".0sec/state.db"), b"new state").unwrap();
        zero_executor::verify_snapshot(&pin.snapshot, &|| Ok(())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"fn main() {}\n");
        drop(pin);
        assert!(!private_root.exists());
        let oversized = std::fs::File::create(dir.path().join("oversized")).unwrap();
        oversized.set_len(64 * 1024 * 1024 + 1).unwrap();
        assert!(
            capture(
                dir.path().to_owned(),
                dir.path().join(".0sec/state.db"),
                WorkspaceSelectionMode::ExcludeNativeState,
                None,
                1000,
                &mut signals
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"fn main() {}\n");
    }
}
