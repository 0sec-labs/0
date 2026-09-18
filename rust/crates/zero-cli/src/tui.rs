//! The terminal frontend is a protocol client; only the child app-server owns state.
use crate::args::Args;
use std::{error::Error, io::IsTerminal, path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

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
    let rendered = tokio::select! {
        biased;
        _ = shutdown => Ok(()),
        result = zero_tui::run(reader, writer, zero_tui::Options {
            session, profile, budget_limit,
        }) => result,
    };
    // The UI restores terminal state and closes stdin before returning. EOF
    // invokes the existing engine cancellation/cleanup path in the server.
    let status = match tokio::time::timeout(Duration::from_secs(30), child.wait()).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            diagnostics.abort();
            return Err("App-server shutdown exceeded 30 seconds and was stopped; inspect operation recovery before retrying work".into());
        }
    }?;
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
