#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
use zero_protocol::{
    OperationStatus,
    discovery::SourceReviewPage,
    source::{Claim, ClaimedSeverity, Hypothesis, VerificationState},
};
fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}
fn candidate(id: &str, sequence: u64) -> SourceReviewCandidate {
    SourceReviewCandidate {
        sequence,
        operation_id: id.into(),
        command_id: format!("command-{id}"),
        operation_status: OperationStatus::Succeeded,
        source_review_sha256: format!("sha256:{}", "1".repeat(64)),
    }
}
fn finding(id: &str, revision: u64) -> SourceFindingRecord {
    SourceFindingRecord {
        session_id: "session".into(),
        source_operation_id: "review".into(),
        source_review_sha256: candidate("review", 20).source_review_sha256,
        hypothesis: Hypothesis {
            id: id.into(),
            state: VerificationState::Unverified,
            claim: Claim {
                title: "A model hypothesis".into(),
                claimed_severity: ClaimedSeverity::High,
                explanation: "Needs investigation".into(),
                citations: vec![],
            },
        },
        status: SourceFindingStatus::New,
        revision,
        last_decision: None,
    }
}
fn decision(revision: u64) -> TriageDecision {
    TriageDecision {
        id: format!("decision-{revision}"),
        command_id: format!("decision-command-{revision}"),
        session_id: "session".into(),
        source_operation_id: "review".into(),
        hypothesis_id: "claim".into(),
        source_review_sha256: candidate("review", 20).source_review_sha256,
        revision,
        expected_revision: revision - 1,
        status: SourceFindingStatus::Accepted,
        note: "operator note".into(),
        created_at_ms: 123,
    }
}
fn reply(ui: &mut Findings, mut actions: Vec<Action>, reply: Reply) -> Vec<Action> {
    ui.reply(actions.remove(0).pending, reply).unwrap()
}
fn loaded() -> Findings {
    let mut ui = Findings::default();
    let request = ui.enter(Some("session"));
    reply(
        &mut ui,
        request,
        Reply::SourceReviews {
            page: SourceReviewPage {
                reviews: vec![candidate("review", 20)],
                next_before_sequence: None,
            },
        },
    );
    let request = ui.key(key(KeyCode::Enter));
    reply(
        &mut ui,
        request,
        Reply::SourceFindings {
            findings: vec![finding("claim", 0)],
        },
    );
    let request = ui.key(key(KeyCode::Enter));
    reply(
        &mut ui,
        request,
        Reply::SourceFinding {
            finding: finding("claim", 0),
            history: vec![],
        },
    );
    ui
}
#[test]
fn discovery_empty_window_has_cursor_and_invalid_candidate_is_not_hidden() {
    let mut ui = Findings::default();
    let request = ui.enter(Some("session"));
    reply(
        &mut ui,
        request,
        Reply::SourceReviews {
            page: SourceReviewPage {
                reviews: vec![],
                next_before_sequence: Some(300),
            },
        },
    );
    assert!(ui.status.contains("Ctrl-L"));
    let next = ui.key(ctrl('l'));
    assert!(matches!(
        next[0].command,
        Command::SourceReviews {
            before_sequence: Some(300),
            ..
        }
    ));
    let mut partial = candidate("partial", 200);
    partial.operation_status = OperationStatus::Failed;
    reply(
        &mut ui,
        next,
        Reply::SourceReviews {
            page: SourceReviewPage {
                reviews: vec![partial],
                next_before_sequence: Some(100),
            },
        },
    );
    let selected = ui.key(key(KeyCode::Enter));
    reply(
        &mut ui,
        selected,
        Reply::Error {
            code: "invalid".into(),
            message: "source operation has no valid retained review".into(),
        },
    );
    assert_eq!(ui.review.as_ref().unwrap().operation_id, "partial");
    assert!(ui.status.contains("no valid"));
    assert!(ui.findings.is_empty());
    ui.key(key(KeyCode::Esc));
    assert_eq!(ui.reviews.len(), 1);
    assert_eq!(ui.reviews[0].operation_status, OperationStatus::Failed);
}
#[test]
fn stale_session_selection_and_refresh_responses_cannot_replace_current_records() {
    let mut ui = Findings::default();
    let stale = ui.enter(Some("old"));
    let current = ui.enter(Some("session"));
    reply(
        &mut ui,
        stale,
        Reply::Error {
            code: "fixture".into(),
            message: "stale failure".into(),
        },
    );
    assert!(ui.busy);
    reply(
        &mut ui,
        current,
        Reply::SourceReviews {
            page: SourceReviewPage {
                reviews: vec![candidate("review", 20), candidate("other", 10)],
                next_before_sequence: None,
            },
        },
    );
    let old_selection = ui.key(key(KeyCode::Enter));
    ui.key(key(KeyCode::Esc));
    ui.key(key(KeyCode::Down));
    let current = ui.key(key(KeyCode::Enter));
    reply(
        &mut ui,
        old_selection,
        Reply::SourceFindings {
            findings: vec![finding("old", 0)],
        },
    );
    assert!(ui.busy);
    assert!(ui.findings.is_empty());
    let mut f = finding("new", 0);
    f.source_operation_id = "other".into();
    reply(
        &mut ui,
        current,
        Reply::SourceFindings { findings: vec![f] },
    );
    let stale = ui.key(ctrl('g'));
    let latest = ui.key(ctrl('g'));
    reply(
        &mut ui,
        stale,
        Reply::Error {
            code: "fixture".into(),
            message: "stale refresh".into(),
        },
    );
    assert!(ui.busy);
    reply(&mut ui, latest, Reply::SourceFindings { findings: vec![] });
    assert!(!ui.busy);
    assert!(ui.status.contains("no safety"));
}
#[test]
fn short_byte_pages_advance_by_returned_count_and_history_revision_without_accumulation() {
    let mut ui = loaded();
    ui.key(key(KeyCode::Esc));
    let next = ui.key(ctrl('l'));
    assert!(matches!(
        next[0].command,
        Command::SourceFindings { offset: 1, .. }
    ));
    reply(
        &mut ui,
        next,
        Reply::SourceFindings {
            findings: vec![finding("second", 0)],
        },
    );
    assert_eq!(ui.findings.len(), 1);
    let next = ui.key(ctrl('l'));
    assert!(matches!(
        next[0].command,
        Command::SourceFindings { offset: 2, .. }
    ));
    reply(&mut ui, next, Reply::SourceFindings { findings: vec![] });
    assert!(ui.key(ctrl('l')).is_empty());
    let mut ui = loaded();
    let first = ui.key(ctrl('g'));
    reply(
        &mut ui,
        first,
        Reply::SourceFinding {
            finding: finding("claim", 3),
            history: vec![decision(1)],
        },
    );
    let next = ui.key(ctrl('l'));
    assert!(matches!(
        next[0].command,
        Command::SourceFinding {
            after_revision: 1,
            ..
        }
    ));
    reply(
        &mut ui,
        next,
        Reply::SourceFinding {
            finding: finding("claim", 3),
            history: vec![decision(2), decision(3)],
        },
    );
    assert_eq!(ui.history.len(), 2);
    let next = ui.key(ctrl('l'));
    assert!(matches!(
        next[0].command,
        Command::SourceFinding {
            after_revision: 3,
            ..
        }
    ));
    reply(
        &mut ui,
        next,
        Reply::SourceFinding {
            finding: finding("claim", 3),
            history: vec![],
        },
    );
    assert!(ui.key(ctrl('l')).is_empty());
}
#[test]
fn note_paste_is_inert_bounded_and_conflict_never_rebases_or_submits_automatically() {
    let mut ui = loaded();
    assert!(ui.key(key(KeyCode::Char('a'))).is_empty());
    ui.paste("investigate 世界\r\nnext");
    assert!(ui.key(key(KeyCode::Enter)).is_empty());
    let draft = ui.draft.as_ref().unwrap();
    assert_eq!(draft.note, "investigate 世界\nnext\n");
    assert!(!draft.submitted);
    let saved = draft.note.clone();
    ui.paste(&"x".repeat(4096));
    assert_eq!(ui.draft.as_ref().unwrap().note, saved);
    let first = ui.key(ctrl('s'));
    let first_json = serde_json::to_value(&first[0].command).unwrap();
    assert!(ui.blocks_navigation());
    assert!(ui.key(key(KeyCode::Esc)).is_empty());
    assert!(ui.draft.is_some());
    let refreshed = reply(
        &mut ui,
        first,
        Reply::Error {
            code: "conflict".into(),
            message: "revision changed".into(),
        },
    );
    assert!(ui.draft.as_ref().unwrap().conflict);
    assert!(ui.key(ctrl('s')).is_empty());
    ui.key(ctrl('b'));
    assert_eq!(ui.draft.as_ref().unwrap().revision, 0);
    reply(
        &mut ui,
        refreshed,
        Reply::SourceFinding {
            finding: finding("claim", 2),
            history: vec![decision(1), decision(2)],
        },
    );
    assert_eq!(ui.draft.as_ref().unwrap().note, saved);
    assert_eq!(ui.draft.as_ref().unwrap().revision, 0);
    assert!(ui.key(ctrl('s')).is_empty());
    ui.key(ctrl('b'));
    assert_eq!(ui.draft.as_ref().unwrap().revision, 2);
    assert!(ui.detail_ready);
    let next = ui.key(ctrl('s'));
    let next_json = serde_json::to_value(&next[0].command).unwrap();
    assert_ne!(
        first_json["params"]["command_id"],
        next_json["params"]["command_id"]
    );
    assert_eq!(next_json["params"]["expected_revision"], 2);
    assert_eq!(next_json["params"]["note"], saved);
}
#[test]
fn exact_retry_preserves_intent_and_distinguishes_receipt_from_newer_current_state() {
    let mut ui = loaded();
    ui.key(key(KeyCode::Char('s')));
    ui.paste("not actionable");
    let first = ui.key(ctrl('s'));
    let original = serde_json::to_value(&first[0].command).unwrap();
    reply(
        &mut ui,
        first,
        Reply::Error {
            code: "fixture".into(),
            message: "retry allowed".into(),
        },
    );
    ui.paste("must not change submitted intent");
    let retry = ui.key(ctrl('s'));
    assert_eq!(serde_json::to_value(&retry[0].command).unwrap(), original);
    let mut d = decision(1);
    d.command_id = original["params"]["command_id"].as_str().unwrap().into();
    d.status = SourceFindingStatus::Suppressed;
    d.note = "not actionable".into();
    let mut current = finding("claim", 3);
    current.status = SourceFindingStatus::Accepted;
    reply(
        &mut ui,
        retry,
        Reply::SourceFindingTriaged {
            finding: current,
            decision: d,
            duplicate: true,
        },
    );
    assert!(ui.draft.is_none());
    assert_eq!(ui.receipt.as_ref().unwrap().revision, 1);
    assert_eq!(ui.detail.as_ref().unwrap().revision, 3);
    assert!(ui.status.contains("exact retry"));
    assert!(ui.status.contains("Unverified"));
    ui.key(key(KeyCode::Esc));
    assert_eq!(ui.findings[0].revision, 3);
    assert_eq!(ui.findings[0].status, SourceFindingStatus::Accepted);
    let request = ui.key(key(KeyCode::Enter));
    let mut updated = finding("claim", 4);
    updated.status = SourceFindingStatus::Suppressed;
    reply(
        &mut ui,
        request,
        Reply::SourceFinding {
            finding: updated,
            history: vec![],
        },
    );
    ui.key(key(KeyCode::Esc));
    assert_eq!(ui.findings[0].revision, 4);
    assert_eq!(ui.findings[0].status, SourceFindingStatus::Suppressed);
    assert_eq!(
        ui.findings[0].hypothesis.state,
        VerificationState::Unverified
    );
}
#[test]
fn read_failures_prevent_decision_or_conflict_rebase_and_identity_tampering_is_rejected() {
    let mut ui = loaded();
    let refresh = ui.key(ctrl('g'));
    reply(
        &mut ui,
        refresh,
        Reply::Error {
            code: "invalid".into(),
            message: "provenance unavailable".into(),
        },
    );
    assert!(ui.key(key(KeyCode::Char('a'))).is_empty());
    assert!(ui.draft.is_none());
    let refresh = ui.key(ctrl('g'));
    let mut wrong = finding("claim", 0);
    wrong.source_review_sha256 = "wrong digest".into();
    assert!(
        ui.reply(
            refresh.into_iter().next().unwrap().pending,
            Reply::SourceFinding {
                finding: wrong,
                history: vec![]
            }
        )
        .is_err()
    );
    let mut ui = loaded();
    ui.key(key(KeyCode::Char('r')));
    let request = ui.key(ctrl('s'));
    let refresh = reply(
        &mut ui,
        request,
        Reply::Error {
            code: "conflict".into(),
            message: "changed".into(),
        },
    );
    reply(
        &mut ui,
        refresh,
        Reply::Error {
            code: "invalid".into(),
            message: "cannot validate".into(),
        },
    );
    ui.key(ctrl('b'));
    assert!(ui.draft.as_ref().unwrap().conflict);
    assert!(ui.key(ctrl('s')).is_empty());
}
#[test]
fn rendering_labels_claims_honestly_and_never_emits_terminal_controls() {
    let mut ui = loaded();
    ui.detail.as_mut().unwrap().hypothesis.claim.title = "Unicode 世界\u{1b}]0;hostile\u{7}".into();
    ui.detail.as_mut().unwrap().status = SourceFindingStatus::Accepted;
    for (width, height) in [(140, 35), (35, 10), (1, 1)] {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                render::draw(frame, area, area, &ui);
            })
            .unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>();
        assert!(!text.contains('\u{1b}'));
        assert!(!text.contains('\u{7}'));
    }
    let mut outer = crate::state::State::new(crate::Options::default());
    outer.view = crate::state::View::Findings;
    outer.findings = ui;
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(140, 35)).unwrap();
    terminal
        .draw(|frame| crate::render::draw(frame, &outer))
        .unwrap();
    let text = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect::<String>();
    assert!(text.contains("Unverified"));
    assert!(text.contains("claimed severity High"));
    assert!(text.contains("operator Accepted"));
    assert!(text.contains("not established"));
    assert!(!text.contains("verified vulnerability"));
}
#[test]
fn oversized_or_malformed_pages_fail_boundedly() {
    let mut ui = Findings::default();
    let request = ui.enter(Some("session"));
    assert!(
        ui.reply(
            request.into_iter().next().unwrap().pending,
            Reply::SourceReviews {
                page: SourceReviewPage {
                    reviews: vec![candidate("duplicate", 20), candidate("duplicate", 20)],
                    next_before_sequence: None
                }
            }
        )
        .is_err()
    );
    let mut ui = loaded();
    let request = ui.key(ctrl('g'));
    let mut f = finding("claim", 0);
    f.hypothesis.claim.explanation = "x".repeat(PAGE_BYTES);
    assert!(
        ui.reply(
            request.into_iter().next().unwrap().pending,
            Reply::SourceFinding {
                finding: f,
                history: vec![]
            }
        )
        .is_err()
    );
    assert_eq!(
        ui.detail.as_ref().unwrap().hypothesis.claim.explanation,
        "Needs investigation"
    );
    assert_eq!(
        serde_json::to_value(ui.detail.as_ref().unwrap()).unwrap()["hypothesis"]["state"],
        json!("unverified")
    );
}

