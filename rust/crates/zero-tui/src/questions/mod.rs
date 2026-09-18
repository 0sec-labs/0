//! Durable information-only answers, isolated from tool and scope authority.
pub mod render;
use crate::{Error, Result, state::safe};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::collections::BTreeSet;
use zero_protocol::{Command, Reply, questions::*};
#[derive(Clone)]
pub struct Intent {
    session: String,
    question: String,
    digest: String,
    command: String,
    decision: OperatorDecision,
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
    pub question: String,
    pub answers: Vec<OperatorAnswer>,
    pub row: usize,
    intent: Option<Intent>,
}
#[derive(Default)]
pub struct Questions {
    pub open: bool,
    pub records: Vec<OperatorQuestionRecord>,
    pub selected: usize,
    pub detail: Option<OperatorQuestionRecord>,
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
impl Questions {
    pub fn reset(&mut self) {
        let epoch = self.epoch.saturating_add(1);
        *self = Self::default();
        self.epoch = epoch;
    }
    pub fn blocks_navigation(&self) -> bool {
        self.sending
            || self.draft.as_ref().is_some_and(|d| {
                d.intent.is_some()
                    || d.answers
                        .iter()
                        .any(|a| !a.selected_indices.is_empty() || a.custom_text.is_some())
            })
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
        actions.extend(self.page(0));
        actions
    }
    fn page(&self, after: u64) -> Vec<Action> {
        let Some(session) = &self.session else {
            return vec![];
        };
        vec![Action {
            command: Command::OperatorQuestions {
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
            self.notice = "Select a session to inspect questions".into();
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
                "More than 20 pending question hints; inspect durable questions list".into();
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
            command: Command::OperatorQuestion {
                session_id: session.clone(),
                question_operation_id: id.into(),
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
        if record.status != OperatorQuestionStatus::Pending || self.draft.is_some() {
            return;
        }
        self.draft = Some(Draft {
            question: record.operation_id.clone(),
            answers: record
                .request
                .questions
                .iter()
                .enumerate()
                .map(|(i, _)| OperatorAnswer {
                    question_index: i as u32,
                    selected_indices: vec![],
                    custom_text: None,
                })
                .collect(),
            row: 0,
            intent: None,
        });
    }
    pub fn rows(&self) -> Vec<(usize, Option<usize>)> {
        let Some(record) = &self.detail else {
            return vec![];
        };
        let mut rows = vec![];
        for (i, q) in record.request.questions.iter().enumerate() {
            for j in 0..q.options.as_ref().map_or(0, Vec::len) {
                rows.push((i, Some(j)));
            }
            if q.allow_custom {
                rows.push((i, None));
            }
        }
        rows
    }
    pub fn paste(&mut self, text: &str) {
        if !self.open || self.sending {
            return;
        }
        self.begin_draft();
        let rows = self.rows();
        let Some(draft) = self.draft.as_mut().filter(|d| d.intent.is_none()) else {
            return;
        };
        let Some((question, None)) = rows.get(draft.row) else {
            return;
        };
        let text = safe(&text.replace("\r\n", "\n").replace('\r', "\n"));
        let old = draft.answers[*question]
            .custom_text
            .as_deref()
            .unwrap_or("");
        if old.len() + text.len() > 16384 {
            self.notice = "Custom answer exceeds 16 KiB; paste was not inserted".into();
            return;
        }
        if !text.is_empty() {
            draft.answers[*question].custom_text = Some(format!("{old}{text}"));
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
                KeyCode::Char('s') => {
                    self.begin_draft();
                    let Some(draft) = &self.draft else {
                        return vec![];
                    };
                    return self.submit(OperatorDecision::Answer {
                        answers: draft.answers.clone(),
                    });
                }
                KeyCode::Char('d') => return self.submit(OperatorDecision::Dismiss),
                KeyCode::Char('u') => {
                    self.draft = None;
                    self.detail = None;
                    self.notice = "Local draft discarded; no answer or dismissal sent".into();
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
            return vec![];
        }
        self.begin_draft();
        let rows = self.rows();
        match key.code {
            KeyCode::PageUp => self.scroll = self.scroll.saturating_sub(5),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_add(5),
            KeyCode::Up => {
                if let Some(d) = &mut self.draft {
                    d.row = d.row.saturating_sub(1)
                }
            }
            KeyCode::Down | KeyCode::Tab => {
                if let Some(d) = &mut self.draft {
                    d.row = (d.row + 1).min(rows.len().saturating_sub(1))
                }
            }
            KeyCode::Char(' ') => {
                let row = self.draft.as_ref().and_then(|d| rows.get(d.row)).copied();
                if let Some((question, Some(index))) = row {
                    if let (Some(draft), Some(record)) = (&mut self.draft, &self.detail) {
                        if draft.intent.is_none() {
                            let selected = &mut draft.answers[question].selected_indices;
                            let index = index as u32;
                            if selected.contains(&index) {
                                selected.retain(|v| *v != index);
                            } else {
                                if !record.request.questions[question].multi_select {
                                    selected.clear();
                                }
                                selected.push(index);
                                selected.sort_unstable();
                            }
                        }
                    }
                } else {
                    self.paste(" ");
                }
            }
            KeyCode::Enter => self.paste("\n"),
            KeyCode::Char(c) => self.paste(&c.to_string()),
            KeyCode::Backspace => {
                if let Some(d) = &mut self.draft {
                    if d.intent.is_none() {
                        if let Some((q, None)) = rows.get(d.row) {
                            if let Some(text) = &mut d.answers[*q].custom_text {
                                text.pop();
                                if text.is_empty() {
                                    d.answers[*q].custom_text = None;
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        vec![]
    }
    fn submit(&mut self, decision: OperatorDecision) -> Vec<Action> {
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
            if record.status != OperatorQuestionStatus::Pending {
                self.notice = "Question is no longer pending; no new answer submitted".into();
                return vec![];
            }
            if let Err(error) = decision.validate(&record.request) {
                self.notice = safe(&error.to_string());
                return vec![];
            }
            Intent {
                session: record.session_id.clone(),
                question: record.operation_id.clone(),
                digest: record.request_sha256.clone(),
                command: uuid::Uuid::new_v4().to_string(),
                decision,
            }
        };
        self.begin_draft();
        if let Some(draft) = &mut self.draft {
            draft.intent = Some(intent.clone());
        }
        self.sending = true;
        self.notice = "Saving answer decision; this grants no permissions".into();
        vec![Action {
            command: Command::DecideOperatorQuestion {
                session_id: intent.session.clone(),
                command_id: intent.command.clone(),
                question_operation_id: intent.question.clone(),
                expected_request_sha256: intent.digest.clone(),
                decision: intent.decision.clone(),
            },
            pending: Pending::Decision(intent),
        }]
    }
    fn validate(record: &OperatorQuestionRecord, session: &str) -> Result<()> {
        if record.session_id != session
            || record.sequence == 0
            || serde_json::to_vec(record)?.len() > 192 * 1024
        {
            return Err(fail("invalid or oversized question record"));
        }
        record
            .request
            .validate()
            .map_err(|_| fail("invalid retained question request"))?;
        let status = match record.decision.as_ref().map(|r| &r.decision) {
            Some(OperatorDecision::Answer { .. }) => Some(OperatorQuestionStatus::Answered),
            Some(OperatorDecision::Dismiss) => Some(OperatorQuestionStatus::Dismissed),
            None => None,
        };
        if status.as_ref().is_some_and(|s| s != &record.status)
            || (record.status == OperatorQuestionStatus::Answered
                || record.status == OperatorQuestionStatus::Dismissed)
                && status.is_none()
        {
            return Err(fail("question status contradicts decision"));
        }
        if let Some(receipt) = &record.decision {
            if receipt.session_id != record.session_id
                || receipt.question_operation_id != record.operation_id
                || receipt.request_sha256 != record.request_sha256
            {
                return Err(fail("question decision identity mismatch"));
            }
            receipt
                .decision
                .validate(&record.request)
                .map_err(|_| fail("invalid retained answer"))?;
        }
        Ok(())
    }
    fn normalized(&self, mut record: OperatorQuestionRecord) -> Result<OperatorQuestionRecord> {
        let id = record.operation_id.clone();
        for old in self
            .records
            .iter()
            .chain(self.detail.iter())
            .filter(|r| r.operation_id == id)
        {
            if old.request != record.request
                || old.request_sha256 != record.request_sha256
                || old.actor_operation_id != record.actor_operation_id
                || old.root_operation_id != record.root_operation_id
                || old.sequence != record.sequence
                || old.session_id != record.session_id
            {
                return Err(fail("question identity changed"));
            }
            if old.status != OperatorQuestionStatus::Pending {
                if record.status == OperatorQuestionStatus::Pending {
                    record = old.clone();
                } else if old.status != record.status || old.decision != record.decision {
                    return Err(fail("terminal question decision changed"));
                }
            }
        }
        Ok(record)
    }
    fn update(&mut self, record: OperatorQuestionRecord) -> Result<()> {
        let record = self.normalized(record)?;
        if record.status == OperatorQuestionStatus::Pending {
            if self.hinted.len() >= 20 && !self.hinted.contains(&record.operation_id) {
                return Err(fail("too many pending question identities"));
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
                    .position(|r| r.status != OperatorQuestionStatus::Pending)
                {
                    self.records.remove(index);
                } else {
                    return Err(fail(
                        "question inbox exceeds bounded page plus pending records",
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
                    return Err(fail("question answer correlation changed"));
                }
                self.sending = false;
                match reply {
                    Reply::OperatorQuestionDecided {
                        question,
                        decision,
                        duplicate,
                    } => {
                        Self::validate(&question, &intent.session)?;
                        if question.operation_id != intent.question
                            || question.request_sha256 != intent.digest
                            || decision.session_id != intent.session
                            || decision.question_operation_id != intent.question
                            || decision.request_sha256 != intent.digest
                            || decision.command_id != intent.command
                            || decision.decision != intent.decision
                            || question.decision.as_ref() != Some(&decision)
                        {
                            return Err(fail("question acknowledgment changed submitted intent"));
                        }
                        self.update(question)?;
                        self.draft = None;
                        self.notice = format!(
                            "Decision saved{}; answer receipt retained, not proof of model consumption. No permissions granted",
                            if duplicate { " (exact retry)" } else { "" }
                        );
                        Ok(self.refresh())
                    }
                    Reply::Error { message, .. } => {
                        self.notice = format!(
                            "Answer not acknowledged: {}. Frozen draft retained; Ctrl-S retries answer, Ctrl-D retries dismissal",
                            safe(&message)
                        );
                        Ok(self.get(&intent.question, false))
                    }
                    _ => Err(fail("unexpected question decision response")),
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
                    Reply::OperatorQuestions { questions } => {
                        if questions.len() > 20
                            || serde_json::to_vec(&questions)?.len() > 1024 * 1024
                        {
                            return Err(fail("question page exceeds bounds"));
                        }
                        let mut cursor = after;
                        for record in &questions {
                            Self::validate(record, &session)?;
                            if record.sequence <= cursor
                                || root
                                    .as_ref()
                                    .is_some_and(|root| root != &record.root_operation_id)
                            {
                                return Err(fail("question page cursor or root mismatch"));
                            }
                            cursor = record.sequence;
                        }
                        self.next = (!questions.is_empty()).then_some(cursor);
                        let mut questions = questions
                            .into_iter()
                            .map(|q| self.normalized(q))
                            .collect::<Result<Vec<_>>>()?;
                        // A concurrent older page cannot erase a newer pending hint.
                        for old in &self.records {
                            if old.status == OperatorQuestionStatus::Pending
                                && !questions.iter().any(|q| q.operation_id == old.operation_id)
                            {
                                questions.push(old.clone());
                            }
                        }
                        self.records.clear();
                        for record in questions {
                            self.update(record)?;
                        }
                        self.selected = self.selected.min(self.records.len().saturating_sub(1));
                        Ok(vec![])
                    }
                    Reply::Error { message, .. } => {
                        self.notice = format!("Question list unavailable: {}", safe(&message));
                        Ok(vec![])
                    }
                    _ => Err(fail("unexpected question list response")),
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
                    Reply::OperatorQuestion { question } => {
                        Self::validate(&question, &session)?;
                        if question.operation_id != id {
                            return Err(fail("question detail identity mismatch"));
                        }
                        let question = self.normalized(question)?;
                        self.update(question.clone())?;
                        if show {
                            if self.draft.as_ref().is_some_and(|d| d.question != id) {
                                self.notice="Ctrl-U discards the previous local draft before selecting another question".into();
                            } else {
                                self.detail = Some(question);
                                self.scroll = 0;
                                self.begin_draft();
                            }
                        }
                        Ok(vec![])
                    }
                    Reply::Error { message, .. } => {
                        self.notice = format!("Question unavailable: {}", safe(&message));
                        Ok(vec![])
                    }
                    _ => Err(fail("unexpected question detail response")),
                }
            }
        }
    }
}
#[cfg(test)]
mod tests;
