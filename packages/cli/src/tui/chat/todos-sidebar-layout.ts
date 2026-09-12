/**
 * Row budgeting for the todos/plan section of the RIGHT sidebar.
 *
 * The sidebar is a narrow, fixed-height column shared by the AGENTS and
 * FINDINGS sections; the plan sits beneath them as a sibling section and must
 * never grow unbounded. This module holds the pieces of arithmetic the
 * component would otherwise inline — how many item rows to draw given the rows
 * the section was granted (folding the remainder into a single "+N more" tail),
 * how many cells an item's text may claim, and how an item's text wraps across
 * a small number of rows — so every invariant is a unit test rather than a code
 * review. It mirrors the cap logic already used by the AGENTS / FINDINGS /
 * SESSIONS sections in chat-screen, and the wrap/budget helpers are shared with
 * the FINDINGS sidebar section (see findings-sidebar-layout.ts).
 */

import { sanitizeTuiText, fitTuiText } from "../text.js";
import type { TodosEventPayload, TodoStatus } from "@0sec/core";

/** Default number of rows a wrapped sidebar item may span. */
export const DEFAULT_WRAP_LINES = 2;

/**
 * Word-wrap `value` to at most `maxLines` rows, each at most `width` cells. The
 * FIRST row is fitted to `firstWidth` (defaults to `width`) so a caller can
 * reserve trailing cells on line one for a glyph or badge; continuation rows
 * use the full `width`. Words that do not fit on an empty line are hard-split.
 * When content remains after `maxLines` rows, the LAST row is ellipsised (via
 * {@link fitTuiText}). Always returns at least one row (possibly `""`), and
 * every returned row is guaranteed ≤ its row's width in cells.
 */
export function wrapCells(
  value: unknown,
  width: number,
  maxLines: number = DEFAULT_WRAP_LINES,
  firstWidth?: number,
): string[] {
  const w = Math.max(1, Math.floor(width));
  const fw = Math.max(1, Math.floor(firstWidth ?? w));
  const maxL = Math.max(1, Math.floor(maxLines));
  const text = sanitizeTuiText(value);
  const lines: string[] = [];
  let rest = text;
  const widthFor = (index: number): number => (index === 0 ? fw : w);

  while (rest.length > 0 && lines.length < maxL) {
    const lw = widthFor(lines.length);
    if (rest.length <= lw) {
      lines.push(rest);
      rest = "";
      break;
    }
    // Prefer breaking on the last space at or before the width boundary so a
    // word is never split unless it is itself wider than the row.
    let breakAt = -1;
    for (let k = Math.min(lw, rest.length - 1); k > 0; k--) {
      if (rest[k] === " ") {
        breakAt = k;
        break;
      }
    }
    if (breakAt > 0) {
      lines.push(rest.slice(0, breakAt));
      rest = rest.slice(breakAt + 1);
    } else {
      // No space to break on within the width → hard-split the long word.
      lines.push(rest.slice(0, lw));
      rest = rest.slice(lw);
    }
  }

  // Content beyond the last drawable row: ellipsise the final row to its width.
  if (rest.length > 0 && lines.length > 0) {
    const idx = lines.length - 1;
    lines[idx] = fitTuiText(`${lines[idx]} ${rest}`, widthFor(idx));
  }
  if (lines.length === 0) lines.push("");
  return lines;
}

export interface SidebarRowBudget {
  /** How many items to render as full rows. */
  visible: number;
  /** How many are folded into the "+N more" tail (0 ⇒ no tail row). */
  overflow: number;
}

/**
 * Fit variable-height items into `availableRows` sidebar rows. `costs[i]` is the
 * number of rows item `i` occupies (≥1, e.g. from {@link wrapCells}). Items are
 * taken from the front while they fit; when they do not all fit, ONE row is
 * reserved for the "+N more" tail, so the rows actually painted —
 * `sum(costs[0..visible]) + (overflow > 0 ? 1 : 0)` — never exceed
 * `availableRows`. `visible + overflow` always equals the item count.
 */
