import { describe, expect, it, vi } from "vitest";
import { createLocalOllamaRoutingRuntime } from "./local-ollama-routing.js";
import { qualifyTaskRouting, taskRoutingFixtureRuntime, type RoutingQualificationPlan } from "./task-routing.js";
const model = "local-existing-model:latest";
const digest = "a".repeat(64);
const plan: RoutingQualificationPlan = { mode: "local-model", models: [model], repeats: 1, maxCalls: 16, costCapUsd: 0, timeCapMs: 10000, authorizationRef: "benign local protocol controls only", workflow: { targetKind: "web", goal: "unknown-vulnerabilities", depth: "quick" }, local: { manifestDigest: `sha256:${digest}`, sourcePin: "existing-model@revision", weightsDigest: `sha256:${digest}`, maxInputTokens: 4096, maxOutputTokens: 256, totalTokenCap: 70000 } };

it("uses only loopback, verifies the manifest around inference and bounds actual token generation", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:11434\/api\//);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (String(url).endsWith("/tags")) return Response.json({ models: [{ name: model, digest }] });
    if (String(url).endsWith("/version")) return Response.json({ version: "test-local-runtime" });
    if (String(url).endsWith("/ps")) return Response.json({ models: [{ name: model, size: 1234, size_vram: 1000 }] });
    const body = JSON.parse(String(init?.body));
    expect(body.options).toEqual({ temperature: 0, seed: 0, num_ctx: 4096, num_predict: 256 });
    expect(body.think).toBe(false);
    return Response.json({ model, message: { content: "OK" }, done: true, prompt_eval_count: 20, eval_count: 2, total_duration: 1000000 });
  });
  const runtime = createLocalOllamaRoutingRuntime(plan, fetchImpl as typeof fetch);
  expect(await runtime.executeNative("local-only", [{ role: "user", content: [{ type: "text", text: "Reply OK." }] }], [])).toMatchObject({ usage: { inputTokens: 20, outputTokens: 2 }, content: [{ type: "text", text: "OK" }] });
  const measured = await runtime.observation();
  expect(measured).toMatchObject({ inferenceRequests: 1, metadataRequests: 4, externalApiFeeUsd: 0, computeCostUsd: null, runtimeReportedResidentModelBytes: 1234, runtimeReportedVramBytes: 1000 });
  expect(measured.measurements[0]).toMatchObject({ inputTokens: 20, outputTokens: 2, serverTotalNs: 1000000 });
  expect(requests.filter(request => request.url.endsWith("/chat"))).toHaveLength(1);
});

it("stops a missing or changed local manifest without pulling weights or invoking inference", async () => {
  const fetchImpl = vi.fn(async (url: string | URL | Request) => { expect(String(url)).toContain("/api/tags"); return Response.json({ models: [{ name: model, digest: "b".repeat(64) }] }); });
  const runtime = createLocalOllamaRoutingRuntime(plan, fetchImpl as typeof fetch);
  await expect(runtime.executeNative("local-only", [], [])).rejects.toThrow(/no pull or fallback/);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("accounts local panel tokens without manufacturing a dollar compute price", async () => {
  const fixture = taskRoutingFixtureRuntime([model]);
  const fork = fixture.forkForSubagent!.bind(fixture);
  fixture.forkForSubagent = async (...args) => ({ ...await fork(...args), resolvedProvider: () => "ollama-local" });
  const report = await qualifyTaskRouting({ plan, runtime: fixture });
  expect(report.status).toBe("completed-for-review");
  expect(report.totalCalls).toBe(16);
  expect(report.externalApiFeeUsd).toBe(0);
  expect(report.estimatedUsd).toBeNull();
  expect(report.trials.every(trial => trial.estimatedUsd === null)).toBe(true);
  expect(report.trials.reduce((n,trial) => n + trial.inputTokens, 0)).toBe(1600);
});

it("reserves the worst-case context and output tokens before the next local call", async () => {
  const fixture = taskRoutingFixtureRuntime([model]);
  const fork = fixture.forkForSubagent!.bind(fixture);
  fixture.forkForSubagent = async (...args) => ({ ...await fork(...args), resolvedProvider: () => "ollama-local" });
  const report = await qualifyTaskRouting({ plan: { ...plan, local: { ...plan.local!, totalTokenCap: 4352 } }, runtime: fixture });
  expect(report.totalCalls).toBe(1);
  expect(report.status).toBe("inconclusive");
  expect(report.trials[0]!.reason).toMatch(/token reservation/);
});
