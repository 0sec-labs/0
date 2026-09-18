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

#[test]
fn explicit_launch_continuation_applies_to_initial_input_then_follows_local_history() {
    for (status, agent_status, continuable) in [
        ("succeeded", "completed", true),
        ("failed", "turn_limit", true),
        ("unknown", "unknown", false),
        ("failed", "failed", false),
        ("succeeded", "completed", false),
    ] {
        let mut ui = state();
        let mut initial_profile = profile();
        initial_profile.continuation_of = Some("explicit-fork".into());
        ui.options.profile = Some(initial_profile.clone());
        ui.latest = Some(history(1, "older-history", "succeeded", "completed", true));
        ready(&mut ui);
        ui.paste("initial fork prompt");
        let rejected = ui.enqueue();
        assert!(
            matches!(&rejected[0].command, Command::QueueAgent { request, .. }
            if request.continuation_of.as_deref() == Some("explicit-fork"))
        );
        response(
            &mut ui,
            &rejected[0],
            json!({"type":"error","code":"fixture","message":"not admitted"}),
        );
        assert_eq!(
            serde_json::to_value(ui.options.profile.as_ref().unwrap()).unwrap(),
            serde_json::to_value(&initial_profile).unwrap()
        );
        assert_eq!(ui.composer, "initial fork prompt");

        let accepted = ui.enqueue();
        let mut input = queued("initial", 1, QueuedAgentStatus::Pending);
        if let Command::QueueAgent {
            request,
            command_id,
            ..
        } = &accepted[0].command
        {
            assert_eq!(request.continuation_of.as_deref(), Some("explicit-fork"));
            input.request = request.clone();
            input.command_id = command_id.clone();
        } else {
            panic!("expected durable enqueue");
        }
        let run = response(
            &mut ui,
            &accepted[0],
            json!({"type":"agent_queued","input":input,"duplicate":false}),
        );
        initial_profile.continuation_of = None;
        assert_eq!(
            serde_json::to_value(ui.options.profile.as_ref().unwrap()).unwrap(),
            serde_json::to_value(&initial_profile).unwrap()
        );
        let refreshed = response(
            &mut ui,
            &run[0],
            json!({
                "type":"agent", "operation":{"id":"local-outcome","session_id":"session","command_id":"queued:initial","payload":{},"status":status,"owner":null,"outcome":null},
                "result":{"status":agent_status,"text":"outcome","turns":1,"tool_calls":0,"error":null},"duplicate":false
            }),
        );
        initial_profile.continuation_of = None;
        assert_eq!(
            serde_json::to_value(ui.options.profile.as_ref().unwrap()).unwrap(),
            serde_json::to_value(&initial_profile).unwrap(),
            "only the initial anchor changes"
        );
        ui.paste("follow-up prompt");
        assert!(ui.enqueue().is_empty(), "must await fresh retained context");
        response(
            &mut ui,
            &refreshed[0],
            history_reply(json!([history(
                2,
                "local-outcome",
                status,
                agent_status,
                continuable
            )])),
        );
        response(
            &mut ui,
            &refreshed[1],
            json!({"type":"agent_queue","inputs":[]}),
        );

        // Changing sessions and returning must not restore the initial fork.
        ui.open("other-session".into());
        let reopened = ui.open("session".into());
        response(
            &mut ui,
            &reopened[0],
            history_reply(json!([history(
                2,
                "local-outcome",
                status,
                agent_status,
                continuable
            )])),
        );
        response(
            &mut ui,
            &reopened[1],
            json!({"type":"agent_queue","inputs":[]}),
        );
        let next = ui.enqueue();
        if continuable {
            assert!(
                matches!(&next[0].command, Command::QueueAgent { request, after_input: None, .. }
                if request.continuation_of.as_deref() == Some("local-outcome"))
            );
        } else {
            assert!(
                next.is_empty(),
                "unsafe outcomes must not fall back to the initial fork"
            );
            assert!(ui.status.contains("needs recovery"));
            assert_eq!(ui.composer, "follow-up prompt");
        }
    }
}