export function budgetWrappedRows(
  costs: readonly number[],
  availableRows: number,
): SidebarRowBudget {
  const total = costs.length;
  const rows = Math.max(0, Math.floor(availableRows));
  if (rows <= 0) return { visible: 0, overflow: total };

  const sum = costs.reduce((acc, c) => acc + Math.max(1, Math.floor(c)), 0);
  if (sum <= rows) return { visible: total, overflow: 0 };

  // Everything cannot fit: reserve the last row for the tail and pack the rest.
  const budget = rows - 1;
  let used = 0;
  let visible = 0;
  for (const cost of costs) {
    const c = Math.max(1, Math.floor(cost));
    if (used + c <= budget) {
      used += c;
      visible += 1;
    } else break;
  }
  return { visible, overflow: total - visible };
}

/**
 * Fit `itemCount` items into `availableRows` sidebar rows. When everything
 * fits, all items show and there is no tail. When it does not, ONE row is
 * reserved for the "+N more" tail, so the rows actually painted —
 * `visible + (overflow > 0 ? 1 : 0)` — never exceed `availableRows`.
 * `visible + overflow` always equals the (clamped) item count.
 */
export function budgetSidebarRows(itemCount: number, availableRows: number): SidebarRowBudget {
  const count = Math.max(0, Math.floor(itemCount));
  const rows = Math.max(0, Math.floor(availableRows));
  if (rows <= 0) return { visible: 0, overflow: count };
  if (count <= rows) return { visible: count, overflow: 0 };
  const visible = Math.max(0, rows - 1);
  return { visible, overflow: count - visible };
}

/**
 * Cells available for a todo row's text: the column width minus the leading
 * glyph cell and its one-cell gap. Clamped to ≥1 so `fitTuiText` always has a
 * positive budget even in a degenerate 1-cell column.
 */
export function todoTextWidth(columnWidth: number): number {
  return Math.max(1, Math.floor(columnWidth) - 2);
}

// ── Shared sidebar-section idiom ────────────────────────────────────────────
//
// AGENTS / FINDINGS / PLAN are siblings in one narrow column and must read as
// one set. The two helpers below are the ONLY places the shared idiom is
// spelled out — a one-row `LABEL n` header, and a trailing status/severity
// badge that never eats the row's primary text — so the three sections cannot
// drift apart the way they had.

/** Rows every sidebar section spends on its header line. */
export const SIDEBAR_SECTION_HEADER_ROWS = 1;

/**
 * Cells a trailing badge (a finding's severity, an agent's status) may claim on
 * a sidebar row. Capped so the row's primary text always keeps at least four
 * cells, and collapsed to 0 in a column too narrow to carry both — the caller
 * then draws the text alone. This is the arithmetic the FINDINGS section has
 * always used; it lives here so AGENTS can use exactly the same rhythm.
 */
export function sidebarBadgeCells(label: string, columnWidth: number): number {
  const width = Math.max(0, Math.floor(columnWidth));
  const len = Math.max(0, String(label ?? "").length);
  return Math.min(len, Math.max(0, width - 4));
}

/**
 * The shared section header: an uppercase label followed by the count of items
 * the section actually holds, fitted to `width`. The count is rendered only
 * when it is a real, finite number — an unknown count shows the bare label
 * rather than a fabricated "0".
 */
export function buildSidebarSectionHeader(
  label: string,
  count: number | undefined,
  width: number,
): string {
  const name = String(label ?? "").toUpperCase();
  const text =
    typeof count === "number" && Number.isFinite(count) ? `${name} ${Math.max(0, Math.floor(count))}` : name;
  return fitTuiText(text, Math.max(1, width));
}

// ── Priority ordering for sidebar ───────────────────────────────────────────

/**
 * Status priority for sidebar display: `in_progress` (0) comes first so active
 * work is always visible, then `pending` (1), then `completed` (2). Within each
 * tier the item's original order is preserved.
 */
