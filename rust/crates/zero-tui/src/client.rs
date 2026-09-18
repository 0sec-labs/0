use crate::{Error, Result};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::mpsc,
};
use zero_protocol::{ExecutionEvent, MAX_FRAME_BYTES, PROTOCOL_VERSION, Request, ServerMessage};

// Responses may contain retained outcomes larger than the inbound request cap.
// This is a UI transport limit, not a limit on durable engine evidence.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

pub struct Client<W> {
    writer: W,
    pub messages: mpsc::Receiver<Result<ServerMessage>>,
    pub progress: mpsc::Receiver<ServerMessage>,
    task: tokio::task::JoinHandle<()>,
}
impl<W> Drop for Client<W> {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl<W: AsyncWrite + Unpin> Client<W> {
    pub fn new<R: AsyncRead + Unpin + Send + 'static>(reader: R, writer: W) -> Self {
        let (tx, messages) = mpsc::channel(1);
        let (ptx, progress) = mpsc::channel(128);
        let task = tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            loop {
                let parsed = read_message(&mut reader).await;
                match parsed {
                    Ok(
                        message @ ServerMessage::Event {
                            event: ExecutionEvent::ModelProgress { .. },
                            ..
                        },
                    ) => {
                        if advisory_bounded(&message) {
                            let _ = ptx.try_send(message);
                        }
                    }
                    Ok(message) => {
                        if tx.send(Ok(message)).await.is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(Err(error)).await;
                        return;
                    }
                }
            }
        });
        Self {
            writer,
            messages,
            progress,
            task,
        }
    }
    pub async fn send(&mut self, request: &Request) -> Result<()> {
        let mut bytes = serde_json::to_vec(request)?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(Error::Protocol("request exceeds frame limit".into()));
        }
        bytes.push(b'\n');
        tokio::time::timeout(Duration::from_secs(5), async {
            self.writer.write_all(&bytes).await?;
            self.writer.flush().await
        })
        .await
        .map_err(|_| Error::Protocol("app-server write timeout".into()))??;
        Ok(())
    }
    pub async fn close(&mut self) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(2), self.writer.shutdown())
            .await
            .map_err(|_| Error::Protocol("app-server stdin close timeout".into()))??;
        Ok(())
    }
}
// A compromised/mismatched advisory producer cannot multiply the larger
// terminal-response allowance by the lossy queue capacity.
fn advisory_bounded(message: &ServerMessage) -> bool {
    use zero_protocol::model::{MAX_PROGRESS_TEXT_BYTES, ProviderProgress};
    let ServerMessage::Event {
        event:
            ExecutionEvent::ModelProgress {
                session_id,
                operation_id,
                parent_operation_id,
                progress,
                ..
            },
        ..
    } = message
    else {
        return false;
    };
    if session_id.len() > 4096
        || operation_id.len() > 4096
        || parent_operation_id
            .as_ref()
            .is_some_and(|id| id.len() > 4096)
    {
        return false;
    }
    let bytes = match progress {
        ProviderProgress::TextDelta { text, .. }
        | ProviderProgress::ReasoningDelta { text, .. }
        | ProviderProgress::RefusalDelta { text, .. } => text.len(),
        ProviderProgress::ToolCallDelta {
            id_delta,
            name_delta,
            arguments_delta,
            ..
        } => id_delta
            .len()
            .saturating_add(name_delta.len())
            .saturating_add(arguments_delta.len()),
    };
    bytes <= MAX_PROGRESS_TEXT_BYTES
}

