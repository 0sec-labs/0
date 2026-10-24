import { describe, expect, it, vi } from "vitest";
import { preflightTaskRouting, qualifyTaskRouting, recommendQualifiedRouting, taskRoutingFixtureRuntime, type RoutingQualificationPlan } from "./task-routing.js";
import type { NativeRuntime } from "../runtime/types.js";
const plan: RoutingQualificationPlan = { mode: "fixture", models: ["gpt-4o-mini", "gpt-4o"], repeats: 2, maxCalls: 64, costCapUsd: 1, timeCapMs: 10_000, authorizationRef: "public synthetic fixture only", workflow: { targetKind: "web", goal: "unknown-vulnerabilities", depth: "quick" } };
const run = (overrides: Partial<RoutingQualificationPlan> = {}, runtime?: NativeRuntime) => qualifyTaskRouting({ plan: { ...plan, ...overrides }, runtime: runtime ?? taskRoutingFixtureRuntime(plan.models) });
const reviewed = async () => { const report = await run(); return { ...report, mode: "model-api" as const, plan: { ...report.plan, mode: "model-api" as const }, trials: report.trials.map(t => ({ ...t, provider: "openai" })) }; };
const selection = { approvedModels: plan.models, provider: "openai", reviewRef: "reviewed synthetic workflow provider authorization", workflow: plan.workflow, minimumRepeats: 2 };

describe("finite offline task routing qualification", () => {
  it("reserves complete paired positive/negative panel before any request", async () => {
    expect(preflightTaskRouting(plan)).toBe(64);
    const runtime = taskRoutingFixtureRuntime(plan.models);
    const fork = vi.spyOn(runtime, "forkForSubagent");
    await expect(run({ maxCalls: 63 }, runtime)).rejects.toThrow(/64 reserved calls/);
    expect(fork).not.toHaveBeenCalled();
  });
  it("records every task, curated tool roundtrip, evidence state, usage and total mixed-model spend", async () => {
    const report = await run();
    expect(report.status).toBe("completed-for-review");
    expect(report.trials).toHaveLength(32);
    expect(report.totalCalls).toBe(64);
    expect(report.trials.every(t => t.status === "passed" && t.toolRoundTrip && t.authorityPreserved && t.evidencePreserved && t.validationPreserved)).toBe(true);
    expect(new Set(report.trials.map(t => t.role))).toEqual(new Set(["discovery", "attack", "verify", "report"]));
    expect(report.trials.reduce((n,t) => n + t.inputTokens, 0)).toBe(6400);
    expect(report.trials.reduce((n,t) => n + t.outputTokens, 0)).toBe(640);
    expect(report.estimatedUsd).toBeCloseTo(report.trials.reduce((n,t) => n + t.estimatedUsd!, 0));
    expect(report.actualProviderChargeUsd).toBeNull();
    expect(report.automaticEnablement).toBe(false);
  });
  it("detects deliberately upgraded unverified findings rather than rewarding refusal reduction", async () => {
    const report = await run({}, taskRoutingFixtureRuntime(plan.models, "gpt-4o"));
    expect(report.trials.filter(t => t.model === "gpt-4o").every(t => t.status === "failed" && !t.validationPreserved)).toBe(true);
    expect(report.trials.filter(t => t.model !== "gpt-4o").every(t => t.status === "passed")).toBe(true);
  });
  it("stops all models at one shared estimated spend threshold", async () => {
    const report = await run({ costCapUsd: 0.000001 });
    expect(report.totalCalls).toBe(1);
    expect(report.status).toBe("inconclusive");
    expect(report.stopReason).toMatch(/shared estimated cost cap/);
    expect(report.estimatedUsd).toBeGreaterThan(plan.costCapUsd / 1_000_000);
  });
  it("does not treat missing provider usage as zero or dispatch another candidate", async () => {
    const root = taskRoutingFixtureRuntime(plan.models);
    const fork = root.forkForSubagent!.bind(root);
    root.forkForSubagent = async (...args) => { const child = await fork(...args); const execute = child.executeNative.bind(child); child.executeNative = async (...params) => { const result = await execute(...params); delete result.usage; return result; }; return child; };
    const report = await run({}, root);
    expect(report.totalCalls).toBe(1);
    expect(report.estimatedUsd).toBeNull();
    expect(report.unknownUsage).toBe(true);
    expect(report.stopReason).toMatch(/unknown usage/);
  });
  it("refuses a silently substituted model before its first request", async () => {
    const root = taskRoutingFixtureRuntime(plan.models);
    root.forkForSubagent = async () => ({ ...root, resolvedModel: () => "unapproved" });
    const report = await run({}, root);
    expect(report.totalCalls).toBe(0);
    expect(report.stopReason).toMatch(/no substitution/);
  });
  it("rejects malformed tool dispatch without executing arbitrary tools", async () => {
    const root = taskRoutingFixtureRuntime(plan.models);
    const fork = root.forkForSubagent!.bind(root);
    root.forkForSubagent = async (...args) => ({ ...await fork(...args), executeNative: async () => ({ content: [{ type: "tool_use", id: "bad", name: "shell", input: { command: "no execution" } }], stopReason: "tool_use", durationMs: 1, usage: { inputTokens: 10, outputTokens: 10 } }) });
    const report = await run({}, root);
    expect(report.trials.every(t => t.status === "inconclusive" && !t.toolRoundTrip)).toBe(true);
    expect(report.totalCalls).toBe(32);
  });
  it("honors a shared deadline during an in-flight task", async () => {
    vi.useFakeTimers();
    try {
      const root = taskRoutingFixtureRuntime(plan.models);
      root.forkForSubagent = async () => ({ ...root, executeNative: async (_s,_m,_t,_c,signal) => new Promise((_resolve,reject) => { signal?.addEventListener("abort", () => reject(signal.reason), { once: true }); }) });
      const pending = run({ timeCapMs: 10 }, root);
      await vi.advanceTimersByTimeAsync(11);
      const report = await pending;
      expect(report.status).toBe("inconclusive");
      expect(report.totalCalls).toBe(1);
      expect(report.stopReason).toMatch(/wall-clock/);
    } finally { vi.useRealTimers(); }
  });
});

