import { describe, expect, it, vi } from "vitest";
import { createJevEvaluator, jevConfigFromEnvironment } from "./jev.js";
import type { JevEvaluationRequest } from "./jev.js";

const request: JevEvaluationRequest = {
  state: { observation: "Untrusted target content" },
  questions: { next: { type: "choice", instructions: "Select a supplied action or handoff.",
    criteria: { inspect: "Inspect the supplied item", handoff: "Uncertain or unsupported" } } },
};
const responseBody = (answers: unknown, usage: unknown = { input_tokens: 100, output_tokens: 10 }) => ({
  model: "jev-1.13.0", answers, usage,
});
const validAnswer = { next: { type: "choice", choice: "handoff", probabilities: { inspect: 0.1, handoff: 0.9 } } };

function client(fetchImpl: typeof fetch, maxCostUsd = 0.10) {
  return createJevEvaluator({ provider: "typesafe", apiKey: "test-only-key", fetch: fetchImpl, maxCostUsd });
}

describe("Jev evaluation trust boundaries", () => {
  it("requires explicit data-egress opt-in even when provider credentials exist", () => {
    expect(jevConfigFromEnvironment("memory", { AI_GATEWAY_API_KEY: "test-only-key" })).toBeUndefined();
    expect(() => jevConfigFromEnvironment("memory", { "0SEC_JEV_FEATURES": "memory" }))
      .toThrow("AI_GATEWAY_API_KEY is required");
  });

  it("rejects invented options rather than executing a provider-supplied action", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(responseBody({
      next: { type: "choice", choice: "delete_everything", probabilities: { delete_everything: 1 } },
    })));
    await expect(client(fetchImpl).evaluate(request)).rejects.toThrow("invalid choice distribution");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses partial answers and missing usage instead of inventing confidence or free inference", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(responseBody({})))
      .mockResolvedValueOnce(Response.json({ model: "jev-1.13.0", answers: validAnswer }));
    const evaluator = client(fetchImpl);
    await expect(evaluator.evaluate(request)).rejects.toThrow("unexpected answer IDs");
    await expect(evaluator.evaluate(request)).rejects.toThrow("malformed evaluation data");
  });

  it("reserves budget before concurrent dispatch and retains it on unknown provider usage", async () => {
    let failRequest!: (error: Error) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((_resolve, reject) => {
      failRequest = reject;
    }));
    const evaluator = client(fetchImpl, 0.003);
    const pending = evaluator.evaluate(request);
    await expect(evaluator.evaluate(request)).rejects.toThrow("budget exhausted");
    failRequest(new Error("provider body contains a secret"));
    await expect(pending).rejects.toThrow("evaluation unavailable");
    await expect(evaluator.evaluate(request)).rejects.toThrow("budget exhausted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not leak provider error bodies or retry failed requests", async () => {
    const providerErrorBody = "sensitive-customer-payload";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(providerErrorBody, { status: 429 }));
    await expect(client(fetchImpl).evaluate(request)).rejects.toThrow(/^Jev provider returned HTTP 429$/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch requests that have already been cancelled", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(client(fetchImpl).evaluate({ ...request, signal: controller.signal })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows the keyless classifier only for an explicitly enabled kernel prepass", () => {
    expect(jevConfigFromEnvironment("kernel", {
      "0SEC_JEV_FEATURES": "kernel", "0SEC_JEV_PROVIDER": "classifier",
    })).toMatchObject({ provider: "classifier", feature: "kernel", maxClassifications: 1_000 });
    expect(() => jevConfigFromEnvironment("memory", {
      "0SEC_JEV_FEATURES": "memory", "0SEC_JEV_PROVIDER": "classifier",
    })).toThrow("restricted to the kernel prepass");
  });

  it("maps classifier groups back to typed kernel answers without treating false confidence as true", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { labels: string[]; inputs: string[] };
      expect(init?.headers).toMatchObject({ "User-Agent": "0sec-kernel-prepass/1.0" });
      if (body.labels[0] === "true") {
        return Response.json({ model: "jev-1.13.0", results: body.inputs.map(() => ({
          label: "false", confidence: 0.88, scores: { true: 0.12, false: 0.88 }, model: "jev-1.13.0",
        })) });
      }
      return Response.json({ model: "jev-1.13.0", results: body.inputs.map(() => ({
        label: "defer", confidence: 0.7, scores: { high: 0.1, low: 0.2, defer: 0.7 }, model: "jev-1.13.0",
      })) });
    });
    const evaluator = createJevEvaluator({ provider: "classifier", feature: "kernel", fetch: fetchImpl });
    const result = await evaluator.evaluate({
      state: [{ candidate: "c0", title: "candidate" }],
      questions: {
        c0_reachable: { type: "boolean", instructions: "Is this reachable?" },
        c0_priority: { type: "choice", instructions: "Select priority.", criteria: {
          high: "Strong evidence", low: "Weak evidence", defer: "Insufficient context",
        } },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("classifier.dev:jev-1.13.0");
    expect(result.answers).toEqual({
      c0_reachable: { type: "boolean", probability: 0.12 },
      c0_priority: { type: "choice", choice: "defer", probabilities: { high: 0.1, low: 0.2, defer: 0.7 } },
    });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
  });

  it("retains classifier failures and unscored inputs as sanitized evaluation failures", async () => {
    const kernelRequest: JevEvaluationRequest = {
      state: [{ id: "c0", diff: "04020000" }],
      questions: { c0_risk: { type: "boolean", instructions: "Is risk evidenced?" } },
    };
    const unscored = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: "jev-1.13.0", results: [{
      label: "false", confidence: null, scores: null, unscored: "not natural language",
    }] }));
    await expect(createJevEvaluator({ provider: "classifier", feature: "kernel", fetch: unscored })
      .evaluate(kernelRequest)).rejects.toThrow("Classifier evaluation unavailable");

    const providerErrorBody = "provider-secret-body";
    const failed = vi.fn<typeof fetch>().mockResolvedValue(new Response(providerErrorBody, { status: 429 }));
    await expect(createJevEvaluator({ provider: "classifier", feature: "kernel", fetch: failed })
      .evaluate(kernelRequest)).rejects.toThrow(/^Classifier provider returned HTTP 429$/);
  });

  it("reserves classifier classification budget before dispatch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const evaluator = createJevEvaluator({
      provider: "classifier", feature: "kernel", fetch: fetchImpl, maxClassifications: 1,
    });
    await expect(evaluator.evaluate({
      state: [{ id: "c0" }],
      questions: {
        c0_one: { type: "boolean", instructions: "One?" },
        c0_two: { type: "boolean", instructions: "Two?" },
      },
    })).rejects.toThrow("budget exhausted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
