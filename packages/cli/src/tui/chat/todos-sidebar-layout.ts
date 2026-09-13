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

// ── Ephemeral plan (self-pruning HUD) ───────────────────────────────────────
//
// Ported from oh-my-pi's todo tool + interactive-mode auto-clear (see
// `isClosedTodo` / `selectCollapsedTodos` / `#syncTodoAutoClearTimer`). The
// intent: finished work stops cluttering the plan. A completed todo lingers
// only long enough to play a strike-through flash, then it self-prunes; once
// EVERY todo is settled the whole HUD collapses to nothing after a short delay.
//
// This module owns only the *policy* — it is a pure function of the todos, the
// timestamps at which they completed, and a caller-supplied `now`. No clock is
// read here and no timer is set: the component reads `Date.now()` per render,
// and the returned `nextChangeInMs` tells it exactly when the next visual change
// is due so it can nudge one more render (reusing the render cadence the sidebar
// already runs on, never a new global timer). That split keeps every rule below
// a unit test rather than something you can only see by watching the terminal.

/**
 * What "done, hide it" means, shared by every surface so the strike flash, the
 * self-prune, and the full-clear can never disagree about which todos are
 * finished (oh-my-pi's `isClosedTodo`). Takes a bare status string rather than
 * the {@link TodoStatus} union so a future `"abandoned"`/`"blocked"` vocabulary
 * needs no change here.
 */
export function isClosedTodo(status: string): boolean {
  return status === "completed" || status === "abandoned";
}

/** Beat before the strike begins to travel, so a completion registers first. */
export const TODO_STRIKE_HOLD_MS = 120;
/** How long the strike-through takes to sweep across a completed row's text. */
export const TODO_STRIKE_REVEAL_MS = 640;
/**
 * Total life of a completed row's flash. After this it self-prunes (vanishes)
 * while other work is still open — the "walking viewport" that keeps the plan
 * showing live work, not a growing pile of checked boxes.
 */
export const TODO_STRIKE_TOTAL_MS = TODO_STRIKE_HOLD_MS + TODO_STRIKE_REVEAL_MS;
/**
 * Delay after the LAST todo settles before the whole HUD collapses to empty
 * (oh-my-pi's `tasks.todoClearDelay`, whose default is 60s and is user
 * configurable). We deliberately shorten it to a few seconds and hardcode it —
 * the operator asked for finished plans to clear on their own after a *short*
 * delay, and settings.ts is a hot shared file we were asked to leave alone. If
 * configurability is ever wanted, a single number setting read by the host and
 * passed as `clearDelayMs` restores it without touching this policy.
 */
export const TODO_CLEAR_DELAY_MS = 6_000;
/** Re-render cadence hint while a strike is mid-sweep, so the reveal is smooth. */
const TODO_STRIKE_FRAME_MS = 60;

export interface EphemeralTodoOptions {
  /** Wall-clock the caller measured this render at (`Date.now()`). */
  now: number;
  /** todoId → ms at which it first became closed (completed/abandoned). */
  completedAt: ReadonlyMap<string, number>;
  /** Override the strike hold/reveal/clear windows (tests, or a host setting). */
  holdMs?: number;
  revealMs?: number;
  clearDelayMs?: number;
}

