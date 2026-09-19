import { describe, expect, it } from "vitest";

import {
  COLLAPSED_SUBREPORT_LIMIT,
  EXPANDED_SUBREPORT_LIMIT,
  agentIntentLine,
  agentStatsParts,
  capTaskBodyLines,
  composeSubReportRow,
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

  it("formats badge, brief, and isolated affixes with an empty (unjoined) status line", () => {
    const { rows } = subReportRows([{ name: "A", agent: "scout", brief: "probe", isolated: true }], false);
    expect(rows[0]).toEqual({
      name: "A",
      badge: " (scout)",
      // The raw prompt is dropped; with no telemetry the tail falls back to
      // "Starting…" (the card only paints it while the agent is running).
      brief: "",
      isolated: " [isolated]",
      accentId: "A",
      status: "",
      running: false,
      stats: [],
      intent: "Starting…",
    });
  });

  it("falls back to a generic name and empty affixes", () => {
    const { rows } = subReportRows([{ name: "" }], false);
    expect(rows[0]).toEqual({
      name: "agent",
      badge: "",
      brief: "",
      isolated: "",
      accentId: "agent",
      status: "",
      running: false,
      stats: [],
      intent: "Starting…",
    });
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

describe("agentStatsParts", () => {
  it("emits tokens · context · duration · model in OMP order, compacted", () => {
    expect(
      agentStatsParts({ tokens: 12_400, contextTokens: 3100, durationMs: 8200, model: "sonnet" }),
    ).toEqual(["12.4k tok", "3.1k ctx", "8.20s", "sonnet"]);
  });

  it("omits every field that is missing or non-positive (no fabrication)", () => {
    expect(agentStatsParts({})).toEqual([]);
    expect(agentStatsParts({ tokens: 0, contextTokens: 0, durationMs: -1, model: "   " })).toEqual([]);
  });

  it("shows tokens alone when only tokens are present", () => {
    expect(agentStatsParts({ tokens: 842 })).toEqual(["842 tok"]);
  });

  it("truncates an over-long model id to 30 cells", () => {
    const [part] = agentStatsParts({ model: "anthropic/claude-opus-4-8:high-effort-xxx" });
    expect(part).toHaveLength(30);
    expect(part.endsWith("…")).toBe(true);
  });
});

describe("agentIntentLine", () => {
  it("joins tool and note for a running agent, capping the note at 40", () => {
    expect(agentIntentLine({ status: "running", tool: "shell", note: "probing /api/v2 for IDOR" })).toBe(
      "shell: probing /api/v2 for IDOR",
    );
    const long = "x".repeat(60);
    expect(agentIntentLine({ status: "working", tool: "shell", note: long })).toBe(`shell: ${"x".repeat(39)}…`);
  });

  it("shows the tool or the note alone when only one is present", () => {
    expect(agentIntentLine({ status: "running", tool: "read_file" })).toBe("read_file");
    expect(agentIntentLine({ status: "running", note: "reading the users table" })).toBe("reading the users table");
  });

  it("is empty for a settled or unknown status, even with a stale intent", () => {
    expect(agentIntentLine({ status: "completed", tool: "shell", note: "done" })).toBe("");
    expect(agentIntentLine({ status: undefined, tool: "shell", note: "x" })).toBe("");
  });
});

describe("composeSubReportRow", () => {
  it("assembles a full OMP-style running row with a stable accent id and stats", () => {
    expect(
      composeSubReportRow({
        name: "Explorer",
        agent: "scout",
        brief: "enumerate the users table",
        id: "agent-7f",
        status: "running",
        tokens: 12_400,
        durationMs: 8200,
        model: "sonnet",
        tool: "shell",
        note: "probing for IDOR",
      }),
    ).toEqual({
      name: "Explorer",
      badge: " (scout)",
      // The raw prompt is NOT surfaced; the tail carries the live summary.
      brief: "",
      isolated: "",
      accentId: "agent-7f",
      status: "running",
      running: true,
      stats: ["12.4k tok", "8.20s", "sonnet"],
      // Derived from the `report_status` note, sentence-cased — not the prompt.
      intent: "Probing for IDOR",
    });
  });

  it("opens an underscored status word and falls back to name for the accent id", () => {
    const row = composeSubReportRow({ name: "Prober", status: "in_progress" });
    expect(row.status).toBe("in progress");
    expect(row.accentId).toBe("Prober");
    // "in_progress" is not the running/working live state, so no intent shows.
    expect(row.running).toBe(false);
  });

  it("derives the tail from the child's current tool + args, never the spawn prompt", () => {
    const row = composeSubReportRow({
      name: "Reader",
      brief: "audit the whole authentication subsystem for IDOR and CSRF",
      status: "running",
      tool: "read_file",
      toolInput: { path: "src/auth/session.ts" },
      toolRunning: true,
    });
    // An in-flight tool is the freshest "now"; the prompt never appears.
    expect(row.intent).toBe("Reading session.ts");
    expect(row.brief).toBe("");
    expect(row.running).toBe(true);
  });

  it("prefers the child's latest assistant prose over a stale last tool", () => {
    const row = composeSubReportRow({
      name: "Writer",
      brief: "draft the migration plan",
      status: "working",
      tool: "read_file",
      assistant: "Now writing the rollback section of the migration plan.",
    });
    expect(row.intent).toBe("Now writing the rollback section of the migration plan");
    expect(row.brief).toBe("");
  });

  it("shows a live 'Working (turn N/M)' fallback before any tool/prose, not the prompt", () => {
    const row = composeSubReportRow({
      name: "Starter",
      brief: "explore the codebase",
      status: "running",
      turn: 2,
      maxTurns: 8,
    });
    expect(row.intent).toBe("Working (turn 2/8)");
    expect(row.brief).toBe("");
  });

  it("keeps a settled agent's terminal word (running/done/failed distinct)", () => {
    const done = composeSubReportRow({ name: "A", status: "completed", brief: "x" });
    expect(done.running).toBe(false);
    expect(done.intent).toBe("done");
    const failed = composeSubReportRow({ name: "B", status: "failed", brief: "x" });
    expect(failed.intent).toBe("failed");
  });
});
