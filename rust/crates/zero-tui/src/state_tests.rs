#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
fn profile() -> zero_protocol::agent::AgentRequest {
    serde_json::from_value(json!({"provider":"fixture","model":"fixture","instructions":"host authority","prompt":"MUST_NOT_AUTO_EXECUTE","execution":{"execution_id":"fixture","image":"local:fixture","snapshot":{"id":"pin","root":"/private/source","digest":format!("sha256:{}","0".repeat(64)),"files":[]},"argv":["unused"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024},"max_turns":3,"reservation_per_turn":10})).unwrap()
}
fn state() -> State {
    State::new(Options {
        session: Some("session".into()),
        profile: Some(profile()),
        budget_limit: 100,
    })
}
fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
fn response(state: &mut State, request: &Request, reply: Value) -> Vec<Request> {
    state
        .message(ServerMessage::Response {
            protocol_version: PROTOCOL_VERSION,
            id: Some(request.id.clone()),
            reply: Box::new(serde_json::from_value(reply).unwrap()),
        })
        .unwrap()
}
fn history(
    sequence: u64,
    operation: &str,
    status: &str,
    agent_status: &str,
    continuable: bool,
) -> Value {
    json!({"sequence":sequence,"operation_id":operation,"command_id":format!("command-{operation}"),"status":status,"agent_status":agent_status,"continuable":continuable,"prompt":{"text":"saved user","truncated":false},"reply_text":{"text":"saved answer","truncated":false},"error":null,"tool_calls":0})
}
fn history_reply(entries: Value) -> Value {
    json!({"type":"session_history","page":{"entries":entries,"next_before_sequence":null}})
}
fn queued(id: &str, sequence: u64, status: QueuedAgentStatus) -> QueuedAgent {
    QueuedAgent {
        id: id.into(),
        session_id: "session".into(),
        sequence,
        command_id: format!("command-{id}"),
        request: profile(),
        after_input: None,
        run_command_id: format!("queued:{id}"),
        resolved_request: None,
        status,
        operation_id: None,
    }
}
fn ready(state: &mut State) {
    state.history_loaded = true;
    state.queue_loaded = true;
}
#[test]
fn unicode_paste_is_inert_and_failed_enqueue_keeps_original_draft() {
    let mut ui = state();
    ready(&mut ui);
    assert!(ui.composer.is_empty());
    ui.paste("héllo 世界\r\nsecond\u{1b}[31m");
    assert!(ui.pending.is_empty());
    assert_eq!(ui.composer, "héllo 世界\nsecond[31m");
    let requests = ui.key(key(KeyCode::Enter));
    assert_eq!(requests.len(), 1);
    let command = match &requests[0].command {
        Command::QueueAgent {
            request,
            command_id,
            ..
        } => {
            assert_eq!(request.prompt, ui.composer);
            assert_eq!(request.instructions, "host authority");
            command_id
        }
        other => panic!("{other:?}"),
    };
    assert!(uuid::Uuid::parse_str(command).is_ok());
    let draft = ui.composer.clone();
    ui.paste("new draft");
    ui.key(key(KeyCode::Backspace));
    assert_eq!(ui.composer, draft);
    response(
        &mut ui,
        &requests[0],
        json!({"type":"error","code":"fixture","message":"queue rejected"}),
    );
    assert_eq!(ui.composer, draft);
    ui.key(key(KeyCode::Left));
    ui.key(key(KeyCode::Backspace));
    assert!(ui.composer.is_char_boundary(ui.cursor));
}
#[test]
fn short_queue_page_is_not_exhaustion_and_saved_pending_never_autoruns() {
    let mut ui = state();
    ui.history_loaded = true;
    let request = ui.request(
        Command::AgentQueue {
            session_id: "session".into(),
            after_sequence: 0,
            limit: 50,
        },
        Pending::Queue {
            session: "session".into(),
            epoch: ui.epoch,
        },
    );
    let next = response(
        &mut ui,
        &request,
        json!({"type":"agent_queue","inputs":[queued("saved",1,QueuedAgentStatus::Pending)]}),
    );
    assert_eq!(next.len(), 1);
    assert!(!ui.queue_loaded);
    assert!(matches!(
        next[0].command,
        Command::AgentQueue {
            after_sequence: 1,
            ..
        }
    ));
    let after = response(&mut ui, &next[0], json!({"type":"agent_queue","inputs":[]}));
    assert!(after.is_empty());
    assert!(ui.queue_loaded);
    assert!(ui.active.is_none());
    ui.paste("follow up");
    let enqueued = ui.enqueue();
    assert!(
        matches!(&enqueued[0].command,Command::QueueAgent{after_input:Some(id),..} if id=="saved")
    );
    ui.options.profile = None;
    response(
        &mut ui,
        &enqueued[0],
        json!({"type":"error","code":"fixture","message":"rejected"}),
    );
    assert!(ui.enqueue().is_empty());
}
#[test]
fn stale_session_reads_cannot_mix_history_queue_or_budget() {
    let mut ui = state();
    let old = ui.refresh();
    ui.open("other".into());
    response(
        &mut ui,
        &old[0],
        history_reply(json!([history(1, "old", "succeeded", "completed", true)])),
    );
    response(
        &mut ui,
        &old[1],
        json!({"type":"agent_queue","inputs":[queued("old",1,QueuedAgentStatus::Pending)]}),
    );
    response(
        &mut ui,
        &old[2],
        json!({"type":"session_budget","budget":{"limit":99,"charged":1,"reserved":1}}),
    );
    assert!(ui.history.is_empty());
    assert!(ui.queue.is_empty());
    assert!(ui.budget.is_none());
    assert!(!ui.queue_loaded);
}
#[test]
fn newest_direct_turn_and_same_sequence_terminal_refresh_determine_continuation() {
    let mut ui = state();
    ready(&mut ui);
    let mut older = queued("older", 1, QueuedAgentStatus::Succeeded);
    older.operation_id = Some("old-op".into());
    ui.queue.push(older);
    ui.queue.push(queued(
        "cancelled-undispatched",
        2,
        QueuedAgentStatus::Cancelled,
    ));
    let reads = ui.refresh();
    response(
        &mut ui,
        &reads[0],
        history_reply(json!([history(7, "newest", "running", "unknown", false)])),
    );
    ui.paste("follow up");
    response(
        &mut ui,
        &reads[1],
        json!({"type":"agent_queue","inputs":[]}),
    );
    assert!(ui.enqueue().is_empty());
    let reads = ui.refresh();
    response(
        &mut ui,
        &reads[0],
        history_reply(json!([history(
            7,
            "newest",
            "succeeded",
            "completed",
            true
        )])),
    );
    response(
        &mut ui,
        &reads[1],
        json!({"type":"agent_queue","inputs":[]}),
    );
    let requests = ui.enqueue();
    assert_eq!(requests.len(), 1);
    assert!(
        matches!(&requests[0].command,Command::QueueAgent{request,after_input:None,..} if request.continuation_of.as_deref()==Some("newest"))
    );
    response(
        &mut ui,
        &requests[0],
        json!({"type":"error","code":"fixture","message":"retry draft"}),
    );
    let reads = ui.refresh();
    response(
        &mut ui,
        &reads[0],
        history_reply(json!([history(
            8,
            "source-terminal",
            "succeeded",
            "completed",
            false
        )])),
    );
    response(
        &mut ui,
        &reads[1],
        json!({"type":"agent_queue","inputs":[]}),
    );
    assert!(ui.enqueue().is_empty());
    assert_eq!(ui.composer, "follow up");
}
#[test]
fn pending_mutations_block_session_switch_and_duplicate_create() {
    let mut ui = state();
    ready(&mut ui);
    ui.paste("durable intent");
    let request = ui.enqueue();
    assert!(!request.is_empty());
    assert!(ui.open("other".into()).is_empty());
    assert!(ui.new_session().is_empty());
    assert_eq!(ui.session.as_deref(), Some("session"));
    response(
        &mut ui,
        &request[0],
        json!({"type":"error","code":"fixture","message":"rejected"}),
    );
    let create = ui.new_session();
    assert_eq!(create.len(), 1);
    assert!(ui.new_session().is_empty());
    assert!(ui.open("other".into()).is_empty());
}
#[test]
fn local_ack_drains_fifo_and_late_or_foreign_progress_is_ignored() {
    let mut ui = state();
    ready(&mut ui);
    ui.paste("first");
    let first = ui.enqueue();
    let mut one = queued("one", 1, QueuedAgentStatus::Pending);
    if let Command::QueueAgent {
        command_id,
        request,
        ..
    } = &first[0].command
    {
        one.command_id = command_id.clone();
        one.request = request.clone();
    }
    let run = response(
        &mut ui,
        &first[0],
        json!({"type":"agent_queued","input":one,"duplicate":false}),
    );
    assert_eq!(run.len(), 1);
    assert!(ui.composer.is_empty());
    assert!(ui.active.is_some());
    ui.event(ExecutionEvent::Admitted {
        session_id: "session".into(),
        command_id: "queued:one".into(),
        operation_id: "parent".into(),
        execution_id: "queued:one".into(),
    });
    let progress = |parent: &str, seq| ExecutionEvent::ModelProgress {
        session_id: "session".into(),
        operation_id: "child".into(),
        parent_operation_id: Some(parent.into()),
        sequence: seq,
        progress: ProviderProgress::TextDelta {
            item_index: 0,
            content_index: 0,
            text: "δ".into(),
        },
    };
    ui.event(progress("foreign", 1));
    assert!(ui.active.as_ref().unwrap().text.is_empty());
    ui.event(progress("parent", 2));
    assert_eq!(ui.active.as_ref().unwrap().text, "δ");
    assert!(ui.active.as_ref().unwrap().gaps);
    ui.event(progress("parent", 2));
    assert_eq!(ui.active.as_ref().unwrap().text, "δ");
    ui.paste("second");
    let second = ui.enqueue();
    let mut two = queued("two", 2, QueuedAgentStatus::Pending);
    if let Command::QueueAgent {
        command_id,
        request,
        after_input,
        ..
    } = &second[0].command
    {
        assert_eq!(after_input.as_deref(), Some("one"));
        two.command_id = command_id.clone();
        two.request = request.clone();
        two.after_input = after_input.clone();
    }
    assert!(
        response(
            &mut ui,
            &second[0],
            json!({"type":"agent_queued","input":two,"duplicate":false})
        )
        .is_empty()
    );
    ui.cancel(); // Explicit cancellation must stop automatic draining even if completion wins the race.
    ui.view = View::Queue;
    ui.selected = 0;
    assert!(ui.run_selected().is_empty());
    assert!(ui.halted);
    let result = json!({"type":"agent","operation":{"id":"parent","session_id":"session","command_id":"queued:one","payload":{},"status":"succeeded","owner":null,"outcome":null},"result":{"status":"completed","text":"done","turns":1,"tool_calls":0,"error":null},"duplicate":false});
    let actions = response(&mut ui, &run[0], result);
    assert!(
        !actions
            .iter()
            .any(|r| matches!(r.command, Command::RunQueuedAgent { .. }))
    );
    assert!(ui.active.is_none());
    ui.event(progress("parent", 3));
    assert!(ui.active.is_none());
    assert_eq!(ui.queue[1].status, QueuedAgentStatus::Pending);
}
#[test]
fn renderer_handles_unicode_hostile_control_text_and_small_resizes() {
    let mut ui = state();
    ready(&mut ui);
    ui.paste("Unicode 世界\nline two");
    ui.status = "\u{1b}]0;injection\u{7}".into();
    for (width, height) in [(100, 30), (25, 8), (1, 1)] {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = ratatui::Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| crate::render::draw(frame, &ui))
            .unwrap();
        let buffer = terminal.backend().buffer();
        for cell in &buffer.content {
            assert!(!cell.symbol().contains('\u{1b}'));
        }
    }
}

