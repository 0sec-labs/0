import { describe, expect, it } from "vitest";
import type { JevEvaluator } from "@0sec/shared";
import { rankCrashesWithJev, crashSummaryFromTriage } from "./crash-triage.js";
import type { CrashRecord } from "./crash-triage.js";

function crash(id: string, overrides: Partial<CrashRecord> = {}): CrashRecord {
  return {
    id,
    target: "kernel-6.12",
    summary: `UAF in ${id}: slab-use-after-free in foo_free during concurrent bar_put`,
    backtrace: `BUG: KASAN: use-after-free in foo_free+0x1a4/0x200\n ${id}_crash trace line 2\n ${id}_crash trace line 3`,
    pc: "0xffffffff8123456",
    registers: "RAX: 0xdead000000000042 RDI: 0xdead000000000042",
    subsystem: "net/core",
    ...overrides,
  };
}

const PROVE_EVALUATOR: JevEvaluator = {
  async evaluate(request) {
    const answers = Object.fromEntries(Object.keys(request.questions).map((id) => {
      if (id.endsWith("_exploitable")) return [id, { type: "boolean", probability: 0.85 }];
      if (id.endsWith("_knownPattern")) return [id, { type: "boolean", probability: 0.2 }];
      return [id, { type: "choice", choice: "high", probabilities: { high: 0.9, medium: 0.1, low: 0, defer: 0 } }];
    }));
    return {
      model: "jev-test",
      answers,
      usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.001 },
      durationMs: 1,
    };
  },
};

describe("rankCrashesWithJev", () => {
  it("ranks exhaustively and preserves provider failures as visible unscored candidates", async () => {
    let successes = 0;
    const evaluator: JevEvaluator = {
      async evaluate(request) {
        // Fail the batch containing crash c16, wherever batching places it.
        const state = request.state as Array<{ id?: string }>;
        if (state.some((entry) => entry.id === "c16")) throw new Error("provider unavailable");
        successes++;
        const answers = Object.fromEntries(Object.keys(request.questions).map((id) => {
          if (id.endsWith("_exploitable")) return [id, { type: "boolean", probability: 0.7 }];
          if (id.endsWith("_knownPattern")) return [id, { type: "boolean", probability: 0.3 }];
          return [id, { type: "choice", choice: "high", probabilities: { high: 0.8, medium: 0.15, low: 0.05, defer: 0 } }];
        }));
        return {
          model: "jev-test",
          answers,
          usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.001 },
          durationMs: 1,
        };
      },
    };

    // 17 crashes; every batch succeeds except the one holding c16.
    const input = Array.from({ length: 17 }, (_, index) => crash(`c${String(index).padStart(2, "0")}`));
    const result = await rankCrashesWithJev(input, evaluator);

    expect(result.candidates).toHaveLength(17);
    expect(new Set(result.candidates.map((candidate) => candidate.crash.id)).size).toBe(17);
    expect(result.evaluated).toBe(16);
    expect(result.unscored).toBe(1);
    expect(result.candidates.at(-1)).toMatchObject({ disposition: "unscored", reason: "provider unavailable" });
    expect(result.candidates.at(-1)?.crash.id).toBe("c16");
    expect(result.usage).toEqual({ inputTokens: 10 * successes, outputTokens: 4 * successes, estimatedCostUsd: 0.001 * successes });
  });

  it("score ordering reflects priority/exploitable/knownPattern weights", async () => {
    // Differentiate within a single batch: c0 gets high signals, c1 gets defer signals
    const evaluator: JevEvaluator = {
      async evaluate(request) {
        const answers = Object.fromEntries(Object.keys(request.questions).map((id) => {
          const high = id.startsWith("c0_");
          if (id.endsWith("_exploitable")) return [id, { type: "boolean", probability: high ? 0.9 : 0.15 }];
          if (id.endsWith("_knownPattern")) return [id, { type: "boolean", probability: high ? 0.1 : 0.85 }];
          return [id, {
            type: "choice",
            choice: high ? "high" : "defer",
            probabilities: high
              ? { high: 0.95, medium: 0.05, low: 0, defer: 0 }
              : { high: 0, medium: 0, low: 0.1, defer: 0.9 },
          }];
        }));
        return {
          model: "jev-test",
          answers,
          usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.001 },
          durationMs: 1,
        };
      },
    };

    const highCrash = crash("high-one");
    const deferCrash = crash("defer-one");
    const result = await rankCrashesWithJev([highCrash, deferCrash], evaluator);

    expect(result.candidates).toHaveLength(2);
    // High-priority exploitable crash should rank higher
    expect(result.candidates[0]?.crash.id).toBe("high-one");
    expect(result.candidates[0]?.score).toBeGreaterThan(result.candidates[1]?.score);
    expect(result.candidates[0]?.route).toBe("prove");
    expect(result.candidates[1]?.route).toBe("shadow");
    expect(result.candidates[0]?.signals?.priority).toBe("high");
    expect(result.candidates[1]?.signals?.priority).toBe("defer");
  });

  it("handles oversized backtraces gracefully", async () => {
    const oversized = crash("giant", {
      backtrace: "A".repeat(10_000),
    });
    const result = await rankCrashesWithJev([oversized], PROVE_EVALUATOR);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.disposition).toBe("ranked");
    expect(result.candidates[0]?.score).toBeGreaterThan(0);
  });
});

