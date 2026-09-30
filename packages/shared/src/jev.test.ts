import { describe, expect, it, vi } from "vitest";
import { createJevEvaluator, jevConfigFromEnvironment } from "./jev.js";
import type { JevEvaluationRequest } from "./jev.js";

const request: JevEvaluationRequest = {
  state: { observation: "Untrusted target content" },
  questions: { next: { type: "choice", instructions: "Select a supplied action or handoff.",
    criteria: { inspect: "Inspect the supplied item", handoff: "Uncertain or unsupported" } } },
};
const responseBody = (answers: unknown, usage: unknown = { inputTokens: 100, outputTokens: 10 }) => ({
  model: "jev-1.13.0", answers, usage,
});
const validAnswer = { next: { type: "choice", choice: "handoff", probabilities: { inspect: 0.1, handoff: 0.9 } } };

// The cloud provider is the org-billed path (orchestrator -> AI gateway ->
// typesafe-ai/jev), and it speaks plain HTTP, so it is what these boundary
// tests drive. `vercel` reaches the same upstream model through the AI SDK.
function client(fetchImpl: typeof fetch, maxCostUsd = 0.10) {
  return createJevEvaluator({
    provider: "cloud", apiKey: "test-only-key", cloudUrl: "https://cloud.0.security/api/evaluations",
    feature: "memory", fetch: fetchImpl, maxCostUsd,
  });
}

describe("Jev evaluation trust boundaries", () => {
  it("requires explicit data-egress opt-in even when provider credentials exist", () => {
    expect(jevConfigFromEnvironment("memory", { AI_GATEWAY_API_KEY: "test-only-key" })).toBeUndefined();
    expect(() => jevConfigFromEnvironment("memory", { "ZERO_JEV_FEATURES": "memory" }))
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

  it("accepts only vercel and cloud providers", () => {
    expect(jevConfigFromEnvironment("memory", {
      "ZERO_JEV_FEATURES": "memory", AI_GATEWAY_API_KEY: "test-only-key",
    })).toMatchObject({ provider: "vercel" });
    expect(jevConfigFromEnvironment("memory", {
      "ZERO_JEV_FEATURES": "memory", "ZERO_JEV_PROVIDER": "cloud",
      "ZERO_JEV_CLOUD_TOKEN": "test-only-key", "ZERO_JEV_CLOUD_URL": "https://cloud.0.security/api/evaluations",
    })).toMatchObject({ provider: "cloud", feature: "memory" });
    for (const provider of ["typesafe", "classifier"]) {
      expect(() => jevConfigFromEnvironment("memory", {
        "ZERO_JEV_FEATURES": "memory", "ZERO_JEV_PROVIDER": provider, AI_GATEWAY_API_KEY: "k",
      })).toThrow("ZERO_JEV_PROVIDER must be vercel or cloud");
    }
  });

  it("reports usage so the org-billed path can charge the request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(responseBody(validAnswer)));
    const seen: { inputTokens: number; estimatedCostUsd: number }[] = [];
    const evaluator = createJevEvaluator({
      provider: "cloud", apiKey: "test-only-key", cloudUrl: "https://cloud.0.security/api/evaluations",
      feature: "memory", fetch: fetchImpl, onUsage: (usage) => seen.push(usage),
    });

    const evaluation = await evaluator.evaluate(request);

    expect(evaluation.usage.inputTokens).toBe(100);
    expect(evaluation.usage.estimatedCostUsd).toBeCloseTo(100 * (0.042 / 1_000_000), 12);
    expect(seen).toHaveLength(1);
  });
});
