//! Read-only native scan discovery. No owner claim, migration or ambient config.
use clap::{Args, ValueEnum};
use std::{error::Error, path::Path, time::Duration};
use tokio::io::AsyncWriteExt;
use zero_protocol::{Reply, scan::ScanPage};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Format {
    Terminal,
    Json,
}

#[derive(Debug, Args)]
pub struct HistoryArgs {
    /// Maximum native HTTP scans in this page (newest admissions first).
    #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u32).range(1..=32))]
    limit: u32,
    /// Continue strictly before the returned admission cursor.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
    before_sequence: Option<u64>,
    #[arg(long, value_enum, default_value = "terminal")]
    format: Format,
}

pub async fn run(state: &Path, options: &HistoryArgs) -> Result<bool, Box<dyn Error>> {
    let state = state.to_owned();
    let before = options.before_sequence;
    let limit = options.limit;
    let page = inspect(move || zero_engine::read_scans(&state, before, limit)).await?;
    match options.format {
        Format::Json => crate::write_json(&Reply::Scans { page }, false).await?,
        Format::Terminal => write_text(&render(&page)).await?,
    }
    Ok(true)
}

fn render(page: &ScanPage) -> String {
    use std::fmt::Write;
    let mut out = String::from(
        "Native HTTP scan history (standalone and managed)\nClaims remain unverified; empty results do not establish safety.\nTimes are Unix milliseconds. Statuses describe retained work, not a security verdict.\n",
    );
    if page.scans.is_empty() {
        out.push_str("No native HTTP scans in this page.\n");
    }
    for snapshot in &page.scans {
        let scan = &snapshot.scan;
        let _ = writeln!(
            out,
            "\n{}  {}\n  session={} command={} profile={}\n  created={} observed={} journal_sequence={}\n  controller={:?} root={:?} phase={:?} close={:?}",
            scan.id,
            display(&scan.target, 4096),
            scan.session_id,
            display(&scan.command_id, 256),
            display(&scan.profile_name, 128),
            scan.created_at_ms,
            snapshot.observed_at_ms,
            snapshot.observed_sequence,
            snapshot.controller_status,
            snapshot.root_status,
            snapshot.phase,
            snapshot.close_reason,
        );
        let _ = writeln!(
            out,
            "  model {}: charged={} held={} limit={}\n  HTTP: requests={} request_bytes={} response_charged_bytes={} response_held_bytes={}",
            match snapshot.currency {
                zero_protocol::scan::ScanCurrency::Usd => "micro-USD",
                zero_protocol::scan::ScanCurrency::Units => "units",
            },
            snapshot.budget.charged,
            snapshot.budget.reserved,
            snapshot.budget.limit,
            snapshot.http_usage.requests,
            snapshot.http_usage.request_body_bytes,
            snapshot.http_usage.response_charged_bytes,
            snapshot.http_usage.response_reserved_bytes,
        );
        if let Some(result) = &snapshot.result {
            let _ = writeln!(
                out,
                "  outcome={:?} completeness={:?} unverified_claims={} publication={:?}",
                result.outcome.stop_reason,
                result.outcome.completeness,
                result.outcome.summary.submitted_hypotheses,
                result.publication,
            );
        } else {
            out.push_str("  terminal result unavailable; claim count unavailable\n");
        }
        let _ = writeln!(
            out,
            "  inspect: scan show --scan {} | timeline {}",
            scan.id, scan.id
        );
    }
    if let Some(cursor) = page.next_before_sequence {
        let _ = writeln!(out, "\nNext page: history --before-sequence {cursor}");
    } else {
        out.push_str("\nEnd of retained scan history at this read.\n");
    }
    crate::console::terminal_text(&out)
}

/// Keep control sequences and unbounded untrusted labels out of human exports.
pub(crate) fn display(value: &str, limit: usize) -> String {
    let safe = crate::console::terminal_text(value).replace(['\n', '\r', '\t'], " ");
    let mut result: String = safe.chars().take(limit).collect();
    if safe.chars().count() > limit {
        result.push_str("… [truncated]");
    }
    result
}

/// Read work is bounded by the underlying page API and always drained on signal.
pub(crate) async fn inspect<T: Send + 'static>(
    read: impl FnOnce() -> Result<T, zero_engine::EngineError> + Send + 'static,
) -> Result<T, Box<dyn Error>> {
    let mut task = tokio::task::spawn_blocking(read);
    tokio::select! {
        result = &mut task => Ok(result??),
        _ = crate::server::shutdown_signal() => {
            let _ = task.await;
            Err("Native history read interrupted".into())
        },
        _ = tokio::time::sleep(Duration::from_secs(5)) => {
            let _ = task.await;
            Err("Native history read deadline exceeded".into())
        }
    }
}

pub(crate) async fn write_text(text: &str) -> Result<(), Box<dyn Error>> {
    let mut stdout = tokio::io::stdout();
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(5), async {
            stdout.write_all(text.as_bytes()).await?;
            stdout.flush().await
        }) => result.map_err(|_| "History output deadline exceeded")??,
        _ = crate::server::shutdown_signal() => return Err("History output interrupted".into()),
    }
    Ok(())
}
