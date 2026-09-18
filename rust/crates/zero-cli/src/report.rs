//! Pure local rendering; no scan, engine state or upload side effects.
use clap::ValueEnum;
use std::{error::Error, path::Path, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zero_report::{MAX_REPORT_BYTES, Report};
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ReportFormat {
    Json,
    Sarif,
}

pub async fn run(path: &Path, format: ReportFormat) -> Result<bool, Box<dyn Error>> {
    let signal = crate::server::shutdown_signal();
    tokio::pin!(signal);
    let read = async {
        let file = tokio::fs::File::open(path).await?;
        let mut bytes = Vec::new();
        file.take((MAX_REPORT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        Ok::<_, std::io::Error>(bytes)
    };
    let bytes = tokio::select! {
        bytes=tokio::time::timeout(Duration::from_secs(5),read)=>bytes.map_err(|_|"Report input deadline exceeded")??,
        _=&mut signal=>return Ok(false),
    };
    let report = Report::parse(&bytes)?;
    let mut rendered = match format {
        ReportFormat::Json => report.json()?,
        ReportFormat::Sarif => report.sarif(env!("CARGO_PKG_VERSION"))?,
    };
    rendered.push('\n');
    let write = async {
        let mut stdout = tokio::io::stdout();
        stdout.write_all(rendered.as_bytes()).await?;
        stdout.flush().await
    };
    tokio::select! {
        result=tokio::time::timeout(Duration::from_secs(5),write)=>result.map_err(|_|"Report output deadline exceeded")??,
        _=&mut signal=>return Ok(false),
    };
    Ok(true)
}
