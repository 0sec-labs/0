import { describe, expect, it } from "vitest";
import {
  budgetSidebarRows,
  budgetWrappedRows,
  todoTextWidth,
  wrapCells,
  buildSidebarOverflowText,
  buildSidebarHeader,
  isClosedTodo,
  selectEphemeralTodos,
  TODO_STRIKE_HOLD_MS,
  TODO_STRIKE_REVEAL_MS,
  TODO_STRIKE_TOTAL_MS,
  TODO_CLEAR_DELAY_MS,
} from "./todos-sidebar-layout.js";
import { fitTuiText } from "../text.js";
import type { TodosEventPayload } from "@0/core";

type Todo = TodosEventPayload["todos"][number];
const todo = (id: string, status: Todo["status"], content = id): Todo => ({ id, content, status });
const ids = (sel: { todos: readonly Todo[] }): string[] => sel.todos.map(t => t.id);

describe("budgetSidebarRows", () => {
  it("shows everything when the list fits, with no tail", () => {
    expect(budgetSidebarRows(3, 5)).toEqual({ visible: 3, overflow: 0 });
    expect(budgetSidebarRows(5, 5)).toEqual({ visible: 5, overflow: 0 });
    expect(budgetSidebarRows(0, 5)).toEqual({ visible: 0, overflow: 0 });
  });

  it("reserves one row for the tail when the list overflows", () => {
    // 5 rows, 8 items → 4 visible + a "+4 more" tail = 5 painted rows.
    expect(budgetSidebarRows(8, 5)).toEqual({ visible: 4, overflow: 4 });
  });

  it("hides everything into the tail when only one row is available", () => {
    expect(budgetSidebarRows(8, 1)).toEqual({ visible: 0, overflow: 8 });
  });

  it("paints nothing when there are no rows", () => {
    expect(budgetSidebarRows(8, 0)).toEqual({ visible: 0, overflow: 8 });
  });

  it("sweep: rows painted never exceed the budget and counts are conserved", () => {
    for (let count = 0; count <= 60; count++) {
      for (let rows = 0; rows <= 25; rows++) {
        const { visible, overflow } = budgetSidebarRows(count, rows);
        const painted = visible + (overflow > 0 ? 1 : 0);
        // With no rows granted nothing is painted (all items report as
        // overflow); the tail row only exists when there is a row to hold it.
        if (rows > 0) expect(painted).toBeLessThanOrEqual(rows);
        else expect(visible).toBe(0);
        expect(visible).toBeGreaterThanOrEqual(0);
        expect(overflow).toBeGreaterThanOrEqual(0);
        expect(visible + overflow).toBe(count);
      }
    }
  });
});

describe("todoTextWidth", () => {
  it("reserves the glyph cell and its gap", () => {
    expect(todoTextWidth(24)).toBe(22);
    expect(todoTextWidth(32)).toBe(30);
  });

  it("never returns less than one cell", () => {
    expect(todoTextWidth(2)).toBe(1);
    expect(todoTextWidth(1)).toBe(1);
    expect(todoTextWidth(0)).toBe(1);
  });

  it("sweep: fitted todo text never exceeds the row's text width", () => {
    const sample =
      "Enumerate the authentication surface and map every unauthenticated endpoint";
    for (let width = 1; width <= 40; width++) {
      const textWidth = todoTextWidth(width);
      const fitted = fitTuiText(sample, textWidth);
      expect(fitted.length).toBeLessThanOrEqual(textWidth);
      // The whole row (glyph + gap + text) never exceeds the column.
      expect(1 + 1 + fitted.length).toBeLessThanOrEqual(Math.max(3, width));
    }
  });
});