export function sidebarItemPriority(status: string): number {
  return status === "in_progress" ? 0 : status === "pending" ? 1 : 2;
}

/**
 * Build a short overflow summary that describes the hidden items rather than
 * a bare "+N more". Returns text already fitted to `width`.
 *
 * - All completed: "+N done"
 * - Some completed, some remaining: "+N remaining, M done"
 * - All remaining: "+N remaining"
 */
export function buildSidebarOverflowText(
  hiddenItems: ReadonlyArray<{ status: string }>,
  width: number,
): string {
  const count = hiddenItems.length;
  if (count <= 0) return "";

  let active = 0;
  let pending = 0;
  let completed = 0;
  for (const item of hiddenItems) {
    if (item.status === "in_progress") active++;
    else if (item.status === "pending") pending++;
    else completed++;
  }

  const remaining = active + pending;
  let text: string;
  if (remaining === 0) {
    text = `+${completed} done`;
  } else if (completed === 0) {
    text = `+${remaining} remaining`;
  } else {
    text = `+${remaining} remaining, ${completed} done`;
  }

  return fitTuiText(text, Math.max(1, width));
}

/**
 * Build the sidebar section header with status-aware labels.
 *
 * - All completed: "PLAN ● 5/5" (compact checkmark style)
 * - Normal: "PLAN 3/5"
 */
export function buildSidebarHeader(
  done: number,
  total: number,
  width: number,
): string {
  const base = `PLAN ${done}/${total}`;
  const allDone = done === total && total > 0;

  if (allDone) {
    // Compact: "PLAN ✓ 5/5"
    return fitTuiText(`PLAN ● ${done}/${total}`, Math.max(1, width));
  }

  return fitTuiText(base, Math.max(1, width));
}

/**
 * The PLAN section's footer when the collapsed view is hiding work.
 *
 * Truncation here must not delete information, so the line is CHOSEN to fit
 * rather than fitted by chopping: the richest phrasing that fits `width` wins,
 * and each fallback drops the least load-bearing clause first.
 *
 *   1. `+N more · M active · expand`   everything, when the column is wide
 *   2. `+N more · M active`            the hidden ACTIVE count outranks the
 *                                      word "expand", because the header's
 *                                      caret is the real affordance and is
 *                                      visible at every width — the hint is a
 *                                      reminder, the count is data
 *   3. `+N more`                       the narrowest honest statement
 *
 * Nothing hidden ⇒ empty string; the caller then shows its own idle hint. The
 * `M active` clause is omitted entirely when no active work is hidden rather
 * than printing "0 active".
 */
export function buildPlanOverflowFooter(hidden: number, active: number, width: number): string {
  const n = Math.max(0, Math.floor(hidden));
  if (n <= 0) return "";
  const a = Math.max(0, Math.floor(active));
  const cells = Math.max(1, Math.floor(width));
  const base = `+${n} more`;
  const withActive = a > 0 ? `${base} · ${a} active` : base;
  const candidates = [`${withActive} · expand`, withActive, base];
  for (const candidate of candidates) {
    if (candidate.length <= cells) return candidate;
  }
  return fitTuiText(base, cells);
}

export interface TodoTreeRow {
  key: string;
  prefix: string;
  glyph: string;
  text: string;
  status?: TodoStatus;
  todoId?: string;
  first?: boolean;
  last?: boolean;
  group: string;
}

