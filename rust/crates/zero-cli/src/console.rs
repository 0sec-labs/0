//! Deliberately line-oriented: no full-screen terminal or implicit authority.
use crate::{
    framing::{self, Frame},
    server,
};
use std::{error::Error, sync::Arc};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::mpsc,
};
use zero_engine::Engine;
use zero_protocol::{
    Command, ExecutionEvent, MAX_FRAME_BYTES, OperationStatus, Reply,
    agent::{AgentRequest, AgentStatus},
};

pub async fn run(
    engine: Arc<Engine>,
    session: String,
    profile: AgentRequest,
) -> Result<bool, Box<dyn Error>> {
    let result = conversation(engine.clone(), session, profile).await;
    engine.shutdown().await?;
    result
}
async fn conversation(
    engine: Arc<Engine>,
    session: String,
    mut profile: AgentRequest,
) -> Result<bool, Box<dyn Error>> {
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    let signal = server::shutdown_signal();
    tokio::pin!(signal);
    diagnostic("Experimental line console. Enter one prompt per line; EOF ends between turns.")
        .await?;
    loop {
        let frame = tokio::select! {
            frame=framing::read_frame(&mut input,MAX_FRAME_BYTES)=>frame?,
            _=&mut signal=>return Ok(false),
        };
        let Some(frame) = frame else {
            return Ok(true);
        };
        let Frame::Data(bytes) = frame else {
            return Err("Console prompt exceeds frame byte limit".into());
        };
        let prompt = String::from_utf8(bytes).map_err(|_| "Console prompt must be UTF-8")?;
        if prompt.trim().is_empty() {
            continue;
        }
        profile.prompt = prompt;
        let command_id = format!("console-{}", uuid::Uuid::new_v4());
        diagnostic(&format!("command {command_id}")).await?;
        let command = Command::RunAgent {
            session_id: session.clone(),
            command_id: command_id.clone(),
            request: profile.clone(),
        };
        let (events, mut event_rx) = mpsc::channel(128);
        let diagnostic_engine = engine.clone();
        let drain = tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                if let ExecutionEvent::Admitted {
                    operation_id,
                    command_id,
                    ..
                } = event
                {
                    if let Err(error) = diagnostic(&format!(
                        "admitted operation {operation_id} command {command_id}"
                    ))
                    .await
                    {
                        let _ = diagnostic_engine.shutdown().await;
                        return Err(error);
                    }
                }
            }
            Ok::<(), std::io::Error>(())
        });
        let owner = engine.clone();
        let mut active = tokio::spawn(async move { owner.handle(command, events).await });
        let mut interrupted = false;
        let reply = tokio::select! {
            reply=&mut active=>reply?,
            _=&mut signal=>{
                interrupted=true;
                engine.shutdown().await?;
                active.await?
            }
        };
        drain.await??;
        match reply {
            Reply::Agent {
                operation,
                result: Some(result),
                ..
            } if operation.status == OperationStatus::Succeeded
                && result.status == AgentStatus::Completed =>
            {
                if interrupted {
                    diagnostic(&format!("checkpoint operation {}", operation.id)).await?;
                    return Ok(false);
                }
                let rendered = terminal_text(&result.text);
                tokio::select! {
                    _ = &mut signal => return Ok(false),
                    written = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                        output.write_all(rendered.as_bytes()).await?;
                        output.write_all(b"\n").await?;
                        output.flush().await
                    }) => written.map_err(|_| "Console output stalled")??,
                }

                diagnostic(&format!("checkpoint operation {}", operation.id)).await?;
                profile.continuation_of = Some(operation.id);
            }
            Reply::Agent { operation, .. } => {
                diagnostic(&format!(
                    "Stopped at operation {} ({:?}). Inspect session events and budget; unresolved usage requires explicit reconciliation. No next prompt was submitted.",
                    operation.id, operation.status
                )).await?;
                return Ok(false);
            }
            Reply::Error { code, message } => {
                diagnostic(&format!(
                    "Stopped command {command_id}: {code}: {message}. Inspect session events before retrying."
                )).await?;
                return Ok(false);
            }
            _ => return Err("Unexpected console engine reply".into()),
        }
    }
}

// Model output is untrusted terminal text. Keep readable line/tab formatting,
// but render terminal control bytes visibly (including ESC/OSC and carriage
// return) rather than allowing output to change clipboard or terminal state.
pub(crate) fn terminal_text(value: &str) -> String {
    let mut rendered = String::with_capacity(value.len());
    for c in value.chars() {
        if c.is_control() && c != '\n' && c != '\t' {
            rendered.extend(c.escape_default());
        } else {
            rendered.push(c);
        }
    }
    rendered
}
#[cfg(test)]
mod tests {
    #[test]
    fn model_terminal_controls_are_inert_but_text_layout_is_retained() {
        assert_eq!(
            super::terminal_text("ok\n\t\x1b]52;c;payload\x07\r"),
            "ok\n\t\\u{1b}]52;c;payload\\u{7}\\r"
        );
    }
}

async fn diagnostic(message: &str) -> std::io::Result<()> {
    let mut error = tokio::io::stderr();
    let line = format!("{}\n", terminal_text(message));
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        error.write_all(line.as_bytes()).await?;
        error.flush().await
    })
    .await
    .map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "Console diagnostic output stalled",
        )
    })?
}
