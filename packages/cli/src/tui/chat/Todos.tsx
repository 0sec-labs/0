/** @jsxImportSource @opentui/react */
import React, { useEffect, useReducer, useRef } from "react";
import { TextAttributes } from "@opentui/core";
import type { TodosEventPayload } from "@0/core";
import { fitTuiText } from "../text.js";
import type { Theme } from "../theme-context.js";
import { useSymbols } from "../symbol-context.js";
import {
  buildSidebarHeader,
  buildTodoTreeRows,
  isClosedTodo,
  selectEphemeralTodos,
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
          <box flexDirection="row" width={textWidth} height={1} flexShrink={0} minWidth={0}>
            {headWidth > 0 ? <text width={headWidth} height={1} wrapMode="none" truncate fg={theme.SUCCESS} attributes={TextAttributes.STRIKETHROUGH}>{head}</text> : null}
            {tailWidth > 0 ? <text width={tailWidth} height={1} wrapMode="none" truncate fg={theme.SUCCESS}>{tail}</text> : null}
          </box>
        );
      } else {
        textCell = <text width={textWidth} height={1} wrapMode="none" truncate fg={active ? theme.TEXT : theme.MUTED} attributes={active || !row.todoId ? TextAttributes.BOLD : undefined}>{fitTuiText(row.text, textWidth)}</text>;
      }
    }
    return (
      <box key={row.key} flexDirection="row" width={width} height={1} flexShrink={0} minWidth={0}>
        {prefixWidth > 0 ? <text width={prefixWidth} height={1} wrapMode="none" truncate fg={active ? theme.ACCENT : theme.MUTED}>{fitTuiText(row.prefix, prefixWidth)}</text> : null}
        {glyphWidth > 0 ? <text width={glyphWidth} height={1} wrapMode="none" truncate fg={glyphColor}>{fitTuiText(`${row.glyph} `, glyphWidth)}</text> : null}
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