#[test]
fn worker_error_before_or_after_admission_event_cannot_reuse_initial_anchor() {
    for admission_seen in [false, true] {
        let mut ui = state();
        ui.options.profile.as_mut().unwrap().continuation_of = Some("explicit-fork".into());
        ready(&mut ui);
        let mut input = queued("local", 1, QueuedAgentStatus::Pending);
        input.request.continuation_of = Some("explicit-fork".into());
        ui.queue.push(input.clone());
        let run = ui.start(input);
        if admission_seen {
            ui.event(ExecutionEvent::Admitted {
                session_id: "session".into(),
                command_id: "queued:local".into(),
                operation_id: "local-unknown".into(),
                execution_id: "queued:local".into(),
            });
        }
        let refreshed = response(
            &mut ui,
            &run[0],
            json!({"type":"error","code":"fixture","message":"worker failed"}),
        );
        assert!(
            ui.options
                .profile
                .as_ref()
                .unwrap()
                .continuation_of
                .is_none()
        );
        assert_eq!(
            ui.queue[0].request.continuation_of.as_deref(),
            Some("explicit-fork"),
            "durable input preserves the original retry intent"
        );
        ui.paste("follow-up");
        assert!(
            ui.enqueue().is_empty(),
            "wait for refreshed durable outcome"
        );
        response(
            &mut ui,
            &refreshed[0],
            history_reply(json!([history(
                1,
                "local-unknown",
                "unknown",
                "unknown",
                false
            )])),
        );
        let mut settled = queued("local", 1, QueuedAgentStatus::Unknown);
        settled.operation_id = Some("local-unknown".into());
        let page = response(
            &mut ui,
            &refreshed[1],
            json!({"type":"agent_queue","inputs":[settled]}),
        );
        response(&mut ui, &page[0], json!({"type":"agent_queue","inputs":[]}));
        assert!(ui.enqueue().is_empty());
        assert!(ui.status.contains("needs recovery"));
        assert_eq!(ui.composer, "follow-up");
    }
}

#[test]
fn steering_shortcut_holds_draft_and_remains_bound_after_active_turn_changes() {
    let mut ui = state();
    ready(&mut ui);
    ui.paste("direction λ\nsecond line");
    let ctrl = |c| KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL);
    assert!(ui.key(ctrl('t')).is_empty());
    assert!(!ui.composer.is_empty());
    let _run = ui.start(queued("first", 1, QueuedAgentStatus::Pending));
    assert!(ui.key(ctrl('t')).is_empty(), "unadmitted turn cannot steer");
    ui.active.as_mut().unwrap().operation = Some("root-one".into());
    let actions = ui.key(ctrl('t'));
    let Command::SteerAgent {
        session_id,
        operation_id,
        command_id,
        prompt,
    } = &actions[0].command
    else {
        panic!("steer")
    };
    assert_eq!(operation_id, "root-one");
    let draft = ui.composer.clone();
    ui.paste("not appended");
    ui.key(ctrl('u'));
    ui.key(key(KeyCode::Backspace));
    assert!(ui.key(key(KeyCode::Enter)).is_empty());
    assert!(ui.key(ctrl('n')).is_empty());
    assert_eq!(ui.composer, draft);
    assert!(
        !ui.key(ctrl('x')).is_empty(),
        "cancellation remains available"
    );
    ui.active = None;
    let _ = ui.start(queued("second", 2, QueuedAgentStatus::Pending));
    ui.active.as_mut().unwrap().operation = Some("root-two".into());
    let reads = response(
        &mut ui,
        &actions[0],
        json!({"type":"agent_steered","duplicate":false,"message":{"id":"message","session_id":session_id,"operation_id":operation_id,"command_id":command_id,"sequence":1,"prompt":prompt,"status":"pending","inference_operation_id":null}}),
    );
    assert!(ui.composer.is_empty());
    assert_eq!(ui.steering.target.as_deref(), Some("root-one"));
    assert!(
        matches!(&reads[0].command,Command::AgentSteering{operation_id,..} if operation_id=="root-one")
    );
    let retry_text = "new queued followup";
    ui.paste(retry_text);
    assert!(
        matches!(
            ui.key(key(KeyCode::Enter))[0].command,
            Command::QueueAgent { .. }
        ),
        "Enter keeps queue semantics"
    );
}

