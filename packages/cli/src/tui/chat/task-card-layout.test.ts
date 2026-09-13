import { describe, expect, it } from "vitest";

import {
  COLLAPSED_SUBREPORT_LIMIT,
  EXPANDED_SUBREPORT_LIMIT,
  capTaskBodyLines,
  splitTaskContext,
  subReportRows,
  taskBodyLines,
  taskMarkdownSections,
  type TaskBodyLine,
} from "./task-card-layout.js";
import type { ChatEntry } from "./types.js";

function entry(fields: Partial<ChatEntry>): ChatEntry {
  return { id: "e1", kind: "tool", text: "spawn_agents", turn: 1, metaKind: "task", ...fields };
}

describe("splitTaskContext", () => {
  it("splits the three canonical H1 headings", () => {
    const md = [
      "# Goal",
      "Land the task card.",
      "# Constraints",
      "No build runs.",
      "# Contract",
      "ToolResultMeta.kind = 'task'.",
    ].join("\n");
    expect(splitTaskContext(md)).toEqual({
      goal: "Land the task card.",
      constraints: "No build runs.",
      contract: "ToolResultMeta.kind = 'task'.",
    });
  });

  it("captures leading prose before the first heading as rest", () => {
    const md = ["Some preamble.", "# Goal", "Do the thing."].join("\n");
    const split = splitTaskContext(md);
    expect(split.rest).toBe("Some preamble.");
    expect(split.goal).toBe("Do the thing.");
  });

  it("is case-insensitive and keeps unrecognised headings inside their section", () => {
    const md = ["# goal", "line one", "## Sub", "still goal"].join("\n");
    const split = splitTaskContext(md);
    expect(split.goal).toBe("line one\n## Sub\nstill goal");
  });

  it("returns an empty object for blank input", () => {
    expect(splitTaskContext(undefined)).toEqual({});
    expect(splitTaskContext("   ")).toEqual({});
  });
});

describe("taskMarkdownSections", () => {
  it("prefers pre-split fields over taskContext", () => {
    const sections = taskMarkdownSections(
      entry({ taskGoal: "G", taskConstraints: "C", taskContext: "# Goal\nignored" }),
    );
    expect(sections.map((s) => s.label)).toEqual(["Goal", "Constraints"]);
    expect(sections[0].text).toBe("G");
  });

  it("splits taskContext when no pre-split fields exist, then appends assignment", () => {
    const sections = taskMarkdownSections(
      entry({ taskContext: "# Goal\nships\n# Contract\napi", taskAssignment: "# Target\nfoo.ts" }),
    );
    expect(sections.map((s) => s.label)).toEqual(["Goal", "Contract", "Assignment"]);
  });

  it("emits a Context section for unheaded context prose", () => {
    const sections = taskMarkdownSections(entry({ taskContext: "just some background" }));
    expect(sections).toEqual([{ label: "Context", text: "just some background" }]);
  });
});

describe("subReportRows", () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `Agent${i}`, agent: "scout", brief: `task ${i}` }));

  it("caps at the collapsed limit and reports the hidden count", () => {
    const { rows, hidden } = subReportRows(make(6), false);
    expect(rows).toHaveLength(COLLAPSED_SUBREPORT_LIMIT);
    expect(hidden).toBe(6 - COLLAPSED_SUBREPORT_LIMIT);
  });

  it("uncaps when expanded", () => {
    const { rows, hidden } = subReportRows(make(6), true);
    expect(rows).toHaveLength(6);
    expect(hidden).toBe(0);
  });

  it("formats badge, brief, and isolated affixes", () => {
    const { rows } = subReportRows([{ name: "A", agent: "scout", brief: "probe", isolated: true }], false);
    expect(rows[0]).toEqual({ name: "A", badge: " (scout)", brief: ": probe", isolated: " [isolated]" });
  });

  it("falls back to a generic name and empty affixes", () => {
    const { rows } = subReportRows([{ name: "" }], false);
    expect(rows[0]).toEqual({ name: "agent", badge: "", brief: "", isolated: "" });
  });

  it("bounds the expanded list at the given ceiling instead of growing forever", () => {
    const { rows, hidden } = subReportRows(make(40), true, EXPANDED_SUBREPORT_LIMIT);
    expect(rows).toHaveLength(EXPANDED_SUBREPORT_LIMIT);
    expect(hidden).toBe(40 - EXPANDED_SUBREPORT_LIMIT);
  });

  it("keeps the historical uncapped behaviour when no expanded ceiling is passed", () => {
    const { rows, hidden } = subReportRows(make(40), true);
    expect(rows).toHaveLength(40);
    expect(hidden).toBe(0);
  });
});

describe("taskBodyLines", () => {
  it("flattens each section into a rule row followed by one text row per line", () => {
    const lines = taskBodyLines([
      { label: "Goal", text: "line 1\nline 2" },
      { label: "Contract", text: "only" },
    ]);
    expect(lines).toEqual<TaskBodyLine[]>([
      { kind: "rule", label: "Goal" },
      { kind: "text", text: "line 1" },
      { kind: "text", text: "line 2" },
      { kind: "rule", label: "Contract" },
      { kind: "text", text: "only" },
    ]);
  });

  it("returns nothing for no sections", () => {
    expect(taskBodyLines([])).toEqual([]);
  });
});

describe("capTaskBodyLines", () => {
  const lines: TaskBodyLine[] = Array.from({ length: 40 }, (_, i) => ({ kind: "text", text: `l${i}` }));

  it("caps to the budget and reports the hidden remainder", () => {
    const { visible, hidden } = capTaskBodyLines(lines, 10);
    expect(visible).toHaveLength(10);
    expect(hidden).toBe(30);
  });

  it("hides nothing when the list fits the budget", () => {
    const { visible, hidden } = capTaskBodyLines(lines.slice(0, 4), 10);
    expect(visible).toHaveLength(4);
    expect(hidden).toBe(0);
  });

  it("treats a zero or negative budget as everything hidden", () => {
    expect(capTaskBodyLines(lines, 0)).toEqual({ visible: [], hidden: 40 });
    expect(capTaskBodyLines(lines, -5)).toEqual({ visible: [], hidden: 40 });
  });
});
