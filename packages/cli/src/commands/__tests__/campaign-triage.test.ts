/**
 * Tests for the docs-grounded severity triage of `0 campaign`
 * (packages/cli/src/commands/campaign-triage.ts).
 *
 * Pure prompt/parsing/orchestration helpers are exercised directly; the db
 * and the LLM are injected, so no network call and no real database are ever
 * touched (the optional live smoke runs against a COPY of an engagement db).
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildBatchTriagePrompt,
  buildDocsContext,
  buildTriagePrompt,
  clampSeverity,
  parseTriageVerdicts,
  runDocsTriage,
  triageFindings,
  triageNote,
  type TriageDb,
  type TriageFindingRow,
} from "../campaign-triage.js";

// ── 1. Prompt construction ──────────────────────────────────────────────────

describe("buildTriagePrompt", () => {
  const finding = {
    title: "Public gateway performs no authentication",
    description: "Any visitor holding the link reaches the terminal session. ".repeat(120),
    severity: "high",
    category: "exposure",
  };
  const prompt = buildTriagePrompt(finding, "The public ports are documented as shared demo terminals.\n## Intended design");

  it("includes the finding title and severity", () => {
    expect(prompt).toContain("Public gateway performs no authentication");
    expect(prompt).toContain("[high]");
    expect(prompt).toContain("category: exposure");
  });

  it("includes only an excerpt of a long description", () => {
    const longFinding = {
      ...finding,
      description: `${"Any visitor holding the link reaches the terminal session. ".repeat(120)}TRUNCATED-TAIL ${"z".repeat(2_000)}`,
    };
    const excerpted = buildTriagePrompt(longFinding, "docs");
    expect(excerpted).toContain("Any visitor holding the link reaches the terminal session.");
    expect(excerpted).toContain("…");
    expect(excerpted).not.toContain("TRUNCATED-TAIL");
  });

  it("embeds the docs context", () => {
    expect(prompt).toContain("The public ports are documented as shared demo terminals.");
  });

  it("demands a strict-JSON verdict in the spec's shape", () => {
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain('"documented_design": boolean');
    expect(prompt).toContain('"recommended_severity": "high"|"medium"|"low"|"info"');
  });

  it("state a placeholder when no docs context is available", () => {
    expect(buildTriagePrompt(finding, "   ")).toContain("(none provided)");
  });
});

describe("buildBatchTriagePrompt", () => {
  const findings = [
    { title: "Gateway performs no authentication", description: "link-only access", severity: "high", category: "exposure" },
    { title: "userns mounts permitted inside gVisor", description: "mount namespace allowed", severity: "medium", category: "hardening" },
  ];

  it("lists every finding with a zero-based index and asks for a JSON array", () => {
    const prompt = buildBatchTriagePrompt(findings, "docs text");
    expect(prompt).toContain("#1 [high] Gateway performs no authentication");
    expect(prompt).toContain("#2 [medium] userns mounts permitted inside gVisor");
    expect(prompt).toContain("JSON array");
    expect(prompt).toContain('"index"');
  });
});

// ── 2. Parsing and batch verdicts ───────────────────────────────────────────

describe("parseTriageVerdicts", () => {
  it("accepts a strict JSON array and keeps the given indexes", () => {
    const raw = JSON.stringify([
      { index: 0, documented_design: true, doc_page: "https://t/docs/gateways", reasoning: "documented as intended", recommended_severity: "info" },
      { index: 1, documented_design: false, doc_page: null, reasoning: "docs claim TLS", recommended_severity: "high" },
    ]);
    const verdicts = parseTriageVerdicts(raw);
    expect(verdicts).toEqual([
      { index: 0, documented_design: true, doc_page: "https://t/docs/gateways", reasoning: "documented as intended", recommended_severity: "info" },
      { index: 1, documented_design: false, doc_page: null, reasoning: "docs claim TLS", recommended_severity: "high" },
    ]);
  });

  it("accepts code-fenced JSON", () => {
    const verdicts = parseTriageVerdicts('```json\n[{"index":0,"documented_design":true,"doc_page":null,"reasoning":"r","recommended_severity":"low"}]\n```');
    expect(verdicts).toHaveLength(1);
    expect(verdicts![0]!.documented_design).toBe(true);
  });

  it("falls back to positional indexes when the model omits them", () => {
    const verdicts = parseTriageVerdicts('[{"documented_design":false,"doc_page":null,"reasoning":"r","recommended_severity":"high"},{"documented_design":true,"doc_page":null,"reasoning":"r","recommended_severity":"info"}]');
    expect(verdicts!.map((verdict) => verdict.index)).toEqual([0, 1]);
  });

  it("returns null for garbage and for non-array payloads", () => {
    expect(parseTriageVerdicts("these ports are, in my opinion, fine")).toBeNull();
    expect(parseTriageVerdicts("{not json")).toBeNull();
    expect(parseTriageVerdicts('{"documented_design": true}')).toBeNull();
    expect(parseTriageVerdicts("")).toBeNull();
  });

  it("never marks a verdict documented unless the model said exactly true", () => {
    const verdicts = parseTriageVerdicts('[{"index":0,"documented_design":"yes","doc_page":null,"reasoning":"r","recommended_severity":"info"}]');
    expect(verdicts![0]!.documented_design).toBe(false);
  });
});

describe("triageFindings", () => {
  const findings = [
    { title: "Gateway performs no authentication", description: "link-only access", severity: "high", category: "exposure" },
    { title: "userns mounts permitted inside gVisor", description: "mount namespace allowed", severity: "medium", category: "hardening" },
  ];

  it("makes exactly one LLM call and returns verdicts in input order", async () => {
    const llm = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("Gateway performs no authentication");
      expect(prompt).toContain("userns mounts permitted inside gVisor");
      return JSON.stringify([
        { index: 1, documented_design: true, doc_page: "docs/gvisor", reasoning: "intended design", recommended_severity: "info" },
        { index: 0, documented_design: false, doc_page: null, reasoning: "docs claim auth", recommended_severity: "high" },
      ]);
    });
    const verdicts = await triageFindings(findings, ["agent37.com docs"], llm);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(verdicts.map((verdict) => verdict.index)).toEqual([0, 1]);
    expect(verdicts[0]!.documented_design).toBe(false);
    expect(verdicts[1]!.documented_design).toBe(true);
  });

  it("trims each docs page to 20k chars and the total to 40k", async () => {
    let prompt = "";
    const llm = async (text: string) => {
      prompt = text;
      return "[]";
    };
    await triageFindings(findings, ["a".repeat(30_000), "b".repeat(30_000)], llm);
    expect(prompt).toContain("a".repeat(20_000));
    expect(prompt).not.toContain("a".repeat(20_001));
    expect(prompt.length - prompt.indexOf("docs") ).toBeLessThan(45_000);
  });

  it("returns [] without calling the model when there is nothing to triage", async () => {
    const llm = vi.fn();
    expect(await triageFindings([], ["docs"], llm)).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("returns [] silently when the LLM throws", async () => {
    const llm = vi.fn(async () => {
      throw new Error("upstream 500");
    });
    expect(await triageFindings(findings, ["docs"], llm)).toEqual([]);
  });

  it("returns [] when the answer cannot be parsed", async () => {
    expect(await triageFindings(findings, ["docs"], async () => "I could not produce JSON")).toEqual([]);
  });

  it("drops out-of-range and duplicate verdicts", async () => {
    const llm = async () => JSON.stringify([
      { index: 5, documented_design: true, doc_page: null, reasoning: "r", recommended_severity: "info" },
      { index: 0, documented_design: true, doc_page: null, reasoning: "first", recommended_severity: "info" },
      { index: 0, documented_design: false, doc_page: null, reasoning: "second", recommended_severity: "info" },
    ]);
    const verdicts = await triageFindings(findings, ["docs"], llm);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.index).toBe(0);
    expect(verdicts[0]!.reasoning).toBe("first");
  });
});

describe("clampSeverity", () => {
  it("keeps the current severity unless the recommendation is strictly lower", () => {
    expect(clampSeverity("medium", "high")).toBe("medium");
    expect(clampSeverity("medium", "medium")).toBe("medium");
    expect(clampSeverity("high", "info")).toBe("info");
    expect(clampSeverity("medium", "low")).toBe("low");
    expect(clampSeverity("medium", null)).toBe("medium");
    expect(clampSeverity("critical", "high")).toBe("high");
  });
});

// ── 3. Orchestration: downgrade-only writes and the rowid cursor ───────────

function mockDb(rows: TriageFindingRow[]): TriageDb & {
  since: number[];
  applied: Array<{ finding: TriageFindingRow; severity: string; note: string }>;
} {
  const since: number[] = [];
  const applied: Array<{ finding: TriageFindingRow; severity: string; note: string }> = [];
  return {
    listFindingsSince: (rowid: number) => {
      since.push(rowid);
      return rows;
    },
    applyDocsDowngrade: (finding, severity, note) => {
      applied.push({ finding, severity, note });
    },
    since,
    applied,
  };
}

function row(overrides: Partial<TriageFindingRow> & Pick<TriageFindingRow, "rowid" | "title" | "severity">): TriageFindingRow {
  return {
    id: `finding-${overrides.rowid}`,
    description: "observed behavior",
    category: "exposure",
    fingerprint: `fp-${overrides.rowid}`,
    triageStatus: "new",
    triageNote: null,
    ...overrides,
  };
}

describe("runDocsTriage", () => {
  it("applies documented_design verdicts as downgrade-only acceptances", async () => {
    const db = mockDb([
      row({ rowid: 7, title: "Gateway performs no authentication", severity: "high" }),
      row({ rowid: 8, title: "userns mounts permitted inside gVisor", severity: "medium" }),
    ]);
    const llm = async (prompt: string) => {
      expect(prompt).toContain("Gateway performs no authentication");
      return JSON.stringify([
        { index: 0, documented_design: true, doc_page: "https://www.agent37.com/docs/llms.txt", reasoning: "docs describe public gateways as intended", recommended_severity: "info" },
        { index: 1, documented_design: true, doc_page: "https://www.agent37.com/docs/llms.txt", reasoning: "docs describe userns as intended", recommended_severity: "info" },
      ]);
    };
    const run = await runDocsTriage({ db, docsPages: ["agent37 docs"], llm, lastTriagedRowid: 6 });
    expect(run).toEqual({ checked: 2, downgraded: 2, unchanged: 0, lastTriagedRowid: 8 });
    expect(db.since).toEqual([6]);
    expect(db.applied).toHaveLength(2);
    expect(db.applied[0]!.severity).toBe("info");
    expect(db.applied[0]!.note).toBe(triageNote("docs describe public gateways as intended", "https://www.agent37.com/docs/llms.txt"));
    expect(db.applied[0]!.note).toContain("docs-grounded triage:");
  });

  it("ignores upgrade claims: a medium finding recommended high keeps medium", async () => {
    const db = mockDb([row({ rowid: 3, title: "Ports exposed", severity: "medium" })]);
    const llm = async () => JSON.stringify([
      { index: 0, documented_design: true, doc_page: null, reasoning: "definitely bad", recommended_severity: "high" },
    ]);
    const run = await runDocsTriage({ db, docsPages: ["docs"], llm });
    expect(db.applied).toHaveLength(1);
    expect(db.applied[0]!.severity).toBe("medium");
    expect(run).toEqual({ checked: 1, downgraded: 0, unchanged: 1, lastTriagedRowid: 3 });
  });

  it("never touches findings the operator already triaged or below-medium ones", async () => {
    const db = mockDb([
      row({ rowid: 4, title: "Already accepted", severity: "high", triageStatus: "accepted" }),
      row({ rowid: 5, title: "Suppressed by operator", severity: "high", triageStatus: "suppressed" }),
      row({ rowid: 6, title: "Low severity noise", severity: "low" }),
    ]);
    const llm = vi.fn(async () => "[]");
    const run = await runDocsTriage({ db, docsPages: ["docs"], llm, lastTriagedRowid: 3 });
    expect(llm).not.toHaveBeenCalled();
    expect(db.applied).toHaveLength(0);
    // The eligibility filter resolved every row, so the cursor still moves.
    expect(run).toEqual({ checked: 0, downgraded: 0, unchanged: 0, lastTriagedRowid: 6 });
  });

  it("leaves the cursor in place when the LLM fails, so findings are retried", async () => {
    const db = mockDb([row({ rowid: 9, title: "Something high", severity: "high" })]);
    const llm = async () => {
      throw new Error("openrouter down");
    };
    const run = await runDocsTriage({ db, docsPages: ["docs"], llm, lastTriagedRowid: 4 });
    expect(run).toEqual({ checked: 0, downgraded: 0, unchanged: 0, lastTriagedRowid: 4 });
    expect(db.applied).toHaveLength(0);
    expect(db.since).toEqual([4]);
  });

  it("keeps the cursor when the answer is unparseable garbage", async () => {
    const db = mockDb([row({ rowid: 9, title: "Something high", severity: "high" })]);
    const run = await runDocsTriage({ db, docsPages: ["docs"], llm: async () => "…!?" });
    expect(run.lastTriagedRowid).toBe(0);
    expect(db.applied).toHaveLength(0);
  });

  it("returns early without querying when no findings exist since the cursor", async () => {
    const db = mockDb([]);
    const llm = vi.fn(async () => "[]");
    const run = await runDocsTriage({ db, docsPages: ["docs"], llm, lastTriagedRowid: 12 });
    expect(run).toEqual({ checked: 0, downgraded: 0, unchanged: 0, lastTriagedRowid: 12 });
    expect(llm).not.toHaveBeenCalled();
    expect(db.since).toEqual([12]);
  });
});

// ── 4. Docs context assembly ────────────────────────────────────────────────

describe("buildDocsContext", () => {
  it("caps each page at 20k chars and the total at 40k", () => {
    const context = buildDocsContext(["a".repeat(30_000), "b".repeat(30_000)]);
    expect(context.startsWith("a".repeat(20_000))).toBe(true);
    expect(context).toContain("b".repeat(19_998));
    expect(context).not.toContain("b".repeat(19_999));
    expect(context.length).toBe(40_000);
    // The per-page cap keeps page 2's content inside the total budget even
    // with the join separator.
    expect(context.length).toBeLessThanOrEqual(40_000);
  });

  it("keeps short pages intact", () => {
    expect(buildDocsContext(["short docs"])).toBe("short docs");
  });
});