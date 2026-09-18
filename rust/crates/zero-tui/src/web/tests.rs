#![allow(clippy::unwrap_used)]
use super::*;
use ratatui::{Terminal, backend::TestBackend, layout::Rect};
use zero_protocol::{OperationStatus, web::*};
fn fixture() -> WebWorkflowReport {
    serde_json::from_str(include_str!("../../../zero-report/tests/fixtures/web.json")).unwrap()
}
fn key(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}
fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}
fn reply(ui: &mut Findings, mut a: Vec<Action>, r: Reply) -> Vec<Action> {
    assert_eq!(a.len(), 1);
    ui.reply(a.remove(0).pending, r).unwrap()
}
fn candidate() -> WebRunCandidate {
    WebRunCandidate {
        sequence: 10,
        operation_id: "review".into(),
        command_id: "run".into(),
        operation_status: OperationStatus::Succeeded,
        web_review_sha256: fixture().run.artifacts.get("web.review").cloned(),
    }
}
fn record(revision: u64) -> WebFindingRecord {
    let r = fixture();
    WebFindingRecord {
        session_id: "session".into(),
        web_operation_id: "review".into(),
        web_review_sha256: r.run.artifacts["web.review"].clone(),
        hypothesis: r.run.review.unwrap().hypotheses.remove(0),
        status: WebTriageStatus::New,
        revision,
        last_decision: None,
    }
}
fn overview() -> Findings {
    let mut ui = Findings::default();
    let a = ui.enter(Some("session"));
    reply(
        &mut ui,
        a,
        Reply::WebRuns {
            page: WebRunsPage {
                runs: vec![candidate()],
                next_before_sequence: None,
            },
        },
    );
    let a = ui.key(key(KeyCode::Enter));
    assert!(matches!(a[0].command, Command::WebRun { .. }));
    reply(&mut ui, a, Reply::WebRun { run: fixture().run });
    ui
}
fn loaded() -> Findings {
    let mut ui = overview();
    let a = ui.key(key(KeyCode::Enter));
    reply(
        &mut ui,
        a,
        Reply::WebFindings {
            findings: vec![record(0)],
        },
    );
    let a = ui.key(key(KeyCode::Enter));
    reply(
        &mut ui,
        a,
        Reply::WebFinding {
            finding: record(0),
            history: vec![],
        },
    );
    ui
}
#[test]
fn partial_runs_and_empty_scan_windows_do_not_disappear() {
    let mut ui = Findings::default();
    let a = ui.enter(Some("session"));
    reply(
        &mut ui,
        a,
        Reply::WebRuns {
            page: WebRunsPage {
                runs: vec![],
                next_before_sequence: Some(20),
            },
        },
    );
    assert!(ui.status.contains("Ctrl-L"));
    let a = ui.key(ctrl('l'));
    assert!(matches!(
        a[0].command,
        Command::WebRuns {
            before_sequence: Some(20),
            ..
        }
    ));
    let mut c = candidate();
    c.operation_status = OperationStatus::Cancelled;
    c.web_review_sha256 = None;
    reply(
        &mut ui,
        a,
        Reply::WebRuns {
            page: WebRunsPage {
                runs: vec![c],
                next_before_sequence: None,
            },
        },
    );
    let a = ui.key(key(KeyCode::Enter));
    let mut run = fixture().run;
    run.review = None;
    run.operation_status = OperationStatus::Cancelled;
    run.artifacts.clear();
    reply(&mut ui, a, Reply::WebRun { run });
    assert_eq!(ui.screen, Screen::Overview);
    let a = ui.key(key(KeyCode::Char('e')));
    reply(
        &mut ui,
        a,
        Reply::WebHttpOperations {
            page: WebHttpOperationsPage {
                operations: vec![],
                next_after_sequence: Some(128),
            },
        },
    );
    assert!(matches!(
        ui.key(ctrl('l'))[0].command,
        Command::WebHttpOperations {
            after_sequence: 128,
            ..
        }
    ));
}
#[test]
fn stale_sessions_and_selection_ranges_are_ignored() {
    let mut ui = Findings::default();
    let a = ui.enter(Some("old"));
    let current = ui.enter(Some("session"));
    reply(
        &mut ui,
        a,
        Reply::Error {
            code: "bad".into(),
            message: "stale".into(),
        },
    );
    assert!(ui.busy);
    reply(
        &mut ui,
        current,
        Reply::WebRuns {
            page: WebRunsPage {
                runs: vec![candidate()],
                next_before_sequence: None,
            },
        },
    );
    let stale = ui.key(key(KeyCode::Enter));
    ui.key(key(KeyCode::Esc));
    reply(&mut ui, stale, Reply::WebRun { run: fixture().run });
    assert!(ui.run.is_none());
    assert_eq!(ui.screen, Screen::Reviews);
}
#[test]
fn evidence_range_is_binary_safe_and_bound_to_exact_citation() {
    let mut ui = loaded();
    let a = ui.key(key(KeyCode::Char('e')));
    assert!(
        matches!(&a[0].command,Command::HttpEvidence{operation_id,..} if operation_id=="http-1")
    );
    let e = fixture().observations.remove(0).evidence.unwrap();
    let a = reply(
        &mut ui,
        a,
        Reply::HttpEvidence {
            evidence: e.clone(),
        },
    );
    assert!(matches!(
        a[0].command,
        Command::HttpEvidenceRange {
            offset: 0,
            limit: 4096,
            ..
        }
    ));
    let range = HttpEvidenceRange {
        session_id: "session".into(),
        operation_id: e.operation_id,
        response_manifest_sha256: e.response_manifest_sha256,
        retained_body_sha256: e.retained_body_sha256,
        offset: 0,
        total_bytes: 4,
        data_base64: "AP9hYg==".into(),
        next_offset: None,
    };
    reply(&mut ui, a, Reply::HttpEvidenceRange { range });
    let mut term = Terminal::new(TestBackend::new(120, 35)).unwrap();
    term.draw(|f| render::draw(f, Rect::new(0, 0, 120, 30), Rect::new(0, 30, 120, 5), &ui))
        .unwrap();
    let text = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect::<String>();
    assert!(text.contains("AP9hYg=="));
    assert!(text.contains("redacted decoded bytes"));
    assert!(text.contains("replacement"));
    let a = ui.key(ctrl('g'));
    let mut wrong = fixture().observations.remove(0).evidence.unwrap();
    wrong.operation_id = "foreign".into();
    assert!(
        ui.reply(
            a.into_iter().next().unwrap().pending,
            Reply::HttpEvidence { evidence: wrong }
        )
        .is_err()
    );
}
#[test]
fn paste_enter_are_inert_and_conflict_preserves_exact_intent_until_explicit_rebase() {
    let mut ui = loaded();
    ui.key(key(KeyCode::Char('a')));
    ui.paste("理由\nsecond line");
    assert!(ui.key(key(KeyCode::Enter)).is_empty());
    assert!(ui.blocks_navigation());
    let a = ui.key(ctrl('s'));
    let original = serde_json::to_value(&a[0].command).unwrap();
    let a = reply(
        &mut ui,
        a,
        Reply::Error {
            code: "conflict".into(),
            message: "revision changed".into(),
        },
    );
    assert_eq!(ui.draft.as_ref().unwrap().revision, 0);
    assert!(ui.key(ctrl('s')).is_empty());
    reply(
        &mut ui,
        a,
        Reply::WebFinding {
            finding: record(2),
            history: vec![],
        },
    );
    assert!(ui.key(ctrl('s')).is_empty());
    ui.key(ctrl('b'));
    let a = ui.key(ctrl('s'));
    let new = serde_json::to_value(&a[0].command).unwrap();
    assert_eq!(new["params"]["expected_revision"], 2);
    assert_eq!(new["params"]["note"], original["params"]["note"]);
    assert_ne!(
        new["params"]["command_id"],
        original["params"]["command_id"]
    );
}
#[test]
fn uncertain_retry_is_exact_and_duplicate_receipt_does_not_replace_current_revision() {
    let mut ui = loaded();
    ui.key(key(KeyCode::Char('s')));
    ui.paste("inspect later");
    let a = ui.key(ctrl('s'));
    let command = a[0].command.clone();
    reply(
        &mut ui,
        a,
        Reply::Error {
            code: "transport".into(),
            message: "unknown receipt".into(),
        },
    );
    ui.paste("must not edit");
    let a = ui.key(ctrl('s'));
    assert_eq!(
        serde_json::to_value(&a[0].command).unwrap(),
        serde_json::to_value(&command).unwrap()
    );
    let Command::TriageWebFinding {
        command_id, note, ..
    } = command
    else {
        panic!()
    };
    let mut f = record(3);
    f.status = WebTriageStatus::Accepted;
    let d = WebTriageDecision {
        id: "d1".into(),
        command_id,
        session_id: f.session_id.clone(),
        web_operation_id: f.web_operation_id.clone(),
        hypothesis_id: f.hypothesis.id.clone(),
        web_review_sha256: f.web_review_sha256.clone(),
        revision: 1,
        expected_revision: 0,
        status: WebTriageStatus::Suppressed,
        note,
        created_at_ms: 0,
    };
    reply(
        &mut ui,
        a,
        Reply::WebFindingTriaged {
            finding: f,
            decision: d,
            duplicate: true,
        },
    );
    assert!(ui.status.contains("current revision 3"));
    ui.key(key(KeyCode::Esc));
    assert_eq!(ui.findings[0].revision, 3);
    assert_eq!(ui.findings[0].status, WebTriageStatus::Accepted);
    assert!(!ui.blocks_navigation());
}
#[test]
fn web_draft_survives_help_and_question_overlays_and_blocks_view_changes() {
    let mut state = crate::state::State::new(crate::Options {
        session: Some("session".into()),
        ..Default::default()
    });
    state.web = loaded();
    state.view = crate::state::View::Web;
    state.key(key(KeyCode::Char('a')));
    state.paste("operator draft λ");
    state.key(key(KeyCode::F(1)));
    state.key(ctrl('g'));
    assert_eq!(state.view, crate::state::View::Web);
    state.key(key(KeyCode::Esc));
    state.key(key(KeyCode::Tab));
    assert_eq!(state.view, crate::state::View::Web);
    state.key(ctrl('n'));
    assert_eq!(state.web.draft.as_ref().unwrap().note, "operator draft λ");
    state.key(ctrl('o'));
    assert!(state.questions.open);
    state.key(key(KeyCode::Esc));
    assert_eq!(state.web.draft.as_ref().unwrap().note, "operator draft λ");
    state.key(key(KeyCode::Esc));
    assert!(state.web.draft.is_none());
    state.key(key(KeyCode::Tab));
    assert_eq!(state.view, crate::state::View::Sessions);
}