#[test]
fn steering_refreshes_on_new_inference_only_and_paste_never_sends() {
    let mut ui = state();
    ready(&mut ui);
    let _ = ui.start(queued("first", 1, QueuedAgentStatus::Pending));
    ui.active.as_mut().unwrap().operation = Some("root".into());
    ui.paste("steer");
    let sent = ui.key(KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL));
    let Command::SteerAgent { command_id, .. } = &sent[0].command else {
        panic!()
    };
    response(
        &mut ui,
        &sent[0],
        json!({"type":"agent_steered","duplicate":false,"message":{"id":"m","session_id":"session","operation_id":"root","command_id":command_id,"sequence":1,"prompt":"steer","status":"pending","inference_operation_id":null}}),
    );
    let event = |op: &str, sequence| ServerMessage::Event {
        protocol_version: PROTOCOL_VERSION,
        event: ExecutionEvent::ModelProgress {
            session_id: "session".into(),
            operation_id: op.into(),
            parent_operation_id: Some("root".into()),
            sequence,
            progress: ProviderProgress::TextDelta {
                item_index: 0,
                content_index: 0,
                text: "visible".into(),
            },
        },
    };
    let refresh = ui.message(event("model-two", 1)).unwrap();
    assert!(matches!(
        refresh[0].command,
        Command::AgentSteering {
            after_sequence: 0,
            ..
        }
    ));
    assert!(ui.message(event("model-two", 2)).unwrap().is_empty());
    assert_eq!(
        ui.steering.messages[0].status,
        zero_protocol::steering::AgentSteeringStatus::Pending
    );
    assert!(!ui.message(event("model-three", 1)).unwrap().is_empty());
}

#[test]
fn reopened_history_loads_retained_steering_without_replacing_an_acknowledged_target() {
    let mut ui = state();
    let reads = ui.refresh();
    let receipt_reads = response(
        &mut ui,
        &reads[0],
        history_reply(json!([history(
            8,
            "reopened",
            "succeeded",
            "completed",
            true
        )])),
    );
    assert!(
        matches!(&receipt_reads[0].command,Command::AgentSteering{operation_id,after_sequence:0,..} if operation_id=="reopened")
    );
    let newer = ui.refresh();
    assert!(
        response(
            &mut ui,
            &newer[0],
            history_reply(json!([history(9, "new-root", "running", "unknown", false)]))
        )
        .is_empty()
    );
    assert_eq!(ui.steering.target.as_deref(), Some("reopened"));
    ui.open("different-session".into());
    response(
        &mut ui,
        &receipt_reads[0],
        json!({"type":"agent_steering","messages":[{"id":"old","session_id":"session","operation_id":"reopened","sequence":1,"command_id":"steer","prompt":"retained","status":"undelivered","inference_operation_id":null}]}),
    );
    assert!(ui.steering.messages.is_empty());
    assert!(ui.steering.target.is_none());
}

#[test]
fn question_overlay_preserves_composer_and_findings_view_and_cancel_remains_global() {
    let mut ui = state();
    ready(&mut ui);
    ui.paste("draft outside question");
    ui.view = View::Findings;
    ui.findings.status = "retained finding context".into();
    ui.key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL));
    assert!(ui.questions.open);
    ui.paste("inert without selected custom field");
    assert_eq!(ui.composer, "draft outside question");
    ui.key(key(KeyCode::Esc));
    assert!(!ui.questions.open);
    assert_eq!(ui.view, View::Findings);
    assert_eq!(ui.findings.status, "retained finding context");
    ui.view = View::Conversation;
    let _ = ui.start(queued("run", 1, QueuedAgentStatus::Pending));
    ui.active.as_mut().unwrap().operation = Some("root".into());
    ui.key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL));
    assert!(
        !ui.key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL))
            .is_empty()
    );
    assert!(ui.active.as_ref().unwrap().cancel_requested);
}