export interface EphemeralTodoSelection {
  /** The todos to render now: open work, plus any closed row still flashing. */
  todos: TodosEventPayload["todos"];
  /** todoId → strike reveal fraction in [0,1] for a currently-flashing row. */
  strike: Map<string, number>;
  /** True once a fully-settled plan's clear delay has elapsed → render nothing. */
  cleared: boolean;
  /**
   * Milliseconds until the next visual change (a strike frame, a self-prune, or
   * the full clear). The caller schedules ONE more render at this point;
   * `undefined` means the plan is visually at rest and needs no further nudge.
   */
  nextChangeInMs: number | undefined;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Reveal fraction for a completed row `elapsed` ms after it closed. */
function strikeReveal(elapsed: number, holdMs: number, revealMs: number): number {
  if (elapsed <= holdMs) return 0;
  if (revealMs <= 0) return 1;
  return clamp01((elapsed - holdMs) / revealMs);
}

/**
 * The ephemeral-plan policy. Given the current todos, the times each closed
 * todo settled, and `now`, decide what the HUD shows this instant:
 *
 *  - Open work always shows.
 *  - A closed todo shows ONLY while its flash is alive (`< totalMs` since it
 *    closed) — it plays a progressive strike-through, then self-prunes. A closed
 *    todo with no recorded timestamp (e.g. one restored already-done from a
 *    session) never flashed, so it is hidden immediately.
 *  - When EVERY todo is settled the plan lingers (still striking any fresh rows)
 *    until `clearDelayMs` after the last settle, then `cleared` flips true and
 *    the caller renders nothing. A fully-settled plan with no timestamps at all
 *    (a restored, already-finished plan) clears at once rather than lingering.
 *
 * `strike` carries the reveal fraction for whichever rows are mid-flash;
 * `nextChangeInMs` is when to paint next. Pure: same inputs ⇒ same output.
 */
export function selectEphemeralTodos(
  todos: TodosEventPayload["todos"],
  options: EphemeralTodoOptions,
): EphemeralTodoSelection {
  const { now, completedAt } = options;
  const holdMs = Math.max(0, options.holdMs ?? TODO_STRIKE_HOLD_MS);
  const revealMs = Math.max(0, options.revealMs ?? TODO_STRIKE_REVEAL_MS);
  const totalMs = holdMs + revealMs;
  const clearDelayMs = Math.max(0, options.clearDelayMs ?? TODO_CLEAR_DELAY_MS);

  const strike = new Map<string, number>();
  let next = Number.POSITIVE_INFINITY;
  const consider = (ms: number): void => {
    if (ms > 0 && ms < next) next = ms;
  };
  const nextChangeInMs = (): number | undefined =>
    Number.isFinite(next) ? Math.max(1, Math.ceil(next)) : undefined;

  if (todos.length === 0) return { todos, strike, cleared: false, nextChangeInMs: undefined };

  // How long a fresh closed row should stay on screen and how it strikes.
  const trackFlash = (id: string, elapsed: number): void => {
    if (elapsed >= totalMs) {
      strike.set(id, 1);
      return;
    }
    const fraction = strikeReveal(elapsed, holdMs, revealMs);
    strike.set(id, fraction);
    // Ask for the next paint: end of the hold beat, a smooth reveal frame, or
    // the moment the flash expires — whichever comes first.
    consider(elapsed < holdMs ? holdMs - elapsed : fraction < 1 ? TODO_STRIKE_FRAME_MS : totalMs - elapsed);
  };

  const settled = todos.every(item => isClosedTodo(item.status));

  if (settled) {
    let settledAt = Number.NEGATIVE_INFINITY;
    let anyStamp = false;
    for (const item of todos) {
      const stamp = completedAt.get(item.id);
      if (stamp != null) {
        anyStamp = true;
        if (stamp > settledAt) settledAt = stamp;
      }
    }
    // A plan settled with no timestamps at all was already finished when we first
    // saw it (a restored session): clear it straight away rather than lingering.
    if (!anyStamp) return { todos: [], strike, cleared: true, nextChangeInMs: undefined };

    const sinceSettled = now - settledAt;
    if (sinceSettled >= clearDelayMs) return { todos: [], strike, cleared: true, nextChangeInMs: undefined };

    // Still within the linger window: keep the finished plan up, striking any
    // rows whose flash has not yet expired, and schedule the full clear.
    for (const item of todos) {
      const stamp = completedAt.get(item.id);
      if (stamp != null) trackFlash(item.id, now - stamp);
    }
    consider(clearDelayMs - sinceSettled);
    return { todos, strike, cleared: false, nextChangeInMs: nextChangeInMs() };
  }

  // Open work remains: show it, and keep only the closed rows still flashing.
  const visible: TodosEventPayload["todos"] = [];
  for (const item of todos) {
    if (!isClosedTodo(item.status)) {
      visible.push(item);
      continue;
    }
    const stamp = completedAt.get(item.id);
    if (stamp == null) continue; // never flashed (restored done) → prune now
    const elapsed = now - stamp;
    if (elapsed >= totalMs) continue; // flash finished → self-prune (vanish)
    visible.push(item);
    trackFlash(item.id, elapsed);
  }
  return { todos: visible, strike, cleared: false, nextChangeInMs: nextChangeInMs() };
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
