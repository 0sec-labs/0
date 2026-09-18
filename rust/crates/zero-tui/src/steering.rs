//! Explicit durable steering. Captured means journaled, not provider-delivered.
use crate::{Error, Result, state::safe};
use zero_protocol::{
    Command, Reply,
    steering::{AgentSteeringMessage, AgentSteeringStatus},
};
#[derive(Clone)]
pub struct Intent {
    session: String,
    operation: String,
    command: String,
    prompt: String,
}
#[derive(Clone)]
pub enum Pending {
    Send(Intent),
    Read {
        session: String,
        operation: String,
        epoch: u64,
        after: u64,
    },
}
pub struct Action {
    pub command: Command,
    pub pending: Pending,
}
#[derive(Default)]
pub struct Steering {
    pub target: Option<String>,
    pub messages: Vec<AgentSteeringMessage>,
    pub notice: String,
    pub sending: bool,
    session: Option<String>,
    epoch: u64,
    retry: Option<Intent>,
}
impl Steering {
    pub fn reset(&mut self) {
        let epoch = self.epoch.saturating_add(1);
        *self = Self::default();
        self.epoch = epoch;
    }
    pub fn send(
        &mut self,
        session: Option<&str>,
        operation: Option<&str>,
        prompt: &str,
    ) -> Vec<Action> {
        if self.sending {
            self.notice = "Wait for durable steering acknowledgment".into();
            return vec![];
        }
        let Some(session) = session else {
            self.notice = "Ctrl-T needs a selected session; draft preserved".into();
            return vec![];
        };
        if prompt.trim().is_empty() || prompt.len() > 16384 || prompt.contains('\0') {
            self.notice = "Steering requires nonempty text up to 16 KiB; draft preserved".into();
            return vec![];
        }
        // A rejected/uncertain acknowledgment leaves an immutable retry intent.
        // A later root (or no active root) must never retarget the held draft.
        let intent = match self
            .retry
            .as_ref()
            .filter(|r| r.session == session && r.prompt == prompt)
        {
            Some(intent) => intent.clone(),
            None => {
                let Some(operation) = operation else {
                    self.notice =
                        "Ctrl-T needs an admitted active turn; draft preserved and nothing queued"
                            .into();
                    return vec![];
                };
                Intent {
                    session: session.into(),
                    operation: operation.into(),
                    command: uuid::Uuid::new_v4().to_string(),
                    prompt: prompt.into(),
                }
            }
        };
        if self.session.as_deref() != Some(session)
            || self.target.as_deref() != Some(&intent.operation)
        {
            self.reset();
            self.session = Some(session.into());
            self.target = Some(intent.operation.clone());
        }
        let operation = &intent.operation;
        self.sending = true;
        self.retry = Some(intent.clone());
        self.notice =
            format!("Saving steering for operation {operation} — draft held until acknowledgment");
        vec![Action {
            command: Command::SteerAgent {
                session_id: intent.session.clone(),
                operation_id: intent.operation.clone(),
                command_id: intent.command.clone(),
                prompt: intent.prompt.clone(),
            },
            pending: Pending::Send(intent),
        }]
    }
    /// Reopened history may discover receipts, but must not replace a live send target.
    pub fn observe(&mut self, session: &str, operation: &str) -> Vec<Action> {
        if self.target.is_some() || self.sending {
            return vec![];
        }
        self.session = Some(session.into());
        self.target = Some(operation.into());
        self.refresh()
    }
    pub fn refresh(&mut self) -> Vec<Action> {
        if self.session.is_none() || self.target.is_none() {
            return vec![];
        }
        self.epoch = self.epoch.saturating_add(1);
        self.page(0)
    }
    fn page(&self, after: u64) -> Vec<Action> {
        let (Some(session), Some(operation)) = (&self.session, &self.target) else {
            return vec![];
        };
        vec![Action {
            command: Command::AgentSteering {
                session_id: session.clone(),
                operation_id: operation.clone(),
                after_sequence: after,
                limit: 50,
            },
            pending: Pending::Read {
                session: session.clone(),
                operation: operation.clone(),
                epoch: self.epoch,
                after,
            },
        }]
    }
    fn validate(message: &AgentSteeringMessage, session: &str, operation: &str) -> Result<()> {
        if message.session_id != session
            || message.operation_id != operation
            || message.prompt.len() > 16384
            || message.id.len() > 4096
            || message.command_id.len() > 4096
            || message
                .inference_operation_id
                .as_ref()
                .is_some_and(|id| id.len() > 4096)
            || message.sequence == 0
            || (message.status == AgentSteeringStatus::Captured)
                != message.inference_operation_id.is_some()
        {
            return Err(Error::Protocol(
                "invalid or mismatched steering receipt".into(),
            ));
        }
        Ok(())
    }
    fn merge(&mut self, message: AgentSteeringMessage) -> Result<()> {
        if let Some(old) = self
            .messages
            .iter_mut()
            .find(|v| v.sequence == message.sequence)
        {
            if old.id != message.id
                || old.command_id != message.command_id
                || old.prompt != message.prompt
            {
                return Err(Error::Protocol("steering receipt identity changed".into()));
            }
            if old.status != AgentSteeringStatus::Pending
                && message.status == AgentSteeringStatus::Pending
            {
                return Ok(());
            }
            if old.status != AgentSteeringStatus::Pending
                && (old.status != message.status
                    || old.inference_operation_id != message.inference_operation_id)
            {
                return Err(Error::Protocol("terminal steering receipt changed".into()));
            }
            *old = message;
        } else {
            if self.messages.len() >= 128 {
                return Err(Error::Protocol(
                    "steering display exceeds 128 retained records".into(),
                ));
            }
            self.messages.push(message);
            self.messages.sort_by_key(|m| m.sequence);
        }
        Ok(())
    }
    /// Return the acknowledged prompt to clear, without touching a newer draft.
    pub fn reply(
        &mut self,
        pending: Pending,
        reply: Reply,
    ) -> Result<(Vec<Action>, Option<String>)> {
        match pending {
            Pending::Send(intent) => {
                if self.session.as_deref() != Some(&intent.session)
                    || self.target.as_deref() != Some(&intent.operation)
                {
                    return Err(Error::Protocol(
                        "steering acknowledgment changed target".into(),
                    ));
                }
                self.sending = false;
                match reply {
                    Reply::AgentSteered { message, duplicate } => {
                        Self::validate(&message, &intent.session, &intent.operation)?;
                        if message.command_id != intent.command || message.prompt != intent.prompt {
                            return Err(Error::Protocol(
                                "steering acknowledgment changed submitted intent".into(),
                            ));
                        }
                        self.notice = format!(
                            "Steering saved{}: {:?} — operation {}. Captured means journaled, not provider receipt",
                            if duplicate { " (exact retry)" } else { "" },
                            message.status,
                            intent.operation
                        );
                        self.merge(message)?;
                        self.retry = None;
                        Ok((self.refresh(), Some(intent.prompt)))
                    }
                    Reply::Error { message, .. } => {
                        self.notice = format!(
                            "Steering not acknowledged: {}. Draft preserved; Ctrl-T retries same target and text",
                            safe(&message)
                        );
                        Ok((vec![], None))
                    }
                    _ => Err(Error::Protocol("unexpected steering acknowledgment".into())),
                }
            }
            Pending::Read {
                session,
                operation,
                epoch,
                after,
            } => {
                if epoch != self.epoch
                    || self.session.as_deref() != Some(&session)
                    || self.target.as_deref() != Some(&operation)
                {
                    return Ok((vec![], None));
                }
                match reply {
                    Reply::AgentSteering { messages } => {
                        if messages.len() > 50 || serde_json::to_vec(&messages)?.len() > 1024 * 1024
                        {
                            return Err(Error::Protocol("steering page exceeds bounds".into()));
                        }
                        let mut sequence = after;
                        for message in messages.iter() {
                            Self::validate(message, &session, &operation)?;
                            if message.sequence <= sequence {
                                return Err(Error::Protocol(
                                    "steering page cursor did not advance".into(),
                                ));
                            }
                            sequence = message.sequence;
                        }
                        let more = !messages.is_empty();
                        for message in messages {
                            self.merge(message)?;
                        }
                        Ok((if more { self.page(sequence) } else { vec![] }, None))
                    }
                    Reply::Error { message, .. } => {
                        self.notice = format!(
                            "Steering history unavailable: {}. Saved acknowledgment remains associated with {operation}",
                            safe(&message)
                        );
                        Ok((vec![], None))
                    }
                    _ => Err(Error::Protocol(
                        "unexpected steering history response".into(),
                    )),
                }
            }
        }
    }
}
#[cfg(test)]
#[path = "steering_tests.rs"]
mod tests;
