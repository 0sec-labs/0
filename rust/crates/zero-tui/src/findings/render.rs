use super::{Findings, Screen};
use crate::state::safe;
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Style},
    text::Line,
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
};
pub fn draw(frame: &mut Frame, area: Rect, editor: Rect, state: &Findings) {
    let title = match state.screen {
        Screen::Reviews => "Source reviews — metadata only",
        Screen::Hypotheses => "Source hypotheses — Unverified",
        Screen::Detail => "Hypothesis detail — Unverified",
    };
    let block = Block::default().borders(Borders::ALL).title(title);
    if state.screen != Screen::Detail {
        let rows: Vec<ListItem<'_>> = match state.screen {
            Screen::Reviews => state
                .reviews
                .iter()
                .map(|r| {
                    ListItem::new(format!(
                        "{} {:?} {}\n  source.review {}",
                        r.sequence,
                        r.operation_status,
                        safe(&r.operation_id),
                        safe(&r.source_review_sha256)
                    ))
                })
                .collect(),
            _ => state
                .findings
                .iter()
                .map(|f| {
                    ListItem::new(format!(
                        "{:?} · Unverified · claimed {:?} · revision {}\n  {}\n  {}",
                        f.status,
                        f.hypothesis.claim.claimed_severity,
                        f.revision,
                        safe(&f.hypothesis.claim.title),
                        safe(&f.hypothesis.id)
                    ))
                })
                .collect(),
        };
        let mut selected = ListState::default();
        selected.select(Some(state.selected));
        frame.render_stateful_widget(
            List::new(rows)
                .block(block)
                .highlight_style(Style::default().fg(Color::Black).bg(Color::Cyan)),
            area,
            &mut selected,
        );
    } else {
        let mut lines = Vec::new();
        if let Some(f) = &state.detail {
            lines.extend([
                Line::from(safe(&f.hypothesis.claim.title)),
                Line::from(format!(
                    "Unverified · claimed severity {:?} · operator {:?} · revision {}",
                    f.hypothesis.claim.claimed_severity, f.status, f.revision
                )),
                Line::from(
                    "Accepted means operator follow-up. Security conclusion: not established.",
                ),
                Line::from(format!("Hypothesis {}", safe(&f.hypothesis.id))),
                Line::from(format!("Source operation {}", safe(&f.source_operation_id))),
                Line::from(format!("Review SHA256 {}", safe(&f.source_review_sha256))),
            ]);
            lines.extend(
                safe(&f.hypothesis.claim.explanation)
                    .lines()
                    .map(|s| Line::from(s.to_owned())),
            );
            lines.push(Line::from("Citations (retained source identities):"));
            for citation in &f.hypothesis.claim.citations {
                lines.push(Line::from(format!(
                    "{}:{}-{} · {}",
                    safe(&citation.path),
                    citation.start_line,
                    citation.end_line,
                    safe(&citation.sha256)
                )));
            }
            if let Some(d) = &state.receipt {
                lines.push(Line::from(format!(
                    "Last submitted receipt: revision {} {:?}, command {}",
                    d.revision,
                    d.status,
                    safe(&d.command_id)
                )));
                lines.push(Line::from(format!(
                    "Current record independently: revision {} {:?}",
                    f.revision, f.status
                )));
                lines.extend(safe(&d.note).lines().map(|s| Line::from(s.to_owned())));
            }
            lines.push(Line::from(
                "Decision history — current page only (Ctrl-L next, Ctrl-G first):",
            ));
            for d in &state.history {
                lines.push(Line::from(format!(
                    "revision {} {:?} · {} · at {}",
                    d.revision,
                    d.status,
                    safe(&d.command_id),
                    d.created_at_ms
                )));
                lines.extend(safe(&d.note).lines().map(|s| Line::from(s.to_owned())));
            }
        }
        frame.render_widget(
            Paragraph::new(lines)
                .block(block)
                .wrap(Wrap { trim: false })
                .scroll((state.scroll, 0)),
            area,
        );
    }
    if let Some(draft) = &state.draft {
        let mut note = draft.note.clone();
        note.insert(draft.cursor, '▏');
        frame.render_widget(
            Paragraph::new(note)
                .block(Block::default().borders(Borders::ALL).title(format!(
                    "Decision note — Ctrl-S submits · {:?} · expected revision {}{}",
                    draft.status,
                    draft.revision,
                    if draft.conflict {
                        " · CONFLICT: Ctrl-B rebase"
                    } else {
                        ""
                    }
                )))
                .wrap(Wrap { trim: false }),
            editor,
        );
    } else {
        frame.render_widget(Paragraph::new("Enter: select review / hypothesis · Esc: back\nDetail: a accept · s suppress · r reopen (operator decisions only)\nCtrl-L: next page · Ctrl-G: refresh · PgUp/PgDn: scroll").block(Block::default().borders(Borders::ALL).title("Source investigation — evidence remains Unverified")).wrap(Wrap {trim:false}),editor);
    }
}
