import { afterEach, expect, test, vi } from "vitest";
import type { ConsoleSession } from "@0/core";
import { launch, type TuiHandle } from "../index.js";

const fixture = vi.hoisted(() => ({ send: vi.fn<ConsoleSession["send"]>() }));
vi.mock("../../../src/console-session.js", async (original) => {
  const actual = await original<typeof import("../../../src/console-session.js")>();
  return {
    ...actual,
    createLocalConsoleSession: (...args: Parameters<typeof actual.createLocalConsoleSession>) => {
      const session = actual.createLocalConsoleSession(...args);
      session.send = fixture.send;
      return session;
    },
  };
});
vi.mock("../../../src/tui/credential-store.js", async (original) => ({
  ...await original<typeof import("../../../src/tui/credential-store.js")>(),
  loadCredentials: () => ({}), credentialEnvPatch: () => ({}),
}));

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
  fixture.send.mockReset();
  vi.restoreAllMocks();
});

test("keeps a long streamed markdown answer visible", async () => {
  const chunk = "alpha **bold** beta `inline-code` gamma delta ".repeat(40);
  const tail = "STREAMED_LONG_RESPONSE_TAIL";
  let complete = false;
  fixture.send.mockImplementation(async (_text, callbacks) => {
    let answer = "";
    for (let index = 0; index < 128; index++) {
      const delta = index === 127 ? `${chunk}${tail}` : chunk;
      answer += delta;
      callbacks?.onAssistantDelta?.(delta);
      // Let the production 33 ms presentation coalescer commit each growing
      // prefix; synchronous callbacks would test only the final answer.
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    complete = true;
    return {
      assistantText: answer,
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      budget: { tokensUsed: 2, tokenBudget: Infinity, iterations: 0, maxToolIterations: 100 },
      stopReason: "end_turn",
    };
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 503 }));
  tui = await launch({
    cols: 185,
    rows: 50,
    route: { type: "chat", options: { model: "deepseek-chat", providerId: "deepseek" } },
    settings: { onboardingCompleted: true, allowModelSelfExtension: false, diagnosticReporting: "off", reduceMotion: true },
    env: { ZERO_PROVIDER: "deepseek", ZERO_MODEL: "deepseek-chat", DEEPSEEK_API_KEY: "synthetic-test-key" },
  });
  await tui.sendKeys("stream a long synthetic answer");
  await tui.sendKey("return");
  await vi.waitFor(() => expect(complete).toBe(true), { timeout: 15_000 });
  await tui.waitForText(/hidden in this TUI preview/, 15_000);
  expect(tui.captureFrame()).toContain("hidden in this TUI preview");
  expect(process.memoryUsage().rss).toBeLessThan(1_000_000_000);
}, 45_000);
