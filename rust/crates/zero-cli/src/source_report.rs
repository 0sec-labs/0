//! A retained source review is not a legacy scan report or a safety verdict.
use clap::ValueEnum;
use std::{error::Error, path::Path, time::Duration};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum SourceReportFormat {
    Json,
    Markdown,
    Html,
}

pub async fn run(
    state: &Path,
    session: &str,
    operation: &str,
    reproductions: &[String],
    repairs: &[String],
    format: SourceReportFormat,
) -> Result<bool, Box<dyn Error>> {
    let state = state.to_owned();
    let session = session.to_owned();
    let operation = operation.to_owned();
    let reproductions = reproductions.to_owned();
    let repairs = repairs.to_owned();
    let format = match format {
        SourceReportFormat::Json => zero_report::SourceReportFormat::Json,
        SourceReportFormat::Markdown => zero_report::SourceReportFormat::Markdown,
        SourceReportFormat::Html => zero_report::SourceReportFormat::Html,
    };
    let signal = crate::server::shutdown_signal();
    tokio::pin!(signal);
    let inspect = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let report = zero_engine::read_source_workflow_report(
            &state,
            &session,
            &operation,
            &reproductions,
            &repairs,
        )
        .map_err(|e| e.to_string())?;
        zero_report::render_source_report(&report, format).map_err(|e| e.to_string())
    });
    let mut rendered = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(5), inspect) =>
            result.map_err(|_| "Source report read deadline exceeded")??
                .map_err(std::io::Error::other)?,
        _ = &mut signal => return Ok(false),
    };
    rendered.push('\n');
    let write = async {
        let mut stdout = tokio::io::stdout();
        stdout.write_all(rendered.as_bytes()).await?;
        stdout.flush().await
    };
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(5), write) =>
            result.map_err(|_| "Source report output deadline exceeded")??,
        _ = &mut signal => return Ok(false),
    };
    Ok(true)
}
