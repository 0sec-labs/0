/** @jsxImportSource @opentui/react */
import React, { useEffect, useReducer, useRef, useState } from "react";
import { sleekScrollbar } from "../scrollbar.js";
import { TextAttributes } from "@opentui/core";
import type { TodosEventPayload } from "@0/core";
import { fitTuiText } from "../text.js";
import type { Theme } from "../theme-context.js";
import { useSymbols } from "../symbol-context.js";
import {
  buildPlanOverflowFooter,
  buildSidebarHeader,
  buildTodoTreeRows,
  isClosedTodo,
  selectEphemeralTodos,
  windowTodoTree,
  SIDEBAR_SECTION_HEADER_ROWS,
  type EphemeralTodoSelection,
  type TodoTreeRow,
} from "./todos-sidebar-layout.js";

/**
 * The ephemeral-plan driver (oh-my-pi's self-pruning HUD, adapted to our TUI).
 *
 * It remembers WHEN each todo first closed — the one piece of state the pure
 * {@link selectEphemeralTodos} policy needs but cannot derive from a payload
 * snapshot — and feeds it, with `now`, to that policy every render. The policy
 * hands back which rows to show, the strike-reveal fraction for any row still
 * flashing, whether the settled plan has now cleared, and `nextChangeInMs`: the
 * one moment a further paint is due. We schedule exactly that paint with a
 * single self-terminating timeout — not a standing global ticker. While a turn
 * is running the host already re-renders us on its animation frame, so the
 * flash usually rides that cadence for free; the timeout only covers the quiet
 * gaps (notably the post-settle wait before the whole HUD clears).
 *
 * The completion stamps live in a ref, so they survive re-renders but not a
 * hide/show remount of the sidebar — which is harmless and intended: a reopened
 * plan simply shows its settled end-state rather than replaying old flashes,
 * exactly like the expansion state this column already treats as disposable.
 */
function useEphemeralPlan(todos: TodosEventPayload["todos"]): EphemeralTodoSelection {
  const stamps = useRef(new Map<string, number>());
  const [tick, bump] = useReducer((n: number) => (n + 1) % 1_000_000, 0);
  const now = Date.now();

  // Diff the snapshot against what we last saw: stamp newly-closed todos, void
  // the stamp of any that reopened, and forget ids that left the plan.
  const present = new Set<string>();
  for (const item of todos) {
    present.add(item.id);
    if (isClosedTodo(item.status)) {
      if (!stamps.current.has(item.id)) stamps.current.set(item.id, now);
    } else {
      stamps.current.delete(item.id);
    }
  }
  for (const id of [...stamps.current.keys()]) if (!present.has(id)) stamps.current.delete(id);

  const selection = selectEphemeralTodos(todos, { now, completedAt: stamps.current });

  useEffect(() => {
    if (selection.nextChangeInMs === undefined) return;
    const timer = setTimeout(bump, selection.nextChangeInMs);
    return () => clearTimeout(timer);
    // `tick` re-arms the timeout each frame while a change is still pending —
    // during a smooth reveal `nextChangeInMs` is constant, so it alone would
    // fire only once.
  }, [selection.nextChangeInMs, tick]);

  return selection;
}

