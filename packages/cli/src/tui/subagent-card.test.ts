import { describe, expect, it } from "vitest";
import {
  AGENT_SUMMARY_MAX,
  deriveAgentSummary,
  describeToolAction,
  parseSubagentCard,
  reduceActiveSubagents,
  summaryInputFromMessage,
} from "./subagent-card.js";

describe("parseSubagentCard", () => {
  it("returns card data for a successful completed subagent", () => {
    const card = parseSubagentCard(true, {
      turns: 12,
      findings: 3,
      summary: "Found SQLi in /api/users",
      done: true,
    });
    expect(card).toEqual({
      outcome: "completed",
      turns: 12,
      findings: 3,
      summary: "Found SQLi in /api/users",
    });
  });

  it("returns card data for a successful but incomplete subagent", () => {
    const card = parseSubagentCard(true, {
      turns: 25,
      findings: 0,
      summary: "Max turns reached, partial progress",
      done: false,
    });
    expect(card).toEqual({
      outcome: "failed",
      turns: 25,
      findings: 0,
      summary: "Max turns reached, partial progress",
    });
  });

  it("returns card data for a failed subagent with error", () => {
    const card = parseSubagentCard(false, null, "No API key available");
    expect(card).toEqual({
      outcome: "failed",
      turns: 0,
      findings: 0,
      summary: "",
      error: "No API key available",
    });
  });

  it("returns null for a non-subagent successful tool result", () => {
    expect(parseSubagentCard(true, "some plain string result")).toBeNull();
    expect(parseSubagentCard(true, 42)).toBeNull();
    expect(parseSubagentCard(true, null)).toBeNull();
  });

  it("returns null when output shape is wrong (missing turns)", () => {
    expect(parseSubagentCard(true, { findings: 1, summary: "x", done: true })).toBeNull();
  });

  it("returns null when output shape is wrong (non-number turns)", () => {
    expect(parseSubagentCard(true, { turns: "eight", findings: 1, summary: "x", done: true })).toBeNull();
  });

  it("returns null when output shape is wrong (non-string summary)", () => {
    expect(parseSubagentCard(true, { turns: 8, findings: 1, summary: 123, done: true })).toBeNull();
  });

  it("rejects negative or non-integer counters", () => {
    expect(parseSubagentCard(true, { turns: -1, findings: 0, summary: "x", done: true })).toBeNull();
    expect(parseSubagentCard(true, { turns: 1.5, findings: 0, summary: "x", done: true })).toBeNull();
    expect(parseSubagentCard(true, { turns: 1, findings: -1, summary: "x", done: true })).toBeNull();
  });

  it("trims whitespace from summary", () => {
    const card = parseSubagentCard(true, {
      turns: 5,
      findings: 1,
      summary: "  found it  ",
      done: true,
    });
    expect(card?.summary).toBe("found it");
  });

  it("returns card with error from non-success with empty error string", () => {
    const card = parseSubagentCard(false, null, "");
    expect(card).toEqual({
      outcome: "failed",
      turns: 0,
      findings: 0,
      summary: "",
      error: "",
    });
  });

  it("falls back to unknown error when error is missing", () => {
    const card = parseSubagentCard(false, null, undefined);
    expect(card).toEqual({
      outcome: "failed",
      turns: 0,
      findings: 0,
      summary: "",
      error: "unknown error",
    });
  });
});

describe("reduceActiveSubagents", () => {
  const qEvent = {
    agent_id: "a1",
    parent_scan_id: "scan-x",
    status: "queued" as const,
    task: "SQLi table enumeration",
    max_turns: 8,
  };

  const rEvent = {
    agent_id: "a1",
    parent_scan_id: "scan-x",
    status: "running" as const,
    task: "SQLi table enumeration",
    max_turns: 8,
    turns: 2,
  };

  const cEvent = {
    agent_id: "a1",
    parent_scan_id: "scan-x",
    status: "completed" as const,
    task: "SQLi table enumeration",
    max_turns: 8,
    turns: 6,
    findings: 2,
    summary: "found tables",
  };

  const fEvent = {
    agent_id: "a1",
    parent_scan_id: "scan-x",
    status: "failed" as const,
    task: "SQLi table enumeration",
    max_turns: 8,
    turns: 4,
    error: "API key expired",
  };

  it("inserts a queued event into empty state", () => {
    const result = reduceActiveSubagents({}, qEvent);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result.a1?.status).toBe("queued");
  });

  it("promotes queued to running", () => {
    const result = reduceActiveSubagents({ a1: qEvent }, rEvent);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result.a1?.status).toBe("running");
    expect(result.a1?.turns).toBe(2);
  });

  it("parks a completed agent in the roster (does not remove it)", () => {
    const state = { a1: rEvent, a2: { ...rEvent, agent_id: "a2", task: "XSS probe" } };
    const result = reduceActiveSubagents(state, cEvent);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result.a1?.status).toBe("completed");
    expect(result.a2).toBeDefined();
  });

  it("keeps a failed agent in the roster with its terminal status", () => {
    const state = { a1: rEvent };
    const result = reduceActiveSubagents(state, fEvent);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result.a1?.status).toBe("failed");
  });

  it("upserts a second agent alongside the first", () => {
    const state = { a1: rEvent };
    const second = { ...qEvent, agent_id: "a2", task: "XSS probe" };
    const result = reduceActiveSubagents(state, second);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result.a2?.status).toBe("queued");
  });

  it("returns a new object (not mutated)", () => {
    const state = { a1: qEvent };
    const result = reduceActiveSubagents(state, rEvent);
    expect(result).not.toBe(state);
    expect(state.a1?.status).toBe("queued");
  });
});
describe("describeToolAction", () => {
  it("names a concrete file target for read/write/edit tools", () => {
    expect(describeToolAction("read_file", { path: "src/auth/auth.ts" })).toBe("Reading auth.ts");
    expect(describeToolAction("apply_patch", { path: "packages/cli/src/tui/model-screen.tsx" }))
      .toBe("Editing model-screen.tsx");
    expect(describeToolAction("write", { file: "/tmp/out.json" })).toBe("Writing out.json");
  });

  it("falls back to a generic verb when no target argument is present", () => {
    expect(describeToolAction("read_file")).toBe("Reading files");
    expect(describeToolAction("Edit", {})).toBe("Editing files");
  });

  it("summarises a shell command by its first token (skipping env prefixes)", () => {
    expect(describeToolAction("bash", { command: "rg TODO packages/cli" })).toBe("Running `rg`");
    expect(describeToolAction("run_command", { command: "FOO=bar node build.js" })).toBe("Running `node`");
    expect(describeToolAction("bash", {})).toBe("Running a command");
  });

  it("summarises a search by its pattern and a fetch by its host", () => {
    expect(describeToolAction("search_files", { pattern: "spawn_agent" })).toBe("Searching for `spawn_agent`");
    expect(describeToolAction("grep", {})).toBe("Searching the code");
    expect(describeToolAction("http_request", { url: "https://www.example.com/a/b?x=1" }))
      .toBe("Fetching example.com");
  });

  it("maps domain tools and treats report_status as no action", () => {
    expect(describeToolAction("save_finding", { title: "x" })).toBe("Recording a finding");
    expect(describeToolAction("spawn_agents", {})).toBe("Delegating to subagents");
    expect(describeToolAction("report_status", { note: "x" })).toBe("");
  });

  it("keeps an unknown tool name as `Running <tool>` and is total on junk", () => {
    expect(describeToolAction("nmap")).toBe("Running nmap");
    expect(describeToolAction("")).toBe("");
    expect(() => describeToolAction("read_file", null)).not.toThrow();
  });
});