describe("wrapCells", () => {
  it("keeps a short title on a single row, unbroken", () => {
    expect(wrapCells("short title", 20, 2)).toEqual(["short title"]);
  });

  it("wraps on a word boundary across two rows without splitting a word", () => {
    const lines = wrapCells("unsafe tar extraction of attacker archive", 14, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(14);
    // No line starts or ends with a stray space; words stay intact where they fit.
    for (const line of lines) expect(line).toBe(line.trim());
  });

  it("ellipsises the last row when content remains beyond maxLines", () => {
    const lines = wrapCells(
      "patch archive extraction to reject path traversal entries entirely now",
      12,
      2,
    );
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
    expect(lines[1].endsWith("...")).toBe(true);
  });

  it("hard-splits a word longer than the width", () => {
    const lines = wrapCells("supercalifragilisticexpialidocious", 6, 2);
    expect(lines[0].length).toBeLessThanOrEqual(6);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(6);
  });

  it("honours a narrower first row for a trailing badge", () => {
    const lines = wrapCells("directory traversal in archive handler", 18, 2, 12);
    expect(lines[0].length).toBeLessThanOrEqual(12);
    for (let i = 1; i < lines.length; i++) expect(lines[i].length).toBeLessThanOrEqual(18);
  });

  it("always returns at least one row", () => {
    expect(wrapCells("", 10, 2)).toEqual([""]);
    expect(wrapCells("   ", 10, 2)).toEqual([""]);
  });

  it("sweep: every wrapped row fits its width and rows never exceed maxLines", () => {
    const samples = [
      "Unsafe tar extraction of attacker-controlled archive leads to RCE",
      "patch archive extraction to reject path traversal entries",
      "SSRF",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ];
    for (const sample of samples) {
      for (let width = 1; width <= 40; width++) {
        for (let maxLines = 1; maxLines <= 3; maxLines++) {
          for (const first of [width, Math.max(1, width - 5)]) {
            const lines = wrapCells(sample, width, maxLines, first);
            expect(lines.length).toBeGreaterThanOrEqual(1);
            expect(lines.length).toBeLessThanOrEqual(maxLines);
            lines.forEach((line, idx) => {
              const limit = idx === 0 ? first : width;
              expect(line.length).toBeLessThanOrEqual(limit);
            });
          }
        }
      }
    }
  });
});

describe("budgetWrappedRows", () => {
  it("shows everything when the total row cost fits, with no tail", () => {
    expect(budgetWrappedRows([1, 2, 1], 5)).toEqual({ visible: 3, overflow: 0 });
    expect(budgetWrappedRows([2, 2], 4)).toEqual({ visible: 2, overflow: 0 });
    expect(budgetWrappedRows([], 5)).toEqual({ visible: 0, overflow: 0 });
  });

  it("reserves one row for the tail when items overflow the budget", () => {
    // 5 rows, items costing 2+2+2 → two fit (4 rows) + a tail row = 5 painted.
    expect(budgetWrappedRows([2, 2, 2], 5)).toEqual({ visible: 2, overflow: 1 });
    // 4 rows, same items → only one fits beside the tail (2 + 1 = 3 ≤ 4).
    expect(budgetWrappedRows([2, 2, 2], 4)).toEqual({ visible: 1, overflow: 2 });
  });

  it("paints nothing but the tail when the first item cannot fit beside it", () => {
    expect(budgetWrappedRows([2, 2], 2)).toEqual({ visible: 0, overflow: 2 });
  });

  it("paints nothing when there are no rows", () => {
    expect(budgetWrappedRows([1, 2], 0)).toEqual({ visible: 0, overflow: 2 });
  });

  it("sweep: rows painted never exceed the budget and counts are conserved", () => {
    const costLists = [
      [1, 1, 1, 1, 1, 1, 1, 1],
      [2, 2, 2, 2, 2, 2],
      [1, 2, 1, 2, 1, 2, 1],
      [2, 1, 1, 2, 2, 1, 1, 2, 2],
    ];
    for (const costs of costLists) {
      for (let rows = 0; rows <= 20; rows++) {
        const { visible, overflow } = budgetWrappedRows(costs, rows);
        const paintedItemRows = costs
          .slice(0, visible)
          .reduce((acc, c) => acc + c, 0);
        const painted = paintedItemRows + (overflow > 0 ? 1 : 0);
        if (rows > 0) expect(painted).toBeLessThanOrEqual(rows);
        else expect(visible).toBe(0);
        expect(visible).toBeGreaterThanOrEqual(0);
        expect(overflow).toBeGreaterThanOrEqual(0);
        expect(visible + overflow).toBe(costs.length);
      }
    }
  });
});

describe("buildSidebarOverflowText", () => {
  it("returns empty for zero hidden items", () => {
    expect(buildSidebarOverflowText([], 20)).toBe("");
  });

  it("fits result to width", () => {
    const text = buildSidebarOverflowText(
      [{ status: "pending" }, { status: "pending" }],
      6,
    );
    expect(text.length).toBeLessThanOrEqual(6);
  });
});

describe("buildSidebarHeader", () => {
  it("fits result to width", () => {
    const text = buildSidebarHeader(5, 5, 5);
    expect(text.length).toBeLessThanOrEqual(5);
  });
});

describe("isClosedTodo", () => {
  it("treats completed and abandoned as closed, everything else as open", () => {
    expect(isClosedTodo("completed")).toBe(true);
    expect(isClosedTodo("abandoned")).toBe(true);
    expect(isClosedTodo("pending")).toBe(false);
    expect(isClosedTodo("in_progress")).toBe(false);
    expect(isClosedTodo("blocked")).toBe(false);
  });
});

describe("selectEphemeralTodos", () => {
  const NOW = 1_000_000;

  it("returns nothing to draw and no clear for an empty plan", () => {
    const sel = selectEphemeralTodos([], { now: NOW, completedAt: new Map() });
    expect(sel.todos).toEqual([]);
    expect(sel.cleared).toBe(false);
    expect(sel.strike.size).toBe(0);
    expect(sel.nextChangeInMs).toBeUndefined();
  });

  it("keeps a just-completed row as a flashing lead while open work remains", () => {
    const todos = [todo("a", "completed"), todo("b", "in_progress"), todo("c", "pending")];
    const completedAt = new Map([["a", NOW - 10]]); // 10ms ago → inside the flash
    const sel = selectEphemeralTodos(todos, { now: NOW, completedAt });
    expect(ids(sel)).toEqual(["a", "b", "c"]);
    expect(sel.strike.has("a")).toBe(true);
    expect(sel.cleared).toBe(false);
    expect(sel.nextChangeInMs).toBeGreaterThan(0);
  });

  it("self-prunes a completed row once its flash has elapsed", () => {
    const todos = [todo("a", "completed"), todo("b", "in_progress")];
    const completedAt = new Map([["a", NOW - TODO_STRIKE_TOTAL_MS - 1]]);
    const sel = selectEphemeralTodos(todos, { now: NOW, completedAt });
    expect(ids(sel)).toEqual(["b"]); // "a" has vanished
    expect(sel.strike.has("a")).toBe(false);
    expect(sel.cleared).toBe(false);
    expect(sel.nextChangeInMs).toBeUndefined(); // nothing left animating
  });

  it("hides a completed row that carries no timestamp (restored already-done)", () => {
    const todos = [todo("a", "completed"), todo("b", "pending")];
    const sel = selectEphemeralTodos(todos, { now: NOW, completedAt: new Map() });
    expect(ids(sel)).toEqual(["b"]);
    expect(sel.cleared).toBe(false);
  });

  it("progressively reveals the strike across the reveal window", () => {
    const todos = [todo("a", "completed"), todo("b", "in_progress")];
    const midReveal = NOW - (TODO_STRIKE_HOLD_MS + TODO_STRIKE_REVEAL_MS / 2);
    const sel = selectEphemeralTodos(todos, { now: NOW, completedAt: new Map([["a", midReveal]]) });
    const fraction = sel.strike.get("a");
    expect(fraction).toBeDefined();
    expect(fraction!).toBeGreaterThan(0.3);
    expect(fraction!).toBeLessThan(0.7);
  });

  it("holds the strike at zero during the initial hold beat", () => {
    const todos = [todo("a", "completed"), todo("b", "in_progress")];
    const sel = selectEphemeralTodos(todos, { now: NOW, completedAt: new Map([["a", NOW - 1]]) });
    expect(sel.strike.get("a")).toBe(0);
  });

  it("keeps a fully-settled plan visible during the linger, then schedules the clear", () => {
    const todos = [todo("a", "completed"), todo("b", "completed")];
    const completedAt = new Map([["a", NOW - 4_000], ["b", NOW - 1_000]]);
    const sel = selectEphemeralTodos(todos, { now: NOW, completedAt });
    expect(ids(sel)).toEqual(["a", "b"]); // still shown while it lingers
    expect(sel.cleared).toBe(false);
    // Clear is due clearDelay after the LATEST settle ("b", 1s ago).
    expect(sel.nextChangeInMs).toBe(TODO_CLEAR_DELAY_MS - 1_000);
  });

  it("clears the whole HUD once the settle delay has elapsed", () => {
    const todos = [todo("a", "completed"), todo("b", "completed")];
    const completedAt = new Map([["a", NOW - TODO_CLEAR_DELAY_MS - 1], ["b", NOW - TODO_CLEAR_DELAY_MS - 1]]);
    const sel = selectEphemeralTodos(todos, { now: NOW, completedAt });
    expect(sel.todos).toEqual([]);
    expect(sel.cleared).toBe(true);
    expect(sel.nextChangeInMs).toBeUndefined();
  });

  it("clears a restored, already-finished plan immediately (no timestamps)", () => {
    const todos = [todo("a", "completed"), todo("b", "completed")];
    const sel = selectEphemeralTodos(todos, { now: NOW, completedAt: new Map() });
    expect(sel.cleared).toBe(true);
    expect(sel.todos).toEqual([]);
  });

  it("honours overridden timing windows", () => {
    const todos = [todo("a", "completed"), todo("b", "in_progress")];
    // With a 10ms total window, a 20ms-old completion is already pruned.
    const sel = selectEphemeralTodos(todos, {
      now: NOW,
      completedAt: new Map([["a", NOW - 20]]),
      holdMs: 0,
      revealMs: 10,
    });
    expect(ids(sel)).toEqual(["b"]);
  });
});
