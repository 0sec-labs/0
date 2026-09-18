//! The terminal frontend is a protocol client; only the child app-server owns state.
use crate::args::Args;
use std::{error::Error, io::IsTerminal, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Command,
};

pub async fn run(
    args: &Args,
    session: Option<String>,
    request: Option<&Path>,
    budget_limit: u64,
) -> Result<bool, Box<dyn Error>> {
    // Check before loading profiles, resolving hosted credentials or creating state.
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Err(
            "tui requires a terminal on stdin and stdout; use console or app-server for pipes"
                .into(),
        );
    }
    let profile = match request {
        Some(path) => Some(
            serde_json::from_slice(&crate::providers::read_bounded(path).await?)
                .map_err(|_| "Invalid TUI agent profile JSON")?,
        ),
        None => None,
    };
    // Register eagerly before the separately grouped child exists. A signal
    // received during startup must still close its pipes and await cleanup.
    let shutdown = shutdown_signal()?;
    let mut command = Command::new(std::env::current_exe()?);
    command.arg("--state").arg(&args.state);
    for (name, path) in [
        ("--providers", args.providers.as_deref()),
        ("--http-profiles", args.http_profiles.as_deref()),
        ("--harness-config", args.harness_config.as_deref()),
        ("--docker-bin", args.docker_bin.as_deref()),
        ("--smolvm-bin", args.smolvm_bin.as_deref()),
    ] {
        if let Some(path) = path {
            command.arg(name).arg(path);
        }
    }
    for (name, value) in [
        ("--hosted-model", args.hosted_model.as_deref()),
        ("--hosted-host", args.hosted_host.as_deref()),
        ("--hosted-token-env", args.hosted_token_env.as_deref()),
    ] {
        if let Some(value) = value {
            command.arg(name).arg(value);
        }
    }
    if let Some(timeout) = args.hosted_timeout_ms {
        command.arg("--hosted-timeout-ms").arg(timeout.to_string());
    }
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // UI signals close the owned pipe once; the server gets graceful EOF,
        // rather than a second terminal signal racing its shutdown protocol.
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn()?;
    let writer = child.stdin.take().ok_or("Missing app-server input pipe")?;
    let reader = child
        .stdout
        .take()
        .ok_or("Missing app-server output pipe")?;
    let mut errors = child
        .stderr
        .take()
        .ok_or("Missing app-server diagnostic pipe")?;
    let mut diagnostics = tokio::spawn(async move {
        let mut retained = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            let n = errors.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            let take = n.min((64 * 1024usize).saturating_sub(retained.len()));
            retained.extend_from_slice(&chunk[..take]);
            // Keep draining after the retention cap so stderr cannot block cleanup.
        }
        Ok::<_, std::io::Error>(retained)
    });
    // Keep ownership of the actual child stdout until process cleanup finishes.
    // Closing the UI must not turn queued final replies into a server BrokenPipe.
    let (ui_reader, ui_writer) = tokio::io::duplex(64 * 1024);
    let mut relay = OutputRelay(tokio::spawn(relay_output(reader, ui_writer)));
    let rendered = tokio::select! {
        biased;
        _ = shutdown => Ok(()),
        result = zero_tui::run(ui_reader, writer, zero_tui::Options {
            session, profile, budget_limit,
        }) => result,
    };
    // The UI restores terminal state and closes stdin before returning. EOF
    // invokes the existing engine cancellation/cleanup path in the server.
    let cleanup_deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let status = match tokio::time::timeout_at(cleanup_deadline, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            let _ = child.kill().await;
            relay.abort().await;
            diagnostics.abort();
            return Err(error.into());
        }
        Err(_) => {
            let _ = child.kill().await;
            relay.abort().await;
            diagnostics.abort();
            return Err("App-server shutdown exceeded 30 seconds and was stopped; inspect operation recovery before retrying work".into());
        }
    };
    let relayed = relay.finish(cleanup_deadline).await;
    let diagnostic = match tokio::time::timeout(Duration::from_secs(1), &mut diagnostics).await {
        Ok(Ok(Ok(bytes))) => String::from_utf8_lossy(&bytes).into_owned(),
        _ => {
            diagnostics.abort();
            String::new()
        }
    };
    if !status.success() {
        return Err(format!("App-server stopped with {status}: {}", diagnostic.trim()).into());
    }
    relayed?;
    rendered.map_err(|error| -> Box<dyn Error> { error.to_string().into() })?;
    Ok(true)
}

