import { describe, expect, it } from "vitest";
import { syzChoiceWeightsFromPlan, syzWeightingContextFromJev } from "./syz-choice-weights.js";

const baseOpts = { target: "6.12.101" };

describe("syzChoiceWeightsFromPlan", () => {
  it("produces a schema-complete weights file from a valid plan", () => {
    const plan = JSON.stringify({
      weights: { "socket$nl_route": 90, "sendmsg$nl_xfrm": 80, socket: 65, setsockopt: 60, mmap: 40 },
      rationale: "netlink focus",
    });
    const { file, rationale } = syzChoiceWeightsFromPlan(plan, baseOpts);
    expect(file.version).toBe(1);
    expect(file.target.label).toBe("linux/amd64");
    expect(Object.keys(file.weights).sort()).toEqual(["sendmsg$nl_xfrm", "setsockopt", "socket", "socket$nl_route", "mmap"].sort());
    expect([...file.allowed_names].sort()).toEqual(Object.keys(file.weights).sort());
    expect(file.provenance.provider.length).toBeGreaterThan(0);
    expect(file.provenance.plan_hash).toHaveLength(64);
    expect(file.provenance.source_hash).toHaveLength(64);
    expect(rationale).toBe("netlink focus");
  });

  it("drops unknown-shape names and non-positive weights", () => {
    const plan = JSON.stringify({
      weights: {
        "socket$nl_route": 90, "sendmsg$nl_xfrm": 80, socket: 65, setsockopt: 60, mmap: 40,
        "BAD NAME": 10, "io_uring_setup": -5, "nan": Number.NaN, "1bad": 3,
      },
    });
    const { file } = syzChoiceWeightsFromPlan(plan, baseOpts);
    expect(Object.keys(file.weights)).toHaveLength(5);
    expect(file.weights).not.toHaveProperty("io_uring_setup");
    expect(file.weights).not.toHaveProperty("BAD NAME");
  });

  it("clamps weights into [0.1, 100] and caps entry count", () => {
    const weights: Record<string, number> = {};
    for (let i = 0; i < 60; i++) weights[`call${i}`] = i === 0 ? 10_000 : 50;
    const { file } = syzChoiceWeightsFromPlan(JSON.stringify({ weights }), { ...baseOpts, maxEntries: 10 });
    expect(Object.keys(file.weights)).toHaveLength(10);
    expect(Math.max(...Object.values(file.weights))).toBeLessThanOrEqual(100);
  });

  it("rejects plans with too few valid entries", () => {
    const plan = JSON.stringify({ weights: { socket: 50, mmap: 10 } });
    expect(() => syzChoiceWeightsFromPlan(plan, baseOpts)).toThrow(/too few valid entries/);
  });

  it("rejects non-JSON and accepts fence-wrapped JSON", () => {
    expect(() => syzChoiceWeightsFromPlan("not json at all", baseOpts)).toThrow();
    const fenced = "```json\n" + JSON.stringify({ weights: { a: 1, b: 2, c: 3, d: 4 } }) + "\n```";
    const { file } = syzChoiceWeightsFromPlan(fenced, baseOpts);
    expect(Object.keys(file.weights)).toHaveLength(4);
  });
});

describe("syzWeightingContextFromJev", () => {
  it("serializes ranked evidence and omits provider failures", () => {
    const context = syzWeightingContextFromJev({
      commits: {
        candidates: [
          { sha: "abc", subject: "net: repair refcount", dateIso: "2026-01-01", rank: 1, score: 0.9,
            files: ["net/test.c"], nextAction: "variant-hunt" },
          { sha: "bad", subject: "unscored", dateIso: "2026-01-01", rank: 2, score: -1,
            files: [], nextAction: "context-expand", reason: "provider unavailable" },
        ],
        commitsEnumerated: 2, evaluated: 1, unscored: 1,
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, durationMs: 1,
      },
      hypotheses: {
        candidates: [{
          finding: { id: "f1", templateId: "kernel", title: "socket lifetime", description: "test",
            severity: "high", category: "use-after-free", status: "discovered",
            evidence: { request: "net/socket.c:42", response: "", analysis: "ref imbalance" }, timestamp: 0 },
          rank: 1, score: 0.8, disposition: "ranked", nextAction: "verify",
        }],
        evaluated: 1, unscored: 0,
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, durationMs: 1,
      },
    });
    expect(context).toContain("net/test.c");
    expect(context).toContain("net/socket.c:42");
    expect(context).toContain('"action":"verify"');
    expect(context).not.toContain("provider unavailable");
    expect(context).not.toContain('"sha":"bad"');
  });
});