#[test]
fn outer_keyboard_routing_needs_no_profile_blocks_session_changes_and_preserves_active_cancel() {
    let mut ui = crate::state::State::new(crate::Options {
        session: Some("session".into()),
        ..Default::default()
    });
    assert!(ui.key(key(KeyCode::Tab)).is_empty());
    let discover = ui.key(key(KeyCode::Tab));
    assert_eq!(ui.view, crate::state::View::Findings);
    assert!(
        matches!(&discover[0].command,Command::SourceReviews{session_id,..} if session_id=="session")
    );
    ui.findings = loaded();
    assert!(ui.key(key(KeyCode::Char('a'))).is_empty());
    ui.paste("explicit note");
    ui.key(key(KeyCode::F(1)));
    assert!(ui.help);
    assert!(ui.key(ctrl('g')).is_empty());
    assert_eq!(ui.view, crate::state::View::Findings);
    ui.key(key(KeyCode::Esc));
    assert!(!ui.help);
    assert!(ui.findings.draft.is_some());
    assert!(ui.key(key(KeyCode::Tab)).is_empty());
    assert_eq!(ui.view, crate::state::View::Findings);
    assert!(ui.key(ctrl('n')).is_empty());
    assert_eq!(ui.session.as_deref(), Some("session"));
    assert!(ui.key(key(KeyCode::Enter)).is_empty());
    assert_eq!(ui.findings.draft.as_ref().unwrap().note, "explicit note\n");
    ui.active = Some(crate::state::Active {
        input: "active".into(),
        command: "queued:active".into(),
        operation: Some("operation".into()),
        text: String::new(),
        reasoning: String::new(),
        tools: String::new(),
        sequences: Default::default(),
        gaps: false,
        cancel_requested: false,
    });
    let cancel = ui.key(ctrl('x'));
    assert!(
        matches!(&cancel[0].command,Command::Cancel{execution_id,..} if execution_id=="queued:active")
    );
    ui.message(zero_protocol::ServerMessage::Response {
        protocol_version: zero_protocol::PROTOCOL_VERSION,
        id: Some(cancel[0].id.clone()),
        reply: Box::new(Reply::Cancelled {
            execution_id: "queued:active".into(),
            accepted: false,
        }),
    })
    .unwrap();
    assert!(ui.findings.status.contains("not accepted"));
    assert!(ui.findings.draft.is_some());
    let decision = ui.key(ctrl('s'));
    assert!(matches!(
        decision[0].command,
        Command::TriageSourceFinding { .. }
    ));
    assert!(ui.key(ctrl('n')).is_empty());
    assert!(ui.key(key(KeyCode::Esc)).is_empty());
    assert!(ui.findings.draft.is_some());
}

