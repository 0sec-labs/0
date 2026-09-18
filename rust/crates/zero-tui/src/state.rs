use crate::{Error, Options, Result};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use zero_protocol::{
    Command, ExecutionEvent, PROTOCOL_VERSION, Reply, Request, RequestId, ServerMessage,
    model::ProviderProgress,
    queue::{QueuedAgent, QueuedAgentStatus},
};
const COMPOSER_BYTES: usize = 16384;
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum View {
    Sessions,
    Conversation,
    Queue,
}
#[derive(Clone)]
enum Pending {
    Init,
    Sessions,
    Create,
    History {
        session: String,
        older: bool,
        epoch: u64,
    },
    Queue {
        session: String,
        epoch: u64,
    },
    Budget {
        session: String,
        epoch: u64,
    },
    Enqueue {
        command: String,
        prompt: String,
    },
    Run,
    Cancel,
}
#[derive(Clone)]
pub struct Active {
    pub input: String,
    pub command: String,
    pub operation: Option<String>,
    pub text: String,
    pub reasoning: String,
    pub tools: String,
    pub sequences: BTreeMap<String, u64>,
    pub gaps: bool,
    pub cancel_requested: bool,
}
pub struct State {
    pub options: Options,
    pub view: View,
    pub session: Option<String>,
    pub sessions: Vec<Value>,
    pub selected: usize,
    pub history: Vec<Value>,
    pub history_windowed: bool,
    pub queue: Vec<QueuedAgent>,
    pub budget: Option<Value>,
    pub composer: String,
    pub cursor: usize,
    pub status: String,
    pub active: Option<Active>,
    pub scroll: u16,
    pub help: bool,
    pub quit: bool,
    pending: BTreeMap<String, Pending>,
    session_cursor: Option<zero_protocol::history::SessionCursor>,
    history_cursor: Option<u64>,
    queue_cursor: Option<u64>,
    epoch: u64,
    latest: Option<Value>,
    history_loaded: bool,
    queue_loaded: bool,
    local: BTreeSet<String>,
    halted: bool,
}
pub fn safe(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}
fn bounded_append(target: &mut String, text: &str) {
    let mut n = (65536usize.saturating_sub(target.len())).min(text.len());
    while !text.is_char_boundary(n) {
        n -= 1;
    }
    target.push_str(&safe(&text[..n]));
}
impl State {
    pub fn new(options: Options) -> Self {
        let session = options.session.clone();
        Self {
            view: if session.is_some() {
                View::Conversation
            } else {
                View::Sessions
            },
            session,
            options,
            sessions: vec![],
            selected: 0,
            history: vec![],
            history_windowed: false,
            queue: vec![],
            budget: None,
            composer: String::new(),
            cursor: 0,
            status: "Connecting to app-server…".into(),
            active: None,
            scroll: 0,
            help: false,
            quit: false,
            pending: BTreeMap::new(),
            session_cursor: None,
            history_cursor: None,
            queue_cursor: None,
            epoch: 0,
            latest: None,
            history_loaded: false,
            queue_loaded: false,
            local: BTreeSet::new(),
            halted: false,
        }
    }
    fn request(&mut self, command: Command, pending: Pending) -> Request {
        let id = uuid::Uuid::new_v4().to_string();
        self.pending.insert(id.clone(), pending);
        Request {
            protocol_version: PROTOCOL_VERSION,
            id: RequestId::Text(id),
            command,
        }
    }
    pub fn initialize(&mut self) -> Request {
        self.request(Command::Initialize, Pending::Init)
    }
    fn sessions_page(&mut self) -> Request {
        self.request(
            Command::SessionListPage {
                after: self.session_cursor.clone(),
                limit: 20,
            },
            Pending::Sessions,
        )
    }
    fn refresh(&mut self) -> Vec<Request> {
        self.epoch = self.epoch.saturating_add(1);
        self.history_loaded = false;
        self.queue_loaded = false;
        let Some(session) = self.session.clone() else {
            return vec![];
        };
        vec![
            self.request(
                Command::SessionHistory {
                    session_id: session.clone(),
                    before_sequence: None,
                    limit: 20,
                },
                Pending::History {
                    session: session.clone(),
                    older: false,
                    epoch: self.epoch,
                },
            ),
            self.request(
                Command::AgentQueue {
                    session_id: session.clone(),
                    after_sequence: 0,
                    limit: 50,
                },
                Pending::Queue {
                    session: session.clone(),
                    epoch: self.epoch,
                },
            ),
            self.request(
                Command::SessionBudget {
                    session_id: session.clone(),
                },
                Pending::Budget {
                    session,
                    epoch: self.epoch,
                },
            ),
        ]
    }
    fn open(&mut self, session: String) -> Vec<Request> {
        if self.active.is_some() || self.mutation_pending() {
            self.status = "Cancel or finish the active turn before switching sessions".into();
            return vec![];
        }
        self.session = Some(session);
        self.history.clear();
        self.latest = None;
        self.queue.clear();
        self.local.clear();
        self.history_loaded = false;
        self.queue_loaded = false;
        self.halted = false;
        self.history_cursor = None;
        self.queue_cursor = None;
        self.budget = None;
        self.selected = 0;
        self.view = View::Conversation;
        self.status = "Loading saved session…".into();
        self.refresh()
    }
    pub fn paste(&mut self, text: &str) {
        if self.view != View::Conversation
            || self
                .pending
                .values()
                .any(|p| matches!(p, Pending::Enqueue { .. }))
        {
            return;
        }
        let text = safe(&text.replace("\r\n", "\n").replace('\r', "\n"));
        if self.composer.len() + text.len() > COMPOSER_BYTES {
            self.status = "Composer limit: 16 KiB; paste was not inserted".into();
            return;
        }
        self.composer.insert_str(self.cursor, &text);
        self.cursor += text.len();
    }
    pub fn key(&mut self, key: KeyEvent) -> Vec<Request> {
        if key.kind == KeyEventKind::Release {
            return vec![];
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl {
            match key.code {
                KeyCode::Char('q') => {
                    self.quit = true;
                    return vec![];
                }
                KeyCode::Char('c') => {
                    if self.active.is_some() {
                        return self.cancel();
                    }
                    self.quit = true;
                    return vec![];
                }
                KeyCode::Char('x') => return self.cancel(),
                KeyCode::Char('n') => return self.new_session(),
                KeyCode::Char('r') => return self.run_selected(),
                KeyCode::Char('l') => return self.more(),
                KeyCode::Char('g') => {
                    self.view = View::Conversation;
                    return self.refresh();
                }
                KeyCode::Char('u') => {
                    if !self
                        .pending
                        .values()
                        .any(|p| matches!(p, Pending::Enqueue { .. }))
                    {
                        self.composer.clear();
                        self.cursor = 0;
                    }
                    return vec![];
                }
                _ => return vec![],
            }
        }
        if self.help && !matches!(key.code, KeyCode::F(1) | KeyCode::Esc) {
            return vec![];
        }
        if self
            .pending
            .values()
            .any(|p| matches!(p, Pending::Enqueue { .. }))
            && matches!(
                key.code,
                KeyCode::Backspace | KeyCode::Delete | KeyCode::Char(_)
            )
        {
            return vec![];
        }
        match key.code {
            KeyCode::F(1) => self.help = !self.help,
            KeyCode::Esc if self.help => self.help = false,
            KeyCode::Tab => {
                self.view = match self.view {
                    View::Sessions => View::Conversation,
                    View::Conversation => View::Queue,
                    View::Queue => View::Sessions,
                };
                self.selected = 0;
                if self.view == View::Sessions && self.sessions.is_empty() {
                    return vec![self.sessions_page()];
                }
            }
            KeyCode::PageUp => self.scroll = self.scroll.saturating_add(10),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(10),
            KeyCode::Up if self.view != View::Conversation => {
                self.selected = self.selected.saturating_sub(1)
            }
            KeyCode::Down if self.view != View::Conversation => {
                let n = if self.view == View::Sessions {
                    self.sessions.len()
                } else {
                    self.queue.len()
                };
                self.selected = (self.selected + 1).min(n.saturating_sub(1));
            }
            KeyCode::Char('n') if self.view == View::Sessions => return self.new_session(),
            KeyCode::Enter if self.view == View::Sessions => {
                if let Some(id) = self
                    .sessions
                    .get(self.selected)
                    .and_then(|s| s["id"].as_str())
                    .map(str::to_owned)
                {
                    return self.open(id);
                }
            }
            KeyCode::Enter if self.view == View::Conversation => {
                if key.modifiers.contains(KeyModifiers::SHIFT) {
                    self.paste("\n");
                } else {
                    return self.enqueue();
                }
            }
            KeyCode::Char(c) if self.view == View::Conversation && !c.is_control() => {
                self.paste(&c.to_string())
            }
            KeyCode::Left if self.view == View::Conversation => {
                self.cursor = self.composer[..self.cursor]
                    .char_indices()
                    .next_back()
                    .map_or(0, |(i, _)| i);
            }
            KeyCode::Right if self.view == View::Conversation => {
                if let Some(c) = self.composer[self.cursor..].chars().next() {
                    self.cursor += c.len_utf8();
                }
            }
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.composer.len(),
            KeyCode::Backspace if self.view == View::Conversation => {
                if let Some((i, _)) = self.composer[..self.cursor].char_indices().next_back() {
                    self.composer.drain(i..self.cursor);
                    self.cursor = i;
                }
            }
            KeyCode::Delete if self.view == View::Conversation => {
                if let Some(c) = self.composer[self.cursor..].chars().next() {
                    self.composer.drain(self.cursor..self.cursor + c.len_utf8());
                }
            }
            _ => {}
        }
        vec![]
    }
    fn mutation_pending(&self) -> bool {
        self.pending.values().any(|p| {
            matches!(
                p,
                Pending::Enqueue { .. } | Pending::Create | Pending::Cancel | Pending::Run
            )
        })
    }
    fn new_session(&mut self) -> Vec<Request> {
        if self.active.is_some() || self.mutation_pending() {
            self.status =
                "Finish or cancel active work and await acknowledgments before creating a session"
                    .into();
            return vec![];
        }
        vec![self.request(
            Command::SessionCreate {
                generation: "native-tui".into(),
                budget_limit: self.options.budget_limit,
            },
            Pending::Create,
        )]
    }
    fn more(&mut self) -> Vec<Request> {
        let Some(session) = self.session.clone() else {
            return vec![self.sessions_page()];
        };
        match self.view {
            View::Sessions => {
                if self.session_cursor.is_some() {
                    vec![self.sessions_page()]
                } else {
                    vec![]
                }
            }
            View::Conversation => {
                if self.history_cursor.is_some() {
                    vec![self.request(
                        Command::SessionHistory {
                            session_id: session.clone(),
                            before_sequence: self.history_cursor,
                            limit: 20,
                        },
                        Pending::History {
                            session,
                            older: true,
                            epoch: self.epoch,
                        },
                    )]
                } else {
                    vec![]
                }
            }
            View::Queue => {
                if let Some(after_sequence) = self.queue_cursor {
                    vec![self.request(
                        Command::AgentQueue {
                            session_id: session.clone(),
                            after_sequence,
                            limit: 50,
                        },
                        Pending::Queue {
                            session,
                            epoch: self.epoch,
                        },
                    )]
                } else {
                    vec![]
                }
            }
        }
    }
    fn enqueue(&mut self) -> Vec<Request> {
        if self.composer.trim().is_empty() {
            return vec![];
        }
        if self
            .pending
            .values()
            .any(|p| matches!(p, Pending::Enqueue { .. }))
        {
            self.status = "Wait for the previous durable enqueue acknowledgment".into();
            return vec![];
        }
        let Some(session) = self.session.clone() else {
            self.status = "Select or create a session first".into();
            return vec![];
        };
        if !self.history_loaded || !self.queue_loaded || self.queue_cursor.is_some() {
            self.status = "Load the complete queue (queue view, Ctrl-L) before enqueueing".into();
            return vec![];
        }
        if self.local.len() >= 50 {
            self.status = "At most 50 live queued inputs; wait or cancel pending inputs".into();
            return vec![];
        }
        let Some(mut request) = self.options.profile.clone() else {
            self.status = "Browse only: launch with --request to compose turns".into();
            return vec![];
        };
        // Live queued inputs keep their immutable FIFO lineage. Otherwise use
        // the actual newest conversation operation, not a stale queued receipt.
        let predecessor = self
            .queue
            .iter()
            .rev()
            .find(|q| {
                matches!(
                    q.status,
                    QueuedAgentStatus::Pending | QueuedAgentStatus::Running
                )
            })
            .map(|q| q.id.clone());
        if predecessor.is_some() {
            request.continuation_of = None;
        } else if request.continuation_of.is_none() {
            if let Some(latest) = &self.latest {
                let completed =
                    latest["agent_status"] == "completed" && latest["status"] == "succeeded";
                let checkpoint =
                    latest["agent_status"] == "turn_limit" && latest["status"] == "failed";
                if !completed && !checkpoint || latest["continuable"] != true {
                    self.status =
                        "Latest turn needs recovery or a new session; no new turn was queued"
                            .into();
                    return vec![];
                }
                request.continuation_of = latest["operation_id"].as_str().map(str::to_owned);
                self.halted = false; // This Enter explicitly authorizes continuation.
            }
        }
        request.prompt = self.composer.clone();
        let prompt = request.prompt.clone();
        let command = uuid::Uuid::new_v4().to_string();
        let result = self.request(
            Command::QueueAgent {
                session_id: session,
                command_id: command.clone(),
                request,
                after_input: predecessor,
            },
            Pending::Enqueue { command, prompt },
        );
        self.status = "Saving queued input… composer retained until acknowledgment".into();
        vec![result]
    }
    fn start(&mut self, input: QueuedAgent) -> Vec<Request> {
        if self.active.is_some() {
            self.status = "A turn is already running".into();
            return vec![];
        }
        self.active = Some(Active {
            input: input.id.clone(),
            command: input.run_command_id.clone(),
            operation: None,
            text: String::new(),
            reasoning: String::new(),
            tools: String::new(),
            sequences: BTreeMap::new(),
            gaps: false,
            cancel_requested: false,
        });
        self.status = format!("Running input {}", input.id);
        vec![self.request(
            Command::RunQueuedAgent {
                session_id: input.session_id,
                input_id: input.id,
            },
            Pending::Run,
        )]
    }
    fn auto(&mut self) -> Vec<Request> {
        if self.halted || self.active.is_some() || self.queue_cursor.is_some() {
            return vec![];
        }
        if let Some(input) = self.queue.iter().find(|q| {
            matches!(
                q.status,
                QueuedAgentStatus::Pending | QueuedAgentStatus::Running
            )
        }) {
            if input.status == QueuedAgentStatus::Pending && self.local.contains(&input.id) {
                return self.start(input.clone());
            }
        }
        vec![]
    }
    fn run_selected(&mut self) -> Vec<Request> {
        if self.active.is_some() {
            self.status = "A turn is already active; cancellation intent remains in effect".into();
            return vec![];
        }
        if self.view != View::Queue {
            return vec![];
        }
        if let Some(input) = self.queue.get(self.selected).cloned() {
            if input.status == QueuedAgentStatus::Pending {
                self.halted = false;
                return self.start(input);
            }
            self.status = "Selected input is not pending; inspect its retained outcome".into();
        }
        vec![]
    }
    fn cancel(&mut self) -> Vec<Request> {
        let Some(session) = self.session.clone() else {
            return vec![];
        };
        if let Some(active) = &mut self.active {
            active.cancel_requested = true;
            let command = active.command.clone();
            self.halted = true;
            return vec![self.request(
                Command::Cancel {
                    session_id: session,
                    execution_id: command,
                },
                Pending::Cancel,
            )];
        }
        if self.view == View::Queue {
            if let Some(input) = self.queue.get(self.selected) {
                if input.status == QueuedAgentStatus::Pending {
                    return vec![self.request(
                        Command::CancelQueuedAgent {
                            session_id: session,
                            input_id: input.id.clone(),
                        },
                        Pending::Cancel,
                    )];
                }
            }
        }
        vec![]
    }
    fn merge_queue(&mut self, input: QueuedAgent) {
        if let Some(old) = self.queue.iter_mut().find(|q| q.id == input.id) {
            if old.status == QueuedAgentStatus::Pending
                || old.status == QueuedAgentStatus::Running
                || input.status != QueuedAgentStatus::Pending
                    && input.status != QueuedAgentStatus::Running
            {
                *old = input;
            }
        } else {
            self.queue.push(input);
        }
        self.queue.sort_by_key(|q| q.sequence);
    }
    pub fn message(&mut self, message: ServerMessage) -> Result<Vec<Request>> {
        match message {
            ServerMessage::Event { event, .. } => {
                let retry_cancel = matches!(&event,ExecutionEvent::Admitted{session_id,command_id,..} if Some(session_id)==self.session.as_ref() && self.active.as_ref().is_some_and(|a|a.cancel_requested&&a.command==*command_id));
                self.event(event);
                Ok(if retry_cancel { self.cancel() } else { vec![] })
            }
            ServerMessage::Response { id, reply, .. } => {
                let Some(RequestId::Text(id)) = id else {
                    return Err(Error::Protocol("uncorrelated app-server response".into()));
                };
                let Some(pending) = self.pending.remove(&id) else {
                    return Err(Error::Protocol("unknown app-server response ID".into()));
                };
                if let Pending::History { session, epoch, .. }
                | Pending::Queue { session, epoch }
                | Pending::Budget { session, epoch } = &pending
                {
                    if Some(session) != self.session.as_ref() || *epoch != self.epoch {
                        return Ok(vec![]);
                    }
                }
                if let Reply::Error { message, .. } = reply.as_ref() {
                    self.status = safe(message);
                    if matches!(pending, Pending::Init) {
                        return Err(Error::Protocol(self.status.clone()));
                    }
                    if matches!(pending, Pending::Run) {
                        self.active = None;
                        self.halted = true;
                        return Ok(self.refresh());
                    }
                    if let Pending::Enqueue { prompt, .. } = pending {
                        if self.composer.is_empty() {
                            self.composer = prompt;
                            self.cursor = self.composer.len();
                        }
                    }
                    return Ok(vec![]);
                }
                let value = serde_json::to_value(reply.as_ref())?;
                match pending {
                    Pending::Init => {
                        if !matches!(
                            reply.as_ref(),
                            Reply::Initialized {
                                protocol_version: PROTOCOL_VERSION,
                                ..
                            }
                        ) {
                            return Err(Error::Protocol("app-server initialization failed".into()));
                        }
                        if self.session.is_some() {
                            Ok(self.refresh())
                        } else {
                            Ok(vec![self.sessions_page()])
                        }
                    }
                    Pending::Sessions => {
                        let page = &value["page"];
                        let rows = page["sessions"]
                            .as_array()
                            .ok_or_else(|| Error::Protocol("missing session page".into()))?;
                        for row in rows {
                            if serde_json::to_vec(row)?.len() > 16384 {
                                return Err(Error::Protocol(
                                    "session display row exceeds terminal bound".into(),
                                ));
                            }
                            if !self.sessions.iter().any(|s| s["id"] == row["id"]) {
                                self.sessions.push(row.clone());
                            }
                        }
                        if self.sessions.len() > 500 {
                            let excess = self.sessions.len() - 500;
                            self.sessions.drain(..excess);
                            self.selected = 0;
                        }
                        self.session_cursor = serde_json::from_value(page["next_cursor"].clone())?;
                        self.status =
                            "Ready — select a session, or n / Ctrl-N to create one".into();
                        Ok(vec![])
                    }
                    Pending::Create => {
                        let session = value["session"]["id"]
                            .as_str()
                            .ok_or_else(|| Error::Protocol("missing created session".into()))?;
                        Ok(self.open(session.into()))
                    }
                    Pending::History { older, .. } => {
                        if !older {
                            self.history.clear();
                            self.history_windowed = false;
                        }
                        let page = &value["page"];
                        let rows = page["entries"]
                            .as_array()
                            .ok_or_else(|| Error::Protocol("missing history page".into()))?;
                        if let Some(first) = rows.first() {
                            if self.latest.as_ref().is_none_or(|latest| {
                                first["sequence"].as_u64() > latest["sequence"].as_u64()
                                    || first["sequence"] == latest["sequence"]
                                        && first["operation_id"] == latest["operation_id"]
                            }) {
                                self.latest = Some(first.clone());
                            }
                        }
                        for row in rows {
                            if serde_json::to_vec(row)?.len() > 128 * 1024 {
                                return Err(Error::Protocol(
                                    "conversation display row exceeds terminal bound".into(),
                                ));
                            }
                            if let Some(old) = self
                                .history
                                .iter_mut()
                                .find(|h| h["operation_id"] == row["operation_id"])
                            {
                                *old = row.clone();
                            } else {
                                self.history.push(row.clone());
                            }
                        }
                        self.history.sort_by_key(|h| {
                            std::cmp::Reverse(h["sequence"].as_u64().unwrap_or(0))
                        });
                        if self.history.len() > 200 {
                            let excess = self.history.len() - 200;
                            self.history.drain(..excess);
                            self.history_windowed = true;
                        }
                        self.history_cursor = page["next_before_sequence"].as_u64();
                        self.history_loaded = true;
                        self.ready();
                        Ok(vec![])
                    }
                    Pending::Queue { session, .. } => {
                        let rows = value["inputs"]
                            .as_array()
                            .ok_or_else(|| Error::Protocol("missing queue page".into()))?;
                        self.queue_cursor = rows.last().and_then(|r| r["sequence"].as_u64());
                        for row in rows {
                            let input: QueuedAgent = serde_json::from_value(row.clone())?;
                            if input.session_id != session {
                                return Err(Error::Protocol("foreign session queue row".into()));
                            }
                            self.merge_queue(input);
                        }
                        // Keep bounded memory without treating a partial page as exhaustion.
                        while self.queue.len() > 200
                            || serde_json::to_vec(&self.queue)?.len() > 8 * 1024 * 1024
                        {
                            if let Some(index) = self.queue.iter().position(|q| {
                                !matches!(
                                    q.status,
                                    QueuedAgentStatus::Pending | QueuedAgentStatus::Running
                                )
                            }) {
                                self.queue.remove(index);
                            } else {
                                self.queue_loaded = false;
                                self.status="Queue exceeds terminal memory limit; manage pending inputs with queue CLI".into();
                                return Err(Error::Protocol(self.status.clone()));
                            }
                        }
                        self.queue_loaded = rows.is_empty();
                        if let Some(after_sequence) = self.queue_cursor {
                            return Ok(vec![self.request(
                                Command::AgentQueue {
                                    session_id: session.clone(),
                                    after_sequence,
                                    limit: 50,
                                },
                                Pending::Queue {
                                    session,
                                    epoch: self.epoch,
                                },
                            )]);
                        }
                        self.ready();
                        Ok(self.auto())
                    }
                    Pending::Budget { .. } => {
                        self.budget = Some(value["budget"].clone());
                        Ok(vec![])
                    }
                    Pending::Enqueue { command, prompt } => {
                        let input: QueuedAgent = serde_json::from_value(value["input"].clone())?;
                        if input.command_id != command
                            || Some(&input.session_id) != self.session.as_ref()
                        {
                            return Err(Error::Protocol(
                                "queued input correlation mismatch".into(),
                            ));
                        }
                        if self.composer == prompt {
                            self.composer.clear();
                            self.cursor = 0;
                        }
                        self.status = format!("Queued input {} — durable", input.id);
                        self.local.insert(input.id.clone());
                        self.merge_queue(input);
                        Ok(self.auto())
                    }
                    Pending::Run => {
                        let Reply::Agent {
                            operation, result, ..
                        } = *reply
                        else {
                            return Err(Error::Protocol("unexpected queued-run response".into()));
                        };
                        let active = self.active.take().ok_or_else(|| {
                            Error::Protocol("run response has no active input".into())
                        })?;
                        if operation.command_id != active.command
                            || Some(&operation.session_id) != self.session.as_ref()
                        {
                            return Err(Error::Protocol("run result correlation mismatch".into()));
                        }
                        self.halted = self.halted
                            || active.cancel_requested
                            || !(operation.status == zero_protocol::OperationStatus::Succeeded
                                && result.as_ref().is_some_and(|r| {
                                    r.status == zero_protocol::agent::AgentStatus::Completed
                                        && r.source_review.is_none()
                                }));
                        if let Some(input) = self.queue.iter_mut().find(|q| q.id == active.input) {
                            input.operation_id = Some(operation.id.clone());
                            input.status = match operation.status {
                                zero_protocol::OperationStatus::Succeeded => {
                                    QueuedAgentStatus::Succeeded
                                }
                                zero_protocol::OperationStatus::Cancelled => {
                                    QueuedAgentStatus::Cancelled
                                }
                                zero_protocol::OperationStatus::Unknown => {
                                    QueuedAgentStatus::Unknown
                                }
                                _ => QueuedAgentStatus::Failed,
                            };
                        }
                        self.local.remove(&active.input);
                        self.status = format!(
                            "Operation {} {:?}{}",
                            operation.id,
                            operation.status,
                            if self.halted {
                                " — inspect journal; pending inputs retained"
                            } else {
                                ""
                            }
                        );
                        let mut out = self.refresh();
                        out.extend(self.auto());
                        Ok(out)
                    }
                    Pending::Cancel => {
                        if let Some(input) = value.get("input") {
                            self.merge_queue(serde_json::from_value(input.clone())?);
                        }
                        self.status = if value.get("accepted") == Some(&Value::Bool(false)) {
                            "Cancellation not accepted yet; saved intent will retry on admission"
                        } else {
                            "Cancellation accepted; waiting for retained result and cleanup"
                        }
                        .into();
                        Ok(vec![])
                    }
                }
            }
        }
    }
    fn ready(&mut self) {
        if self.history_loaded && self.queue_loaded && self.active.is_none() && !self.halted {
            self.status =
                "Ready — Enter queues a prompt; saved pending work needs queue view Ctrl-R".into();
        }
    }
    fn event(&mut self, event: ExecutionEvent) {
        match event {
            ExecutionEvent::Admitted {
                session_id,
                command_id,
                operation_id,
                ..
            } => {
                if Some(&session_id) == self.session.as_ref() {
                    if let Some(active) = &mut self.active {
                        if active.command == command_id {
                            active.operation = Some(operation_id);
                        }
                    }
                }
            }
            ExecutionEvent::ModelProgress {
                session_id,
                operation_id,
                parent_operation_id,
                sequence,
                progress,
            } => {
                if Some(&session_id) != self.session.as_ref() {
                    return;
                }
                let Some(active) = &mut self.active else {
                    return;
                };
                if active.operation.is_none() || parent_operation_id != active.operation {
                    return;
                }
                if active.sequences.len() >= 64 && !active.sequences.contains_key(&operation_id) {
                    active.gaps = true;
                    return;
                }
                let prior = active.sequences.entry(operation_id).or_default();
                if sequence <= *prior {
                    return;
                }
                if sequence != *prior + 1 {
                    active.gaps = true;
                }
                *prior = sequence;
                match progress {
                    ProviderProgress::TextDelta { text, .. } => {
                        bounded_append(&mut active.text, &text)
                    }
                    ProviderProgress::ReasoningDelta { text, .. } => {
                        bounded_append(&mut active.reasoning, &text)
                    }
                    ProviderProgress::RefusalDelta { text, .. } => {
                        bounded_append(&mut active.text, &format!("\nRefusal: {text}"))
                    }
                    ProviderProgress::ToolCallDelta {
                        name_delta,
                        arguments_delta,
                        ..
                    } => {
                        bounded_append(&mut active.tools, &format!("{name_delta}{arguments_delta}"))
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