fn shutdown_signal()
-> std::io::Result<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut interrupt = signal(SignalKind::interrupt())?;
        let mut terminate = signal(SignalKind::terminate())?;
        Ok(Box::pin(async move {
            tokio::select! {
                _ = interrupt.recv() => {},
                _ = terminate.recv() => {},
            }
        }))
    }
    #[cfg(windows)]
    {
        let mut interrupt = tokio::signal::windows::ctrl_c()?;
        let mut terminate = tokio::signal::windows::ctrl_break()?;
        Ok(Box::pin(async move {
            tokio::select! {
                _ = interrupt.recv() => {},
                _ = terminate.recv() => {},
            }
        }))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "native terminal shutdown signals are unsupported on this platform",
        ))
    }
}

// This task owns a fixed-size forwarding buffer. Once the UI closes, output is
// discarded while the actual child still gets to flush its final journal replies.
async fn relay_output<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    mut reader: R,
    mut writer: W,
) -> std::io::Result<()> {
    let mut buffer = [0; 8192];
    let mut forwarding = true;
    loop {
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            return Ok(());
        }
        if forwarding {
            if let Err(error) = writer.write_all(&buffer[..n]).await {
                if error.kind() != std::io::ErrorKind::BrokenPipe {
                    return Err(error);
                }
                forwarding = false;
            }
        }
    }
}
struct OutputRelay(tokio::task::JoinHandle<std::io::Result<()>>);
impl OutputRelay {
    async fn abort(&mut self) {
        self.0.abort();
        let _ = (&mut self.0).await;
    }
    async fn finish(&mut self, deadline: tokio::time::Instant) -> std::io::Result<()> {
        let deadline = deadline.min(tokio::time::Instant::now() + Duration::from_secs(1));
        match tokio::time::timeout_at(deadline, &mut self.0).await {
            Ok(result) => result.map_err(std::io::Error::other)?,
            Err(_) => {
                self.abort().await;
                Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "App-server output drain did not close",
                ))
            }
        }
    }
}
impl Drop for OutputRelay {
    fn drop(&mut self) {
        self.0.abort();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn final_frames_are_drained_after_ui_drop_without_broken_pipe() {
        let (mut server, reader) = tokio::io::duplex(32);
        let (mut ui, writer) = tokio::io::duplex(32);
        let mut relay = OutputRelay(tokio::spawn(relay_output(reader, writer)));
        let producer = tokio::spawn(async move {
            server.write_all(b"visible").await?;
            // Far larger than both bounded pipes: final writes cannot all complete
            // before the UI drops its reader, even under a favorable schedule.
            server.write_all(&vec![b'!'; 256 * 1024]).await?;
            server.shutdown().await
        });
        let mut visible = [0; 7];
        assert!(ui.read_exact(&mut visible).await.is_ok());
        assert_eq!(&visible, b"visible");
        drop(ui);
        let written = tokio::time::timeout(Duration::from_secs(2), producer).await;
        assert!(matches!(written, Ok(Ok(Ok(())))));
        assert!(
            relay
                .finish(tokio::time::Instant::now() + Duration::from_secs(1))
                .await
                .is_ok()
        );
    }
    #[tokio::test]
    async fn relay_preserves_input_errors_instead_of_treating_them_as_ui_close() {
        struct FailedRead;
        impl AsyncRead for FailedRead {
            fn poll_read(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
                _: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "fixture",
                )))
            }
        }
        let result = relay_output(FailedRead, tokio::io::sink()).await;
        assert!(result.is_err_and(|e| e.kind() == std::io::ErrorKind::InvalidData));
    }
}