describe("crashSummaryFromTriage", () => {
  it("produces parseable markdown with all candidate ids", async () => {
    const crashes = [crash("alpha"), crash("beta")];
    const result = await rankCrashesWithJev(crashes, PROVE_EVALUATOR);
    const summary = crashSummaryFromTriage(result);

    // Every candidate id must appear
    expect(summary).toContain("alpha");
    expect(summary).toContain("beta");
    // Each line starts with a rank number
    const lines = summary.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^\d+\.\s/);
      // Route label is present
      expect(line).toMatch(/PROVE|DEEPEN|SHADOW/);
      // Key signals present
      expect(line).toMatch(/expl=\d+%/);
      expect(line).toMatch(/known=\d+%/);
      expect(line).toMatch(/prio=/);
    }
  });

  it("handles empty result", () => {
    const result = {
      candidates: [],
      evaluated: 0,
      unscored: 0,
      model: undefined,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      durationMs: 0,
    };
    const summary = crashSummaryFromTriage(result);
    expect(summary).toBe("\n");
  });

  it("includes unscored candidates with appropriate label", async () => {
    // no per-call counter: failure is keyed on batch content, not call order
    const failingEvaluator: JevEvaluator = {
      async evaluate(request) {
        // Fail only the batch containing crash "bad".
        const state = request.state as Array<{ id?: string }>;
        if (state.some((entry) => entry.id === "bad")) throw new Error("provider unavailable");
        const answers = Object.fromEntries(Object.keys(request.questions).map((id) => {
          if (id.endsWith("_exploitable")) return [id, { type: "boolean", probability: 0.7 }];
          if (id.endsWith("_knownPattern")) return [id, { type: "boolean", probability: 0.2 }];
          return [id, { type: "choice", choice: "high", probabilities: { high: 0.8, medium: 0.15, low: 0.05, defer: 0 } }];
        }));
        return {
          model: "jev-test",
          answers,
          usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.001 },
          durationMs: 1,
        };
      },
    };

    // 17 crashes; only the batch holding "bad" fails -> 1 unscored.
    const result = await rankCrashesWithJev(
      Array.from({ length: 17 }, (_, i) => crash(i < 16 ? `good-${i}` : "bad")),
      failingEvaluator,
    );
    const summary = crashSummaryFromTriage(result);
    expect(summary).toContain("good");
    expect(summary).toContain("bad");
    const lines = summary.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain("bad");
    expect(lastLine).toContain("unscored");
  });
});