async fn read_message<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Result<ServerMessage> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Err(Error::Protocol("app-server disconnected".into()));
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let take = newline.map_or(available.len(), |n| n + 1);
        if bytes.len() + take > MAX_RESPONSE_BYTES + 1 {
            return Err(Error::Protocol("app-server response exceeds the 32 MiB TUI display limit; inspect the retained operation or reopen bounded session history".into()));
        }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            break;
        }
    }
    let message: ServerMessage = serde_json::from_slice(&bytes)?;
    let version = match &message {
        ServerMessage::Response {
            protocol_version, ..
        }
        | ServerMessage::Event {
            protocol_version, ..
        } => *protocol_version,
    };
    if version != PROTOCOL_VERSION {
        return Err(Error::Protocol(
            "app-server protocol version mismatch".into(),
        ));
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use tokio::io::AsyncReadExt;
    use zero_protocol::{Reply, RequestId, model::ProviderProgress};

    fn response(text: &str) -> ServerMessage {
        ServerMessage::Response {
            protocol_version: PROTOCOL_VERSION,
            id: Some(RequestId::Text("correlation".into())),
            reply: Box::new(Reply::Error {
                code: "test".into(),
                message: text.into(),
            }),
        }
    }
    fn wire(message: &ServerMessage) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(message).unwrap();
        bytes.push(b'\n');
        bytes
    }
    #[tokio::test]
    async fn fragmented_utf8_frame_preserves_response_identity_and_text() {
        let expected = response("Euro € and emoji 🦀");
        let bytes = wire(&expected);
        let (mut write, read) = tokio::io::duplex(7);
        let producer = tokio::spawn(async move {
            for byte in bytes {
                write.write_all(&[byte]).await.unwrap();
                tokio::task::yield_now().await;
            }
        });
        let actual = read_message(&mut BufReader::new(read)).await.unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        producer.await.unwrap();
    }
    #[tokio::test]
    async fn response_limit_is_independent_of_inbound_request_limit() {
        let expected = response(&"x".repeat(MAX_FRAME_BYTES + 100));
        let bytes = wire(&expected);
        let mut reader = BufReader::new(bytes.as_slice());
        let actual = read_message(&mut reader).await.unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        // A sentinel is rejected before parsing or waiting for a terminating newline.
        let bytes = vec![b' '; MAX_RESPONSE_BYTES + 2];
        let error = read_message(&mut BufReader::new(bytes.as_slice()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("32 MiB"));
        assert!(error.to_string().contains("retained operation"));
    }
    #[tokio::test]
    async fn malformed_version_and_partial_eof_are_explicit_protocol_errors() {
        for input in [&b"not-json\n"[..], &b"{\"protocol_version\":"[..], &b""[..]] {
            assert!(read_message(&mut BufReader::new(input)).await.is_err());
        }
        let mut wrong = serde_json::to_value(response("ok")).unwrap();
        wrong["protocol_version"] = serde_json::json!(PROTOCOL_VERSION + 1);
        let mut bytes = serde_json::to_vec(&wrong).unwrap();
        bytes.push(b'\n');
        assert!(
            read_message(&mut BufReader::new(bytes.as_slice()))
                .await
                .unwrap_err()
                .to_string()
                .contains("version mismatch")
        );
    }
    #[tokio::test]
    async fn full_advisory_queue_drops_progress_without_blocking_authoritative_reply() {
        let (mut remote, read) = tokio::io::duplex(4096);
        let mut client = Client::new(read, tokio::io::sink());
        let producer = tokio::spawn(async move {
            for (session_id, progress) in [
                (
                    "s".into(),
                    ProviderProgress::TextDelta {
                        item_index: 0,
                        content_index: 0,
                        text: "OVERSIZED".repeat(4096),
                    },
                ),
                (
                    "s".repeat(4097),
                    ProviderProgress::TextDelta {
                        item_index: 0,
                        content_index: 0,
                        text: "bad identity".into(),
                    },
                ),
                (
                    "s".into(),
                    ProviderProgress::ToolCallDelta {
                        item_index: 0,
                        id_delta: "i".repeat(8192),
                        name_delta: "n".repeat(8192),
                        arguments_delta: "a".into(),
                    },
                ),
            ] {
                let invalid = ServerMessage::Event {
                    protocol_version: PROTOCOL_VERSION,
                    event: ExecutionEvent::ModelProgress {
                        session_id,
                        operation_id: "child".into(),
                        parent_operation_id: Some("parent".into()),
                        sequence: 999,
                        progress,
                    },
                };
                remote.write_all(&wire(&invalid)).await.unwrap();
            }
            for sequence in 1..=512 {
                let message = ServerMessage::Event {
                    protocol_version: PROTOCOL_VERSION,
                    event: ExecutionEvent::ModelProgress {
                        session_id: "s".into(),
                        operation_id: "child".into(),
                        parent_operation_id: Some("parent".into()),
                        sequence,
                        progress: ProviderProgress::TextDelta {
                            item_index: 0,
                            content_index: 0,
                            text: "€".into(),
                        },
                    },
                };
                remote.write_all(&wire(&message)).await.unwrap();
            }
            remote
                .write_all(&wire(&response("authoritative")))
                .await
                .unwrap();
        });
        let reply = tokio::time::timeout(Duration::from_secs(2), client.messages.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(reply).unwrap(),
            serde_json::to_value(response("authoritative")).unwrap()
        );
        assert_eq!(client.progress.len(), 128);
        assert!(matches!(
            client.progress.try_recv().unwrap(),
            ServerMessage::Event {
                event: ExecutionEvent::ModelProgress { sequence: 1, .. },
                ..
            }
        ));
        producer.await.unwrap();
        assert!(client.messages.recv().await.unwrap().is_err());
    }
    #[tokio::test]
    async fn oversized_request_writes_nothing_and_close_delivers_eof() {
        let (write, mut remote) = tokio::io::duplex(1024);
        let mut client = Client::new(tokio::io::empty(), write);
        let request = Request {
            protocol_version: PROTOCOL_VERSION,
            id: RequestId::Text("x".repeat(MAX_FRAME_BYTES)),
            command: zero_protocol::Command::Initialize,
        };
        assert!(
            client
                .send(&request)
                .await
                .unwrap_err()
                .to_string()
                .contains("request exceeds")
        );
        client.close().await.unwrap();
        let mut bytes = Vec::new();
        remote.read_to_end(&mut bytes).await.unwrap();
        assert!(bytes.is_empty());
    }
}
