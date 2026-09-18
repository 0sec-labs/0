use super::*;
use ratatui::{
    Frame,
    text::Line,
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};
pub fn draw(frame: &mut Frame, state: &Approvals) {
    let mut lines = vec![
        Line::from("PERMISSION — one exact invocation. No tool-wide or future grants."),
        Line::from(
            "Approved is permission; consumed is admission, neither proves execution or success.",
        ),
    ];
    if let Some(record) = &state.detail {
        lines.push(Line::from(format!(
            "Approval {} · {:?} · wrapper {:?}",
            safe(&record.operation_id),
            record.status,
            record.operation_status
        )));
        lines.push(Line::from(format!(
            "Tool {} · actor {} · root {}",
            safe(&record.tool_name),
            safe(&record.actor_operation_id),
            safe(&record.root_operation_id)
        )));
        lines.push(Line::from(format!(
            "Intent SHA256 {}",
            safe(&record.intent_sha256)
        )));
        lines.push(Line::from(format!(
            "Preview truncated: {} — model text and arguments are untrusted",
            record.preview_truncated
        )));
        lines.extend(
            safe(&record.preview)
                .lines()
                .map(|s| Line::from(s.to_owned())),
        );
        lines.push(Line::from(format!(
            "Full exact intent: approvals show --session {} --approval {} --full-intent",
            safe(&record.session_id),
            safe(&record.operation_id)
        )));
        lines.push(Line::from(format!(
            "Retained artifact {}",
            safe(&record.intent_artifact)
        )));
        if let Some(decision) = &record.decision {
            lines.push(Line::from(format!(
                "Decision {:?} · receipt {}",
                decision.decision,
                safe(&decision.id)
            )));
        }
        if let Some(consumption) = &record.consumption {
            lines.push(Line::from(format!(
                "Effect {} · status {:?} (inspect effect receipt)",
                safe(&consumption.effect_operation_id),
                record.effect_status
            )));
        }
    } else {
        lines.push(Line::from(
            "Approval inbox — Enter inspects only; arrows select; Ctrl-L next page; Ctrl-G refresh",
        ));
        if state.records.is_empty() {
            lines.push(Line::from(
                "No approvals on this page; opening this view grants nothing.",
            ));
        }
        for (i, r) in state.records.iter().enumerate() {
            lines.push(Line::from(format!(
                "{} {:?} {} · {}",
                if i == state.selected { ">" } else { " " },
                r.status,
                safe(&r.operation_id),
                safe(&r.tool_name)
            )));
        }
    }
    lines.push(Line::from(safe(&state.notice)));
    lines.push(Line::from("After inspecting exact intent: Ctrl-A approve ONCE · Ctrl-D deny · Enter/paste never decide"));
    lines.push(Line::from("PageUp/Down scroll · Esc close/retain intent · Ctrl-U discard local intent/back · Ctrl-X cancel root · Ctrl-Q quit"));
    let area = frame.area();
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((state.scroll, 0))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title("Exact tool invocation approvals"),
            ),
        area,
    );
}
