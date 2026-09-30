import { describe, expect, it } from "vitest";
import {
  reduceWorkerTelemetry,
  resolveContextLimit,
  selectConversationContext,
  type WorkerTelemetry,
} from "./context-window.js";
import { buildStatusSegments } from "./status-bar.js";
import type { SubagentMessagePayload } from "@0/core";

describe("resolveContextLimit — connected providers", () => {
  const loadModels = () => ({
    source: "synced",
    models: [
      { id: "gpt-5.5", provider: "openai", contextTokens: 200_000 },
      { id: "gpt-5.5", provider: "azure", contextTokens: 300_000 },
    ],
  });

  it("uses the active provider's exact catalog window when model IDs overlap", () => {
    expect(resolveContextLimit({ modelId: "gpt-5.5", providerId: "azure" }, { loadModels }))
      .toEqual({ tokens: 300_000, source: "synced-catalog" });
    expect(resolveContextLimit({ modelId: "gpt-5.5", providerId: "openai" }, { loadModels }))
      .toEqual({ tokens: 200_000, source: "synced-catalog" });
  });

  it("never guesses a window without a running provider", () => {
    expect(resolveContextLimit({ modelId: "gpt-5.5", providerId: undefined }, { loadModels })).toBeNull();
  });

  it("keeps a fractional context limit unknown instead of reporting a zero-token window", () => {
    expect(resolveContextLimit(
      { modelId: "future-model", providerId: "openai" },
      { loadModels: () => ({ source: "synced", models: [{ id: "future-model", provider: "openai", contextTokens: 0.5 }] }) },
    )).toBeNull();
  });
});

const messageBase = {
  agent_id: "worker-a",
  parent_scan_id: "parent",
  turn: 1,
  ts: 1,
} satisfies SubagentMessagePayload;

describe("worker conversation context", () => {
  it("retains the latest measured request across partial and terminal updates without accumulating billing usage", () => {
    const measured = reduceWorkerTelemetry({}, {
      ...messageBase,
      model: "shared-model",
      provider: "azure",
      contextTokens: 7000,
      usage: { inputTokens: 100_000, outputTokens: 20_000, cachedInputTokens: 40_000 },
      assistant: "Reviewed the parser.",
    });
    const partial = reduceWorkerTelemetry(measured, {
      ...messageBase,
      turn: 2,
      partial: true,
      model: "shared-model",
      provider: "azure",
      contextTokens: undefined,
      usage: { inputTokens: 130_000, outputTokens: 25_000, cachedInputTokens: 50_000 },
    });
    const settled = reduceWorkerTelemetry(partial, {
      agent_id: "worker-a", parent_scan_id: "parent", status: "completed",
      task: "review", max_turns: 25,
      usage: { inputTokens: 140_000, outputTokens: 28_000, cachedInputTokens: 50_000 },
      durationMs: 5000,
    });
    expect(settled["worker-a"]?.contextTokens).toBe(7000);
    expect(settled["worker-a"]?.usage).toEqual({ inputTokens: 140_000, outputTokens: 28_000, cachedInputTokens: 50_000 });
    expect(settled["worker-a"]?.assistant).toBe("Reviewed the parser.");
    const latest = reduceWorkerTelemetry(settled, { ...messageBase, turn: 3, contextTokens: 3200 });
    expect(latest["worker-a"]?.contextTokens).toBe(3200);
  });

  it("uses the selected worker's exact model/provider capacity and never borrows Main or another worker's occupancy", () => {
    const main = { modelId: "shared-model", providerId: "openai", contextUsed: 60_000 };
    let workers: Record<string, WorkerTelemetry> = reduceWorkerTelemetry({}, {
      ...messageBase, model: "shared-model", provider: "azure", contextTokens: 10_000,
      usage: { inputTokens: 200_000, outputTokens: 5000, cachedInputTokens: 20_000 },
    });
    workers = reduceWorkerTelemetry(workers, {
      ...messageBase, agent_id: "worker-b", model: "shared-model", provider: "deepseek", contextTokens: 20_000,
    });
    workers = reduceWorkerTelemetry(workers, {
      ...messageBase, agent_id: "worker-new", model: "shared-model", provider: "azure",
    });
    const catalogs = {
      loadModels: () => ({
        source: "synced",
        models: [
          { id: "shared-model", provider: "openai", contextTokens: 80_000 },
          { id: "shared-model", provider: "azure", contextTokens: 40_000 },
          { id: "shared-model", provider: "deepseek", contextTokens: 100_000 },
        ],
      }),
    };
    for (const [focus, used, window, percent] of [
      ["worker-a", 10_000, 40_000, "25%"],
      ["worker-b", 20_000, 100_000, "20%"],
      [null, 60_000, 80_000, "75%"],
      ["worker-a", 10_000, 40_000, "25%"],
    ] as const) {
      const context = selectConversationContext(main, focus, workers);
      const limit = resolveContextLimit(context, catalogs);
      expect(context.contextUsed).toBe(used);
      expect(limit?.tokens).toBe(window);
      const meter = buildStatusSegments({ contextUsed: context.contextUsed, contextWindow: limit?.tokens, showContextMeter: true })
        .find((segment) => segment.kind === "meter")?.text;
      expect(meter).toContain(percent);
    }
    const fresh = selectConversationContext(main, "worker-new", workers);
    expect(fresh.contextUsed).toBeUndefined();
    const unknown = buildStatusSegments({
      contextUsed: fresh.contextUsed, contextWindow: resolveContextLimit(fresh, catalogs)?.tokens, showContextMeter: true,
    }).find((segment) => segment.kind === "meter")?.text;
    expect(unknown).toContain("40k");
    expect(unknown).not.toMatch(/[%▱▰]/u);
    const missing = selectConversationContext(main, "unreported-worker", workers);
    expect(missing.contextUsed).toBeUndefined();
    expect(resolveContextLimit(missing, catalogs)).toBeNull();
  });

  it("invalidates occupancy on model or provider changes until that route reports a new request", () => {
    const measured = reduceWorkerTelemetry({}, {
      ...messageBase, model: "claude-sonnet-4-6", provider: "anthropic", contextTokens: 9000,
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 },
    });
    const changedModel = reduceWorkerTelemetry(measured, { ...messageBase, model: "second-model", provider: "anthropic" });
    expect(changedModel["worker-a"]?.contextTokens).toBeUndefined();
    const billing = changedModel["worker-a"]!;
    const cost = buildStatusSegments({
      model: billing.model, showCost: true,
      inputTokens: billing.usage?.inputTokens, outputTokens: billing.usage?.outputTokens,
      usageByModel: [{ model: billing.usageModel, ...billing.usage! }],
    }).find((segment) => segment.kind === "cost")?.text;
    expect(cost).toBe("$18.00");
    const changedProvider = reduceWorkerTelemetry(measured, { ...messageBase, model: "claude-sonnet-4-6", provider: "deepseek" });
    expect(changedProvider["worker-a"]?.contextTokens).toBeUndefined();
    const incompleteRoute = reduceWorkerTelemetry(measured, { ...messageBase, model: "second-model" });
    expect(incompleteRoute["worker-a"]?.provider).toBeUndefined();
    expect(incompleteRoute["worker-a"]?.contextTokens).toBeUndefined();
    const remeasured = reduceWorkerTelemetry(changedModel, {
      ...messageBase, model: "second-model", provider: "openai", contextTokens: 1500,
    });
    expect(remeasured["worker-a"]?.contextTokens).toBe(1500);
  });
});
