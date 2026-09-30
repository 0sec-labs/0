import { describe, expect, it } from "vitest";
import type { Finding, JevEvaluator } from "@0/shared";
import { rankKernelHypothesesWithJev } from "./kernel-jev-prepass.js";

function finding(id: string): Finding {
  return {
    id,
    templateId: "kernel-review",
    title: `candidate ${id}`,
    description: "static kernel hypothesis",
    severity: "high",
    category: "use-after-free",
    status: "discovered",
    evidence: { request: "net/test.c:10", response: "", analysis: "possible refcount imbalance" },
    timestamp: 0,
  };
}

describe("rankKernelHypothesesWithJev", () => {
  it("ranks exhaustively and preserves provider failures as visible unscored candidates", async () => {
    let calls = 0;
    const evaluator: JevEvaluator = {
      async evaluate(request) {
        calls++;
        if (calls === 2) throw new Error("provider unavailable");
        const answers = Object.fromEntries(Object.keys(request.questions).map((id) => {
          if (id.endsWith("_priority")) {
            return [id, { type: "choice", choice: "high", probabilities: { high: 0.9, medium: 0.1, low: 0, defer: 0 } }];
          }
          const candidate = Number(id.match(/^c(\d+)/)?.[1] ?? 0);
          return [id, { type: "boolean", probability: candidate === 0 ? 0.95 : 0.55 }];
        }));
        return {
          model: "jev-test",
          answers,
          usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.001 },
          durationMs: 1,
        };
      },
    };

    const input = Array.from({ length: 17 }, (_, index) => finding(`f${String(index).padStart(2, "0")}`));
    const result = await rankKernelHypothesesWithJev("/missing-tree", input, evaluator);

    expect(result.candidates).toHaveLength(17);
    expect(new Set(result.candidates.map((candidate) => candidate.finding.id)).size).toBe(17);
    expect(result.candidates[0]?.finding.id).toBe("f00");
    expect(result.evaluated).toBe(16);
    expect(result.unscored).toBe(1);
    expect(result.candidates.at(-1)).toMatchObject({ disposition: "unscored", reason: "provider unavailable" });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.001 });
  });
});
