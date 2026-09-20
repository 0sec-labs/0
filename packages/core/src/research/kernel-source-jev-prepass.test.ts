import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJevEvaluator } from "@0sec/shared";
import type { JevEvaluator } from "@0sec/shared";
import { extractKernelFunctions, KERNEL_FUNCTION_BATCH_SIZE, runKernelSourceJevPrepass } from "./kernel-source-jev-prepass.js";

describe("direct kernel function prepass", () => {
  it("keeps the reference 786-function sweep within the default 100-request budget", () => {
    expect(Math.ceil(786 / KERNEL_FUNCTION_BATCH_SIZE)).toBeLessThanOrEqual(100);
    expect(786).toBeLessThanOrEqual(1_000);
  });
  it("extracts top-level functions without mistaking braces in comments and strings", () => {
    const tree = mkdtempSync(join(tmpdir(), "kernel-functions-"));
    mkdirSync(join(tree, "net"));
    writeFileSync(join(tree, "net", "x.c"), `/* { } */\nstatic int first(int x) { const char *s = "}"; return x; }\nint second(void)\n{ if (1) { return 2; } return 0; }\n`);
    expect(extractKernelFunctions(tree, "net").functions.map((f) => f.function)).toEqual(["first", "second"]);
  });

  it("directly scores every function and preserves a failed batch as unscored", async () => {
    const tree = mkdtempSync(join(tmpdir(), "kernel-direct-"));
    mkdirSync(join(tree, "fs"));
    writeFileSync(join(tree, "fs", "x.c"), Array.from({ length: 9 }, (_, i) => `int fn${i}(void) { return ${i}; }`).join("\n"));
    let calls = 0;
    const evaluator: JevEvaluator = { async evaluate(request) {
      calls++;
      if (calls === 2) throw new Error("provider unavailable");
      return { model: "jev-test", answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "choice", choice: "suspicious-bounds-size", probabilities: { "concrete-memory-safety-defect": .1, "suspicious-lifetime-teardown": .1, "suspicious-bounds-size": .5, "unprivileged-complex-no-defect": .1, "no-concrete-defect": .1, "unavailable-or-privileged": .1 } }])), usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }, durationMs: 1 };
    } };
    const result = await runKernelSourceJevPrepass({ tree, subtree: "fs", evaluator });
    expect(calls).toBe(2);
    expect(result.functionsEnumerated).toBe(9);
    expect(result.candidates).toHaveLength(9);
    expect(result.evaluated).toBe(8);
    expect(result.unscored).toBe(1);
    expect(result.classifications).toBe(8);
    expect(result.candidates.at(-1)).toMatchObject({ function: "fn8", disposition: "unscored", reason: "provider unavailable" });
  });

  it("uses candidate IDs accepted by the classifier.dev adapter", async () => {
    const tree = mkdtempSync(join(tmpdir(), "kernel-classifier-"));
    writeFileSync(join(tree, "x.c"), "int exposed(unsigned int n) { return n + 1; }\n");
    const evaluator = createJevEvaluator({
      provider: "classifier",
      feature: "kernel",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { inputs: string[]; labels: string[] };
        expect(request.inputs).toHaveLength(1);
        expect(JSON.parse(request.inputs[0]!)).toMatchObject({ candidate: { id: "c0", function: "exposed" } });
        const scores = Object.fromEntries(request.labels.map((label) => [label, label === "no-concrete-defect" ? 1 : 0]));
        return new Response(JSON.stringify({ model: "classifier-test", results: [{ label: "no-concrete-defect", confidence: 1, scores }] }), { status: 200 });
      },
    });
    const result = await runKernelSourceJevPrepass({ tree, subtree: "x.c", evaluator });
    expect(result).toMatchObject({ functionsEnumerated: 1, evaluated: 1, unscored: 0 });
    expect(result.candidates[0]).toMatchObject({ function: "exposed", selectedLabels: ["no-concrete-defect"] });
  });
});
