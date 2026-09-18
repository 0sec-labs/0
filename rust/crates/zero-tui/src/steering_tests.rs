#![allow(clippy::unwrap_used)]
use super::*;
fn receipt(pending: &Pending, status: AgentSteeringStatus) -> AgentSteeringMessage {
    let Pending::Send(intent) = pending else {
        panic!("send expected")
    };
    AgentSteeringMessage {
        id: "message-1".into(),
        session_id: intent.session.clone(),
        operation_id: intent.operation.clone(),
        sequence: 1,
        command_id: intent.command.clone(),
        prompt: intent.prompt.clone(),
        inference_operation_id: if status == AgentSteeringStatus::Captured {
            Some("inference-1".into())
        } else {
            None
        },
        status,
    }
}
#[test]
fn explicit_admitted_target_exact_retry_and_held_draft_acknowledgment() {
    let mut state = Steering::default();
    assert!(state.send(Some("session"), None, "text").is_empty());
    assert!(
        state
            .send(Some("session"), Some("root"), &"x".repeat(16385))
            .is_empty()
    );
    let first = state
        .send(Some("session"), Some("root"), "λ\nkeep exact ")
        .pop()
        .unwrap();
    assert!(state.sending);
    assert!(
        state
            .send(Some("session"), Some("root"), "other")
            .is_empty()
    );
    assert!(
        state
            .reply(
                first.pending.clone(),
                Reply::Error {
                    code: "busy".into(),
                    message: "try again".into()
                }
            )
            .unwrap()
            .1
            .is_none()
    );
    let retry = state
        .send(Some("session"), Some("root"), "λ\nkeep exact ")
        .pop()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&first.command).unwrap(),
        serde_json::to_value(&retry.command).unwrap()
    );
    let message = receipt(&retry.pending, AgentSteeringStatus::Pending);
    let (reads, clear) = state
        .reply(
            retry.pending,
            Reply::AgentSteered {
                message,
                duplicate: true,
            },
        )
        .unwrap();
    assert_eq!(clear.as_deref(), Some("λ\nkeep exact "));
    assert!(!state.sending);
    assert!(matches!(
        reads[0].command,
        Command::AgentSteering {
            after_sequence: 0,
            ..
        }
    ));
    assert_eq!(state.messages[0].status, AgentSteeringStatus::Pending);
    assert!(state.notice.contains("exact retry"));
}
#[test]
fn bounded_pages_refresh_mutable_statuses_without_downgrade_or_cross_target_mix() {
    let mut state = Steering::default();
    let action = state
        .send(Some("s"), Some("old-root"), "note")
        .pop()
        .unwrap();
    let pending = receipt(&action.pending, AgentSteeringStatus::Pending);
    let (mut reads, _) = state
        .reply(
            action.pending,
            Reply::AgentSteered {
                message: pending.clone(),
                duplicate: false,
            },
        )
        .unwrap();
    let stale = reads[0].pending.clone();
    let captured = AgentSteeringMessage {
        status: AgentSteeringStatus::Captured,
        inference_operation_id: Some("model".into()),
        ..pending.clone()
    };
    let next = state
        .reply(
            reads.remove(0).pending,
            Reply::AgentSteering {
                messages: vec![captured],
            },
        )
        .unwrap()
        .0;
    assert!(matches!(
        next[0].command,
        Command::AgentSteering {
            after_sequence: 1,
            ..
        }
    ));
    assert!(
        state
            .reply(
                next[0].pending.clone(),
                Reply::AgentSteering { messages: vec![] }
            )
            .unwrap()
            .0
            .is_empty()
    );
    let refresh = state.refresh();
    state
        .reply(
            refresh[0].pending.clone(),
            Reply::AgentSteering {
                messages: vec![pending.clone()],
            },
        )
        .unwrap();
    assert_eq!(state.messages[0].status, AgentSteeringStatus::Captured);
    state.send(Some("s"), Some("new-root"), "new");
    state
        .reply(
            stale,
            Reply::AgentSteering {
                messages: vec![pending],
            },
        )
        .unwrap();
    assert!(state.messages.is_empty());
    assert_eq!(state.target.as_deref(), Some("new-root"));
}
#[test]
fn forged_ack_and_terminal_status_contradictions_fail_closed() {
    for tamper in 0..4 {
        let mut state = Steering::default();
        let action = state.send(Some("s"), Some("root"), "note").pop().unwrap();
        let mut message = receipt(&action.pending, AgentSteeringStatus::Pending);
        match tamper {
            0 => message.operation_id = "other".into(),
            1 => message.command_id = "other".into(),
            2 => message.prompt = "changed".into(),
            _ => message.status = AgentSteeringStatus::Captured,
        };
        assert!(
            state
                .reply(
                    action.pending,
                    Reply::AgentSteered {
                        message,
                        duplicate: false
                    }
                )
                .is_err()
        );
        assert!(state.messages.is_empty());
    }
    let mut state = Steering::default();
    let action = state.send(Some("s"), Some("root"), "note").pop().unwrap();
    let message = receipt(&action.pending, AgentSteeringStatus::Captured);
    let (reads, _) = state
        .reply(
            action.pending,
            Reply::AgentSteered {
                message: message.clone(),
                duplicate: false,
            },
        )
        .unwrap();
    let wrong = AgentSteeringMessage {
        status: AgentSteeringStatus::Undelivered,
        inference_operation_id: None,
        ..message
    };
    assert!(
        state
            .reply(
                reads[0].pending.clone(),
                Reply::AgentSteering {
                    messages: vec![wrong]
                }
            )
            .is_err()
    );
}

#[test]
fn rejected_send_keeps_exact_target_and_command_after_idle_or_new_root() {
    let mut state = Steering::default();
    let first = state
        .send(Some("s"), Some("old-root"), "unchanged")
        .pop()
        .unwrap();
    let original = serde_json::to_value(&first.command).unwrap();
    let Pending::Send(original_intent) = &first.pending else {
        panic!("send expected")
    };
    for active in [None, Some("next-root"), None] {
        let pending = state.retry.as_ref().unwrap().clone();
        state
            .reply(
                Pending::Send(pending),
                Reply::Error {
                    code: "uncertain".into(),
                    message: "retry".into(),
                },
            )
            .unwrap();
        let retry = state.send(Some("s"), active, "unchanged").pop().unwrap();
        assert_eq!(serde_json::to_value(&retry.command).unwrap(), original);
        assert_eq!(state.target.as_deref(), Some("old-root"));
    }
    state
        .reply(
            Pending::Send(state.retry.clone().unwrap()),
            Reply::Error {
                code: "late".into(),
                message: "sealed".into(),
            },
        )
        .unwrap();
    assert!(state.send(Some("s"), None, "changed").is_empty());
    let fresh = state
        .send(Some("s"), Some("next-root"), "changed")
        .pop()
        .unwrap();
    assert!(
        matches!(&fresh.command,Command::SteerAgent{operation_id,command_id,..} if operation_id=="next-root" && command_id!=&original_intent.command)
    );
}
