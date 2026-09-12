/** @jsxImportSource @opentui/react */
import React, { useState } from "react";
import { TextAttributes } from "@opentui/core";
import type { TodosEventPayload } from "@0sec/core";
import { fitTuiText } from "../text.js";
import type { Theme } from "../theme-context.js";
import {
  buildPlanOverflowFooter,
  buildSidebarHeader,
  buildTodoTreeRows,
  windowTodoTree,
  SIDEBAR_SECTION_HEADER_ROWS,
  type TodoTreeRow,
} from "./todos-sidebar-layout.js";

/** One phase-aware tree shared by the transcript and bounded sidebar. */
function TodoTree({ rows, width, theme }: { rows: readonly TodoTreeRow[]; width: number; theme: Theme }) {
  return <>{rows.map(row => {
    const active = row.status === "in_progress";
    const prefixWidth = Math.min(width, row.prefix.length);
    const glyphWidth = Math.min(Math.max(0, width - prefixWidth), row.todoId ? 2 : 0);
    const textWidth = Math.max(0, width - prefixWidth - glyphWidth);
    const background = active ? theme.PANEL_ALT : undefined;
    const glyphColor = row.status === "completed" ? theme.SUCCESS : active ? theme.ACCENT : theme.MUTED;
    return (
      <box key={row.key} flexDirection="row" width={width} height={1} flexShrink={0} minWidth={0} backgroundColor={background}>
        {prefixWidth > 0 ? <text width={prefixWidth} height={1} wrapMode="none" truncate fg={active ? theme.ACCENT : theme.MUTED} bg={background}>{fitTuiText(row.prefix, prefixWidth)}</text> : null}
        {glyphWidth > 0 ? <text width={glyphWidth} height={1} wrapMode="none" truncate fg={glyphColor} bg={background}>{fitTuiText(`${row.glyph} `, glyphWidth)}</text> : null}
        {textWidth > 0 ? <text width={textWidth} height={1} wrapMode="none" truncate fg={active ? theme.TEXT : theme.MUTED} bg={background} attributes={active || !row.todoId ? TextAttributes.BOLD : undefined}>{fitTuiText(row.text, textWidth)}</text> : null}
      </box>
    );
  })}</>;
}

export function Todos({
  payload,
  width,
  theme,
}: {
  payload: TodosEventPayload;
  width: number;
  theme: Theme;
}) {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (payload.todos.length === 0 || columns === 0) return null;
  const done = payload.todos.filter(item => item.status === "completed").length;
  return (
    <box flexDirection="column" width={columns} minWidth={0} marginTop={1}>
      <text width={columns} height={1} wrapMode="none" truncate fg={theme.MUTED}>{buildSidebarHeader(done, payload.todos.length, columns)}</text>
      <TodoTree rows={buildTodoTreeRows(payload.todos, columns)} width={columns} theme={theme} />
    </box>
  );
}

export const TODOS_SIDEBAR_HEADER_ROWS = SIDEBAR_SECTION_HEADER_ROWS;

/**
 * The PLAN section of the RIGHT sidebar — the third sibling of AGENTS and
 * FINDINGS, and written to read as one of them: the same muted `PLAN done/total`
 * header line, the same status colours (SUCCESS for completed, ACCENT for the
 * task in flight, MUTED for everything not started), and the same `+N more`
 * overflow tail rather than a differently-worded footer.
 *
 * It differs in exactly one way, deliberately: the header is clickable and
 * carries a caret, because the plan is the only section that expands in place.
 * The caret is the ONLY accent on the line, so the affordance reads without the
 * section shouting louder than its siblings.
 *
 * EXPANSION STATE: prefer the CONTROLLED form — pass `expanded` and `onToggle`
 * and hold the flag on the persistent chat screen. This column is unmounted and
 * remounted whenever the right sidebar is hidden and reopened, so any state
 * living inside it is lost on that cycle. The uncontrolled `useState` fallback
 * below is kept only because losing it is harmless: it collapses back to the
 * default view and every hidden item is one click away again. Never put state
 * here that must SURVIVE a hide/show — a dismissal, an acknowledgement, or
 * anything the operator would have to redo — it belongs to the host.
 *
 * HEIGHT: the section paints EXACTLY `rows` rows and never one more — a leading
 * separator row (only when there is room for it), the header, the tree body,
 * and the footer. Every row is explicitly sized, because an overflowing section
 * in this column paints straight through the CloudHintCard beneath it.
 */
