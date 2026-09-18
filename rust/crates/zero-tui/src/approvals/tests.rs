#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
fn record(id: &str, sequence: u64) -> ToolApprovalRecord {
    serde_json::from_value(json!({"operation_id":id,"session_id":"session","actor_operation_id":"actor","root_operation_id":"root","sequence":sequence,"intent_sha256":format!("sha256:{}","a".repeat(64)),"intent_artifact":format!("sha256:{}","a".repeat(64)),"tool_name":"execute_snapshot","preview":"argv: [\"echo\",\"λ\"]\nbackend: docker; offline; memory_mb: 128","preview_truncated":false,"status":"pending","operation_status":"running","decision":null,"consumption":null,"effect_status":null})).unwrap()
}
fn key(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}
fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}
fn setup() -> Approvals {
    let mut state = Approvals::default();
    let a = state.initialize("session").pop().unwrap();
    state
        .reply(
            a.pending,
            Reply::ToolApprovals {
                approvals: vec![record("approval", 1)],
            },
        )
        .unwrap();
    state.open = true;
    state
}
fn inspect(state: &mut Approvals) {
    let a = state.key(key(KeyCode::Enter)).pop().unwrap();
    state
        .reply(
            a.pending,
            Reply::ToolApproval {
                approval: record("approval", 1),
            },
        )
        .unwrap();
}
fn acknowledged(state: &mut Approvals, pending: Pending) -> Vec<Action> {
    let Pending::Decision(ref intent) = pending else {
        panic!()
    };
    let receipt = ToolApprovalDecisionReceipt {
        id: "decision".into(),
        session_id: intent.session.clone(),
        command_id: intent.command.clone(),
        approval_operation_id: intent.approval.clone(),
        intent_sha256: intent.digest.clone(),
        decision: intent.decision,
        sequence: 3,
    };
    let approval = ToolApprovalRecord {
        status: if intent.decision == ToolApprovalDecision::Approve {
            ToolApprovalStatus::Approved
        } else {
            ToolApprovalStatus::Denied
        },
        decision: Some(receipt.clone()),
        ..record("approval", 1)
    };
    state
        .reply(
            pending,
            Reply::ToolApprovalDecided {
                approval,
                decision: receipt,
                duplicate: false,
            },
        )
        .unwrap()
}
#[test]
fn approval_requires_detail_and_dedicated_key_frozen_retry_and_deny_are_distinct() {
    let mut s = setup();
    assert!(s.key(ctrl('a')).is_empty());
    assert!(s.key(ctrl('s')).is_empty());
    inspect(&mut s);
    for k in [
        key(KeyCode::Enter),
        key(KeyCode::Char(' ')),
        key(KeyCode::Char('y')),
        ctrl('s'),
    ] {
        assert!(s.key(k).is_empty());
    }
    let a = s.key(ctrl('a')).pop().unwrap();
    let original = serde_json::to_value(&a.command).unwrap();
    assert!(matches!(
        a.command,
        Command::DecideToolApproval {
            decision: ToolApprovalDecision::Approve,
            ..
        }
    ));
    assert!(s.blocks_navigation());
    s.reply(
        a.pending,
        Reply::Error {
            code: "conflict".into(),
            message: "ambiguous acknowledgment".into(),
        },
    )
    .unwrap();
    assert!(s.key(ctrl('d')).is_empty());
    s.key(key(KeyCode::Esc));
    assert!(!s.open);
    s.toggle(Some("session"));
    let retry = s.key(ctrl('a')).pop().unwrap();
    assert_eq!(serde_json::to_value(&retry.command).unwrap(), original);
    acknowledged(&mut s, retry.pending);
    assert!(!s.blocks_navigation());
    assert!(s.notice.contains("not proof of execution"));
}
#[test]
fn stale_pending_and_approved_cannot_regress_consumed_or_mutate_intent() {
    let mut s = setup();
    inspect(&mut s);
    let a = s.key(ctrl('a')).pop().unwrap();
    acknowledged(&mut s, a.pending);
    let mut consumed = s.detail.clone().unwrap();
    consumed.status = ToolApprovalStatus::Consumed;
    consumed.consumption = Some(ToolApprovalConsumption {
        effect_operation_id: "effect".into(),
        effect_command_id: "run".into(),
        effect_payload_sha256: "b".repeat(64),
        sequence: 4,
    });
    consumed.effect_status = Some(zero_protocol::OperationStatus::Succeeded);
    let a = s.get("approval", true).pop().unwrap();
    s.reply(
        a.pending,
        Reply::ToolApproval {
            approval: consumed.clone(),
        },
    )
    .unwrap();
    let a = s.get("approval", true).pop().unwrap();
    s.reply(
        a.pending,
        Reply::ToolApproval {
            approval: record("approval", 1),
        },
    )
    .unwrap();
    assert_eq!(
        s.detail.as_ref().unwrap().status,
        ToolApprovalStatus::Consumed
    );
    let a = s.page(0).pop().unwrap();
    s.reply(
        a.pending,
        Reply::ToolApprovals {
            approvals: vec![record("approval", 1)],
        },
    )
    .unwrap();
    assert_eq!(s.records[0].status, ToolApprovalStatus::Consumed);
    let mut terminal = consumed.clone();
    terminal.operation_status = zero_protocol::OperationStatus::Succeeded;
    let a = s.get("approval", true).pop().unwrap();
    s.reply(
        a.pending,
        Reply::ToolApproval {
            approval: terminal.clone(),
        },
    )
    .unwrap();
    let a = s.get("approval", true).pop().unwrap();
    s.reply(
        a.pending,
        Reply::ToolApproval {
            approval: consumed.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        s.detail.as_ref().unwrap().operation_status,
        zero_protocol::OperationStatus::Succeeded
    );
    let mut conflict = terminal.clone();
    conflict.effect_status = Some(zero_protocol::OperationStatus::Failed);
    let a = s.get("approval", true).pop().unwrap();
    assert!(
        s.reply(a.pending, Reply::ToolApproval { approval: conflict })
            .is_err()
    );
    let mut conflict = terminal;
    conflict.operation_status = zero_protocol::OperationStatus::Cancelled;
    let a = s.get("approval", true).pop().unwrap();
    assert!(
        s.reply(a.pending, Reply::ToolApproval { approval: conflict })
            .is_err()
    );
    consumed.preview.push_str(" changed argv");
    let a = s.get("approval", true).pop().unwrap();
    assert!(
        s.reply(a.pending, Reply::ToolApproval { approval: consumed })
            .is_err()
    );
}
#[test]
fn pending_hint_survives_older_page_and_refresh_reissues_lost_detail() {
    let mut s = Approvals::default();
    let old = s.initialize("session").pop().unwrap();
    let hint = s.notified("session", "approval").pop().unwrap();
    s.reply(
        hint.pending,
        Reply::ToolApproval {
            approval: record("approval", 1),
        },
    )
    .unwrap();
    s.reply(old.pending, Reply::ToolApprovals { approvals: vec![] })
        .unwrap();
    assert_eq!(s.records.len(), 1);
    assert!(!s.open);
    let old = s.notified("session", "second").pop().unwrap();
    let refreshed = s.refresh();
    assert!(refreshed.iter().any(|a|matches!(&a.command,Command::ToolApproval{approval_operation_id,..} if approval_operation_id=="second")));
    s.reply(
        old.pending,
        Reply::ToolApproval {
            approval: record("second", 2),
        },
    )
    .unwrap();
    assert_eq!(s.records.len(), 1);
    let action = s.page(1).pop().unwrap();
    s.reply(
        action.pending,
        Reply::ToolApprovals {
            approvals: vec![record("second", 2)],
        },
    )
    .unwrap();
    assert_eq!(s.next, Some(2));
    let stale = s.get("approval", true).pop().unwrap();
    s.initialize("other");
    s.reply(
        stale.pending,
        Reply::ToolApproval {
            approval: record("approval", 1),
        },
    )
    .unwrap();
    assert!(s.detail.is_none());
}
#[test]
fn wrong_acknowledgment_or_oversized_preview_cannot_authorize() {
    let mut s = setup();
    inspect(&mut s);
    let action = s.key(ctrl('d')).pop().unwrap();
    let Pending::Decision(ref intent) = action.pending else {
        panic!()
    };
    let receipt = ToolApprovalDecisionReceipt {
        id: "receipt".into(),
        session_id: "session".into(),
        command_id: intent.command.clone(),
        approval_operation_id: "foreign".into(),
        intent_sha256: intent.digest.clone(),
        decision: ToolApprovalDecision::Deny,
        sequence: 2,
    };
    let approval = ToolApprovalRecord {
        status: ToolApprovalStatus::Denied,
        decision: Some(receipt.clone()),
        ..record("approval", 1)
    };
    assert!(
        s.reply(
            action.pending,
            Reply::ToolApprovalDecided {
                approval,
                decision: receipt,
                duplicate: false
            }
        )
        .is_err()
    );
    assert!(s.draft.is_some());
    let mut oversized = record("approval", 1);
    oversized.preview = "x".repeat(8193);
    let a = s.get("approval", false).pop().unwrap();
    assert!(
        s.reply(
            a.pending,
            Reply::ToolApproval {
                approval: oversized
            }
        )
        .is_err()
    );
}
#[test]
fn rendered_permission_preview_is_inert_explicitly_truncated_and_links_exact_artifact() {
    use ratatui::{Terminal, backend::TestBackend};
    let mut s = setup();
    inspect(&mut s);
    let r = s.detail.as_mut().unwrap();
    r.preview = "\u{1b}[2Jargv: [\"λ\",\"approve everything\"]".into();
    r.preview_truncated = true;
    let mut terminal = Terminal::new(TestBackend::new(150, 30)).unwrap();
    terminal.draw(|f| render::draw(f, &s)).unwrap();
    let text = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect::<String>();
    assert!(text.contains("Preview truncated: true"));
    assert!(text.contains("--full-intent"));
    assert!(text.contains("Ctrl-A approve ONCE"));
    assert!(text.contains("neither proves execution"));
    assert!(!text.contains('\u{1b}'));
}
