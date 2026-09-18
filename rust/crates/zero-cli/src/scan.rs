//! Complete standalone scan invocation and inert retained inspection, independent of legacy cloud env.
use clap::{Args, Subcommand, ValueEnum};
use std::{error::Error, path::Path, sync::Arc, time::Duration};
use tokio::io::AsyncWriteExt;
use zero_protocol::{Command, Reply, scan::*};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Format {
    Terminal,
    Json,
    #[value(alias = "md")]
    Markdown,
    Html,
}
#[derive(Debug, Args)]
#[command(args_conflicts_with_subcommands = true, subcommand_negates_reqs = true)]
pub struct ScanArgs {
    #[arg(long, required = true)]
    pub target: Option<String>,
    #[arg(long, required = true)]
    pub profile: Option<String>,
    #[arg(long)]
    pub command_id: Option<String>,
    #[arg(long, value_enum, default_value = "terminal")]
    pub format: Format,
    #[command(subcommand)]
    pub command: Option<ScanCommand>,
}
#[derive(Debug, Subcommand)]
pub enum ScanCommand {
    /// Inspect a retained scan and authoritative charges/holds without taking ownership.
    Show {
        #[arg(long)]
        scan: String,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
    /// List bounded scan snapshots; follow the actual cursor even after an empty page.
    List {
        #[arg(long)]
        before_sequence: Option<u64>,
        #[arg(long,default_value_t=20,value_parser=clap::value_parser!(u32).range(1..=32))]
        limit: u32,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
    /// Read retained or explicitly partial recovery report; never reruns investigation.
    Report {
        #[arg(long)]
        scan: String,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
}

pub async fn run(args: &crate::args::Args, options: &ScanArgs) -> Result<u8, Box<dyn Error>> {
    if let Some(command) = &options.command {
        return readonly(&args.state, command).await;
    }
    let target = options
        .target
        .as_ref()
        .ok_or("Scan target is required")?
        .clone();
    let profile = options
        .profile
        .as_ref()
        .ok_or("Scan profile is required")?
        .clone();
    if !crate::scan_profiles::valid_name(&profile) {
        return Err("Invalid scan profile name".into());
    }
    if args.harness_config.is_some()
        || args.strategy_host.is_some()
        || args.docker_bin.is_some()
        || args.smolvm_bin.is_some()
    {
        return Err("Standalone HTTP scan does not accept sandbox, plugin or strategy runtime configuration".into());
    }
    let command_id = options
        .command_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if command_id.trim().is_empty() || command_id.len() > 256 || command_id.contains('\0') {
        return Err("Invalid scan command ID".into());
    }
    if args.state.is_file() {
        if let Ok(store) = zero_store::Store::open_read_only(&args.state) {
            if let Some(record) = store.scan_by_command(&command_id)? {
                if record.input_target != target || record.profile_name != profile {
                    return Err(
                        "Scan command identity conflicts with retained target or profile".into(),
                    );
                }
                drop(store);
                let path = args.state.clone();
                let id = record.id;
                let snapshot =
                    tokio::task::spawn_blocking(move || zero_engine::read_scan_status(&path, &id))
                        .await??;
                let code = exit_code(&snapshot);
                output_run(
                    &args.state,
                    &Reply::ScanRun {
                        scan: snapshot,
                        duplicate: true,
                    },
                    options.format,
                )
                .await?;
                return Ok(code);
            }
        }
    }
    validate_scan_target(&target)?;
    // Load/validate public configuration before opening state. Credentials stay in existing private clients.
    let scans = match args.scan_profiles.as_deref() {
        Some(p) => crate::scan_profiles::load(p).await?,
        None => vec![],
    };
    let http = match args.http_profiles.as_deref() {
        Some(p) => crate::http_profiles::load(p).await?,
        None => vec![],
    };
    let providers = match args.providers.as_deref() {
        Some(p) => crate::providers::load(p).await?,
        None => vec![],
    };
    let signals = Signals::new()?;
    let engine = Arc::new(zero_engine::Engine::open(&args.state, None)?);
    for (name, profile) in scans {
        engine.configure_scan(&name, profile)?;
    }
    for (name, client) in http {
        engine.configure_http(&name, client)?;
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
        "Scan command {}\n",
        crate::console::terminal_text(&command_id)
    );
    tokio::time::timeout(
        Duration::from_secs(1),
        tokio::io::stderr().write_all(notice.as_bytes()),
    )
    .await
    .map_err(|_| "Scan notice deadline exceeded")??;
    let (reply, interrupted) = execute(
        engine,
        Command::RunScan {
            command_id,
            target,
            profile,
        },
        signals,
    )
    .await?;
    let snapshot = match &reply {
        Reply::ScanRun { scan, .. } => scan,
        Reply::Error { .. } => {
            crate::write_json(&reply, false).await?;
            return Ok(interrupted.unwrap_or(2));
        }
        _ => return Err("Unexpected scan reply".into()),
    };
    let code = interrupted.unwrap_or_else(|| exit_code(snapshot));
    output_run(&args.state, &reply, options.format).await?;
    Ok(code)
}
/// Shared owned scan lifecycle. Both frontends wait for cleanup before publishing.
pub(crate) async fn execute(
    engine: Arc<zero_engine::Engine>,
    command: Command,
    mut signals: Signals,
) -> Result<(Reply, Option<u8>), Box<dyn Error>> {
    let (events, mut receiver) = tokio::sync::mpsc::channel(128);
    let drain = tokio::spawn(async move { while receiver.recv().await.is_some() {} });
    let worker = engine.clone();
    let mut task = tokio::spawn(async move { worker.handle(command, events).await });
    let mut interrupted = None;
    let result = tokio::select! {
        result=&mut task=>result,
        code=signals.wait()=>{
            interrupted=Some(code);
            engine.shutdown().await?;
            task.await
        }
    };
    engine.shutdown().await?;
    drain.await?;
    Ok((result?, interrupted))
}
async fn output_run(path: &Path, reply: &Reply, format: Format) -> Result<(), Box<dyn Error>> {
    let Reply::ScanRun { scan, .. } = reply else {
        return Err("Unexpected scan output".into());
    };
    if matches!(format, Format::Json) {
        return crate::write_json(reply, false).await;
    }
    if scan.result.is_none() {
        return write_text(&snapshot_text(scan), format).await;
    }
    let state = path.to_owned();
    let id = scan.scan.id.clone();
    let report =
        tokio::task::spawn_blocking(move || zero_engine::read_scan_report(&state, &id)).await??;
    output_report(&report, format).await
}
fn currency(currency: ScanCurrency) -> &'static str {
    match currency {
        ScanCurrency::Units => "units",
        ScanCurrency::Usd => "micro-USD",
    }
}
async fn readonly(path: &Path, command: &ScanCommand) -> Result<u8, Box<dyn Error>> {
    let path = path.to_owned();
    match command {
        ScanCommand::Show { scan, format } => {
            let id = scan.clone();
            let snapshot =
                tokio::task::spawn_blocking(move || zero_engine::read_scan_status(&path, &id))
                    .await??;
            if matches!(format, Format::Json) {
                crate::write_json(&Reply::ScanStatus { scan: snapshot }, false).await?;
            } else {
                write_text(&snapshot_text(&snapshot), *format).await?;
            }
        }
        ScanCommand::List {
            before_sequence,
            limit,
            format,
        } => {
            let before = *before_sequence;
            let limit = *limit;
            let page =
                tokio::task::spawn_blocking(move || zero_engine::read_scans(&path, before, limit))
                    .await??;
            if matches!(format, Format::Json) {
                crate::write_json(&Reply::Scans { page }, false).await?;
            } else {
                let mut text =
                    String::from("Native scoped HTTP scans; no security conclusion established.\n");
                for scan in &page.scans {
                    text.push_str(&snapshot_text(scan));
                }
                text.push_str(&format!(
                    "Next before sequence: {}\n",
                    page.next_before_sequence
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| "exhausted".into())
                ));
                write_text(&text, *format).await?;
            }
        }
        ScanCommand::Report { scan, format } => {
            let id = scan.clone();
            let report =
                tokio::task::spawn_blocking(move || zero_engine::read_scan_report(&path, &id))
                    .await??;
            output_report(&report, *format).await?;
        }
    }
    Ok(0) // A successful read does not reclassify its investigation.
}
pub(crate) fn exit_code(s: &ScanSnapshot) -> u8 {
    let Some(result) = &s.result else { return 2 };
    let o = &result.outcome;
    if !matches!(result.publication, ScanPublication::Retained { .. }) {
        return 2;
    }
    match o.stop_reason {
        ScanStopReason::BudgetLimit => 4,
        ScanStopReason::Cancelled => 130,
        ScanStopReason::Submitted
            if o.completeness == ScanCompleteness::CompletedWorkflow
                && o.budget.reserved == 0
                && o.http_usage.response_reserved_bytes == 0
                && o.root_status == zero_protocol::OperationStatus::Succeeded
                && s.controller_status == zero_protocol::OperationStatus::Succeeded =>
        {
            if o.summary.claimed_high > 0 || o.summary.claimed_critical > 0 {
                1
            } else {
                0
            }
        }
        _ => 2,
    }
}
fn snapshot_text(s: &ScanSnapshot) -> String {
    let mut out = format!(
        "Scan {} — {:?}; controller {:?}, actor {:?}\nTarget {}\nObserved at {} ms, journal sequence {}\nModel budget: {} charged, {} held, {} limit ({}; host-declared rates)\nSession {}; root {}\n",
        s.scan.id,
        s.phase,
        s.controller_status,
        s.root_status,
        s.scan.target,
        s.observed_at_ms,
        s.observed_sequence,
        s.budget.charged,
        s.budget.reserved,
        s.budget.limit,
        currency(s.currency),
        s.scan.session_id,
        s.scan.root_operation_id
    );
    out.push_str(&format!("HTTP: {} requests, {} request-body bytes, {} response bytes charged, {} response bytes held.\nHost stop intent: {:?}\n",s.http_usage.requests,s.http_usage.request_body_bytes,s.http_usage.response_charged_bytes,s.http_usage.response_reserved_bytes,s.close_reason));
    if let Some(r) = &s.result {
        out.push_str(&format!("Investigation: {:?} / {:?}; report publication: {:?}\nUnverified hypotheses: {}; claimed critical {}, high {}, medium {}, low {}, info {}\n",r.outcome.stop_reason,r.outcome.completeness,r.publication,r.outcome.summary.submitted_hypotheses,r.outcome.summary.claimed_critical,r.outcome.summary.claimed_high,r.outcome.summary.claimed_medium,r.outcome.summary.claimed_low,r.outcome.summary.claimed_info));
    } else {
        out.push_str(
            "No retained terminal scan result. Cancellation requests are not completion.\n",
        );
    }
    out.push_str("Security conclusion: not established. Empty hypotheses do not establish safety; operator triage and plan observations do not verify vulnerabilities.\n");
    crate::console::terminal_text(&out)
}
async fn output_report(report: &ScanReport, format: Format) -> Result<(), Box<dyn Error>> {
    if matches!(format, Format::Json) {
        return crate::write_json(
            &Reply::ScanReport {
                report: report.clone(),
            },
            false,
        )
        .await;
    }
    let mut text = format!(
        "Native scoped HTTP scan report — {:?}\nInvestigation {:?} / {:?}\nUnverified claims; security conclusion not established.\nScan {}; session {}; root {}\n{} charged, {} held ({}; host-declared rates).\nObservation cursor: {:?}\n",
        report.kind,
        report.outcome.stop_reason,
        report.outcome.completeness,
        report.scan.id,
        report.scan.session_id,
        report.scan.root_operation_id,
        report.outcome.budget.charged,
        report.outcome.budget.reserved,
        currency(report.outcome.currency),
        report.observations_next_after_sequence
    );
    let h = &report.outcome.http_usage;
    text.push_str(&format!("HTTP: {} requests, {} request-body bytes, {} response bytes charged, {} response bytes held.\nHost stop intent: {:?}\n",h.requests,h.request_body_bytes,h.response_charged_bytes,h.response_reserved_bytes,report.outcome.close_reason));
    if let Some(web) = &report.web {
        if matches!(format, Format::Html) {
            let html = zero_report::render_web_report(web, zero_report::WebReportFormat::Html)?;
            let header = format!(
                "<body><pre>{}</pre>",
                html_escape(&crate::console::terminal_text(&text))
            );
            return write_output(&html.replacen("<body>", &header, 1)).await;
        }
        if matches!(format, Format::Markdown) {
            let header = text
                .lines()
                .map(|line| format!("    {line}\n"))
                .collect::<String>();
            return write_output(&format!(
                "# Native scoped HTTP scan\n\n{header}\n{}",
                zero_report::render_web_report(web, zero_report::WebReportFormat::Markdown)?
            ))
            .await;
        }
        text.push_str(&zero_report::render_web_report(
            web,
            zero_report::WebReportFormat::Markdown,
        )?);
    } else {
        text.push_str(
            "Full report unavailable; inspect retained web evidence using session and root IDs.\n",
        );
    }
    write_text(&text, format).await
}
async fn write_text(text: &str, format: Format) -> Result<(), Box<dyn Error>> {
    let clean = crate::console::terminal_text(text);
    let output = match format {
        Format::Html => format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'\"><title>Native scan report</title></head><body><pre>{}</pre></body></html>\n",
            clean
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
        ),
        Format::Markdown => format!(
            "# Native scoped HTTP scan\n\n{}",
            clean
                .lines()
                .map(|l| format!("    {l}\n"))
                .collect::<String>()
        ),
        _ => clean,
    };
    write_output(&output).await
}
fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
async fn write_output(output: &str) -> Result<(), Box<dyn Error>> {
    if output.len() > 32 * 1024 * 1024 {
        return Err("Scan display exceeds 32 MiB".into());
    }
    let mut out = tokio::io::stdout();
    tokio::select! {
        result=tokio::time::timeout(Duration::from_secs(5),async{out.write_all(output.as_bytes()).await?;out.flush().await})=>result.map_err(|_|"Scan output deadline exceeded")??,
        _=crate::server::shutdown_signal()=>return Err("Scan output interrupted".into()),
    }
    Ok(())
}
pub(crate) struct Signals {
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
}
impl Signals {
    pub(crate) fn new() -> Result<Self, std::io::Error> {
        Ok(Self {
            #[cfg(unix)]
            interrupt: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?,
            #[cfg(unix)]
            terminate: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?,
        })
    }
    async fn wait(&mut self) -> u8 {
        #[cfg(unix)]
        {
            tokio::select! {_=self.interrupt.recv()=>130,_=self.terminate.recv()=>143}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
            130
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;
    #[test]
    fn scan_requires_explicit_target_profile_and_keeps_reads_independent() {
        for args in [
            vec!["native", "scan"],
            vec!["native", "scan", "--target", "https://example.test"],
            vec!["native", "scan", "--profile", "p"],
            vec![
                "native",
                "scan",
                "--target",
                "https://example.test",
                "--profile",
                "p",
                "--mode",
                "http_audit",
            ],
            vec![
                "native",
                "scan",
                "show",
                "--scan",
                "s",
                "--target",
                "https://example.test",
            ],
            vec!["native", "scan", "list", "--limit", "0"],
        ] {
            assert!(crate::args::Args::try_parse_from(args).is_err());
        }
        for args in [
            vec![
                "native",
                "scan",
                "--target",
                "https://example.test",
                "--profile",
                "p",
            ],
            vec!["native", "scan", "show", "--scan", "s"],
            vec!["native", "scan", "list"],
            vec!["native", "scan", "report", "--scan", "s", "--format", "md"],
        ] {
            assert!(crate::args::Args::try_parse_from(args).is_ok());
        }
    }
}