export function TodosSidebar({ payload, width, rows, theme, expanded: expandedProp, onToggle }: {
  payload: TodosEventPayload;
  width: number;
  rows: number;
  theme: Theme;
  expanded?: boolean;
  onToggle?: (expanded: boolean) => void;
}) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = expandedProp ?? internalExpanded;
  const toggle = () => {
    if (onToggle) onToggle(!expanded);
    else if (expandedProp === undefined) setInternalExpanded(!expanded);
  };
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const height = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  if (payload.todos.length === 0 || height < 3 || columns === 0) return null;
  // The blank separator row that sets AGENTS and FINDINGS apart, spent from
  // THIS section's own budget rather than added on top of it — a marginTop
  // would push the section one row past what the column granted it.
  const spacerRows = height >= 5 ? 1 : 0;
  const bodyWidth = Math.max(1, columns - (expanded ? 1 : 0));
  const capacity = Math.max(1, height - TODOS_SIDEBAR_HEADER_ROWS - 1 - spacerRows);
  const tree = buildTodoTreeRows(payload.todos, bodyWidth);
  const window = windowTodoTree(tree, capacity);
  const done = payload.todos.filter(item => item.status === "completed").length;
  // The same tail language as FINDINGS ("+N more"). Hidden work is never
  // silently dropped: the tail states how much is hidden, how much of it is
  // ACTIVE, and — whenever the column can carry the words — that expanding
  // reaches it. The header caret is the affordance at every width, so nothing
  // the collapsed view hides is unreachable.
  const footer = expanded
    ? "scroll · click PLAN to collapse"
    : window.hiddenTodos > 0
      ? buildPlanOverflowFooter(window.hiddenTodos, window.hiddenActive, columns)
      : "click PLAN to expand";
  const caret = expanded ? "▾" : "▸";
  const caretCells = Math.min(columns, 2);
  const labelCells = Math.max(0, columns - caretCells);
  return (
    <box flexDirection="column" width={columns} height={height} flexShrink={0} minWidth={0}>
      {spacerRows === 1 ? <box width={columns} height={1} flexShrink={0} minWidth={0} /> : null}
      <box flexDirection="row" width={columns} height={TODOS_SIDEBAR_HEADER_ROWS} flexShrink={0} minWidth={0} onMouseDown={toggle}>
        <text width={caretCells} height={1} wrapMode="none" truncate fg={theme.ACCENT}>{fitTuiText(`${caret} `, caretCells)}</text>
        {labelCells > 0 ? (
          <text width={labelCells} height={1} wrapMode="none" truncate fg={theme.MUTED}>{buildSidebarHeader(done, payload.todos.length, labelCells)}</text>
        ) : null}
      </box>
      {expanded
        ? <scrollbox
            width={columns}
            height={capacity}
            flexShrink={0}
            scrollX={false}
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: theme.PANEL,
                foregroundColor: theme.MUTED,
              },
              arrowOptions: {
                foregroundColor: theme.MUTED,
                backgroundColor: theme.PANEL,
              },
            }}
          ><box width={bodyWidth} flexDirection="column" flexShrink={0}><TodoTree rows={tree} width={bodyWidth} theme={theme} /></box></scrollbox>
        : <box flexDirection="column" width={columns} height={capacity} flexShrink={0} minWidth={0}><TodoTree rows={window.rows} width={bodyWidth} theme={theme} /></box>}
      <text width={columns} height={1} wrapMode="none" truncate fg={theme.MUTED}>{fitTuiText(footer, columns)}</text>
    </box>
  );
}