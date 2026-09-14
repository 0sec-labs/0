import { describe, expect, it } from "vitest";

import { MAX_RESULT_SUMMARY_CHARS, toolResultSummary } from "./tool-summary.js";
import { formatToolResult } from "./tool-format.js";
import { toolActionTitle } from "./chat/card-layout.js";
import type { ChatEntry } from "./chat/types.js";

// Build a settled tool ChatEntry the way chat-screen does: `detail` holds the
// result summary once an outcome is recorded.
function toolEntry(text: string, toolArgs: string, detail?: string): ChatEntry {
  return {
    id: "t",
    kind: "tool",
    turn: 1,
    text,
    toolArgs,
    ...(detail !== undefined ? { detail, success: true } : {}),
  };
}

describe("toolResultSummary — findings ledger & planning", () => {
  it("query_findings → N findings from the bare array", () => {
    expect(toolResultSummary("query_findings", new Array(20).fill({}))).toBe("20 findings");
    expect(toolResultSummary("query_findings", [{}])).toBe("1 finding");
    expect(toolResultSummary("query_findings", [])).toBe("0 findings");
  });

  it("update_todos → todos with done count", () => {
    expect(toolResultSummary("update_todos", { total: 3, done: 1, todos: [{}, {}, {}] })).toBe("3 todos · 1 done");
    expect(toolResultSummary("write_todos", { total: 1, done: 0 })).toBe("1 todo · 0 done");
    expect(toolResultSummary("update_todos", { todos: [{}, {}] })).toBe("2 todos");
  });

  it("use_loot → count of loot items", () => {
    expect(toolResultSummary("use_loot", { count: 4, items: [] })).toBe("4 loot items");
    expect(toolResultSummary("use_loot", { count: 0, items: [] })).toBe("0 loot items");
  });

  it("plan → tasks with open count", () => {
    expect(toolResultSummary("plan", { total: 5, open: [{}, {}] })).toBe("5 tasks · 2 open");
    expect(toolResultSummary("plan", { enabled: false, message: "x" })).toBe("plan disabled");
  });

  it("update_finding → the status message", () => {
    expect(toolResultSummary("update_finding", { message: "Finding F-1 updated to fixed" })).toBe(
      "Finding F-1 updated to fixed",
    );
  });
});

describe("toolResultSummary — intel (action-discriminated by output shape)", () => {
  it("search_advisories → GHSA/CVE breakdown when the slice accounts for all", () => {
    expect(
      toolResultSummary("intel", {
        count: 2,
        advisories: [{ id: "GHSA-aaaa-bbbb-cccc" }, { id: "CVE-2024-1086" }],
      }),
    ).toBe("1 GHSA · 1 CVE");
  });

  it("search_advisories → plain count when advisories were sliced below count", () => {
    expect(
      toolResultSummary("intel", { count: 40, advisories: [{ id: "GHSA-x" }, { id: "GHSA-y" }] }),
    ).toBe("40 advisories");
  });

  it("advisory_sweep → GHSA · CVE · public breakdown", () => {
    expect(
      toolResultSummary("intel", {
        counts: { total: 3, advisories: 3, publicReports: 0, high: 1, medium: 1, low: 1 },
        leads: [{ id: "GHSA-a" }, { id: "GHSA-b" }, { id: "CVE-2024-1" }],
      }),
    ).toBe("2 GHSA · 1 CVE · 0 public");
  });

  it("lookup_cve → found id / not found", () => {
    expect(toolResultSummary("intel", { found: true, advisory: { id: "CVE-2024-1086" } })).toBe(
      "found CVE-2024-1086",
    );
    expect(toolResultSummary("intel", { cve_id: "CVE-9", found: false })).toBe("not found");
  });

  it("search_public_reports → N reports of M", () => {
    expect(
      toolResultSummary("intel", { query: {}, count: 3, totalCount: 10, reports: [{}, {}, {}] }),
    ).toBe("3 reports of 10");
    expect(toolResultSummary("intel", { count: 2, totalCount: 2, reports: [{}, {}] })).toBe("2 reports");
  });
});

describe("toolResultSummary — scanner (tool-discriminated)", () => {
  it("run_scanner → prefers the handler's own human summary", () => {
    expect(
      toolResultSummary("run_scanner", { summary: "nmap: 3 port(s) reported on host", result: {} }),
    ).toBe("nmap: 3 port(s) reported on host");
  });

  it("run_scanner → reports a skipped scanner", () => {
    expect(
      toolResultSummary("run_scanner", { skipped: true, scanner: "nuclei", reason: "binary not installed" }),
    ).toBe("skipped nuclei: binary not installed");
  });

  it("run_scanner → derives from the parsed result when no summary", () => {
    expect(toolResultSummary("run_scanner", { result: { tool: "nmap", openPorts: [{}, {}, {}] } })).toBe(
      "3 open ports",
    );
    expect(toolResultSummary("run_scanner", { result: { tool: "nuclei", findings: [{}] } })).toBe("1 finding");
    expect(toolResultSummary("run_scanner", { result: { tool: "ffuf", hits: [{}, {}] } })).toBe("2 hits");
    expect(toolResultSummary("run_scanner", { result: { tool: "sqlmap", vulnerable: true } })).toBe("injectable");
  });
});