describe("reviewed explicit routing recommendations", () => {
  it("chooses lowest measured estimated-cost passing model for each role and supplies bounded reasons", async () => {
    const report = await reviewed();
    const result = recommendQualifiedRouting(report, selection);
    expect(Object.values(result.assignments)).toEqual(Array(4).fill("gpt-4o-mini"));
    expect(result.reasons.verify).toContain("2 repeats of one positive and one negative task control");
    expect(result.reasons.verify).toContain("does not establish general security superiority");
  });
  it("never uses fixture data as production quality evidence", async () => {
    const report = await run();
    expect(() => recommendQualifiedRouting(report, selection)).toThrow(/fixture/);
  });
  it("rejects other workflows, providers, unapproved models and insufficient repeats", async () => {
    const report = await reviewed();
    expect(() => recommendQualifiedRouting(report, { ...selection, workflow: { ...selection.workflow, depth: "deep" } })).toThrow(/outside this workflow/);
    expect(() => recommendQualifiedRouting(report, { ...selection, provider: "anthropic" })).toThrow(/no approved/);
    expect(() => recommendQualifiedRouting(report, { ...selection, approvedModels: [] })).toThrow(/no approved/);
    expect(() => recommendQualifiedRouting(report, { ...selection, minimumRepeats: 3 })).toThrow(/incomplete/);
  });
  it("rejects duplicated positives masquerading as complete negative-control coverage", async () => {
    const report = await reviewed();
    report.trials = report.trials.map(t => t.role === "verify" ? { ...t, caseId: "v-01", control: "positive" as const } : t);
    expect(() => recommendQualifiedRouting(report, selection)).toThrow(/no approved qualified model for verify/);
  });
});

it("refuses unknown tariffs before dispatch rather than ranking a fallback estimate as measured cost", async () => {
  const runtime = taskRoutingFixtureRuntime(["unpriced-fixture-model"]);
  const report = await qualifyTaskRouting({ plan: { ...plan, models: ["unpriced-fixture-model"], maxCalls: 32 }, runtime });
  expect(report.totalCalls).toBe(0);
  expect(report.stopReason).toMatch(/tariff unavailable/);
  expect(report.status).toBe("inconclusive");
});

it("preserves opaque provider reasoning for the same-model tool roundtrip without copying it to receipts", async () => {
  const root = taskRoutingFixtureRuntime(plan.models);
  const fork = root.forkForSubagent!.bind(root);
  let echoes = 0;
  root.forkForSubagent = async (...args) => {
    const child = await fork(...args);
    const execute = child.executeNative.bind(child);
    const providerRaw = { provider: "fixture", model: child.resolvedModel!(), wireApi: "responses", output: [{ type: "reasoning", encrypted_content: "OPAQUE_FIXTURE_PAYLOAD" }] };
    child.executeNative = async (...params) => {
      if (params[1].length > 1) {
        expect(params[1][1]!.providerRaw).toBe(providerRaw);
        echoes++;
      }
      const result = await execute(...params);
      return result.stopReason === "tool_use" ? { ...result, providerRaw } : result;
    };
    return child;
  };
  const report = await run({}, root);
  expect(report.status).toBe("completed-for-review");
  expect(echoes).toBe(32);
  expect(JSON.stringify(report)).not.toContain("OPAQUE_FIXTURE_PAYLOAD");
});

it("rejects a changed evaluator or pricing snapshot instead of comparing incompatible receipts", async () => {
  const report = await reviewed();
  expect(() => recommendQualifiedRouting({ ...report, evaluatorDigest: "sha256:other-evaluator" }, selection)).toThrow(/stale/);
  expect(() => recommendQualifiedRouting({ ...report, pricingSnapshotDate: "old" }, selection)).toThrow(/stale/);
});

it("stops after a runtime exception with unknown usage rather than letting another model spend", async () => {
  const root = taskRoutingFixtureRuntime(plan.models);
  root.forkForSubagent = async (_timeout, selection) => ({ ...root, resolvedModel: () => selection!.model!, executeNative: async () => { throw new Error("transport interrupted after dispatch"); } });
  const report = await run({}, root);
  expect(report.totalCalls).toBe(1);
  expect(report.unknownUsage).toBe(true);
  expect(report.estimatedUsd).toBeNull();
  expect(report.stopReason).toContain("unknown usage");
});