describe("deriveAgentSummary", () => {
  it("prefers a tool that is in flight over prose (the freshest 'now')", () => {
    expect(
      deriveAgentSummary({
        status: "running",
        assistant: "Now I will inspect the auth module.",
        tool: "read_file",
        toolInput: { path: "src/auth.ts" },
        toolRunning: true,
      }),
    ).toBe("Reading auth.ts");
  });

  it("uses the latest assistant prose (first sentence, sentence-cased) when no tool is in flight", () => {
    expect(
      deriveAgentSummary({
        status: "running",
        assistant: "reviewing the MCP tool-execution paths. Next I will read the handler.",
      }),
    ).toBe("Reviewing the MCP tool-execution paths");
  });

  it("strips leading Markdown noise from prose so a heading never echoes as-is", () => {
    expect(deriveAgentSummary({ status: "running", assistant: "# Reading the final lines" }))
      .toBe("Reading the final lines");
  });

  it("falls back through note, then last tool, then turn, then Starting…", () => {
    expect(deriveAgentSummary({ status: "running", note: "scanning ports" })).toBe("Scanning ports");
    expect(deriveAgentSummary({ status: "running", tool: "grep", toolInput: { pattern: "x" } }))
      .toBe("Searching for `x`");
    expect(deriveAgentSummary({ status: "running", turn: 3, maxTurns: 8 })).toBe("Working (turn 3/8)");
    expect(deriveAgentSummary({ status: "running" })).toBe("Starting…");
    expect(deriveAgentSummary({ status: "queued" })).toBe("Queued");
  });

  it("returns a terminal word for a settled agent, ignoring stale activity", () => {
    expect(deriveAgentSummary({ status: "completed", tool: "grep", assistant: "still going" })).toBe("done");
    expect(deriveAgentSummary({ status: "failed" })).toBe("failed");
    expect(deriveAgentSummary({ status: "cancelled" })).toBe("stopped");
    expect(deriveAgentSummary({ status: "incomplete" })).toBe("incomplete");
  });

  it("truncates to the bound with an ellipsis and never throws on junk", () => {
    const out = deriveAgentSummary({ status: "running", assistant: "a".repeat(200) }, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith("…")).toBe(true);
    expect(() => deriveAgentSummary(null)).not.toThrow();
    expect(() => deriveAgentSummary({ status: 5 as unknown as string })).not.toThrow();
    expect(deriveAgentSummary({})).toBe("Starting…");
    expect(AGENT_SUMMARY_MAX).toBeGreaterThan(0);
  });
});

describe("summaryInputFromMessage", () => {
  it("pulls the latest prose and the current (last) tool with its args + in-flight flag", () => {
    const out = summaryInputFromMessage({
      assistant: "Looking at the handler.",
      tools: [
        { call: { name: "read_file", arguments: { path: "a.ts" } }, result: { success: true, output: "" } },
        { call: { name: "grep", arguments: { pattern: "x" } }, running: true },
      ],
    });
    expect(out.assistant).toBe("Looking at the handler.");
    expect(out.tool).toBe("grep");
    expect(out.toolInput).toEqual({ pattern: "x" });
    expect(out.toolRunning).toBe(true);
  });

  it("is total: a non-object or a message with no tools yields an empty patch", () => {
    expect(summaryInputFromMessage(undefined)).toEqual({});
    expect(summaryInputFromMessage({ turn: 1 })).toEqual({});
    expect(summaryInputFromMessage({ tools: [] })).toEqual({});
    expect(() => summaryInputFromMessage({ tools: [null] })).not.toThrow();
  });
});
