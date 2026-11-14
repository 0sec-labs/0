import { describe, it, expect } from "vitest";
import type { Finding, ScanConfig } from "../shared/index.js";
import type { NativeRuntime, NativeRuntimeResult, NativeMessage } from "../runtime/types.js";
import { buildDataset, mutateToFalse, runArm, summarize, compareArms, estimateAbCost, type FrozenCandidate } from "./skill-verify-ab.js";

function rec(i: number): FrozenCandidate {
  const finding: Finding = {
    id: `f-${i}`, templateId: `t-${i}`, title: `T${i}`, description: "d", severity: "high", category: "sql-injection",
    status: "discovered", timestamp: 0,
    evidence: { request: `GET /items${i}?id=1 HTTP/1.1`, response: "500 SQL syntax error", analysis: "sqli" },
  };
  return { id: finding.id, label: "true", origin: "recorded", finding };
}

/** Deterministic fake model: confirms iff the candidate still has proof (real endpoint, real param, response body). */
function fakeModel(opts: { silentFor?: RegExp; alwaysFalsePositive?: boolean } = {}): NativeRuntime {
  return {
    type: "api", isAvailable: async () => true,
    async executeNative(system: string, messages: NativeMessage[]): Promise<NativeRuntimeResult> {
      const id = /- id: (\S+)/.exec(system)![1]!;
      const usage = { inputTokens: 1000, outputTokens: 100 };
      if (messages.length > 1) return { content: [{ type: "tool_use", id: "d", name: "done", input: { summary: "x" } }], stopReason: "tool_use", durationMs: 1, usage };
      const bogus = system.includes("__nonexistent__") || system.includes("__nope__") || /Original response:\n+Original analysis/.test(system);
      const status = opts.alwaysFalsePositive || bogus ? "false-positive" : "confirmed";
      const content: NativeRuntimeResult["content"] = [];
      if (!(opts.silentFor && opts.silentFor.test(id))) content.push({ type: "tool_use", id: "u", name: "update_finding", input: { finding_id: id, status } });
      content.push({ type: "tool_use", id: "d", name: "done", input: { summary: status } });
      return { content, stopReason: "tool_use", durationMs: 1, usage };
    },
  };
}
const cfg = { target: "https://example.test", depth: "default", format: "json" } as ScanConfig;

describe("dataset", () => {
  it("builds true + synthetic false candidates deterministically", () => {
    const d1 = buildDataset([1, 2, 3, 4, 5, 6].map(rec)), d2 = buildDataset([1, 2, 3, 4, 5, 6].map(rec));
    expect(d1).toEqual(d2);
    expect(d1.filter((c) => c.label === "true")).toHaveLength(6);
    const f = d1.filter((c) => c.label === "false");
    expect(f).toHaveLength(6);
    expect(new Set(f.map((c) => c.id)).size).toBe(6);
    expect(f.every((c) => c.origin === "synthetic" && c.mutatedFrom)).toBe(true);
  });
  it("each mutation destroys a different part of the proof", () => {
    const [a, b, c] = [0, 1, 2].map((i) => mutateToFalse(rec(1), i).finding.evidence);
    expect(a.request).toContain("__nonexistent__");
    expect(b.request).toContain("__nope__=");
    expect(c.response).toBe("");
  });
});

describe("A/B arms on frozen candidates (fake runtime)", () => {
  const dataset = buildDataset(Array.from({ length: 9 }, (_, i) => rec(i + 1)));

  it("both arms score identically with a proof-aware model; B is non-inferior and fully terminal", async () => {
    const a = summarize("A", await runArm({ arm: "A", candidates: dataset, runtime: fakeModel(), config: cfg }));
    const b = summarize("B", await runArm({ arm: "B", candidates: dataset, runtime: fakeModel(), config: cfg }));
    expect(a.trueRecall).toBe(1); expect(a.fpRejection).toBe(1);
    expect(b.trueRecall).toBe(1); expect(b.fpRejection).toBe(1);
    expect(b.terminalRate).toBe(1);
    expect(b.oracleOverrides).toBe(0);
    expect(compareArms(a, b).pass).toBe(true);
  });

  it("a silent model leaves A with no verdict but B still records a terminal status (coverage gate)", async () => {
    const rt = fakeModel({ silentFor: /^f-3/ });
    const b = await runArm({ arm: "B", candidates: dataset, runtime: rt, config: cfg });
    expect(b.find((r) => r.id === "f-3")!.status).toBe("inconclusive");
    expect(b.every((r) => ["confirmed", "false-positive", "inconclusive"].includes(r.status))).toBe(true);
  });

  it("verified oracle blocks a model false-positive in arm B and is never counted as an override", async () => {
    const oracleById = { "f-1": { verified: true, confidence: 1, evidence: "boom", reason: "" } };
    const rt = fakeModel({ alwaysFalsePositive: true });
    const b = await runArm({ arm: "B", candidates: dataset.slice(0, 1), runtime: rt, config: cfg, oracleById });
    expect(b[0]).toMatchObject({ status: "confirmed", oracleOverride: false });
    const a = await runArm({ arm: "A", candidates: dataset.slice(0, 1), runtime: rt, config: cfg, oracleById });
    expect(a[0]).toMatchObject({ status: "false-positive", oracleOverride: true }); // legacy arm has no gate
  });

  it("compareArms flags regressions and stop conditions", () => {
    const base = summarize("A", [{ id: "x", label: "true", status: "confirmed", turns: 1, costUsd: 1, wallMs: 1, oracleOverride: false }]);
    const bad = { ...base, arm: "B" as const, trueRecall: 0.8, costPerFinding: 2, oracleOverrides: 1, terminalRate: 0.9 };
    const v = compareArms(base, bad);
    expect(v.pass).toBe(false);
    expect(v.failures.length).toBeGreaterThanOrEqual(4);
    expect(v.stop).toContain("recall drop > 5pp");
  });
});

describe("estimateAbCost", () => {
  it("is pure arithmetic over assumptions (no model calls)", () => {
    const e = estimateAbCost({ trueN: 100, falseN: 100, repeats: 3, model: "gpt-5.4" });
    expect(e.findingsPerArm).toBe(600);
    expect(e.totalUsd).toBeCloseTo(e.perArmUsd * 2);
    expect(e.perFindingUsd).toBeGreaterThan(0);
  });
});
