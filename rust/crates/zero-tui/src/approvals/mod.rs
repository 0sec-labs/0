//! Dedicated one-invocation permission decisions; never informational answers.
pub mod render;
use crate::{Error, Result, state::safe};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::collections::BTreeSet;
use zero_protocol::{Command, Reply, approvals::*};
#[derive(Clone)]
pub struct Intent {
    session: String,
    approval: String,
    digest: String,
    command: String,
    decision: ToolApprovalDecision,
}
#[derive(Clone)]
pub enum Pending {
    List {
        session: String,
        epoch: u64,
        root: Option<String>,
        after: u64,
    },
    Get {
        session: String,
        epoch: u64,
        id: String,
        show: bool,
    },
    Decision(Intent),
}
pub struct Action {
    pub command: Command,
    pub pending: Pending,
}
pub struct Draft {
    pub approval: String,
    intent: Option<Intent>,
}
#[derive(Default)]
pub struct Approvals {
    pub open: bool,
    pub records: Vec<ToolApprovalRecord>,
    pub selected: usize,
    pub detail: Option<ToolApprovalRecord>,
    pub draft: Option<Draft>,
    pub notice: String,
    pub sending: bool,
    pub scroll: u16,
    session: Option<String>,
    root: Option<String>,
    epoch: u64,
    next: Option<u64>,
    hinted: BTreeSet<String>,
}
fn fail(message: &str) -> Error {
    Error::Protocol(message.into())
}
impl Approvals {
    pub fn reset(&mut self) {
        let epoch = self.epoch.saturating_add(1);
        *self = Self::default();
        self.epoch = epoch;
    }
    pub fn blocks_navigation(&self) -> bool {
        self.sending || self.draft.as_ref().is_some_and(|d| d.intent.is_some())
    }
    pub fn initialize(&mut self, session: &str) -> Vec<Action> {
        if self.session.as_deref() != Some(session) {
            self.reset();
            self.session = Some(session.into());
        }
        self.refresh()
    }
    pub fn refresh(&mut self) -> Vec<Action> {
        self.epoch = self.epoch.saturating_add(1);
        self.next = None;
        let mut actions = Vec::new();
        for id in &self.hinted {
            actions.extend(self.get(id, false));
        }
        if let Some(detail) = &self.detail {
            if !self.hinted.contains(&detail.operation_id) {
                actions.extend(self.get(&detail.operation_id, false));
            }
        }
        actions.extend(self.page(0));
        actions
    }
    fn page(&self, after: u64) -> Vec<Action> {
        let Some(session) = &self.session else {
            return vec![];
        };
        vec![Action {
            command: Command::ToolApprovals {
                session_id: session.clone(),
                root_operation_id: self.root.clone(),
                after_sequence: after,
                limit: 20,
            },
            pending: Pending::List {
                session: session.clone(),
                epoch: self.epoch,
                root: self.root.clone(),
                after,
            },
        }]
    }
    pub fn toggle(&mut self, session: Option<&str>) -> Vec<Action> {
        self.open = !self.open;
        if !self.open {
            return vec![];
        }
        let Some(session) = session else {
            self.notice = "Select a session to inspect approvals".into();
            return vec![];
        };
        if self.session.as_deref() != Some(session) {
            self.reset();
            self.open = true;
            self.session = Some(session.into());
            return self.refresh();
        }
        self.refresh()
    }
    pub fn notified(&mut self, session: &str, id: &str) -> Vec<Action> {
        if self.session.as_deref() != Some(session) {
            return vec![];
        }
        if self.hinted.len() >= 20 && !self.hinted.contains(id) {
            self.notice =
                "More than 20 pending approval hints; inspect durable approvals list".into();
            return vec![];
        }
        self.hinted.insert(id.into());
        self.get(id, false)
    }
    fn get(&self, id: &str, show: bool) -> Vec<Action> {
        let Some(session) = &self.session else {
            return vec![];
        };
        vec![Action {
            command: Command::ToolApproval {
                session_id: session.clone(),
                approval_operation_id: id.into(),
            },
            pending: Pending::Get {
                session: session.clone(),
                epoch: self.epoch,
                id: id.into(),
                show,
            },
        }]
    }
    fn begin_draft(&mut self) {
        let Some(record) = &self.detail else { return };
        if record.status == ToolApprovalStatus::Pending && self.draft.is_none() {
            self.draft = Some(Draft {
                approval: record.operation_id.clone(),
                intent: None,
            });
        }
    }
    pub fn key(&mut self, key: KeyEvent) -> Vec<Action> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if key.code == KeyCode::Esc {
            self.open = false;
            return vec![];
        }
        if ctrl && key.code == KeyCode::Char('g') {
            return self.refresh();
        }
        if self.sending {
            return vec![];
        }
        if ctrl {
            match key.code {
                KeyCode::Char('a') => return self.submit(ToolApprovalDecision::Approve),
                KeyCode::Char('d') => return self.submit(ToolApprovalDecision::Deny),
                KeyCode::Char('u') => {
                    self.draft = None;
                    self.detail = None;
                    self.notice = "Local permission intent discarded; no decision sent".into();
                }
                KeyCode::Char('l') if self.detail.is_none() => {
                    if let Some(after) = self.next {
                        return self.page(after);
                    }
                }
                _ => {}
            }
            return vec![];
        }
        if self.detail.is_none() {
            match key.code {
                KeyCode::Up => self.selected = self.selected.saturating_sub(1),
                KeyCode::Down => {
                    self.selected = (self.selected + 1).min(self.records.len().saturating_sub(1))
                }
                KeyCode::Enter => {
                    if let Some(record) = self.records.get(self.selected) {
                        return self.get(&record.operation_id, true);
                    }
                }
                _ => {}
            }
        } else {
            match key.code {
                KeyCode::PageUp => self.scroll = self.scroll.saturating_sub(5),
                KeyCode::PageDown => self.scroll = self.scroll.saturating_add(5),
                _ => {}
            }
        }
        vec![]
    }
    fn submit(&mut self, decision: ToolApprovalDecision) -> Vec<Action> {
        let Some(record) = self.detail.clone() else {
            return vec![];
        };
        let frozen = self.draft.as_ref().and_then(|d| d.intent.clone());
        let intent = if let Some(intent) = frozen {
            if intent.decision != decision {
                self.notice =
                    "Submitted intent is frozen; retry it or Ctrl-U explicitly discard local draft"
                        .into();
                return vec![];
            }
            intent
        } else {
            if record.status != ToolApprovalStatus::Pending {
                self.notice =
                    "Approval is no longer pending; no new permission decision submitted".into();
                return vec![];
            }
            Intent {
                session: record.session_id.clone(),
                approval: record.operation_id.clone(),
                digest: record.intent_sha256.clone(),
                command: uuid::Uuid::new_v4().to_string(),
                decision,
            }
        };
        self.begin_draft();
        if let Some(draft) = &mut self.draft {
            draft.intent = Some(intent.clone());
        }
        self.sending = true;
        self.notice = "Saving exact-invocation decision; approval is not proof of execution".into();
        vec![Action {
            command: Command::DecideToolApproval {
                session_id: intent.session.clone(),
                command_id: intent.command.clone(),
                approval_operation_id: intent.approval.clone(),
                expected_intent_sha256: intent.digest.clone(),
                decision: intent.decision,
            },
            pending: Pending::Decision(intent),
        }]
    }
    fn validate(record: &ToolApprovalRecord, session: &str) -> Result<()> {
        if record.session_id != session
            || record.sequence == 0
            || record.intent_artifact != record.intent_sha256
            || record.preview.len() > 8192
            || record.intent_sha256.len() != 71
            || !record.intent_sha256.starts_with("sha256:")
            || !record
                .intent_sha256
                .strip_prefix("sha256:")
                .unwrap_or("")
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || serde_json::to_vec(record)?.len() > 96 * 1024
        {
            return Err(fail("invalid or oversized approval record"));
        }
        if record.status == ToolApprovalStatus::Pending && record.decision.is_some() {
            return Err(fail("pending approval already has a decision"));
        }
        if let Some(receipt) = &record.decision {
            if receipt.session_id != record.session_id
                || receipt.approval_operation_id != record.operation_id
                || receipt.intent_sha256 != record.intent_sha256
            {
                return Err(fail("approval decision identity mismatch"));
            }
            if (receipt.decision == ToolApprovalDecision::Deny
                && record.status != ToolApprovalStatus::Denied)
                || (record.status == ToolApprovalStatus::Denied
                    && receipt.decision != ToolApprovalDecision::Deny)
            {
                return Err(fail("approval decision contradicts status"));
            }
        } else if matches!(
            record.status,
            ToolApprovalStatus::Approved
                | ToolApprovalStatus::Denied
                | ToolApprovalStatus::Consumed
        ) {
            return Err(fail("approval status has no decision receipt"));
        }
        if (record.status == ToolApprovalStatus::Consumed) != record.consumption.is_some()
            || record.consumption.is_some() != record.effect_status.is_some()
            || (record.consumption.is_some()
                && record
                    .decision
                    .as_ref()
                    .is_none_or(|d| d.decision != ToolApprovalDecision::Approve))
        {
            return Err(fail("approval consumption contradicts permission receipt"));
        }
        Ok(())
    }
    fn normalized(&self, mut record: ToolApprovalRecord) -> Result<ToolApprovalRecord> {
        let id = record.operation_id.clone();
        for old in self
            .records
            .iter()
            .chain(self.detail.iter())
            .filter(|r| r.operation_id == id)
        {
            if old.preview != record.preview
                || old.preview_truncated != record.preview_truncated
                || old.intent_artifact != record.intent_artifact
                || old.tool_name != record.tool_name
                || old.intent_sha256 != record.intent_sha256
                || old.actor_operation_id != record.actor_operation_id
                || old.root_operation_id != record.root_operation_id
                || old.sequence != record.sequence
                || old.session_id != record.session_id
            {
                return Err(fail("approval identity changed"));
            }
            if old.decision.is_some()
                && record.decision.is_some()
                && old.decision != record.decision
            {
                return Err(fail("immutable approval decision changed"));
            }
            if old.consumption.is_some()
                && record.consumption.is_some()
                && old.consumption != record.consumption
            {
                return Err(fail("immutable approval consumption changed"));
            }
            if old.status != ToolApprovalStatus::Pending {
                if record.status == ToolApprovalStatus::Pending
                    || (old.status != ToolApprovalStatus::Approved
                        && record.status == ToolApprovalStatus::Approved)
                {
                    record = old.clone();
                } else if old.status != ToolApprovalStatus::Approved && old.status != record.status
                {
                    return Err(fail("terminal approval disposition changed"));
                } else if old
                    .effect_status
                    .is_some_and(|s| s != zero_protocol::OperationStatus::Running)
                    && record.effect_status == Some(zero_protocol::OperationStatus::Running)
                {
                    record = old.clone();
                }
            }
            if old.operation_status != zero_protocol::OperationStatus::Running {
                if record.operation_status == zero_protocol::OperationStatus::Running {
                    record = old.clone();
                } else if record.operation_status != old.operation_status {
                    return Err(fail("terminal approval operation changed"));
                }
            }
            if old
                .effect_status
                .is_some_and(|s| s != zero_protocol::OperationStatus::Running)
                && old.effect_status != record.effect_status
            {
                return Err(fail("terminal approval effect changed"));
            }
        }
        Ok(record)
    }
    fn update(&mut self, record: ToolApprovalRecord) -> Result<()> {
        let record = self.normalized(record)?;
        if record.operation_status == zero_protocol::OperationStatus::Running {
            if self.hinted.len() >= 20 && !self.hinted.contains(&record.operation_id) {
                return Err(fail("too many pending approval identities"));
            }
            self.hinted.insert(record.operation_id.clone());
        } else {
            self.hinted.remove(&record.operation_id);
        }
        if let Some(old) = self
            .records
            .iter_mut()
            .find(|r| r.operation_id == record.operation_id)
        {
            *old = record.clone();
        } else {
            if self.records.len() >= 40 {
                if let Some(index) = self
                    .records
                    .iter()
                    .position(|r| r.status != ToolApprovalStatus::Pending)
                {
                    self.records.remove(index);
                } else {
                    return Err(fail(
                        "approval inbox exceeds bounded page plus pending records",
                    ));
                }
            }
            self.records.push(record.clone());
            self.records.sort_by_key(|r| r.sequence);
        }
        if self
            .detail
            .as_ref()
            .is_some_and(|d| d.operation_id == record.operation_id)
        {
            self.detail = Some(record);
        }
        Ok(())
    }
    pub fn reply(&mut self, pending: Pending, reply: Reply) -> Result<Vec<Action>> {
        match pending {
            Pending::Decision(intent) => {
                if self.session.as_deref() != Some(&intent.session)
                    || self
                        .draft
                        .as_ref()
                        .and_then(|d| d.intent.as_ref())
                        .is_none_or(|i| i.command != intent.command)
                {
                    return Err(fail("approval permission correlation changed"));
                }
                self.sending = false;
                match reply {
                    Reply::ToolApprovalDecided {
                        approval,
                        decision,
                        duplicate,
                    } => {
                        Self::validate(&approval, &intent.session)?;
                        if approval.operation_id != intent.approval
                            || approval.intent_sha256 != intent.digest
                            || decision.session_id != intent.session
                            || decision.approval_operation_id != intent.approval
                            || decision.intent_sha256 != intent.digest
                            || decision.command_id != intent.command
                            || decision.decision != intent.decision
                            || approval.decision.as_ref() != Some(&decision)
                        {
                            return Err(fail("approval acknowledgment changed submitted intent"));
                        }
                        self.update(approval)?;
                        self.draft = None;
                        self.notice = format!(
                            "Decision saved{}; one exact invocation only, not proof of execution",
                            if duplicate { " (exact retry)" } else { "" }
                        );
                        Ok(self.refresh())
                    }
                    Reply::Error { message, .. } => {
                        self.notice = format!(
                            "Decision not acknowledged: {}. Frozen intent retained; Ctrl-A retries approval, Ctrl-D retries denial",
                            safe(&message)
                        );
                        Ok(self.get(&intent.approval, false))
                    }
                    _ => Err(fail("unexpected approval decision response")),
                }
            }
            Pending::List {
                session,
                epoch,
                root,
                after,
            } => {
                if self.session.as_deref() != Some(&session) || self.epoch != epoch {
                    return Ok(vec![]);
                }
                match reply {
                    Reply::ToolApprovals { approvals } => {
                        if approvals.len() > 20
                            || serde_json::to_vec(&approvals)?.len() > 1024 * 1024
                        {
                            return Err(fail("approval page exceeds bounds"));
                        }
                        let mut cursor = after;
                        for record in &approvals {
                            Self::validate(record, &session)?;
                            if record.sequence <= cursor
                                || root
                                    .as_ref()
                                    .is_some_and(|root| root != &record.root_operation_id)
                            {
                                return Err(fail("approval page cursor or root mismatch"));
                            }
                            cursor = record.sequence;
                        }
                        self.next = (!approvals.is_empty()).then_some(cursor);
                        let mut approvals = approvals
                            .into_iter()
                            .map(|q| self.normalized(q))
                            .collect::<Result<Vec<_>>>()?;
                        // A concurrent older page cannot erase a newer pending hint.
                        for old in &self.records {
                            if old.operation_status == zero_protocol::OperationStatus::Running
                                && !approvals.iter().any(|q| q.operation_id == old.operation_id)
                            {
                                approvals.push(old.clone());
                            }
                        }
                        self.records.clear();
                        for record in approvals {
                            self.update(record)?;
                        }
                        self.selected = self.selected.min(self.records.len().saturating_sub(1));
                        Ok(vec![])
                    }
                    Reply::Error { message, .. } => {
                        self.notice = format!("Approval list unavailable: {}", safe(&message));
                        Ok(vec![])
                    }
                    _ => Err(fail("unexpected approval list response")),
                }
            }
            Pending::Get {
                session,
                epoch,
                id,
                show,
            } => {
                if self.session.as_deref() != Some(&session) || self.epoch != epoch {
                    return Ok(vec![]);
                }
                match reply {
                    Reply::ToolApproval { approval } => {
                        Self::validate(&approval, &session)?;
                        if approval.operation_id != id {
                            return Err(fail("approval detail identity mismatch"));
                        }
                        let approval = self.normalized(approval)?;
                        self.update(approval.clone())?;
                        if show {
                            if self.draft.as_ref().is_some_and(|d| d.approval != id) {
                                self.notice="Ctrl-U discards the previous local draft before selecting another approval".into();
                            } else {
                                self.detail = Some(approval);
                                self.scroll = 0;
                                self.begin_draft();
                            }
                        }
                        Ok(vec![])
                    }
                    Reply::Error { message, .. } => {
                        self.notice = format!("Approval unavailable: {}", safe(&message));
                        Ok(vec![])
                    }
                    _ => Err(fail("unexpected approval detail response")),
                }
            }
        }
    }
}
#[cfg(test)]
mod tests;
