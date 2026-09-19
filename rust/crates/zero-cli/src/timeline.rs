//! Ordered native audit journal exports. Sequence order is not an execution replay.
use clap::{Args, ValueEnum};
use serde::Serialize;
use std::{error::Error, path::Path};
use zero_protocol::SessionEvent;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Format {
    Terminal,
    Json,
    Markdown,
    Csv,
}

#[derive(Debug, Args)]
pub struct TimelineArgs {
    /// Exact native HTTP scan ID shown by history; resolves its retained session.
    #[arg(required_unless_present = "session", conflicts_with = "session")]
    scan: Option<String>,
    /// Inspect any native session, including local source reviews.
    #[arg(long, required_unless_present = "scan", conflicts_with = "scan")]
    session: Option<String>,
    /// Resume strictly after the last returned event sequence.
    #[arg(long, default_value_t = 0)]
    after_sequence: u64,
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
    limit: u32,
    #[arg(long, value_enum, default_value = "markdown")]
    format: Format,
}

#[derive(Serialize)]
struct Page {
    schema_version: u32,
    session_id: String,
    scan_id: Option<String>,
    after_sequence: u64,
    /// Every nonempty page has a continuation cursor. Empty means exhausted
    /// at this read; a running owner may append events later.
    next_after_sequence: Option<u64>,
    events: Vec<SessionEvent>,
}

pub async fn run(state: &Path, options: &TimelineArgs) -> Result<bool, Box<dyn Error>> {
    let path = state.to_owned();
    let scan = options.scan.clone();
    let session = options.session.clone();
    for id in scan.iter().chain(session.iter()) {
        if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
            return Err("Timeline requires a bounded exact native identity".into());
        }
    }
    let after = options.after_sequence;
    let limit = options.limit;
    let page = crate::history::inspect(move || {
        let store = zero_store::Store::open_read_only(path)?;
        let session = match (&scan, session) {
            (Some(id), None) => store.scan_snapshot(id)?.scan.session_id,
            (None, Some(id)) => id,
            _ => {
                return Err(zero_engine::EngineError::State(
                    "Select one scan or session".into(),
                ));
            }
        };
        store.get_session(&session)?;
        let events = store.events_bounded(&session, after, limit, &mut (4 * 1024 * 1024))?;
        Ok(Page {
            schema_version: 1,
            session_id: session,
            scan_id: scan,
            after_sequence: after,
            next_after_sequence: events.last().map(|event| event.sequence),
            events,
        })
    })
    .await?;
    match options.format {
        Format::Json => crate::write_json(&page, false).await?,
        format => crate::history::write_text(&render(&page, format)).await?,
    }
    Ok(true)
}

fn summary(event: &SessionEvent) -> String {
    let mut parts = Vec::new();
    for field in [
        "command_id",
        "kind",
        "name",
        "status",
        "charged",
        "reserved",
        "amount",
        "reason",
    ] {
        if let Some(value) = event
            .payload
            .get(field)
            .filter(|value| !value.is_null() && !value.is_object() && !value.is_array())
        {
            parts.push(format!(
                "{field}={}",
                crate::history::display(
                    value
                        .as_str()
                        .map_or_else(|| value.to_string(), str::to_owned)
                        .as_str(),
                    160
                )
            ));
        }
    }
    crate::history::display(&parts.join("; "), 400)
}

fn markdown(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('`', "\\`")
        .replace('[', "\\[")
        .replace(']', "\\]")
}
fn csv(value: &str) -> String {
    // Spreadsheet import must not turn retained labels into formulas.
    let prefix = if value.trim_start().starts_with(['=', '+', '-', '@']) {
        "'"
    } else {
        ""
    };
    format!("\"{prefix}{}\"", value.replace('"', "\"\""))
}
fn render(page: &Page, format: Format) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    if matches!(format, Format::Csv) {
        out.push_str("session_id,sequence,event_kind,operation_id,summary\n");
    } else {
        let _ = writeln!(
            out,
            "Native journal for session {}\nOrdered by durable sequence; event timestamps and ATT&CK/ATLAS tags are not recorded here. This export never replays effects. Human summaries omit payload fields; JSON retains the complete page.\n",
            markdown(&crate::history::display(&page.session_id, 256))
        );
        if matches!(format, Format::Markdown) {
            out.push_str("| Sequence | Event | Operation | Summary |\n| --- | --- | --- | --- |\n");
        }
    }
    for event in &page.events {
        let kind = crate::history::display(&event.kind, 128);
        let operation = crate::history::display(
            if event.kind == "command_admitted" {
                event.payload["id"].as_str().unwrap_or("")
            } else {
                event.payload["operation_id"].as_str().unwrap_or("")
            },
            256,
        );
        let details = summary(event);
        match format {
            Format::Csv => {
                let _ = writeln!(
                    out,
                    "{},{},{},{},{}",
                    csv(&page.session_id),
                    event.sequence,
                    csv(&kind),
                    csv(&operation),
                    csv(&details)
                );
            }
            Format::Markdown => {
                let _ = writeln!(
                    out,
                    "| {} | {} | {} | {} |",
                    event.sequence,
                    markdown(&kind),
                    markdown(&operation),
                    markdown(&details)
                );
            }
            _ => {
                let _ = writeln!(
                    out,
                    "{}  {}  {}  {}",
                    event.sequence, kind, operation, details
                );
            }
        }
    }
    if !matches!(format, Format::Csv) {
        match page.next_after_sequence {
            Some(cursor) => {
                let _ = writeln!(
                    out,
                    "\nNext page: timeline --session {} --after-sequence {cursor}\nContinue until an empty page; later events may arrive while a session is active.",
                    crate::history::display(&page.session_id, 256)
                );
            }
            None => out.push_str("\nNo further events at this read.\n"),
        }
    }
    out
}