describe("toolResultSummary — recon, browser, orchestration", () => {
  it("crawl → pages · links · forms", () => {
    expect(toolResultSummary("crawl", { totalPages: 4, totalLinks: 37, totalForms: 2, pages: [] })).toBe(
      "4 pages · 37 links · 2 forms",
    );
  });

  it("web_search → result count", () => {
    expect(toolResultSummary("web_search", { message: "x", results: [{}, {}, {}] })).toBe("3 results");
  });

  it("browser navigate → status · title", () => {
    expect(toolResultSummary("browser", { url: "u", status: 200, title: "Home" })).toBe("200 · Home");
    expect(toolResultSummary("browser", { clicked: "#submit", url: "u" })).toBe("clicked #submit");
  });

  it("start_scan → status · child id", () => {
    expect(toolResultSummary("start_scan", { child_scan_id: "s-42", status: "queued" })).toBe("queued · s-42");
  });

  it("str_replace → replacement count", () => {
    expect(toolResultSummary("str_replace", { path: "a.ts", replacements: 3 })).toBe("3 replacements");
  });

  it("python_exec → lines · size, noting stderr", () => {
    expect(toolResultSummary("python_exec", { stdout: "a\nb\nc" })).toBe("3 lines · 5 B");
    expect(toolResultSummary("python_exec", { stdout: "", stderr: "boom" })).toBe("no output · stderr");
  });
});

describe("toolResultSummary — truthfulness & totality", () => {
  it("returns '' for unmodelled tools so the caller can fall back", () => {
    expect(toolResultSummary("mystery", { a: 1 })).toBe("");
    expect(toolResultSummary("mystery", [1, 2, 3])).toBe("");
  });

  it("returns '' when a known tool's output is the wrong shape", () => {
    expect(toolResultSummary("intel", null)).toBe("");
    expect(toolResultSummary("query_findings", { not: "an array" })).toBe("");
    expect(toolResultSummary("crawl", "nope")).toBe("");
  });

  it("never throws and stays bounded across garbage input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const inputs: unknown[] = [null, undefined, 42, "str", [], {}, cyclic, { count: Number.NaN }];
    for (const name of ["query_findings", "intel", "run_scanner", "crawl", "mystery"]) {
      for (const out of inputs) {
        expect(() => toolResultSummary(name, out)).not.toThrow();
        expect(toolResultSummary(name, out).length).toBeLessThanOrEqual(MAX_RESULT_SUMMARY_CHARS);
      }
    }
  });
});

describe("formatToolResult delegates domain tools to toolResultSummary", () => {
  it("query_findings flows through the default branch", () => {
    expect(
      formatToolResult({ name: "query_findings", arguments: {} }, { success: true, output: [{}, {}] }),
    ).toBe("2 findings");
  });

  it("intel advisory_sweep flows through the default branch", () => {
    expect(
      formatToolResult(
        { name: "intel", arguments: {} },
        {
          success: true,
          output: { counts: { total: 1, advisories: 1, publicReports: 1 }, leads: [{ id: "GHSA-z" }] },
        },
      ),
    ).toBe("1 GHSA · 1 public");
  });

  it("still falls back to a generic count for unknown tools", () => {
    expect(
      formatToolResult({ name: "mystery", arguments: {} }, { success: true, output: [1, 2, 3, 4] }),
    ).toBe("4 items");
  });

  it("a failure is still reported first, before any summary", () => {
    expect(
      formatToolResult({ name: "query_findings", arguments: {} }, { success: false, output: [], error: "boom" }),
    ).toBe("failed: boom");
  });
});

describe("toolActionTitle promotes the discriminator argument to a verb", () => {
  it("intel search_advisories reads as an Advisories operation", () => {
    // formatToolArgs leads with the raw action token, e.g.
    // "search_advisories go:github.com/uber/kraken".
    const title = toolActionTitle(toolEntry("intel", "search_advisories go:github.com/uber/kraken"));
    expect(title).toBe("Advisories go:github.com/uber/kraken");
  });

  it("run_scanner nmap reads as a Nmap operation", () => {
    expect(toolActionTitle(toolEntry("run_scanner", "nmap example.com"))).toBe("Nmap example.com");
  });

  it("browser navigate reads as a Navigate operation", () => {
    expect(toolActionTitle(toolEntry("browser", "navigate https://x.test"))).toBe("Navigate https://x.test");
  });

  it("query_findings reads as a Findings operation with its inputs", () => {
    expect(toolActionTitle(toolEntry("query_findings", "high (limit 20)"))).toBe("Findings high (limit 20)");
  });

  it("an unknown discriminator falls back to the identity verb + args", () => {
    expect(toolActionTitle(toolEntry("intel", "brand_new_action foo"))).toBe("Intel brand_new_action foo");
  });
});
