/** @jsxImportSource @opentui/react */
import React, { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import type { AuditSummary } from "./audit-workspace.js";
import type { Theme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { useSettings } from "./settings-store.js";
import { spinnerGlyph, UI_ANIMATION_INTERVAL_MS } from "./animations.js";
import { fitTuiText, sanitizeTuiText } from "./text.js";

export interface AuditSwitcherProps {
  records: readonly AuditSummary[];
  selectedAuditId: string | undefined;
  onSelect(id: string): void;
  onCreate(): void;
  onClose(id: string): void;
  width: number;
  rows: number;
  theme: Theme;
}

/** Presentation only: selecting and closing are requests to the workspace owner. */
export function AuditSwitcher({ records, selectedAuditId, onSelect, onCreate, onClose, width, rows, theme }: AuditSwitcherProps) {
  const symbols = useSymbols();
  const { reduceMotion } = useSettings();
  const [frame, setFrame] = useState(0);
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const height = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  const showHint = height >= 4;
  const rowHeight = height >= 6 ? 2 : 1;
  const capacity = Math.max(0, Math.floor((height - 1 - (showHint ? 1 : 0)) / rowHeight));
  const selectedIndex = records.findIndex(record => record.id === selectedAuditId);
  const selected = selectedIndex >= 0 ? records[selectedIndex] : undefined;
  const start = Math.min(Math.max(0, selectedIndex - capacity + 1), Math.max(0, records.length - capacity));
  const visible = records.slice(start, start + capacity);
  const animate = columns > 0 && height > 0 && !reduceMotion && visible.some(record => record.status === "running");

  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setFrame(value => value + 1), UI_ANIMATION_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animate]);


  if (columns === 0 || height === 0) return null;
  const createWidth = Math.min(columns, columns >= 24 ? 7 : 3);
  const closeWidth = selected ? Math.min(Math.max(0, columns - createWidth), columns >= 24 ? 8 : 3) : 0;
  const titleWidth = Math.max(0, columns - createWidth - closeWidth);
  const heading = `Audits ${records.length}${records.length > capacity && capacity > 0 ? ` · ${start + 1}–${Math.min(records.length, start + capacity)}` : ""}`;

  return (
    <box flexDirection="column" width={columns} height={height} flexShrink={0} minWidth={0} overflow="hidden">
      <box flexDirection="row" width={columns} height={1} flexShrink={0}>
        {titleWidth > 0 ? <text width={titleWidth} height={1} wrapMode="none" truncate fg={theme.TEXT} attributes={TextAttributes.BOLD}>{fitTuiText(heading, titleWidth)}</text> : null}
        <text width={createWidth} height={1} wrapMode="none" truncate fg={theme.ACCENT} onMouseDown={() => onCreate()}>{fitTuiText(columns >= 24 ? "[+ New]" : "[+]", createWidth)}</text>
        {closeWidth > 0 ? <text width={closeWidth} height={1} wrapMode="none" truncate fg={selected?.status === "stopping" ? theme.MUTED : theme.TEXT} onMouseDown={() => { if (selected && selected.status !== "stopping") onClose(selected.id); }}>{fitTuiText(columns >= 24 ? " [Close]" : "[×]", closeWidth)}</text> : null}
      </box>
      {records.length === 0 && capacity > 0 ? <text width={columns} height={1} wrapMode="none" truncate fg={theme.MUTED}>{fitTuiText("No live audits · create with Ctrl+Alt+N", columns)}</text> : null}
      {visible.map(record => {
        const active = record.id === selectedAuditId;
        const glyph = record.status === "completed" ? symbols.check : record.status === "failed" ? symbols.cross
          : record.status === "running" ? spinnerGlyph(frame, { reduceMotion })
          : record.status === "waiting" ? "?" : record.status === "stopping" ? symbols.parked : record.status === "stopped" ? symbols.stopped : symbols.queued;
        const color = record.status === "completed" ? theme.SUCCESS : record.status === "failed" ? theme.ERROR
          : record.status === "running" ? theme.ACCENT : record.status === "waiting" ? theme.WARNING : theme.MUTED;
        const title = sanitizeTuiText(record.title).trim() || "Untitled audit";
        const label = `${active ? symbols.rowMarker : " "}${record.unread ? "*" : " "} ${glyph} ${title}`;
        const activity = (record.status === "running" || record.status === "waiting") && record.activity
          ? `${record.status} · ${sanitizeTuiText(record.activity)}` : record.status;
        return (
          <box key={record.id} width={columns} height={rowHeight} flexShrink={0} flexDirection="column"
            backgroundColor={active ? theme.PANEL_ALT : undefined} onMouseDown={() => onSelect(record.id)}>
            <text width={columns} height={1} wrapMode="none" truncate fg={active ? theme.TEXT : color}
              attributes={active ? TextAttributes.BOLD : undefined}>{fitTuiText(label, columns)}</text>
            {rowHeight > 1 ? <text width={columns} height={1} wrapMode="none" truncate fg={theme.MUTED}>{fitTuiText(`    ${activity}`, columns)}</text> : null}
          </box>
        );
      })}
      {showHint ? <text width={columns} height={1} wrapMode="none" truncate fg={theme.MUTED}>{fitTuiText("Ctrl+Alt: ↑↓ select · N new · W close · * unread", columns)}</text> : null}
    </box>
  );
}
