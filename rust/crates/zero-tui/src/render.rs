use crate::state::{State, View, safe};
use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
};
fn display(value: &serde_json::Value) -> String {
    let text = value["text"].as_str().unwrap_or("");
    format!(
        "{}{}",
        safe(text),
        if value["truncated"] == true {
            " [display truncated]"
        } else {
            ""
        }
    )
}
pub fn draw(frame: &mut Frame, state: &State) {
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(3),
            Constraint::Length(5),
            Constraint::Length(2),
        ])
        .split(frame.area());
    frame.render_widget(
        Paragraph::new(format!(
            "0sec native · {:?} · {}\n{}",
            state.view,
            state.session.as_deref().unwrap_or("select session"),
            state.budget_label(std::time::Instant::now())
        ))
        .style(Style::default().fg(Color::Cyan)),
        areas[0],
    );
    match state.view {
        View::Web => crate::web::render::draw(frame, areas[1], areas[2], &state.web),
        View::Findings => crate::findings::render::draw(frame, areas[1], areas[2], &state.findings),
        View::Sessions => {
            let rows: Vec<_> = state
                .sessions
                .iter()
                .map(|session| {
                    ListItem::new(format!(
                        "{}  generation {}",
                        session["id"].as_str().unwrap_or("?"),
                        safe(session["generation"].as_str().unwrap_or("?"))
                    ))
                })
                .collect();
            let mut list = ListState::default();
            list.select(Some(state.selected));
            frame.render_stateful_widget(
                List::new(rows)
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .title("Sessions · Enter selects · n creates · Ctrl-L next page"),
                    )
                    .highlight_style(Style::default().fg(Color::Black).bg(Color::Cyan)),
                areas[1],
                &mut list,
            );
        }
        View::Queue => {
            let rows: Vec<_> = state
                .queue
                .iter()
                .map(|input| {
                    ListItem::new(format!(
                        "{} {:?} {}\n  {}",
                        input.sequence,
                        input.status,
                        input.id,
                        safe(&input.request.prompt).replace('\n', " ↵ ")
                    ))
                })
                .collect();
            let mut list = ListState::default();
            list.select(Some(state.selected));
            frame.render_stateful_widget(
                List::new(rows)
                    .block(Block::default().borders(Borders::ALL).title(
                        "Durable queue · Ctrl-R run selected · Ctrl-X cancel pending · Ctrl-L more",
                    ))
                    .highlight_style(Style::default().fg(Color::Black).bg(Color::Cyan)),
                areas[1],
                &mut list,
            );
        }
        View::Conversation => {
            let mut lines = Vec::new();
            for turn in state.history.iter().rev() {
                lines.push(Line::styled(
                    format!("You · {}", turn["operation_id"].as_str().unwrap_or("?")),
                    Style::default().fg(Color::Cyan),
                ));
                for line in display(&turn["prompt"]).lines() {
                    lines.push(Line::from(line.to_owned()));
                }
                lines.push(Line::styled(
                    format!(
                        "Assistant · {}",
                        turn["status"].as_str().unwrap_or("unknown")
                    ),
                    Style::default().fg(Color::Green),
                ));
                for line in display(&turn["reply_text"]).lines() {
                    lines.push(Line::from(line.to_owned()));
                }
                if !turn["error"].is_null() {
                    lines.push(Line::styled(
                        display(&turn["error"]),
                        Style::default().fg(Color::Red),
                    ));
                }
                lines.push(Line::from(""));
            }
            if let Some(active) = &state.active {
                lines.push(Line::styled(
                    format!(
                        "Live provisional · {}{}",
                        active.operation.as_deref().unwrap_or("awaiting admission"),
                        if active.gaps { " · progress gaps" } else { "" }
                    ),
                    Style::default().fg(Color::Yellow),
                ));
                if !active.reasoning.is_empty() {
                    lines.push(Line::styled(
                        "Reasoning (provisional)",
                        Style::default().add_modifier(Modifier::ITALIC),
                    ));
                    for line in active.reasoning.lines() {
                        lines.push(Line::from(line.to_owned()));
                    }
                }
                for line in active.text.lines() {
                    lines.push(Line::from(line.to_owned()));
                }
                if !active.tools.is_empty() {
                    lines.push(Line::styled(
                        "Tool call draft — not execution",
                        Style::default().fg(Color::Yellow),
                    ));
                    for line in active.tools.lines() {
                        lines.push(Line::from(line.to_owned()));
                    }
                }
            }
            if let Some(target) = &state.steering.target {
                lines.push(Line::styled(
                    format!("Steering for operation {}", safe(target)),
                    Style::default().fg(Color::Cyan),
                ));
                lines.push(Line::from(
                    "Captured means journaled in an inference request, not provider receipt.",
                ));
                for message in &state.steering.messages {
                    lines.push(Line::from(format!(
                        "#{} {:?} {}{}",
                        message.sequence,
                        message.status,
                        safe(&message.id),
                        message
                            .inference_operation_id
                            .as_ref()
                            .map(|id| format!(" → inference {}", safe(id)))
                            .unwrap_or_default()
                    )));
                    for text in safe(&message.prompt).lines() {
                        lines.push(Line::from(text.to_owned()));
                    }
                }
            }
            if lines.is_empty() {
                lines.push(Line::from(
                    "No recorded turns. Enter saves your first prompt to the durable queue.",
                ));
            }
            let inner_width = areas[1].width.saturating_sub(2).max(1) as usize;
            let wrapped: usize = lines
                .iter()
                .map(|line| line.width().max(1).div_ceil(inner_width))
                .sum();
            let bottom = wrapped
                .saturating_sub(areas[1].height.saturating_sub(2) as usize)
                .min(u16::MAX as usize) as u16;
            frame.render_widget(
                Paragraph::new(lines)
                    .block(Block::default().borders(Borders::ALL).title(
                        if state.history_windowed {
                            "Older history window (200 turns) · Ctrl-G newest"
                        } else {
                            "Conversation · PgUp/PgDn scroll · Ctrl-L older · Ctrl-G newest"
                        },
                    ))
                    .wrap(Wrap { trim: false })
                    .scroll((bottom.saturating_sub(state.scroll), 0)),
                areas[1],
            );
        }
    }
    if !matches!(state.view, View::Findings | View::Web) {
        let mut composer = state.composer.clone();
        if state.view == View::Conversation {
            composer.insert(state.cursor, '▏');
        }
        frame.render_widget(
            Paragraph::new(composer).wrap(Wrap { trim: false }).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(if state.options.profile.is_some() {
                        "Composer · Enter queue · Ctrl-T steer active · Shift-Enter newline"
                    } else {
                        "Browse only · --request profile required for new prompts"
                    }),
            ),
            areas[2],
        );
    }
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(safe(if state.view == View::Findings {
                &state.findings.status
            } else if state.view==View::Web {&state.web.status
            } else {
                &state.status
            })),
            Line::from(vec![Span::styled(
                format!("{} loaded pending questions · {} pending approvals · Ctrl-O questions · Ctrl-P approvals · Ctrl-X cancel · Ctrl-Q quit · F1 help",state.questions.records.iter().filter(|q|q.status==zero_protocol::questions::OperatorQuestionStatus::Pending).count(),state.approvals.records.iter().filter(|a|a.status==zero_protocol::approvals::ToolApprovalStatus::Pending).count()),
                Style::default().fg(Color::DarkGray),
            )]),
        ]),
        areas[3],
    );
    if state.approvals.open {
        crate::approvals::render::draw(frame, &state.approvals);
    }
    if state.questions.open {
        crate::questions::render::draw(frame, &state.questions);
    }
    if state.help {
        let area = frame.area();
        frame.render_widget(Clear, area);
        frame.render_widget(Paragraph::new("Native protocol terminal — experimental\n\nTab: sessions / conversation / queue / findings / web\nWeb: Enter run / hypothesis; e retained observations or cited evidence\nWeb range Ctrl-L next 4 KiB; decisions remain operator-only\nCtrl-P: exact invocation approvals; Ctrl-A approve / Ctrl-D deny after inspection\nEnter/paste never approve; Esc retains permission draft\nCtrl-O: operator questions inbox; answers grant no permissions\nQuestion arrows/Space: choices; Enter/paste: text only\nQuestion Ctrl-S: submit; Ctrl-D: dismiss; Esc: close/keep draft\nQuestion Ctrl-U: discard local draft/back; Ctrl-L: next page\nFindings: Enter selects; a/s/r opens operator decision note\nCtrl-S submits note; Esc discards; Ctrl-B rebases after conflict\nFindings Ctrl-L next page / Ctrl-G refresh; evidence stays Unverified\nEnter: select session, or durably queue composer\nCtrl-T: steer admitted active conversation; Enter remains queue\nPending/Captured/Undelivered notes retain their operation identity\nShift-Enter: newline; bracketed paste only inserts\nCtrl-R: explicitly run selected pending queue input\nCtrl-X: cancel active turn or selected pending input\nCtrl-C: cancel active turn, otherwise quit\nCtrl-N / n in session list: create session with explicit launch budget\nCtrl-L: next session/queue page or older history\nPageUp / PageDown: conversation scroll\nCtrl-U: clear composer; arrows/Home/End edit Unicode text\nCtrl-Q: quit; app-server owns cancellation and cleanup\nF2: refresh budget snapshot (no history/queue reload)\nF1: close help\n\nSaved pending work never starts merely by opening a session.\nLive deltas and tool drafts are provisional; final replies are authoritative.\nUnknown or failed work keeps its journal and stops automatic draining.").block(Block::default().borders(Borders::ALL).title("Help")).wrap(Wrap{trim:false}),area);
    }
    // Overlay editors remain intact; cancellation belongs to the owning turn,
    // so its authoritative lifecycle must stay visible above any modal content.
    if state.help || state.questions.open || state.approvals.open {
        if let Some(text) = state.lifecycle_label() {
            let area = frame.area();
            let height = area.height.min(3);
            let strip = ratatui::layout::Rect::new(
                area.x,
                area.y + area.height - height,
                area.width,
                height,
            );
            frame.render_widget(Clear, strip);
            frame.render_widget(
                Paragraph::new(safe(text)).wrap(Wrap { trim: false }).block(
                    Block::default()
                        .borders(Borders::TOP)
                        .title("Owned turn · Ctrl-X cancel · Ctrl-Q quit"),
                ),
                strip,
            );
        }
    }
}
