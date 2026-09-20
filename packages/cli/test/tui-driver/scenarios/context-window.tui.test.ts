import { afterEach, expect, test, vi } from "vitest";
import { CloudClient, type ConsoleSession, type NativeRuntime } from "@0sec/core";
import { launch, type TuiHandle } from "../index.js";
import { updateSetting } from "../../../src/tui/settings-store.js";

const captured = vi.hoisted(() => ({
  windows: [] as Array<number | null | undefined>,
  execute: undefined as NativeRuntime["executeNative"] | undefined,
  credentials: "normal" as "normal" | "missing" | "changed",
}));
vi.mock("@0sec/core", async (original) => {
  const actual = await original<typeof import("@0sec/core")>();
  return {
    ...actual,
    loadCloudCredentials: (...args: Parameters<typeof actual.loadCloudCredentials>) => {
      if (captured.credentials === "missing") throw new actual.CloudAuthMissingError("synthetic logout");
      const credentials = actual.loadCloudCredentials(...args);
      return captured.credentials === "changed" ? { ...credentials, token: "synthetic-replacement-account" } : credentials;
    },
  };
});
vi.mock("../../../src/console-session.js", async (original) => {
  const actual = await original<typeof import("../../../src/console-session.js")>();
  return {
    ...actual,
    createLocalConsoleSession: (...args: Parameters<typeof actual.createLocalConsoleSession>) => {
      if (captured.execute) args[0].runtime.executeNative = captured.execute;
      const session = actual.createLocalConsoleSession(...args);
      const reconfigure = session.reconfigureRuntime;
      session.reconfigureRuntime = (selection: Parameters<ConsoleSession["reconfigureRuntime"]>[0]) => {
        if ("contextWindowTokens" in selection) captured.windows.push(selection.contextWindowTokens);
        reconfigure(selection);
      };
      return session;
    },
  };
});

let tui: TuiHandle | undefined;
afterEach(async () => { await tui?.close(); tui = undefined; vi.restoreAllMocks(); captured.windows.length = 0; captured.execute = undefined; captured.credentials = "normal"; });

test.each([
  [true, "transport"], [false, "transport"], [false, "null"], [false, "missing"], [false, "changed"],
] as const)("hosted compaction metadata: meter=%s, refresh=%s", async (showContextMeter, failure) => {
  vi.spyOn(CloudClient.prototype, "getInferenceAccount").mockResolvedValue(null);
  const models = vi.spyOn(CloudClient.prototype, "getInferenceModels").mockResolvedValue({ object: "list", data: [{
    id: "fixture-private-model", object: "model", provider: "fixture", owned_by: "fixture", upstream_model: "fixture",
    wire_api: "chat_completions", context_length: 123_456, max_output_tokens: 8192,
    pricing: { input_per_million_usd: 1, output_per_million_usd: 1, cached_input_per_million_usd: 0 },
  }] });
  // Hold the planner and the next catalog response independently so the
  // busy-transition refresh is observable while the turn is still alive.
  const planner = Promise.withResolvers<void>();
  captured.execute = async () => {
    await planner.promise;
    return { content: [{ type: "text", text: "fixture complete" }], stopReason: "end_turn", durationMs: 0 };
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  tui = await launch({
    route: { type: "chat", options: { providerId: "hosted", model: "fixture-private-model" } },
    // Keep optional live-harness persistence outside this metadata regression.
    settings: { onboardingCompleted: true, showContextMeter, allowModelSelfExtension: false },
    env: { "0SEC_PROVIDER": "hosted", "0SEC_MODEL": "fixture-private-model", "0SEC_CLOUD_TOKEN": "synthetic-fixture-only" },
  });
  await expect.poll(async () => {
    await tui!.settle();
    return captured.windows.at(-1);
  }, { timeout: 5000 }).toBe(123_456);
  updateSetting("showContextMeter", !showContextMeter);
  await tui.settle();
  expect(captured.windows.at(-1)).toBe(123_456);
  updateSetting("showContextMeter", showContextMeter);
  await tui.settle();
  expect(captured.windows.at(-1)).toBe(123_456);
  const refresh = Promise.withResolvers<Awaited<ReturnType<CloudClient["getInferenceModels"]>>>();
  const priorRequests = models.mock.calls.length;
  models.mockReturnValue(refresh.promise);
  captured.windows.length = 0;
  if (failure === "missing" || failure === "changed") captured.credentials = failure;
  try {
    await tui.sendKeys("synthetic check");
    await tui.sendKey("return");
    if (failure === "missing" || failure === "changed") {
      await expect.poll(async () => { await tui!.settle(); return captured.windows.at(-1); }).toBeNull();
    } else {
      await expect.poll(async () => { await tui!.settle(); return models.mock.calls.length; }).toBeGreaterThan(priorRequests);
      expect(captured.windows).not.toContain(null);
      if (failure === "null") {
        refresh.resolve(null as unknown as Awaited<ReturnType<CloudClient["getInferenceModels"]>>);
        await expect.poll(async () => { await tui!.settle(); return captured.windows.at(-1); }).toBeNull();
      } else {
        // A failed refresh retains the unexpired, same-account window.
        refresh.reject(new Error("synthetic catalog outage"));
        await tui.settle();
        expect(captured.windows).not.toContain(null);
      }
    }
  } finally {
    planner.resolve();
    refresh.resolve({ object: "list", data: [] });
    await tui.settle();
  }
});