#[test]
fn modal_help_cannot_escape_a_draft_or_inflight_decision_navigation_guard() {
    let mut ui = crate::state::State::new(crate::Options {
        session: Some("session".into()),
        ..Default::default()
    });
    ui.view = crate::state::View::Findings;
    ui.findings = loaded();
    ui.key(key(KeyCode::Char('a')));
    ui.key(key(KeyCode::F(1)));
    for k in [ctrl('g'), ctrl('n'), key(KeyCode::Tab)] {
        assert!(ui.key(k).is_empty());
    }
    assert_eq!(ui.view, crate::state::View::Findings);
    assert!(ui.findings.draft.is_some());
    ui.key(key(KeyCode::Esc));
    assert!(!ui.help);
    ui.key(key(KeyCode::Esc));
    assert!(ui.findings.draft.is_none());
    ui.key(key(KeyCode::Char('a')));
    assert_eq!(ui.key(ctrl('s')).len(), 1);
    ui.key(key(KeyCode::F(1)));
    assert!(ui.key(ctrl('g')).is_empty());
    ui.key(key(KeyCode::F(1)));
    assert!(!ui.help);
    assert!(ui.key(key(KeyCode::Esc)).is_empty());
    assert_eq!(ui.view, crate::state::View::Findings);
    assert!(ui.findings.draft.is_some());
    assert!(ui.findings.busy);
}
