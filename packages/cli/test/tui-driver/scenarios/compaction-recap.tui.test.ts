import { afterEach, expect, test, vi } from "vitest";
import React from "react";
import type { TranscriptReviewProps } from "../../../src/tui/chat/TranscriptReview.js";
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

// Exercise ChatScreen's recap lifecycle independently of the custom native
// review renderable (Vitest loads two OpenTUI class identities under Bun).
vi.mock("../../../src/tui/chat/TranscriptReview.js", () => ({
  TranscriptReview: ({ recap }: TranscriptReviewProps) => React.createElement("text", {},
    recap
      ? `PRE-COMPACTION RECAP ${recap.tokensBefore}→${recap.tokensAfter} tok\n${recap.summaryText}\n${JSON.stringify(recap.preCompactionMessages)}`
      : "TRANSCRIPT REVIEW without recap"),
}));

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
  fixture.send.mockReset();
  vi.restoreAllMocks();
});

test("review shows the latest compaction and clear removes retained history", async () => {
  let compactionNumber = 0;
  fixture.send.mockImplementation(async (_text, callbacks) => {
    const current = ++compactionNumber;
    callbacks?.onCompaction?.({
      compactionNumber: current,
      tokensBefore: 10000,
      messagesBefore: 2, messagesAfter: 1,
      summaryText: `SYNTHETIC SUMMARY ${current}`,
      preCompactionMessages: [{ role: "user", content: [{ type: "text", text: `RETAINED HISTORY ${current}` }] }],
      degraded: false,
    });
    callbacks?.onUsage?.({
      inputTokens: 2000, outputTokens: 10, turnTokensUsed: 2010,
      turnTokenBudget: Infinity, iterations: 0, maxToolIterations: 100, kind: "planner",
    });
    return {
      assistantText: `SYNTHETIC ANSWER ${current}`, toolCalls: [],
      usage: { inputTokens: 2000, outputTokens: 10 },
      budget: { tokensUsed: 2010, tokenBudget: Infinity, iterations: 0, maxToolIterations: 100 },
      stopReason: "end_turn",
    };
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 503 }));
  tui = await launch({
    cols: 120, rows: 45,
    route: { type: "chat", options: { model: "deepseek-chat", providerId: "deepseek" } },
    settings: { onboardingCompleted: true, allowModelSelfExtension: false, diagnosticReporting: "off" },
    env: { ZERO_PROVIDER: "deepseek", ZERO_MODEL: "deepseek-chat", DEEPSEEK_API_KEY: "synthetic-test-key" },
  });
  for (let current = 1; current <= 2; current++) {
    await tui.sendKeys(`synthetic turn ${current}`);
    await tui.sendKey("return");
    await tui.waitForText(new RegExp(`SYNTHETIC ANSWER ${current}`));
    await tui.sendKey("o", { ctrl: true });
    const frame = await tui.waitForText(new RegExp(`RETAINED HISTORY ${current}`));
    expect(frame).toContain(`SYNTHETIC SUMMARY ${current}`);
    expect(frame).toContain("10000→2000 tok");
    if (current === 2) expect(frame).not.toContain("RETAINED HISTORY 1");
    await tui.sendKey("escape");
  }
  await tui.sendKeys("/clear");
  await tui.sendKey("return");
  await tui.settle();
  await tui.sendKey("o", { ctrl: true });
  await tui.settle();
  await tui.waitForText(/TRANSCRIPT REVIEW without recap/);
  expect(tui.captureFrame()).not.toContain("PRE-COMPACTION RECAP");
  expect(tui.captureFrame()).not.toContain("RETAINED HISTORY");
  expect(tui.captureFrame()).not.toContain("SYNTHETIC SUMMARY");
});
