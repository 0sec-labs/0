//! Line-oriented durable follow-ups; no full-screen terminal or implicit authority.
use crate::{
    framing::{self, Frame},
    server,
};
use std::{collections::VecDeque, error::Error, future::Future, pin::Pin, sync::Arc};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
};
use zero_engine::Engine;
use zero_protocol::{
    Command, ExecutionEvent, MAX_FRAME_BYTES, OperationStatus, Reply,
    agent::{AgentRequest, AgentStatus},
};

// Aborting this task cannot retract acknowledged inputs. The runtime's bounded
// shutdown handles Tokio's uninterruptible underlying stdin read on an idle pipe.
struct Reader(tokio::task::JoinHandle<()>);
impl Drop for Reader {
    fn drop(&mut self) {
        self.0.abort();
    }
}
type Active = (String, Pin<Box<dyn Future<Output = Reply> + Send>>);

pub async fn run(
    engine: Arc<Engine>,
    session: String,
    profile: AgentRequest,
) -> Result<bool, Box<dyn Error>> {
    let (events, mut event_rx) = mpsc::channel(128);
    let diagnostic_engine = engine.clone();
    let (admitted_tx, admitted_rx) = watch::channel(None::<(String, String)>);
    let (active_tx, active_rx) = watch::channel(None::<String>);
    let drain = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            if let ExecutionEvent::Admitted {
                operation_id,
                command_id,
                ..
            } = event
            {
                if active_rx.borrow().as_deref() == Some(command_id.as_str()) {
                    admitted_tx.send_replace(Some((command_id.clone(), operation_id.clone())));
                }
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
    let result = conversation(
        engine.clone(),
        session,
        profile,
        events.clone(),
        admitted_rx,
        active_tx,
    )
    .await;
    let shutdown = engine.shutdown().await;
    drop(events);
    let drained = drain.await?;
    shutdown?;
    drained?;
    result
}

async fn conversation(
    engine: Arc<Engine>,
    session: String,
    profile: AgentRequest,
    events: mpsc::Sender<ExecutionEvent>,
    admitted: watch::Receiver<Option<(String, String)>>,
    active_command: watch::Sender<Option<String>>,
) -> Result<bool, Box<dyn Error>> {
    // A single reader owns read_frame across awaits. Cancelling/recreating that
    // future for every completed turn would lose a partially consumed line.
    let (input_tx, mut input_rx) = mpsc::channel(1);
    let _reader = Reader(tokio::spawn(async move {
        let mut stdin = BufReader::new(tokio::io::stdin());
        loop {
            let frame = framing::read_frame(&mut stdin, MAX_FRAME_BYTES).await;
            let done = matches!(&frame, Ok(None) | Err(_));
            if input_tx.send(frame).await.is_err() || done {
                break;
            }
        }
    }));
    let signal = server::shutdown_signal();
    tokio::pin!(signal);
    diagnostic("Experimental line console. Ordinary lines are durably queued; /steer TEXT addresses the admitted active turn, //steer escapes literal text. EOF drains accepted inputs; interruption leaves pending inputs for explicit resumption.").await?;
    let mut pending = VecDeque::<(String, String)>::new();
    let mut previous = None;
    let mut active: Option<Active> = None;
    let mut eof = false;
    let mut rejected = false;
    loop {
        tokio::select! {
            biased;
            _ = &mut signal => {
                engine.shutdown().await?;
                if let Some((command, work)) = active.take() {
                    let reply = work.await;
                    let _ = finish(reply, &command, true).await?;
                }
                return Ok(false);
            }
            reply = async { match active.as_mut() { Some((_,work)) => work.as_mut().await, None => std::future::pending().await } }, if active.is_some() => {
                let (command, _) = active.take().ok_or("Missing completed console turn")?;
                active_command.send_replace(None);
                let completed = tokio::select! {
                    biased;
                    _ = &mut signal => return Ok(false),
                    result = finish(reply, &command, false) => result?,
                };
                if !completed { return Ok(false); }
            }
            _ = std::future::ready(()), if active.is_none() && !pending.is_empty() => {
                let (input, command) = pending.pop_front().ok_or("Missing pending console input")?;
                diagnostic(&format!("command {command}")).await?;
                active_command.send_replace(Some(command.clone()));
                let owner = engine.clone();
                let events = events.clone();
                let session_id = session.clone();
                // This future is first polled by the next select, after its
                // biased signal branch. A pending signal cannot start a new turn.
                active = Some((command, Box::pin(async move {
                    owner.handle(Command::RunQueuedAgent { session_id, input_id:input }, events).await
                })));
            }
            frame = input_rx.recv(), if !eof => {
                let Some(frame) = frame else { eof=true; continue; };
                let Some(frame) = frame? else { eof=true; continue; };
                let Frame::Data(bytes) = frame else { return Err("Console prompt exceeds frame byte limit".into()); };
                let prompt=String::from_utf8(bytes).map_err(|_| "Console prompt must be UTF-8")?;
                if prompt.trim().is_empty() { continue; }
                let prompt=match console_line(prompt) {
                    ConsoleLine::Followup(prompt)=>prompt,
                    ConsoleLine::Steer(prompt)=>{
                        let operation=active.as_ref().and_then(|(command,_)|admitted.borrow().as_ref().filter(|(seen,_)|seen==command).map(|(_,operation)|operation.clone()));
                        let Some(operation_id)=operation else {rejected=true;diagnostic("Steering not sent: no admitted active turn. Nothing was queued.").await?;continue;};
                        let command_id=format!("console-steer-{}",uuid::Uuid::new_v4());
                        let reply=engine.handle(Command::SteerAgent{session_id:session.clone(),operation_id,command_id,prompt},events.clone()).await;
                        match reply {
                            Reply::AgentSteered{message,..}=>diagnostic(&format!("steering message {} {:?} operation {} — Captured means journaled, not provider receipt",message.id,message.status,message.operation_id)).await?,
                            Reply::Error{code,message}=>{rejected=true;diagnostic(&format!("Steering not sent: {code}: {message}. Nothing was queued.")).await?;},
                            _=>return Err("Unexpected steering reply".into()),
                        }
                        continue;
                    }
                };
                let mut request=profile.clone();
                request.prompt=prompt;
                if previous.is_some() { request.continuation_of=None; }
                let command_id=format!("console-{}",uuid::Uuid::new_v4());
                let reply=engine.handle(Command::QueueAgent {session_id:session.clone(),command_id,request,after_input:previous.clone()},events.clone()).await;
                match reply {
                    Reply::AgentQueued { input, .. } => {
                        diagnostic(&format!("queued input {}", input.id)).await?;
                        previous=Some(input.id.clone());
                        pending.push_back((input.id,input.run_command_id));
                    }
                    Reply::Error {code,message} => {
                        rejected=true;
                        diagnostic(&format!("Input not queued: {code}: {message}")).await?;
                    }
                    _ => return Err("Unexpected console queue reply".into()),
                }
            }
            _ = std::future::ready(()), if eof && active.is_none() && pending.is_empty() => return Ok(!rejected),
        }
    }
}

enum ConsoleLine {
    Followup(String),
    Steer(String),
}
fn console_line(prompt: String) -> ConsoleLine {
    if let Some(rest) = prompt.strip_prefix("//steer") {
        if rest.is_empty() || rest.starts_with(char::is_whitespace) {
            return ConsoleLine::Followup(prompt[1..].to_owned());
        }
    }
    if let Some(rest) = prompt.strip_prefix("/steer") {
        if rest.is_empty() {
            return ConsoleLine::Steer(String::new());
        }
        if let Some(first) = rest.chars().next().filter(|c| c.is_whitespace()) {
            return ConsoleLine::Steer(rest[first.len_utf8()..].to_owned());
        }
    }
    ConsoleLine::Followup(prompt)
}

async fn finish(reply: Reply, command: &str, interrupted: bool) -> Result<bool, Box<dyn Error>> {
    match reply {
        Reply::Agent {
            operation,
            result: Some(result),
            ..
        } if operation.status == OperationStatus::Succeeded
            && result.status == AgentStatus::Completed =>
        {
            if !interrupted {
                let rendered = terminal_text(&result.text);
                let mut output = tokio::io::stdout();
                tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    output.write_all(rendered.as_bytes()).await?;
                    output.write_all(b"\n").await?;
                    output.flush().await
                })
                .await
                .map_err(|_| "Console output stalled")??;
            }
            diagnostic(&format!("checkpoint operation {}", operation.id)).await?;
            Ok(!interrupted)
        }
        Reply::Agent { operation, .. } => {
            diagnostic(&format!("Stopped at operation {} ({:?}). Inspect session events and budget; unresolved usage requires explicit reconciliation. Pending inputs remain queued; no next prompt was submitted.",operation.id,operation.status)).await?;
            Ok(false)
        }
        Reply::Error { code, message } => {
            diagnostic(&format!("Stopped command {command}: {code}: {message}. Inspect session events and queue before retrying.")).await?;
            Ok(false)
        }
        _ => Err("Unexpected console engine reply".into()),
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
    fn steering_control_is_explicit_and_literal_escape_preserves_exact_text() {
        use super::{ConsoleLine, console_line};
        assert!(matches!(console_line("/steer λ ".into()),ConsoleLine::Steer(s) if s=="λ "));
        assert!(matches!(console_line("/steer".into()),ConsoleLine::Steer(s) if s.is_empty()));
        assert!(
            matches!(console_line("//steer λ ".into()),ConsoleLine::Followup(s) if s=="/steer λ ")
        );
        for input in [
            " /steer not a command",
            "/steering literal",
            "//steering literal",
        ] {
            assert!(matches!(console_line(input.into()),ConsoleLine::Followup(s) if s==input));
        }
    }

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
