use crate::framing::{Frame, read_frame};
use std::{collections::HashSet, io, sync::Arc, time::Duration};
use tokio::io::{AsyncBufRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use zero_engine::Engine;
use zero_protocol::{
    Command, MAX_FRAME_BYTES, PROTOCOL_VERSION, Reply, Request, RequestId, ServerMessage,
};

const MAX_EXECUTIONS: usize = 64;

fn response(id: Option<RequestId>, reply: Reply) -> ServerMessage {
    ServerMessage::Response {
        protocol_version: PROTOCOL_VERSION,
        id,
        reply: Box::new(reply),
    }
}

fn error(id: Option<RequestId>, code: &str, message: impl Into<String>) -> ServerMessage {
    response(
        id,
        Reply::Error {
            code: code.into(),
            message: message.into(),
        },
    )
}

pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// Output is serialized by one writer. Backend events and responses may interleave,
/// but every request response retains its caller-selected correlation identifier.
pub async fn serve<R, W>(engine: Arc<Engine>, mut input: R, mut output: W) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let disconnected = CancellationToken::new();
    let writer_disconnected = disconnected.clone();
    let (out, mut messages) = mpsc::channel::<ServerMessage>(128);
    let writer = tokio::spawn(async move {
        let result: io::Result<()> = async {
            while let Some(message) = messages.recv().await {
                let mut bytes = serde_json::to_vec(&message).map_err(io::Error::other)?;
                bytes.push(b'\n');
                tokio::time::timeout(Duration::from_secs(5), async {
                    output.write_all(&bytes).await?;
                    output.flush().await
                })
                .await
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::TimedOut, "Protocol output stalled")
                })??;
            }
            Ok(())
        }
        .await;
        writer_disconnected.cancel();
        result
    });
    let (events, mut event_rx) = mpsc::channel(128);
    let event_out = out.clone();
    let event_forwarder = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            if event_out
                .send(ServerMessage::Event {
                    protocol_version: PROTOCOL_VERSION,
                    event,
                })
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let mut initialized = false;
    let mut active_ids = HashSet::new();
    let mut tasks = JoinSet::new();
    let mut read_error = None;
    let signal = shutdown_signal();
    tokio::pin!(signal);
    loop {
        while let Some(done) = tasks.try_join_next() {
            if let Ok(id) = done {
                active_ids.remove(&id);
            }
        }
        let frame = tokio::select! {
            _ = &mut signal => break,
            _ = disconnected.cancelled() => break,
            result = read_frame(&mut input, MAX_FRAME_BYTES) => match result {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(error) => { read_error = Some(error); break; }
            }
        };
        let raw = match frame {
            Frame::Data(raw) => raw,
            Frame::Oversized => {
                if out
                    .send(error(
                        None,
                        "frame_too_large",
                        "Request exceeds the frame byte limit",
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
                continue;
            }
        };
        let request: Request = match serde_json::from_slice(&raw) {
            Ok(request) => request,
            Err(failure) => {
                let id = serde_json::from_slice::<serde_json::Value>(&raw)
                    .ok()
                    .and_then(|value| value.get("id").cloned())
                    .and_then(|id| serde_json::from_value(id).ok());
                if out
                    .send(error(id, "invalid_request", failure.to_string()))
                    .await
                    .is_err()
                {
                    break;
                }
                continue;
            }
        };
        // Completion may have arrived while waiting for this frame. A client
        // may reuse a transport ID after receiving its completed response.
        while let Some(done) = tasks.try_join_next() {
            if let Ok(id) = done {
                active_ids.remove(&id);
            }
        }
        let rejection = if request.protocol_version != PROTOCOL_VERSION {
            Some(("unsupported_version", "Unsupported protocol version"))
        } else if active_ids.contains(&request.id) {
            Some(("duplicate_request_id", "Request ID is already in flight"))
        } else if matches!(request.command, Command::Initialize) && initialized {
            Some((
                "already_initialized",
                "This connection is already initialized",
            ))
        } else if !matches!(request.command, Command::Initialize) && !initialized {
            Some((
                "not_initialized",
                "Initialize this connection before issuing commands",
            ))
        } else {
            None
        };
        if let Some((code, message)) = rejection {
            if out
                .send(error(Some(request.id), code, message))
                .await
                .is_err()
            {
                break;
            }
            continue;
        }
        if matches!(
            request.command,
            Command::Execute { .. }
                | Command::Infer { .. }
                | Command::ReviewSource { .. }
                | Command::ReproduceSource { .. }
                | Command::ValidateSourceRepair { .. }
                | Command::RunAgent { .. }
                | Command::RunSandbox { .. }
                | Command::RunPlugin { .. }
        ) {
            if tasks.len() >= MAX_EXECUTIONS {
                if out
                    .send(error(
                        Some(request.id),
                        "overloaded",
                        "Too many in-flight executions",
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
                continue;
            }
            active_ids.insert(request.id.clone());
            let engine = engine.clone();
            let events = events.clone();
            let out = out.clone();
            tasks.spawn(async move {
                let reply = engine.handle(request.command, events).await;
                let _ = out.send(response(Some(request.id.clone()), reply)).await;
                request.id
            });
        } else {
            let initialization = matches!(request.command, Command::Initialize);
            let reply = engine.handle(request.command, events.clone()).await;
            if initialization && matches!(reply, Reply::Initialized { .. }) {
                initialized = true;
            }
            if out.send(response(Some(request.id), reply)).await.is_err() {
                break;
            }
        }
    }
    let shutdown = engine.shutdown().await.map_err(io::Error::other);
    while tasks.join_next().await.is_some() {}
    drop(events);
    let _ = event_forwarder.await;
    drop(out);
    let written = writer.await.map_err(io::Error::other)?;
    if let Some(error) = read_error {
        return Err(error);
    }
    shutdown?;
    written
}
