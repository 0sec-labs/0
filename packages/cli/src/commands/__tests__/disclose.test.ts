/**
 * CLI disclosure selection, argument validation, filing routes, and database
 * lifetime. Commander parses the operator's argv; database and rendering
 * boundaries stay hermetic. Rejections must surface to the caller rather than
 * being inferred from an unused execution mock.
 *
 * Runtime authorization and isolated PoC execution remain core concerns.
 * This suite does not re-pin legacy executor wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type { Finding } from "@0/shared";

// ── Module-level mocks ──────────────────────────────────────────────────────
//
// `disclose.ts` does `await import("@0/db")` inside the action — vitest
// hoists `vi.mock` so the dynamic import also resolves to our stub.

interface FakeFindingRow {
  id: string;
  scanId: string;
  title: string;
  severity: string;
  category: string;
  status: string;
  fingerprint?: string | null;
  triageStatus?: string | null;
  triageNote?: string | null;
  timestamp: number;
  templateId: string;
  description: string;
  evidenceRequest: string;
  evidenceResponse: string;
  evidenceAnalysis?: string | null;
  cvssVector?: string | null;
  cvssScore?: number | null;
  pocSteps?: string | null;
}

const dbState: {
  rows: FakeFindingRow[];
  closed: boolean;
  saveCalls: Array<{ id: string; report: unknown }>;
} = { rows: [], closed: false, saveCalls: [] };

vi.mock("@0/db", () => {
  class FakeOsecDB {
    constructor(_dbPath?: string) {
      dbState.closed = false;
    }
    listFindings(_opts: { scanId?: string; limit?: number }): FakeFindingRow[] {
      return dbState.rows;
    }
    saveFindingPocExecution(id: string, report: unknown): void {
      dbState.saveCalls.push({ id, report });
    }
    close(): void {
      dbState.closed = true;
    }
  }
  return { osecDB: FakeOsecDB };
});

// ── Core mocks ──────────────────────────────────────────────────────────────

const renderAdvisoryMarkdownMock = vi.fn();
const renderExploitScreenshotMock = vi.fn();
const isFreezeAvailableMock = vi.fn();
const verifyAgainstRefMock = vi.fn();
const detectVersionRangeMock = vi.fn();
const extractSiblingFixMock = vi.fn();
const decideFilingStateMock = vi.fn();
const assembleBundleIndexMock = vi.fn();
const formatDroppedReasonMock = vi.fn();
const droppedFilenameMock = vi.fn();

class FakeEmptyPocError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "EmptyPocError";
  }
}

vi.mock("@0/core", () => ({
  renderAdvisoryMarkdown: renderAdvisoryMarkdownMock,
  renderExploitScreenshot: renderExploitScreenshotMock,
  isFreezeAvailable: isFreezeAvailableMock,
  verifyAgainstRef: verifyAgainstRefMock,
  detectVersionRange: detectVersionRangeMock,
  extractSiblingFix: extractSiblingFixMock,
  EmptyPocError: FakeEmptyPocError,
  decideFilingState: decideFilingStateMock,
  assembleBundleIndex: assembleBundleIndexMock,
  formatDroppedReason: formatDroppedReasonMock,
  droppedFilename: droppedFilenameMock,
}));

const { registerDiscloseCommand } = await import("../disclose.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<FakeFindingRow> = {}): FakeFindingRow {
  return {
    id: "f1234567abcd0000",
    scanId: "scan-0000000000000001",
    title: "Reflected XSS in search",
    severity: "high",
    category: "xss",
    status: "verified",
    fingerprint: null,
    triageStatus: null,
    triageNote: null,
    timestamp: 1714521600000,
    templateId: "tpl-xss-reflected",
    description: "Reflected XSS via q= parameter",
    evidenceRequest: "GET /?q=<script>",
    evidenceResponse: "200 OK <script>...",
    evidenceAnalysis: null,
    cvssVector: null,
    cvssScore: null,
    pocSteps: null,
    ...overrides,
  };
}

async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerDiscloseCommand(program);
  await program.parseAsync(["node", "@0/cli", ...argv]);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dbState.rows = [];
  dbState.closed = false;
  dbState.saveCalls = [];

  renderAdvisoryMarkdownMock.mockReset().mockReturnValue({
    filename: "f1234567-xss.md",
    markdown: "# Advisory",
    primaryCwe: "CWE-79",
    cvssScore: 7.5,
  });
  renderExploitScreenshotMock.mockReset().mockReturnValue(null);
  isFreezeAvailableMock.mockReset().mockReturnValue(false);
  verifyAgainstRefMock.mockReset();
  detectVersionRangeMock.mockReset();
  extractSiblingFixMock.mockReset().mockReturnValue(null);
  decideFilingStateMock.mockReset().mockReturnValue({ filingState: "keep" });
  assembleBundleIndexMock.mockReset().mockReturnValue("# INDEX\n");
  formatDroppedReasonMock.mockReset().mockReturnValue("# dropped\n");
  droppedFilenameMock.mockReset().mockImplementation(
    (entry: { finding: Finding; patchStatus?: string; behaviouralVerdict?: string }) =>
      `${entry.finding.id.slice(0, 8)}-${entry.finding.severity}-${entry.patchStatus ?? entry.behaviouralVerdict ?? "dropped"}.md`,
  );

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("disclose — H1-readiness gate (AGENTS.md /disclose pipeline)", () => {
  it("batch mode: filters out `discovered` rows (LLM-hypothesised, not agent-confirmed)", async () => {
    dbState.rows = [
      makeRow({ id: "d0000000aaaa", status: "discovered" }),
      makeRow({ id: "v1111111bbbb", status: "verified" }),
    ];
    await runCli(["disclose", "--dry-run"]);
    // Only the verified row should reach the renderer.
    expect(renderAdvisoryMarkdownMock).toHaveBeenCalledOnce();
    const finding = renderAdvisoryMarkdownMock.mock.calls[0]![0] as Finding;
    expect(finding.id).toBe("v1111111bbbb");
    expect(finding.status).toBe("verified");
  });

  it("batch mode: filters out `false-positive` rows (explicitly rejected)", async () => {
    dbState.rows = [
      makeRow({ id: "fp00000ccc", status: "false-positive" }),
      makeRow({ id: "v11111dddd", status: "confirmed" }),
    ];
    await runCli(["disclose", "--dry-run"]);
    expect(renderAdvisoryMarkdownMock).toHaveBeenCalledOnce();
    const finding = renderAdvisoryMarkdownMock.mock.calls[0]![0] as Finding;
    expect(finding.id).toBe("v11111dddd");
  });

  it("batch mode: filters out triageStatus=suppressed rows", async () => {
    dbState.rows = [
      makeRow({ id: "s0000000eeee", status: "verified", triageStatus: "suppressed" }),
      makeRow({ id: "v1111111ffff", status: "verified" }),
    ];
    await runCli(["disclose", "--dry-run"]);
    expect(renderAdvisoryMarkdownMock).toHaveBeenCalledOnce();
    const finding = renderAdvisoryMarkdownMock.mock.calls[0]![0] as Finding;
    expect(finding.id).toBe("v1111111ffff");
  });

  it("batch mode: filters out rows below --severity-floor", async () => {
    dbState.rows = [
      makeRow({ id: "low00000aaaa", severity: "low", status: "verified" }),
      makeRow({ id: "med00000bbbb", severity: "medium", status: "verified" }),
      makeRow({ id: "hi000000cccc", severity: "high", status: "verified" }),
    ];
    await runCli(["disclose", "--severity-floor", "high", "--dry-run"]);
    expect(renderAdvisoryMarkdownMock).toHaveBeenCalledOnce();
    const finding = renderAdvisoryMarkdownMock.mock.calls[0]![0] as Finding;
    expect(finding.severity).toBe("high");
  });

  it("single-finding mode bypasses the status filter (operator-confirmed workflow)", async () => {
    // `discovered` row passed by ID prefix should still be drafted —
    // single-finding mode is the explicit-opt-in path per the gate's
    // commentary in disclose.ts.
    dbState.rows = [makeRow({ id: "deadbeefcafef00d", status: "discovered" })];
    await runCli(["disclose", "deadbeef", "--dry-run"]);
    expect(renderAdvisoryMarkdownMock).toHaveBeenCalledOnce();
    const finding = renderAdvisoryMarkdownMock.mock.calls[0]![0] as Finding;
    expect(finding.id).toBe("deadbeefcafef00d");
  });

  it("empty DB: emits 'No findings' message and exits clean (no renderer calls)", async () => {
    dbState.rows = [];
    await runCli(["disclose", "--dry-run"]);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toMatch(/No findings/i);
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });

  it("all rows filtered: emits 'No findings at or above severity ...' message", async () => {
    dbState.rows = [makeRow({ severity: "low", status: "verified" })];
    await runCli(["disclose", "--severity-floor", "high", "--dry-run"]);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toMatch(/No findings at or above severity 'high'/);
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });
});

describe("disclose — single-finding lookup", () => {
  it("exact ID match is preferred over prefix matches", async () => {
    dbState.rows = [
      makeRow({ id: "abc12345" }),
      makeRow({ id: "abc12345f00d" }),
    ];
    await runCli(["disclose", "abc12345", "--dry-run"]);
    expect(renderAdvisoryMarkdownMock).toHaveBeenCalledOnce();
    const finding = renderAdvisoryMarkdownMock.mock.calls[0]![0] as Finding;
    expect(finding.id).toBe("abc12345");
  });

  it("ambiguous prefix throws (and does not call the renderer)", async () => {
    dbState.rows = [
      makeRow({ id: "abc12345aaaa" }),
      makeRow({ id: "abc12345bbbb" }),
    ];
    await expect(runCli(["disclose", "abc1234", "--dry-run"])).rejects.toThrow(/ambiguous/i);
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });

  it("unknown ID throws (and does not call the renderer)", async () => {
    dbState.rows = [makeRow({ id: "abc12345aaaa" })];
    await expect(runCli(["disclose", "deadbeef", "--dry-run"])).rejects.toThrow(/not found/i);
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });
});

describe("disclose — argument validation", () => {
  beforeEach(() => {
    dbState.rows = [makeRow()];
  });

  it("rejects --reverify without --target-url", async () => {
    await expect(runCli(["disclose", "--reverify", "--dry-run"])).rejects.toThrow(/--target-url/);
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });

  it("rejects malformed --target-env (missing '=')", async () => {
    await expect(runCli([
      "disclose",
      "--reverify",
      "--target-url",
      "http://localhost:3000",
      "--target-env",
      "JUSTAKEY",
      "--dry-run",
    ])).rejects.toThrow(/--target-env/);
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });

  it("rejects --target-timeout-ms when non-positive", async () => {
    await expect(runCli([
      "disclose",
      "--reverify",
      "--target-url",
      "http://localhost:3000",
      "--target-timeout-ms",
      "0",
      "--dry-run",
    ])).rejects.toThrow(/--target-timeout-ms/);
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });

  it("rejects --reverify-rps when non-positive", async () => {
    await expect(runCli([
      "disclose",
      "--reverify",
      "--target-url",
      "http://localhost:3000",
      "--reverify-rps",
      "-1",
      "--dry-run",
    ])).rejects.toThrow(/--reverify-rps/);
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });

  it("rejects --reverify-rps when non-numeric", async () => {
    await expect(runCli([
      "disclose",
      "--reverify",
      "--target-url",
      "http://localhost:3000",
      "--reverify-rps",
      "fast",
      "--dry-run",
    ])).rejects.toThrow(/--reverify-rps/);
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });
});

describe("disclose — filing routes", () => {
  it("filingState='drop' routes through dropped path, skipping the renderer", async () => {
    dbState.rows = [makeRow()];
    decideFilingStateMock.mockReturnValueOnce({
      filingState: "drop",
      dropReason: "behavioural reverify: exploit_broken",
    });
    await runCli(["disclose", "--dry-run"]);
    // When filingState=drop, renderAdvisoryMarkdown is NOT called for that
    // row — the loop `continue`s after routeDroppedFinding.
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });

  it("drops an advisory rejected by the renderer for an empty PoC", async () => {
    dbState.rows = [makeRow()];
    decideFilingStateMock.mockReturnValue({ filingState: "keep" });
    renderAdvisoryMarkdownMock.mockImplementationOnce(() => {
      throw new FakeEmptyPocError("no PoC content");
    });
    await runCli(["disclose", "--dry-run"]);
    const out = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(out).toMatch(/\bdrop\b/);
    expect(out).not.toMatch(/\bwrote\b/);
  });
});

describe("disclose — database lifetime", () => {
  it("closes the database in the finally block (no leaked handle)", async () => {
    dbState.rows = [makeRow()];
    await runCli(["disclose", "--dry-run"]);
    expect(dbState.closed).toBe(true);
  });

  it("closes the database even when the loop short-circuits on empty DB", async () => {
    dbState.rows = [];
    await runCli(["disclose", "--dry-run"]);
    expect(dbState.closed).toBe(true);
  });
});

describe("disclose — multi-scan guardrail", () => {
  it("throws when selected findings span >1 scan and neither --scan nor --output-dir was passed", async () => {
    dbState.rows = [
      makeRow({ id: "row1aaaa", scanId: "scan-A" }),
      makeRow({ id: "row2bbbb", scanId: "scan-B" }),
    ];
    await expect(runCli(["disclose", "--dry-run"])).rejects.toThrow(/span .* scans/i);
    // The throw happens before the renderer is reached.
    expect(renderAdvisoryMarkdownMock).not.toHaveBeenCalled();
  });

  it("accepts multi-scan when --output-dir overrides the scan-scoped path", async () => {
    dbState.rows = [
      makeRow({ id: "row1aaaa", scanId: "scan-A" }),
      makeRow({ id: "row2bbbb", scanId: "scan-B" }),
    ];
    await runCli([
      "disclose",
      "--output-dir",
      "/tmp/0-disclose-multi",
      "--dry-run",
    ]);
    // Both rows reach the renderer when the multi-scan guard is satisfied.
    expect(renderAdvisoryMarkdownMock).toHaveBeenCalledTimes(2);
  });
});