/** One connected tree shared by transcript and sidebar; declared order is retained. */
export function buildTodoTreeRows(todos: TodosEventPayload["todos"], width: number, maxLines = Number.MAX_SAFE_INTEGER): TodoTreeRow[] {
  const groups = new Map<string, TodosEventPayload["todos"]>();
  for (const item of todos) {
    const group = item.group ?? "";
    const items = groups.get(group);
    if (items) items.push(item);
    else groups.set(group, [item]);
  }
  const result: TodoTreeRow[] = [];
  let groupIndex = 0;
  for (const [group, items] of groups) {
    const lastGroup = ++groupIndex === groups.size;
    const parentRail = group ? (lastGroup ? "  " : "│ ") : "";
    if (group) {
      const done = items.filter(item => item.status === "completed").length;
      const lines = wrapCells(`${group} ${done}/${items.length}`, Math.max(1, width - 2), maxLines);
      lines.forEach((text, index) => result.push({
        key: `group-${groupIndex}-${index}`, group,
        prefix: index === 0 ? (lastGroup ? "└─" : "├─") : parentRail,
        glyph: "", text,
      }));
    }
    items.forEach((item, itemIndex) => {
      const lastItem = itemIndex === items.length - 1;
      const firstPrefix = `${parentRail}${lastItem ? "└─" : "├─"}`;
      const continuation = `${parentRail}${lastItem ? "  " : "│ "}`;
      const lines = wrapCells(item.content, Math.max(1, width - firstPrefix.length - 2), maxLines);
      lines.forEach((text, index) => result.push({
        key: `${item.id}-${index}`, group, todoId: item.id, status: item.status,
        first: index === 0, last: index === lines.length - 1,
        prefix: index === 0 ? firstPrefix : continuation,
        glyph: index > 0 ? " " : item.status === "completed" ? "✓" : item.status === "in_progress" ? "▶" : "·",
        text,
      }));
    });
  }
  return result;
}

/** Keep real active tasks before nearby pending work and one completed context item. */
export function windowTodoTree(tree: readonly TodoTreeRow[], capacity: number): { rows: readonly TodoTreeRow[]; hiddenTodos: number; hiddenActive: number } {
  const count = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;
  if (tree.length <= count) return { rows: tree, hiddenTodos: 0, hiddenActive: 0 };
  const firstRows = tree.map((row, index) => ({ row, index })).filter(entry => entry.row.first);
  const active = firstRows.filter(entry => entry.row.status === "in_progress");
  const anchor = active[0]?.index ?? firstRows.find(entry => entry.row.status === "pending")?.index ?? 0;
  const pending = firstRows.filter(entry => entry.row.status === "pending");
  const nearby = [...pending.filter(entry => entry.index >= anchor), ...pending.filter(entry => entry.index < anchor)];
  const completed = firstRows.filter(entry => entry.row.status === "completed");
  const context = completed.filter(entry => entry.index < anchor).slice(-1);
  const priority = [...active, ...context, ...nearby, ...completed.filter(entry => !context.includes(entry))];
  const selected = new Set<number>();
  for (const entry of active) {
    if (selected.size >= count) break;
    selected.add(entry.index);
  }
  const first = active[0] ?? nearby[0];
  if (first && selected.size < count) {
    let heading = first.index - 1;
    while (heading >= 0 && tree[heading].group === first.row.group && tree[heading].todoId) heading--;
    if (heading >= 0 && tree[heading].group === first.row.group && !tree[heading].todoId) selected.add(heading);
  }
  for (const entry of priority) {
    if (selected.size >= count) break;
    selected.add(entry.index);
  }
  // Use spare rows for connected wraps and group context, never at an active task's expense.
  for (const entry of priority) {
    if (!selected.has(entry.index)) continue;
    for (let index = entry.index + 1; index < tree.length && tree[index].todoId === entry.row.todoId && selected.size < count; index++) selected.add(index);
    let heading = entry.index - 1;
    while (heading >= 0 && tree[heading].group === entry.row.group && tree[heading].todoId) heading--;
    if (heading >= 0 && tree[heading].group === entry.row.group && !tree[heading].todoId && selected.size < count) selected.add(heading);
  }
  const hidden = new Set<string>();
  const hiddenActive = new Set<string>();
  tree.forEach((row, index) => {
    if (row.todoId && !selected.has(index)) {
      hidden.add(row.todoId);
      if (row.first && row.status === "in_progress") hiddenActive.add(row.todoId);
    }
  });
  return { rows: tree.filter((_row, index) => selected.has(index)), hiddenTodos: hidden.size, hiddenActive: hiddenActive.size };
}
