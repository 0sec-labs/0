use super::*;
use ratatui::{
    Frame,
    text::Line,
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};
pub fn draw(frame: &mut Frame, state: &Questions) {
    let mut lines = vec![
        Line::from("Information only — answers grant no scope, tools, access or permission."),
        Line::from("Answered means a saved receipt, not proof the model consumed it."),
    ];
    if let Some(record) = &state.detail {
        lines.push(Line::from(format!(
            "Question {} · {:?}",
            safe(&record.operation_id),
            record.status
        )));
        lines.push(Line::from(format!(
            "Actor {} · root {}",
            safe(&record.actor_operation_id),
            safe(&record.root_operation_id)
        )));
        lines.push(Line::from(format!(
            "Request {}",
            safe(&record.request_sha256)
        )));
        let mut row = 0;
        for (i, q) in record.request.questions.iter().enumerate() {
            lines.push(Line::from(format!("{}. {}", i + 1, safe(&q.header))));
            lines.extend(safe(&q.question).lines().map(|s| Line::from(s.to_owned())));
            for (j, option) in q.options.iter().flatten().enumerate() {
                let active = state.draft.as_ref().is_some_and(|d| d.row == row);
                let checked = state
                    .draft
                    .as_ref()
                    .is_some_and(|d| d.answers[i].selected_indices.contains(&(j as u32)));
                lines.push(Line::from(format!(
                    "{} [{}] {}{}",
                    if active { ">" } else { " " },
                    if checked { "x" } else { " " },
                    safe(&option.label),
                    if option.recommended {
                        " (model recommendation)"
                    } else {
                        ""
                    }
                )));
                if let Some(text) = &option.description {
                    lines.push(Line::from(format!("    {}", safe(text))));
                }
                row += 1;
            }
            if q.allow_custom {
                let active = state.draft.as_ref().is_some_and(|d| d.row == row);
                lines.push(Line::from(format!(
                    "{} Custom text:",
                    if active { ">" } else { " " }
                )));
                let text = state
                    .draft
                    .as_ref()
                    .and_then(|d| d.answers[i].custom_text.as_deref())
                    .unwrap_or("");
                lines.extend(safe(text).lines().map(|s| Line::from(format!("  {s}"))));
                row += 1;
            }
        }
        if let Some(receipt) = &record.decision {
            lines.push(Line::from(format!(
                "Retained decision {}: {}",
                safe(&receipt.id),
                safe(&serde_json::to_string(&receipt.decision).unwrap_or_default())
            )));
        }
    } else {
        lines.push(Line::from(
            "Question inbox — Enter inspects; arrows select; Ctrl-L next page; Ctrl-G refresh",
        ));
        if state.records.is_empty() {
            lines.push(Line::from(
                "No questions on this page. Opening this view sends no answers.",
            ));
        }
        for (i, r) in state.records.iter().enumerate() {
            lines.push(Line::from(format!(
                "{} {:?} {} · actor {}",
                if i == state.selected { ">" } else { " " },
                r.status,
                safe(&r.operation_id),
                safe(&r.actor_operation_id)
            )));
        }
    }
    lines.push(Line::from(safe(&state.notice)));
    lines.push(Line::from(
        "Space selects · arrows/Tab move · Enter/paste only edit text · Ctrl-S submit",
    ));
    lines.push(Line::from("Ctrl-D dismiss · Esc close/retain draft · Ctrl-U discard local draft/back · Ctrl-X cancel root · Ctrl-Q quit"));
    let area = frame.area();
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((state.scroll, 0))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title("Operator questions · no permissions granted"),
            ),
        area,
    );
}