/** One phase-aware tree shared by the transcript and bounded sidebar. */
export function TodoTree({ rows, width, theme, strike }: { rows: readonly TodoTreeRow[]; width: number; theme: Theme; strike?: ReadonlyMap<string, number> }) {
  return <>{rows.map(row => {
    const active = row.status === "in_progress";
    const prefixWidth = Math.min(width, row.prefix.length);
    const glyphWidth = Math.min(Math.max(0, width - prefixWidth), row.todoId ? 2 : 0);
    const textWidth = Math.max(0, width - prefixWidth - glyphWidth);
    const background = active ? theme.PANEL_ALT : undefined;
    const glyphColor = row.status === "completed" ? theme.SUCCESS : active ? theme.ACCENT : theme.MUTED;
    // A closed row mid-flash: its text glows SUCCESS and a strike-through sweeps
    // across it (STRIKETHROUGH on a struck prefix, plain suffix) before the row
    // self-prunes on the next selection. The reveal fraction is split by code
    // point, which matches how fitTuiText budgets cells here (1 char ≈ 1 cell).
    const reveal = row.todoId && row.first ? strike?.get(row.todoId) : undefined;
    let textCell: React.ReactNode = null;
    if (textWidth > 0) {
      if (reveal !== undefined) {
        const chars = [...fitTuiText(row.text, textWidth)];
        const struck = Math.min(chars.length, Math.max(0, Math.round(reveal * chars.length)));
        const head = chars.slice(0, struck).join("");
        const tail = chars.slice(struck).join("");
        const headWidth = struck;
        const tailWidth = chars.length - struck;
        textCell = (
          <box flexDirection="row" width={textWidth} height={1} flexShrink={0} minWidth={0} backgroundColor={background}>
            {headWidth > 0 ? <text width={headWidth} height={1} wrapMode="none" truncate fg={theme.SUCCESS} bg={background} attributes={TextAttributes.STRIKETHROUGH}>{head}</text> : null}
            {tailWidth > 0 ? <text width={tailWidth} height={1} wrapMode="none" truncate fg={theme.SUCCESS} bg={background}>{tail}</text> : null}
          </box>
        );
      } else {
        textCell = <text width={textWidth} height={1} wrapMode="none" truncate fg={active ? theme.TEXT : theme.MUTED} bg={background} attributes={active || !row.todoId ? TextAttributes.BOLD : undefined}>{fitTuiText(row.text, textWidth)}</text>;
      }
    }
    return (
      <box key={row.key} flexDirection="row" width={width} height={1} flexShrink={0} minWidth={0} backgroundColor={background}>
        {prefixWidth > 0 ? <text width={prefixWidth} height={1} wrapMode="none" truncate fg={active ? theme.ACCENT : theme.MUTED} bg={background}>{fitTuiText(row.prefix, prefixWidth)}</text> : null}
        {glyphWidth > 0 ? <text width={glyphWidth} height={1} wrapMode="none" truncate fg={glyphColor} bg={background}>{fitTuiText(`${row.glyph} `, glyphWidth)}</text> : null}
        {textCell}
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
  // Ephemeral pass first: it prunes finished rows and, once the plan is fully
  // settled, clears the whole HUD after a short delay (`cleared`). The header
  // count stays keyed to the FULL payload so "PLAN 5/5" is honest while the
  // finished plan lingers, not "PLAN 0/0" as its rows drain away.
  const plan = useEphemeralPlan(payload.todos);
  if (plan.cleared || plan.todos.length === 0 || columns === 0) return null;
  const done = payload.todos.filter(item => item.status === "completed").length;
  return (
    <box flexDirection="column" width={columns} minWidth={0} marginTop={1}>
      <text width={columns} height={1} wrapMode="none" truncate fg={theme.MUTED}>{buildSidebarHeader(done, payload.todos.length, columns)}</text>
      <TodoTree rows={buildTodoTreeRows(plan.todos, columns)} width={columns} theme={theme} strike={plan.strike} />
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
 * and the footer. Every row is explicitly sized so the section cannot paint
 * through the content below it.
 */
export function TodosSidebar({ payload, width, rows, theme, expanded: expandedProp, onToggle }: {
  payload: TodosEventPayload;
  width: number;
  rows: number;
  theme: Theme;
  expanded?: boolean;
  onToggle?: (expanded: boolean) => void;
}) {
  const symbols = useSymbols();
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = expandedProp ?? internalExpanded;
  const toggle = () => {
    if (onToggle) onToggle(!expanded);
    else if (expandedProp === undefined) setInternalExpanded(!expanded);
  };
  // Ephemeral pass: prune finished rows, flash fresh completions, and clear the
  // whole section a short beat after every task settles. Called before any early
  // return so the hook order stays fixed across renders.
  const plan = useEphemeralPlan(payload.todos);
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const height = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  if (plan.cleared || plan.todos.length === 0 || height < 3 || columns === 0) return null;
  // The blank separator row that sets AGENTS and FINDINGS apart, spent from
  // THIS section's own budget rather than added on top of it — a marginTop
  // would push the section one row past what the column granted it.
  const spacerRows = height >= 5 ? 1 : 0;
  const bodyWidth = Math.max(1, columns - (expanded ? 1 : 0));
  const capacity = Math.max(1, height - TODOS_SIDEBAR_HEADER_ROWS - 1 - spacerRows);
  const tree = buildTodoTreeRows(plan.todos, bodyWidth);
  const window = windowTodoTree(tree, capacity);
  // Progress stays keyed to the FULL payload so the header is honest while the
  // pruned rows drain out from under it.
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
  const caret = expanded ? symbols.caretOpen : symbols.caretClosed;
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
            verticalScrollbarOptions={sleekScrollbar(theme)}
          ><box width={bodyWidth} flexDirection="column" flexShrink={0}><TodoTree rows={tree} width={bodyWidth} theme={theme} strike={plan.strike} /></box></scrollbox>
        : <box flexDirection="column" width={columns} height={capacity} flexShrink={0} minWidth={0}><TodoTree rows={window.rows} width={bodyWidth} theme={theme} strike={plan.strike} /></box>}
      <text width={columns} height={1} wrapMode="none" truncate fg={theme.MUTED}>{fitTuiText(footer, columns)}</text>
    </box>
  );
}