#[test]
fn refresh_epoch_blocks_old_context_until_current_history_and_queue_are_loaded() {
    let mut ui = state();
    ready(&mut ui);
    ui.latest = Some(history(1, "old", "succeeded", "completed", true));
    let stale = ui.refresh();
    let current = ui.refresh();
    ui.paste("must include just-completed turn");
    assert!(ui.enqueue().is_empty());
    response(
        &mut ui,
        &current[0],
        history_reply(json!([history(2, "new", "succeeded", "completed", true)])),
    );
    assert!(ui.enqueue().is_empty(), "queue snapshot not yet exhausted");
    response(
        &mut ui,
        &stale[0],
        history_reply(json!([history(1, "old", "running", "unknown", false)])),
    );
    response(
        &mut ui,
        &stale[1],
        json!({"type":"agent_queue","inputs":[queued("stale",1,QueuedAgentStatus::Pending)]}),
    );
    response(
        &mut ui,
        &stale[2],
        json!({"type":"session_budget","budget":{"limit":99,"charged":99,"reserved":0}}),
    );
    assert_eq!(ui.latest.as_ref().unwrap()["operation_id"], "new");
    assert!(ui.queue.is_empty());
    assert!(ui.budget.is_none());
    response(
        &mut ui,
        &current[1],
        json!({"type":"agent_queue","inputs":[]}),
    );
    let commands = ui.enqueue();
    assert!(
        matches!(&commands[0].command,Command::QueueAgent{request,..} if request.continuation_of.as_deref()==Some("new"))
    );
}

#[test]
fn cancellation_intent_retries_on_admission_and_does_not_claim_false_acceptance() {
    let mut ui = state();
    ready(&mut ui);
    ui.start(queued("active", 1, QueuedAgentStatus::Pending));
    let cancel = ui.cancel();
    response(
        &mut ui,
        &cancel[0],
        json!({"type":"cancelled","execution_id":"queued:active","accepted":false}),
    );
    assert!(ui.status.contains("not accepted"));
    let actions = ui
        .message(ServerMessage::Event {
            protocol_version: PROTOCOL_VERSION,
            event: ExecutionEvent::Admitted {
                session_id: "session".into(),
                command_id: "queued:active".into(),
                operation_id: "parent".into(),
                execution_id: "queued:active".into(),
            },
        })
        .unwrap();
    assert!(
        matches!(&actions[0].command,Command::Cancel{execution_id,..} if execution_id=="queued:active")
    );
    assert!(ui.halted);
}
