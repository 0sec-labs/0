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
        Screen::Reviews => "Web runs — metadata only",
        Screen::Hypotheses => "Web hypotheses — Unverified",
        Screen::Detail => "Hypothesis detail — Unverified",
        Screen::Overview => "Web run — partial results are not a verdict",
        Screen::Observations => "Retained HTTP observations",
        Screen::Evidence => "Retained HTTP evidence — redacted decoded bytes",
    };
    let block = Block::default().borders(Borders::ALL).title(title);
    if matches!(state.screen, Screen::Overview | Screen::Evidence) {
        let mut lines = vec![];
        if state.screen == Screen::Overview {
            if let Some(run) = &state.run {
                lines.push(Line::from(format!(
                    "{} {:?} / {:?}",
                    safe(&run.operation_id),
                    run.operation_status,
                    run.agent_status
                )));
                lines.push(Line::from(
                    "Security conclusion: not established. All hypotheses remain Unverified.",
                ));
                lines.push(Line::from(format!(
                    "HTTP profile {} · {}",
                    safe(&run.authority.profile_name),
                    safe(&run.authority.profile_sha256)
                )));
                lines.push(Line::from(format!(
                    "Shared account {}",
                    safe(&run.authority.account_id)
                )));
                lines.push(Line::from(format!(
                    "Terminal structured review: {}",
                    if run.review.is_some() {
                        "retained"
                    } else {
                        "not retained; inspect partial observations"
                    }
                )));
                if let Some(error) = &run.error {
                    lines.push(Line::from(safe(error)));
                }
                lines.push(Line::from("Enter: unverified hypotheses · e: HTTP observations, including partial outcomes"));
            }
        } else if let Some(e) = &state.evidence {
            lines.extend([
                Line::from(safe(&e.operation_id)),
                Line::from(format!(
                    "{:?} · HTTP {:?} · complete {}",
                    e.operation_status, e.status, e.complete
                )),
                Line::from(format!("Manifest {}", safe(&e.response_manifest_sha256))),
                Line::from(format!(
                    "Retained body {} · {} bytes",
                    safe(&e.retained_body_sha256),
                    e.retained_bytes
                )),
                Line::from(format!(
                    "Wire {} / decoded {} bytes",
                    e.wire_bytes, e.decoded_bytes
                )),
            ]);
            for (i, (name, value)) in e.headers.iter().enumerate() {
                lines.push(Line::from(format!(
                    "Header {i}: {}: {}",
                    safe(name),
                    safe(value)
                )));
            }
            if let Some(range) = &state.range {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(&range.data_base64)
                    .unwrap_or_default();
                lines.push(Line::from(format!(
                    "Body range {}..{} of {} · UTF-8 display (replacement for invalid bytes)",
                    range.offset,
                    range.offset + bytes.len() as u64,
                    range.total_bytes
                )));
                lines.extend(
                    safe(&String::from_utf8_lossy(&bytes))
                        .lines()
                        .map(|s| Line::from(s.to_owned())),
                );
                lines.push(Line::from("Exact range bytes (base64):"));
                lines.push(Line::from(range.data_base64.clone()));
            }
        }
        frame.render_widget(
            Paragraph::new(lines)
                .block(block)
                .wrap(Wrap { trim: false })
                .scroll((state.scroll, 0)),
            area,
        );
    } else if state.screen != Screen::Detail {
        let rows: Vec<ListItem<'_>> = match state.screen {
            Screen::Reviews => state
                .reviews
                .iter()
                .map(|r| {
                    ListItem::new(format!(
                        "{} {:?} {}\n  web.review {}",
                        r.sequence,
                        r.operation_status,
                        safe(&r.operation_id),
                        r.web_review_sha256
                            .as_deref()
                            .map(safe)
                            .unwrap_or_else(|| "No terminal submission".into())
                    ))
                })
                .collect(),
            Screen::Observations => state
                .observations
                .iter()
                .map(|o| {
                    ListItem::new(format!(
                        "{} {:?} {}\n  {}",
                        o.sequence,
                        o.operation_status,
                        safe(&o.operation_id),
                        o.response_manifest_sha256
                            .as_deref()
                            .unwrap_or("No complete retained response")
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
                Line::from(format!("Web operation {}", safe(&f.web_operation_id))),
                Line::from(format!("Review SHA256 {}", safe(&f.web_review_sha256))),
            ]);
            lines.extend(
                safe(&f.hypothesis.claim.explanation)
                    .lines()
                    .map(|s| Line::from(s.to_owned())),
            );
            lines.push(Line::from("Citations (retained redacted HTTP identities):"));
            for (i, citation) in f.hypothesis.claim.citations.iter().enumerate() {
                lines.push(Line::from(format!(
                    "{} {} · {} · {:?}",
                    if i == state.citation_index { ">" } else { " " },
                    safe(&citation.operation_id),
                    safe(&citation.response_manifest_sha256),
                    citation.part
                )));
            }
            lines.push(Line::from(
                "[ / ] selects citation · e inspects exact retained evidence",
            ));
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
        frame.render_widget(Paragraph::new("Enter: select run / hypothesis / evidence · Esc: back\ne: HTTP observations / selected citation · Detail: a accept · s suppress · r reopen (operator decisions only)\nCtrl-L: next page · Ctrl-G: refresh · PgUp/PgDn: scroll").block(Block::default().borders(Borders::ALL).title("Web investigation — evidence remains Unverified")).wrap(Wrap {trim:false}),editor);
    }
}
