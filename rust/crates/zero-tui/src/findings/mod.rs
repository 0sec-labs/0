//! Operator triage is independent of model authority and evidence verification.
pub mod render;
use crate::{Error, Result, state::safe};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use zero_protocol::{
    Command, Reply,
    discovery::SourceReviewCandidate,
    triage::{SourceFindingRecord, SourceFindingStatus, TriageDecision},
};

const PAGE_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    Reviews,
    Hypotheses,
    Detail,
}
#[derive(Clone)]
pub enum Read {
    Reviews {
        before: Option<u64>,
    },
    Findings {
        offset: u32,
    },
    Detail {
        after: u64,
    },
    Decision {
        command_id: String,
        revision: u64,
        status: SourceFindingStatus,
        note: String,
    },
}
#[derive(Clone)]
pub struct Pending {
    epoch: u64,
    session: String,
    review: Option<String>,
    hypothesis: Option<String>,
    kind: Read,
}
pub struct Action {
    pub command: Command,
    pub pending: Pending,
}
pub struct Draft {
    pub status: SourceFindingStatus,
    pub note: String,
    pub cursor: usize,
    pub revision: u64,
    pub digest: String,
    pub conflict: bool,
    command_id: String,
    submitted: bool,
}
pub struct Findings {
    pub screen: Screen,
    pub reviews: Vec<SourceReviewCandidate>,
    pub findings: Vec<SourceFindingRecord>,
    pub detail: Option<SourceFindingRecord>,
    pub history: Vec<TriageDecision>,
    pub selected: usize,
    pub draft: Option<Draft>,
    pub status: String,
    pub scroll: u16,
    pub review: Option<SourceReviewCandidate>,
    pub receipt: Option<TriageDecision>,
    pub busy: bool,
    session: Option<String>,
    epoch: u64,
    initialized: bool,
    detail_ready: bool,
    mutating: bool,
    review_cursor: Option<u64>,
    finding_offset: u32,
    next_finding: Option<u32>,
    next_history: Option<u64>,
}
impl Default for Findings {
    fn default() -> Self {
        Self {
            screen: Screen::Reviews,
            reviews: vec![],
            findings: vec![],
            detail: None,
            history: vec![],
            selected: 0,
            draft: None,
            status: "Select a session to discover source reviews".into(),
            scroll: 0,
            review: None,
            receipt: None,
            busy: false,
            session: None,
            epoch: 0,
            initialized: false,
            detail_ready: false,
            mutating: false,
            review_cursor: None,
            finding_offset: 0,
            next_finding: None,
            next_history: None,
        }
    }
}
fn bounded(value: &Reply) -> Result<()> {
    if serde_json::to_vec(value)?.len() > PAGE_BYTES {
        return Err(Error::Protocol(
            "findings display page exceeds 2 MiB".into(),
        ));
    }
    Ok(())
}
impl Findings {
    pub fn blocks_navigation(&self) -> bool {
        self.mutating || self.draft.is_some()
    }
    pub fn reset(&mut self) {
        let epoch = self.epoch.saturating_add(1);
        *self = Self::default();
        self.epoch = epoch;
    }
    pub fn enter(&mut self, session: Option<&str>) -> Vec<Action> {
        if self.session.as_deref() != session {
            self.reset();
            self.session = session.map(str::to_owned);
        }
        if self.session.is_some() && !self.initialized {
            self.initialized = true;
            return self.issue(Read::Reviews { before: None });
        }
        vec![]
    }
    fn advance(&mut self) {
        self.epoch = self.epoch.saturating_add(1);
        self.busy = false;
        self.scroll = 0;
    }
    fn issue(&mut self, kind: Read) -> Vec<Action> {
        if self.busy {
            return vec![];
        }
        let Some(session) = self.session.clone() else {
            return vec![];
        };
        let review = self.review.as_ref().map(|r| r.operation_id.clone());
        let hypothesis = self.detail.as_ref().map(|f| f.hypothesis.id.clone());
        let command = match &kind {
            Read::Reviews { before } => Command::SourceReviews {
                session_id: session.clone(),
                before_sequence: *before,
                limit: 20,
            },
            Read::Findings { offset } => {
                let Some(source_operation_id) = review.clone() else {
                    return vec![];
                };
                Command::SourceFindings {
                    session_id: session.clone(),
                    source_operation_id,
                    offset: *offset,
                    limit: 20,
                }
            }
            Read::Detail { after } => {
                self.detail_ready = false;
                let (Some(source_operation_id), Some(hypothesis_id)) =
                    (review.clone(), hypothesis.clone())
                else {
                    return vec![];
                };
                Command::SourceFinding {
                    session_id: session.clone(),
                    source_operation_id,
                    hypothesis_id,
                    after_revision: *after,
                    limit: 20,
                }
            }
            Read::Decision {
                command_id,
                revision,
                status,
                note,
            } => {
                let (Some(source_operation_id), Some(hypothesis_id)) =
                    (review.clone(), hypothesis.clone())
                else {
                    return vec![];
                };
                self.mutating = true;
                Command::TriageSourceFinding {
                    session_id: session.clone(),
                    command_id: command_id.clone(),
                    source_operation_id,
                    hypothesis_id,
                    status: *status,
                    expected_revision: *revision,
                    note: note.clone(),
                }
            }
        };
        self.busy = true;
        self.status = if self.mutating {
            "Saving operator decision…"
        } else {
            "Loading source records…"
        }
        .into();
        vec![Action {
            command,
            pending: Pending {
                epoch: self.epoch,
                session,
                review,
                hypothesis,
                kind,
            },
        }]
    }
    pub fn paste(&mut self, text: &str) {
        if self.busy {
            return;
        }
        let Some(draft) = &mut self.draft else {
            return;
        };
        if draft.submitted {
            self.status =
                "Submitted draft is fixed: Ctrl-S retries exactly; conflict needs Ctrl-B rebase"
                    .into();
            return;
        }
        let text = safe(&text.replace("\r\n", "\n").replace('\r', "\n"));
        if draft.note.len() + text.len() > 4096 {
            self.status = "Note limit: 4096 UTF-8 bytes; insertion rejected".into();
            return;
        }
        draft.note.insert_str(draft.cursor, &text);
        draft.cursor += text.len();
    }
    pub fn key(&mut self, key: KeyEvent) -> Vec<Action> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if self.mutating {
            self.status = "Wait for decision acknowledgment before navigation or editing".into();
            return vec![];
        }
        if self.draft.is_some() {
            if ctrl && key.code == KeyCode::Char('s') {
                return self.submit();
            }
            if ctrl && key.code == KeyCode::Char('b') {
                if !self.busy && self.detail_ready {
                    if let (Some(d), Some(f)) = (&mut self.draft, &self.detail) {
                        if d.conflict && d.digest == f.source_review_sha256 {
                            d.revision = f.revision;
                            d.command_id = uuid::Uuid::new_v4().to_string();
                            d.submitted = false;
                            d.conflict = false;
                            self.status = "Draft explicitly rebased; review it, then Ctrl-S submits a new decision".into();
                        }
                    }
                }
                return vec![];
            }
            if key.code == KeyCode::Esc {
                self.draft = None;
                self.status = "Decision draft discarded; no new write sent".into();
                return vec![];
            }
            if ctrl {
                return vec![];
            }
            match key.code {
                KeyCode::Enter => self.paste("\n"),
                KeyCode::Char(c) if !c.is_control() => self.paste(&c.to_string()),
                KeyCode::Left
                | KeyCode::Right
                | KeyCode::Home
                | KeyCode::End
                | KeyCode::Backspace
                | KeyCode::Delete
                    if !self.busy =>
                {
                    if let Some(d) = &mut self.draft {
                        if d.submitted {
                            return vec![];
                        }
                        match key.code {
                            KeyCode::Left => {
                                d.cursor = d.note[..d.cursor]
                                    .char_indices()
                                    .next_back()
                                    .map_or(0, |(i, _)| i)
                            }
                            KeyCode::Right => {
                                if let Some(c) = d.note[d.cursor..].chars().next() {
                                    d.cursor += c.len_utf8();
                                }
                            }
                            KeyCode::Home => d.cursor = 0,
                            KeyCode::End => d.cursor = d.note.len(),
                            KeyCode::Backspace => {
                                if let Some((i, _)) = d.note[..d.cursor].char_indices().next_back()
                                {
                                    d.note.drain(i..d.cursor);
                                    d.cursor = i;
                                }
                            }
                            KeyCode::Delete => {
                                if let Some(c) = d.note[d.cursor..].chars().next() {
                                    d.note.drain(d.cursor..d.cursor + c.len_utf8());
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            return vec![];
        }
        if ctrl {
            return match key.code {
                KeyCode::Char('l') => self.more(),
                KeyCode::Char('g') => self.refresh(),
                _ => vec![],
            };
        }
        match key.code {
            KeyCode::Esc => {
                self.advance();
                self.selected = 0;
                match self.screen {
                    Screen::Reviews => {}
                    Screen::Hypotheses => {
                        self.screen = Screen::Reviews;
                        self.review = None;
                        self.findings.clear();
                    }
                    Screen::Detail => {
                        self.screen = Screen::Hypotheses;
                        self.detail = None;
                        self.history.clear();
                        self.receipt = None;
                    }
                }
            }
            KeyCode::Up => self.selected = self.selected.saturating_sub(1),
            KeyCode::Down => {
                let len = if self.screen == Screen::Reviews {
                    self.reviews.len()
                } else {
                    self.findings.len()
                };
                self.selected = (self.selected + 1).min(len.saturating_sub(1));
            }
            KeyCode::PageUp => self.scroll = self.scroll.saturating_sub(10),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_add(10),
            KeyCode::Enter if !self.busy => match self.screen {
                Screen::Reviews => {
                    if let Some(review) = self.reviews.get(self.selected).cloned() {
                        self.advance();
                        self.review = Some(review);
                        self.screen = Screen::Hypotheses;
                        self.findings.clear();
                        self.detail = None;
                        self.selected = 0;
                        self.next_finding = None;
                        return self.issue(Read::Findings { offset: 0 });
                    }
                }
                Screen::Hypotheses => {
                    if let Some(finding) = self.findings.get(self.selected).cloned() {
                        self.advance();
                        self.cache_record(&finding);
                        self.detail = Some(finding);
                        self.screen = Screen::Detail;
                        self.history.clear();
                        self.receipt = None;
                        self.next_history = None;
                        return self.issue(Read::Detail { after: 0 });
                    }
                }
                Screen::Detail => {}
            },
            KeyCode::Char(c @ ('a' | 's' | 'r'))
                if self.screen == Screen::Detail && !self.busy && self.detail_ready =>
            {
                if let Some(f) = &self.detail {
                    self.draft = Some(Draft {
                        status: match c {
                            'a' => SourceFindingStatus::Accepted,
                            's' => SourceFindingStatus::Suppressed,
                            _ => SourceFindingStatus::New,
                        },
                        note: String::new(),
                        cursor: 0,
                        revision: f.revision,
                        digest: f.source_review_sha256.clone(),
                        conflict: false,
                        command_id: uuid::Uuid::new_v4().to_string(),
                        submitted: false,
                    });
                    self.status = "Operator disposition only; evidence remains Unverified. Ctrl-S submits, Esc discards".into();
                }
            }
            _ => {}
        }
        vec![]
    }
    fn submit(&mut self) -> Vec<Action> {
        if self.busy {
            return vec![];
        }
        let Some(d) = &mut self.draft else {
            return vec![];
        };
        if d.conflict {
            self.status = "Revision conflict: inspect refreshed record; Ctrl-B explicitly rebases, Esc discards".into();
            return vec![];
        }
        d.submitted = true;
        let kind = Read::Decision {
            command_id: d.command_id.clone(),
            revision: d.revision,
            status: d.status,
            note: d.note.clone(),
        };
        self.issue(kind)
    }
    fn more(&mut self) -> Vec<Action> {
        match self.screen {
            Screen::Reviews => self.review_cursor.map(|before| Read::Reviews {
                before: Some(before),
            }),
            Screen::Hypotheses => self.next_finding.map(|offset| Read::Findings { offset }),
            Screen::Detail => self.next_history.map(|after| Read::Detail { after }),
        }
        .map_or_else(Vec::new, |read| self.issue(read))
    }
    fn refresh(&mut self) -> Vec<Action> {
        self.advance();
        self.issue(match self.screen {
            Screen::Reviews => Read::Reviews { before: None },
            Screen::Hypotheses => Read::Findings { offset: 0 },
            Screen::Detail => Read::Detail { after: 0 },
        })
    }
    fn cache_record(&mut self, finding: &SourceFindingRecord) {
        if let Some(cached) = self
            .findings
            .iter_mut()
            .find(|f| f.hypothesis.id == finding.hypothesis.id)
        {
            *cached = finding.clone();
        }
    }
    fn check_record(&self, f: &SourceFindingRecord, hypothesis: Option<&str>) -> Result<()> {
        let valid = self.session.as_deref() == Some(f.session_id.as_str())
            && self.review.as_ref().is_some_and(|r| {
                r.operation_id == f.source_operation_id
                    && r.source_review_sha256 == f.source_review_sha256
            })
            && hypothesis.is_none_or(|id| id == f.hypothesis.id);
        if !valid {
            return Err(Error::Protocol(
                "source finding identity differs from selected review".into(),
            ));
        }
        Ok(())
    }
    fn check_decision(&self, d: &TriageDecision, f: &SourceFindingRecord) -> Result<()> {
        if d.session_id != f.session_id
            || d.source_operation_id != f.source_operation_id
            || d.hypothesis_id != f.hypothesis.id
            || d.source_review_sha256 != f.source_review_sha256
            || d.revision > f.revision
        {
            return Err(Error::Protocol(
                "decision identity differs from selected hypothesis".into(),
            ));
        }
        Ok(())
    }
    pub fn reply(&mut self, pending: Pending, reply: Reply) -> Result<Vec<Action>> {
        if pending.epoch != self.epoch
            || self.session.as_deref() != Some(&pending.session)
            || pending.review.as_deref() != self.review.as_ref().map(|r| r.operation_id.as_str())
            || pending.hypothesis.as_deref()
                != self.detail.as_ref().map(|f| f.hypothesis.id.as_str())
        {
            return Ok(vec![]);
        }
        self.busy = false;
        self.mutating = false;
        if let Reply::Error { code, message } = reply {
            self.status = format!("Source record unavailable: {}", safe(&message));
            if matches!(pending.kind, Read::Decision { .. }) {
                if let Some(d) = &mut self.draft {
                    if code == "conflict" {
                        d.conflict = true;
                        let actions = self.issue(Read::Detail { after: 0 });
                        self.status = "Revision conflict; preserving note and original revision while refreshing".into();
                        return Ok(actions);
                    }
                }
            }
            return Ok(vec![]);
        }
        bounded(&reply)?;
        match (pending.kind, reply) {
            (Read::Reviews { before }, Reply::SourceReviews { page }) => {
                if page.reviews.len() > 20
                    || page
                        .next_before_sequence
                        .is_some_and(|next| before.is_some_and(|old| next >= old))
                {
                    return Err(Error::Protocol(
                        "invalid source review cursor or page".into(),
                    ));
                }
                let mut prev = before.unwrap_or(u64::MAX);
                for r in &page.reviews {
                    if r.sequence >= prev {
                        return Err(Error::Protocol(
                            "source reviews are not strictly ordered".into(),
                        ));
                    }
                    prev = r.sequence;
                }
                self.reviews = page.reviews;
                self.review_cursor = page.next_before_sequence;
                self.selected = 0;
                self.status = if self.reviews.is_empty() {
                    if self.review_cursor.is_some() {
                        "No candidates in this scan window; Ctrl-L continues discovery"
                    } else {
                        "No candidates in this page; this is not a safety verdict"
                    }
                } else {
                    "Metadata candidates only; Enter validates selected source review"
                }
                .into();
            }
            (Read::Findings { offset }, Reply::SourceFindings { findings }) => {
                if findings.len() > 20 {
                    return Err(Error::Protocol("source findings page too large".into()));
                }
                let mut ids = std::collections::BTreeSet::new();
                for f in &findings {
                    self.check_record(f, None)?;
                    if !ids.insert(&f.hypothesis.id) {
                        return Err(Error::Protocol("duplicate hypothesis in page".into()));
                    }
                }
                self.next_finding = if findings.is_empty() {
                    None
                } else {
                    Some(
                        offset
                            .checked_add(findings.len() as u32)
                            .ok_or_else(|| Error::Protocol("finding offset overflow".into()))?,
                    )
                };
                self.finding_offset = offset;
                self.findings = findings;
                self.selected = 0;
                self.status = if self.findings.is_empty() {
                    "No hypotheses in this page; no safety conclusion established"
                } else {
                    "Unverified hypotheses; Enter opens detail. Claimed severity is model-supplied"
                }
                .into();
            }
            (Read::Detail { after }, Reply::SourceFinding { finding, history }) => {
                self.check_record(&finding, pending.hypothesis.as_deref())?;
                if history.len() > 20 {
                    return Err(Error::Protocol("decision history page too large".into()));
                }
                let mut prev = after;
                for d in &history {
                    self.check_decision(d, &finding)?;
                    if d.revision <= prev {
                        return Err(Error::Protocol(
                            "decision revisions are not increasing".into(),
                        ));
                    }
                    prev = d.revision;
                }
                self.next_history = history.last().map(|d| d.revision);
                self.history = history;
                self.cache_record(&finding);
                self.detail = Some(finding);
                self.detail_ready = true;
                self.status = if self.draft.as_ref().is_some_and(|d| d.conflict) { "Conflict refreshed; note retains original revision. Ctrl-B rebases explicitly, Ctrl-S never overwrites silently" } else { "Unverified. a accept / s suppress / r reopen; Ctrl-L next decision history page" }.into();
            }
            (
                Read::Decision {
                    command_id,
                    revision,
                    status,
                    note,
                },
                Reply::SourceFindingTriaged {
                    finding,
                    decision,
                    duplicate,
                },
            ) => {
                self.check_record(&finding, pending.hypothesis.as_deref())?;
                self.check_decision(&decision, &finding)?;
                if decision.command_id != command_id
                    || decision.expected_revision != revision
                    || decision.status != status
                    || decision.note != note
                    || decision.revision != revision.saturating_add(1)
                {
                    return Err(Error::Protocol(
                        "decision receipt does not match submitted intent".into(),
                    ));
                }
                self.status = format!(
                    "Decision saved{}: receipt revision {} {:?}; current revision {} {:?}. Evidence remains Unverified",
                    if duplicate { " (exact retry)" } else { "" },
                    decision.revision,
                    decision.status,
                    finding.revision,
                    finding.status
                );
                self.receipt = Some(decision);
                self.cache_record(&finding);
                self.detail = Some(finding);
                self.draft = None;
            }
            _ => return Err(Error::Protocol("unexpected findings response".into())),
        }
        Ok(vec![])
    }
}
#[cfg(test)]
mod tests;
