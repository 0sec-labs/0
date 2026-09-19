//! Bounded transport, not an execution permission. Only an executor can consume
//! this input, under its original request deadline and sandbox policy.
use tokio::sync::mpsc;

pub struct InteractiveInput(mpsc::Receiver<Vec<u8>>);
pub struct InteractiveSender(mpsc::Sender<Vec<u8>>);
pub fn interactive_input() -> (InteractiveSender, InteractiveInput) {
    let (tx, rx) = mpsc::channel(4);
    (InteractiveSender(tx), InteractiveInput(rx))
}
impl InteractiveSender {
    /// Queue depth and write size are independently bounded. Dropping the sender
    /// closes guest stdin after already accepted writes have drained.
    pub async fn send(&self, bytes: Vec<u8>) -> Result<(), &'static str> {
        if bytes.is_empty() || bytes.len() > 1_048_577 {
            return Err("interactive write exceeds bounds");
        }
        self.0
            .send(bytes)
            .await
            .map_err(|_| "interactive input closed")
    }
}
impl InteractiveInput {
    pub(crate) async fn receive(&mut self) -> Option<Vec<u8>> {
        self.0.recv().await
    }
}