#[test]
fn explicit_session_start_initializes_question_discovery_before_first_hint() {
    let mut ui = state();
    let initial = ui.initialize();
    let requests = response(
        &mut ui,
        &initial,
        json!({"type":"initialized","protocol_version":PROTOCOL_VERSION,"capabilities":[]}),
    );
    assert!(
        requests
            .iter()
            .any(|r| matches!(r.command, Command::OperatorQuestions { .. }))
    );
    let requests = ui
        .message(ServerMessage::Event {
            protocol_version: PROTOCOL_VERSION,
            event: ExecutionEvent::OperatorQuestionRequested {
                session_id: "session".into(),
                root_operation_id: "root".into(),
                actor_operation_id: "child".into(),
                question_operation_id: "question".into(),
            },
        })
        .unwrap();
    assert!(
        matches!(&requests[0].command,Command::OperatorQuestion{question_operation_id,..} if question_operation_id=="question")
    );
    assert!(
        !ui.questions.open,
        "notification must not take keyboard focus"
    );
}

#[test]
fn approval_overlay_preserves_question_draft_and_global_cancel_without_paste_authority() {
    let mut ui = state();
    let initial = ui.initialize();
    let reads = response(
        &mut ui,
        &initial,
        json!({"type":"initialized","protocol_version":PROTOCOL_VERSION,"capabilities":[]}),
    );
    assert!(
        reads
            .iter()
            .any(|r| matches!(r.command, Command::ToolApprovals { .. }))
    );
    ready(&mut ui);
    ui.paste("original conversation λ");
    ui.questions.open = true;
    ui.questions.detail=Some(serde_json::from_value(json!({"operation_id":"question","session_id":"session","actor_operation_id":"root","root_operation_id":"root","sequence":1,"request_sha256":format!("sha256:{}","a".repeat(64)),"request":{"questions":[{"header":"Details","question":"Information?","allow_custom":true}]},"status":"pending","decision":null})).unwrap());
    ui.paste("saved answer λ");
    let before = serde_json::to_value(&ui.questions.draft.as_ref().unwrap().answers).unwrap();
    let requests = ui
        .message(ServerMessage::Event {
            protocol_version: PROTOCOL_VERSION,
            event: ExecutionEvent::ToolApprovalRequested {
                session_id: "session".into(),
                root_operation_id: "root".into(),
                actor_operation_id: "child".into(),
                approval_operation_id: "approval".into(),
            },
        })
        .unwrap();
    assert!(
        matches!(&requests[0].command,Command::ToolApproval{approval_operation_id,..} if approval_operation_id=="approval")
    );
    assert!(ui.questions.open && !ui.approvals.open);
    ui.key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL));
    assert!(ui.approvals.open && !ui.questions.open);
    ui.paste("approve everything\nλ");
    assert!(ui.key(key(KeyCode::Enter)).is_empty());
    assert!(
        ui.key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL))
            .is_empty()
    );
    assert_eq!(ui.composer, "original conversation λ");
    assert_eq!(
        serde_json::to_value(&ui.questions.draft.as_ref().unwrap().answers).unwrap(),
        before
    );
    ui.key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL));
    assert!(ui.questions.open && !ui.approvals.open);
    ui.key(key(KeyCode::Esc));
    let _ = ui.start(queued("run", 1, QueuedAgentStatus::Pending));
    ui.active.as_mut().unwrap().operation = Some("root".into());
    ui.key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL));
    assert!(
        !ui.key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL))
            .is_empty()
    );
    assert!(ui.active.as_ref().unwrap().cancel_requested);
}
#[test]
fn terminal_web_review_leaves_local_followups_pending_after_refresh() {
    let mut ui = state();
    ready(&mut ui);
    let first = queued("one", 1, QueuedAgentStatus::Pending);
    let mut next = queued("two", 2, QueuedAgentStatus::Pending);
    next.after_input = Some(first.id.clone());
    ui.queue = vec![first.clone(), next.clone()];
    ui.local.insert(next.id.clone());
    let run = ui.start(first);
    let report: zero_protocol::web::WebWorkflowReport =
        serde_json::from_str(include_str!("../../zero-report/tests/fixtures/web.json")).unwrap();
    let result = json!({"type":"agent","operation":{"id":"parent","session_id":"session","command_id":"queued:one","payload":{},"status":"succeeded","owner":null,"outcome":null},"result":{"status":"completed","text":"","turns":2,"tool_calls":2,"error":null,"web_review":{"review":report.run.review,"artifacts":report.run.artifacts,"inference_operation":"model-2"}},"duplicate":false});
    let refresh = response(&mut ui, &run[0], result);
    assert!(ui.halted);
    for request in refresh {
        let replies = match request.command {
            Command::SessionHistory { .. } => Some(history_reply(json!([history(
                1,
                "parent",
                "succeeded",
                "completed",
                false
            )]))),
            Command::AgentQueue { .. } => Some(json!({"type":"agent_queue","inputs":[]})),
            _ => None,
        };
        if let Some(reply) = replies {
            let actions = response(&mut ui, &request, reply);
            assert!(
                !actions
                    .iter()
                    .any(|r| matches!(r.command, Command::RunQueuedAgent { .. }))
            );
        }
    }
    // Even if the next local row is supplied by a later queue page, no auto-run.
    ui.merge_queue(next);
    ready(&mut ui);
    assert!(ui.auto().is_empty());
    assert!(ui.active.is_none());
}
#[test]
fn web_view_displays_cancel_acknowledgment_and_retained_final_status() {
    let mut ui = state();
    ready(&mut ui);
    let run = ui.start(queued("active", 1, QueuedAgentStatus::Pending));
    ui.view = View::Web;
    let cancel = ui.cancel();
    assert!(ui.web.status.contains("awaiting acknowledgment"));
    response(
        &mut ui,
        &cancel[0],
        json!({"type":"cancelled","execution_id":"queued:active","accepted":false}),
    );
    assert!(ui.web.status.contains("not accepted"));
    let cancel = ui.cancel();
    response(
        &mut ui,
        &cancel[0],
        json!({"type":"cancelled","execution_id":"queued:active","accepted":true}),
    );
    assert!(
        ui.web
            .status
            .contains("waiting for retained result and cleanup")
    );
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(140, 38)).unwrap();
    terminal
        .draw(|frame| crate::render::draw(frame, &ui))
        .unwrap();
    let text = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect::<String>();
    assert!(text.contains("Cancellation accepted"));
    response(
        &mut ui,
        &run[0],
        json!({"type":"agent","operation":{"id":"parent","session_id":"session","command_id":"queued:active","payload":{},"status":"unknown","owner":null,"outcome":null},"result":{"status":"unknown","text":"","turns":1,"tool_calls":1,"error":"Uncertain"},"duplicate":false}),
    );
    assert!(ui.web.status.contains("Unknown"));
    assert!(ui.web.status.contains("pending inputs retained"));
    assert!(ui.halted);
}

