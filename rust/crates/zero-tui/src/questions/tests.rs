#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
fn record(id: &str, sequence: u64) -> OperatorQuestionRecord {
    serde_json::from_value(json!({"operation_id":id,"session_id":"session","actor_operation_id":"child","root_operation_id":"root","sequence":sequence,"request_sha256":format!("sha256:{}","a".repeat(64)),"request":{"questions":[{"header":"Choice","question":"Which input?","options":[{"label":"One","recommended":true},{"label":"Two"}]},{"header":"Details","question":"Any detail?","allow_custom":true}]},"status":"pending","decision":null})).unwrap()
}
fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}
fn setup() -> Questions {
    let mut state = Questions::default();
    let action = state.initialize("session").pop().unwrap();
    state
        .reply(
            action.pending,
            Reply::OperatorQuestions {
                questions: vec![record("question", 1)],
            },
        )
        .unwrap();
    state.open = true;
    let action = state.key(key(KeyCode::Enter)).pop().unwrap();
    state
        .reply(
            action.pending,
            Reply::OperatorQuestion {
                question: record("question", 1),
            },
        )
        .unwrap();
    state
}
fn edit(state: &mut Questions) {
    state.key(key(KeyCode::Char(' ')));
    state.key(key(KeyCode::Down));
    state.key(key(KeyCode::Down));
    state.paste("Unicode λ🦀\nline");
}
fn acknowledge(state: &mut Questions, pending: Pending) -> Vec<Action> {
    let Pending::Decision(intent) = &pending else {
        panic!()
    };
    let decision = OperatorQuestionDecisionReceipt {
        id: "receipt".into(),
        session_id: intent.session.clone(),
        command_id: intent.command.clone(),
        question_operation_id: intent.question.clone(),
        request_sha256: intent.digest.clone(),
        decision: intent.decision.clone(),
        sequence: 4,
    };
    let question = OperatorQuestionRecord {
        status: if matches!(intent.decision, OperatorDecision::Dismiss) {
            OperatorQuestionStatus::Dismissed
        } else {
            OperatorQuestionStatus::Answered
        },
        decision: Some(decision.clone()),
        ..record("question", 1)
    };
    state
        .reply(
            pending,
            Reply::OperatorQuestionDecided {
                question,
                decision,
                duplicate: false,
            },
        )
        .unwrap()
}
#[test]
fn explicit_submit_preserves_unicode_paste_and_frozen_retry_without_grant() {
    let mut state = setup();
    edit(&mut state);
    state.key(key(KeyCode::Backspace));
    state.key(key(KeyCode::Backspace));
    state.key(key(KeyCode::Backspace));
    state.key(key(KeyCode::Backspace));
    state.key(key(KeyCode::Backspace));
    state.key(key(KeyCode::Backspace));
    assert_eq!(
        state.draft.as_ref().unwrap().answers[1]
            .custom_text
            .as_deref(),
        Some("Unicode λ")
    );
    state.paste("🦀\nline");
    assert!(state.key(key(KeyCode::Enter)).is_empty());
    assert_eq!(state.records[0].status, OperatorQuestionStatus::Pending);
    let action = state.key(ctrl('s')).pop().unwrap();
    assert!(state.sending);
    assert!(state.blocks_navigation());
    let frozen = state.draft.as_ref().unwrap().answers.clone();
    state.paste("ignored");
    state.key(key(KeyCode::Backspace));
    assert_eq!(state.draft.as_ref().unwrap().answers, frozen);
    state.key(key(KeyCode::Esc));
    assert!(!state.open);
    assert!(state.draft.is_some());
    state
        .reply(
            action.pending.clone(),
            Reply::Error {
                code: "retry".into(),
                message: "uncertain receipt".into(),
            },
        )
        .unwrap();
    state.toggle(Some("session"));
    let retry = state.key(ctrl('s')).pop().unwrap();
    assert_eq!(
        serde_json::to_value(action.command).unwrap(),
        serde_json::to_value(&retry.command).unwrap()
    );
    acknowledge(&mut state, retry.pending);
    assert!(state.draft.is_none());
    assert_eq!(
        state.detail.as_ref().unwrap().status,
        OperatorQuestionStatus::Answered
    );
    assert!(state.notice.contains("No permissions granted"));
}
#[test]
fn terminal_decision_cannot_regress_under_old_or_current_epoch_get_and_list() {
    let mut state = setup();
    edit(&mut state);
    let old_get = state.get("question", true).pop().unwrap();
    let old_list = state.refresh().pop().unwrap();
    let action = state.key(ctrl('s')).pop().unwrap();
    acknowledge(&mut state, action.pending);
    state
        .reply(
            old_get.pending,
            Reply::OperatorQuestion {
                question: record("question", 1),
            },
        )
        .unwrap();
    state
        .reply(
            old_list.pending,
            Reply::OperatorQuestions {
                questions: vec![record("question", 1)],
            },
        )
        .unwrap();
    let current_get = state.get("question", true).pop().unwrap();
    state
        .reply(
            current_get.pending,
            Reply::OperatorQuestion {
                question: record("question", 1),
            },
        )
        .unwrap();
    state.records.clear();
    let current_list = state.refresh().pop().unwrap();
    state
        .reply(
            current_list.pending,
            Reply::OperatorQuestions {
                questions: vec![record("question", 1)],
            },
        )
        .unwrap();
    assert_eq!(
        state.detail.as_ref().unwrap().status,
        OperatorQuestionStatus::Answered
    );
    assert_eq!(state.records[0].status, OperatorQuestionStatus::Answered);
    assert!(state.draft.is_none());
    let mut changed = record("question", 1);
    changed.request.questions[0].question = "changed".into();
    let get = state.get("question", true).pop().unwrap();
    assert!(
        state
            .reply(get.pending, Reply::OperatorQuestion { question: changed })
            .is_err()
    );
}
#[test]
fn dismiss_is_explicit_and_notification_never_steals_focus_or_draft() {
    let mut state = setup();
    edit(&mut state);
    state.key(key(KeyCode::Esc));
    let hint = state.notified("session", "sibling-question").pop().unwrap();
    state
        .reply(
            hint.pending,
            Reply::OperatorQuestion {
                question: record("sibling-question", 2),
            },
        )
        .unwrap();
    assert!(!state.open);
    assert_eq!(state.detail.as_ref().unwrap().operation_id, "question");
    assert_eq!(state.draft.as_ref().unwrap().question, "question");
    state.toggle(Some("session"));
    let action = state.key(ctrl('d')).pop().unwrap();
    assert!(matches!(
        action.command,
        Command::DecideOperatorQuestion {
            decision: OperatorDecision::Dismiss,
            ..
        }
    ));
    acknowledge(&mut state, action.pending);
    assert_eq!(
        state.detail.as_ref().unwrap().status,
        OperatorQuestionStatus::Dismissed
    );
}
#[test]
fn short_pages_and_session_epochs_are_bounded_and_correlated() {
    let mut state = Questions::default();
    let initial = state.initialize("session").pop().unwrap();
    state
        .reply(
            initial.pending,
            Reply::OperatorQuestions {
                questions: vec![record("question", 7)],
            },
        )
        .unwrap();
    let next = state.key(ctrl('l')).pop().unwrap();
    assert!(matches!(
        next.command,
        Command::OperatorQuestions {
            after_sequence: 7,
            ..
        }
    ));
    state.initialize("other-session");
    state
        .reply(
            next.pending,
            Reply::OperatorQuestions {
                questions: vec![record("later", 8)],
            },
        )
        .unwrap();
    assert!(state.records.is_empty());
    state.initialize("session");
    let page = state.refresh().pop().unwrap();
    assert!(
        state
            .reply(
                page.pending,
                Reply::OperatorQuestions {
                    questions: (1..=21).map(|i| record(&i.to_string(), i)).collect()
                }
            )
            .is_err()
    );
}
#[test]
fn wrong_receipt_and_empty_answer_never_clear_draft() {
    let mut state = setup();
    assert!(state.key(ctrl('s')).is_empty());
    edit(&mut state);
    let action = state.key(ctrl('s')).pop().unwrap();
    let Pending::Decision(intent) = &action.pending else {
        panic!()
    };
    let receipt = OperatorQuestionDecisionReceipt {
        id: "r".into(),
        session_id: "session".into(),
        command_id: "foreign".into(),
        question_operation_id: "question".into(),
        request_sha256: intent.digest.clone(),
        decision: intent.decision.clone(),
        sequence: 3,
    };
    let question = OperatorQuestionRecord {
        status: OperatorQuestionStatus::Answered,
        decision: Some(receipt.clone()),
        ..record("question", 1)
    };
    assert!(
        state
            .reply(
                action.pending,
                Reply::OperatorQuestionDecided {
                    question,
                    decision: receipt,
                    duplicate: false
                }
            )
            .is_err()
    );
    assert!(state.draft.is_some());
}
#[test]
fn renderer_is_inert_and_labels_information_not_authorization() {
    let mut state = setup();
    state.detail.as_mut().unwrap().request.questions[0].question =
        "untrusted\x1b]52;payload\x07".into();
    edit(&mut state);
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(140, 40)).unwrap();
    terminal.draw(|f| render::draw(f, &state)).unwrap();
    let text = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(text.contains("no permissions granted"));
    assert!(text.contains("model recommendation"));
    assert!(text.contains("Unicode λ"));
    assert!(!text.contains('\x1b'));
    assert!(!text.contains('\x07'));
}

#[test]
fn older_page_cannot_hide_new_pending_hint_and_refresh_reissues_inflight_hint_reads() {
    let mut state = Questions::default();
    let old_page = state.initialize("session").pop().unwrap();
    let hint = state
        .notified("session", "new-child-question")
        .pop()
        .unwrap();
    state
        .reply(
            hint.pending,
            Reply::OperatorQuestion {
                question: record("new-child-question", 50),
            },
        )
        .unwrap();
    state
        .reply(
            old_page.pending,
            Reply::OperatorQuestions { questions: vec![] },
        )
        .unwrap();
    assert_eq!(state.records[0].operation_id, "new-child-question");
    assert!(!state.open);
    let pending_hint = state.notified("session", "another-child").pop().unwrap();
    let refreshed = state.refresh();
    assert!(refreshed.iter().any(|a|matches!(&a.command,Command::OperatorQuestion{question_operation_id,..} if question_operation_id=="another-child")));
    state
        .reply(
            pending_hint.pending,
            Reply::OperatorQuestion {
                question: record("another-child", 51),
            },
        )
        .unwrap();
    assert_eq!(
        state.records.len(),
        1,
        "old hint response is discarded, replacement read remains queued"
    );
}
