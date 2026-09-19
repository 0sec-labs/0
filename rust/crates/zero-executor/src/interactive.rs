//! Bounded transport, not an execution permission. Only an executor can consume
//! this input, under its original request deadline and sandbox policy.
use tokio::sync::{mpsc, oneshot};
pub struct InteractiveInput(mpsc::Receiver<Frame>);
pub struct InteractiveSender(mpsc::Sender<Frame>);
pub(crate) struct Frame {
    pub bytes: Vec<u8>,
    pub ack: Option<oneshot::Sender<Result<(), String>>>,
}
pub fn interactive_input() -> (InteractiveSender, InteractiveInput) {
    let (tx, rx) = mpsc::channel(4);
    (InteractiveSender(tx), InteractiveInput(rx))
}
fn valid(bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.is_empty() || bytes.len() > 1_048_577 {
        Err("interactive write exceeds bounds")
    } else {
        Ok(())
    }
}
impl InteractiveSender {
    /// Queue depth and write size are independently bounded. Dropping the sender
    /// closes guest stdin after already accepted writes have drained.
    pub async fn send(&self, bytes: Vec<u8>) -> Result<(), &'static str> {
        valid(&bytes)?;
        self.0
            .send(Frame { bytes, ack: None })
            .await
            .map_err(|_| "interactive input closed")
    }
    /// Confirms the bytes were written/flushed to the owned launcher's pipe. This
    /// does not establish guest consumption. Any error after queueing is uncertain:
    /// callers must not retry the write and must cancel/join the original process.
    pub async fn send_confirmed(&self, bytes: Vec<u8>) -> Result<(), String> {
        valid(&bytes).map_err(str::to_owned)?;
        let (tx, rx) = oneshot::channel();
        self.0
            .send(Frame {
                bytes,
                ack: Some(tx),
            })
            .await
            .map_err(|_| "interactive input closed before queueing")?;
        rx.await
            .map_err(|_| "interactive write acknowledgment lost")?
    }
}
impl InteractiveInput {
    pub(crate) async fn receive(&mut self) -> Option<Frame> {
        self.0.recv().await
    }
}