#[test]
fn web_view_does_not_hide_cancel_rejection_or_worker_error() {
    let mut ui = state();
    ready(&mut ui);
    let run = ui.start(queued("active", 1, QueuedAgentStatus::Pending));
    ui.view = View::Web;
    let cancel = ui.cancel();
    response(
        &mut ui,
        &cancel[0],
        json!({"type":"error","code":"state","message":"Cancellation command rejected"}),
    );
    assert!(ui.web.status.contains("Cancellation command rejected"));
    response(
        &mut ui,
        &run[0],
        json!({"type":"error","code":"state","message":"Worker settlement unavailable; inspect retained journal"}),
    );
    assert!(ui.web.status.contains("Worker settlement unavailable"));
    assert!(ui.halted);
    assert!(ui.active.is_none());
}
fn terminal_reply(command: &str) -> Value {
    json!({"type":"agent","operation":{"id":"settled-root","session_id":"session","command_id":command,"payload":{},"status":"succeeded","owner":null,"outcome":null},"result":{"status":"completed","text":"finished","turns":1,"tool_calls":0,"error":null},"duplicate":false})
}
#[test]
fn budget_reads_coalesce_without_invalidating_history_and_error_keeps_old_snapshot() {
    let mut ui = state();
    ready(&mut ui);
    ui.start(queued("active", 1, QueuedAgentStatus::Pending));
    let now = Instant::now();
    let epoch = ui.epoch;
    let first = ui.tick(now);
    assert_eq!(first.len(), 1);
    for _ in 0..100 {
        assert!(ui.tick(now + Duration::from_secs(3)).is_empty());
    }
    assert!(ui.history_loaded && ui.queue_loaded);
    assert_eq!(ui.epoch, epoch);
    assert!(ui.refresh_budget().is_empty());
    let next = response(
        &mut ui,
        &first[0],
        json!({"type":"session_budget","budget":{"limit":100,"charged":0,"reserved":10}}),
    );
    assert_eq!(
        next.len(),
        1,
        "one followup for dirty transition while previous read pending"
    );
    assert!(ui.budget_label(Instant::now()).contains("10 reserved"));
    response(
        &mut ui,
        &next[0],
        json!({"type":"error","code":"state","message":"read unavailable"}),
    );
    let label = ui.budget_label(Instant::now() + Duration::from_secs(4));
    assert!(
        label.contains("4s ago")
            && label.contains("refresh failed")
            && label.contains("previous snapshot")
            && label.contains("10 reserved")
    );
    assert!(ui.active.is_some());
    assert!(!ui.halted);
    assert!(ui.history_loaded && ui.queue_loaded);
    let manual = ui.key(key(KeyCode::F(2)));
    assert_eq!(manual.len(), 1);
    response(
        &mut ui,
        &manual[0],
        json!({"type":"session_budget","budget":{"limit":100,"charged":120,"reserved":0}}),
    );
    let label = ui.budget_label(Instant::now());
    assert!(label.contains("120 charged") && label.contains("allowance exhausted"));
    assert!(!label.contains("failed"));
}
#[test]
fn late_cancel_ack_never_replaces_terminal_status_or_labels_a_new_run_cancelled() {
    for accepted in [false, true] {
        let mut ui = state();
        ready(&mut ui);
        let run = ui.start(queued("first", 1, QueuedAgentStatus::Pending));
        let cancel = ui.cancel();
        response(&mut ui, &run[0], terminal_reply("queued:first"));
        let terminal = ui.status.clone();
        let notice = ui.lifecycle_label().unwrap().to_owned();
        assert!(ui.halted);
        response(
            &mut ui,
            &cancel[0],
            json!({"type":"cancelled","execution_id":"queued:first","accepted":accepted}),
        );
        assert_eq!(ui.status, terminal);
        assert_eq!(ui.lifecycle_label(), Some(notice.as_str()));
        let run = ui.start(queued("second", 2, QueuedAgentStatus::Pending));
        let cancel = ui.cancel();
        response(&mut ui, &run[0], terminal_reply("queued:second"));
        ui.start(queued("third", 3, QueuedAgentStatus::Pending));
        let active = ui.status.clone();
        response(
            &mut ui,
            &cancel[0],
            json!({"type":"cancelled","execution_id":"queued:second","accepted":accepted}),
        );
        assert_eq!(ui.status, active);
        assert!(!ui.active.as_ref().unwrap().cancel_requested);
        assert!(ui.lifecycle_label().unwrap().contains("queued:third"));
    }
}
#[test]
fn cancellation_replies_require_exact_target_and_queue_cancel_reports_queue_status() {
    let mut ui = state();
    ui.start(queued("active", 1, QueuedAgentStatus::Pending));
    let cancel = ui.cancel();
    let wrong: Reply = serde_json::from_value(
        json!({"type":"cancelled","execution_id":"foreign","accepted":true}),
    )
    .unwrap();
    assert!(
        ui.message(ServerMessage::Response {
            protocol_version: PROTOCOL_VERSION,
            id: Some(cancel[0].id.clone()),
            reply: Box::new(wrong)
        })
        .is_err()
    );
    let mut ui = state();
    ui.view = View::Queue;
    ui.queue
        .push(queued("pending", 1, QueuedAgentStatus::Pending));
    let cancel = ui.cancel();
    response(
        &mut ui,
        &cancel[0],
        json!({"type":"agent_input","input":queued("pending",1,QueuedAgentStatus::Cancelled)}),
    );
    assert!(ui.status.contains("Queued input pending: Cancelled"));
    assert!(!ui.status.contains("waiting"));
    assert_eq!(ui.queue[0].status, QueuedAgentStatus::Cancelled);
}
#[test]
fn cancellation_lifecycle_remains_visible_over_help_questions_and_approvals() {
    for overlay in 0..3 {
        let mut ui = state();
        ui.composer = "preserved draft λ".into();
        let run = ui.start(queued("active", 1, QueuedAgentStatus::Pending));
        match overlay {
            0 => ui.help = true,
            1 => ui.questions.open = true,
            _ => ui.approvals.open = true,
        }
        let cancel = ui.key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
        response(
            &mut ui,
            &cancel[0],
            json!({"type":"cancelled","execution_id":"queued:active","accepted":true}),
        );
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(140, 38)).unwrap();
        terminal.draw(|f| crate::render::draw(f, &ui)).unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>();
        assert!(text.contains("Cancellation accepted") && text.contains("queued:active"));
        response(&mut ui, &run[0], terminal_reply("queued:active"));
        terminal.draw(|f| crate::render::draw(f, &ui)).unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>();
        assert!(text.contains("Succeeded") && !text.contains("waiting for retained result"));
        assert_eq!(ui.composer, "preserved draft λ");
        assert!(match overlay {
            0 => ui.help,
            1 => ui.questions.open,
            _ => ui.approvals.open,
        });
    }
}
#[test]
fn snapshot_freshness_and_failure_are_visible_on_an_eighty_column_terminal() {
    let mut ui = state();
    let request = ui.refresh_budget();
    response(
        &mut ui,
        &request[0],
        json!({"type":"session_budget","budget":{"limit":1000000,"charged":12345,"reserved":20000}}),
    );
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
    terminal.draw(|f| crate::render::draw(f, &ui)).unwrap();
    let text = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect::<String>();
    assert!(text.contains("received 0s ago"));
    let request = ui.refresh_budget();
    response(
        &mut ui,
        &request[0],
        json!({"type":"error","code":"state","message":"temporarily unavailable"}),
    );
    terminal.draw(|f| crate::render::draw(f, &ui)).unwrap();
    let text = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect::<String>();
    assert!(text.contains("received 0s ago") && text.contains("refresh failed"));
}
#[test]
fn older_rejected_cancel_ack_cannot_downgrade_an_accepted_cancellation() {
    let mut ui = state();
    ui.start(queued("active", 1, QueuedAgentStatus::Pending));
    let old = ui.cancel();
    let newer = ui.cancel();
    response(
        &mut ui,
        &newer[0],
        json!({"type":"cancelled","execution_id":"queued:active","accepted":true}),
    );
    let accepted = ui.status.clone();
    response(
        &mut ui,
        &old[0],
        json!({"type":"cancelled","execution_id":"queued:active","accepted":false}),
    );
    assert_eq!(ui.status, accepted);
    assert!(ui.status.contains("Cancellation accepted"));
    assert!(ui.cancel().is_empty());
    assert!(ui.active.as_ref().unwrap().cancel_requested && ui.halted);
}
