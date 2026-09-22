import { afterEach, expect, test, vi } from "vitest";
import { launch, type TuiHandle } from "../index.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
  vi.restoreAllMocks();
});

test("account admission preserves a draft until an explicit check and send", async () => {
  let eligible = false;
  let inferenceCalls = 0;
  let sentDrafts = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/account")) return Response.json({
      schemaVersion: "usage-v2",
      snapshotAt: "2026-09-22T12:00:00.000Z",
      scope: { orgId: "org_fixture" },
      state: "ready",
      reason: null,
      plan: { id: null, name: null, monthlyPriceUsd: null },
      included: { state: "exhausted", usedPercent: 100, resetsAt: null },
      prepaid: { balanceUsd: "20.00", fallbackEnabled: eligible },
      canManageBilling: true,
      admission: { eligible, reason: eligible ? null : "prepaid_disabled" },
    });
    if (url.endsWith("/models")) return Response.json({ data: [
      { id: "service-default", wire_api: "chat_completions", max_output_tokens: 512 },
    ] });
    if (url.endsWith("/chat/completions")) {
      inferenceCalls++;
      const body = JSON.parse(String(init?.body));
      if (body.messages.some((message: { role: string; content: unknown }) =>
        message.role === "user" && message.content === "Please keep my draft")) sentDrafts++;
      expect(body.model).toBe("service-default");
      expect(body.messages.some((message: { content: unknown }) =>
        JSON.stringify(message.content).includes("Please keep my draft"))).toBe(true);
      return Response.json({
        choices: [{ message: { content: "Your draft reached the service." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    }
    return new Response(null, { status: 404 });
  });
  tui = await launch({
    route: { type: "chat", options: { providerId: "hosted" } },
    env: { ZERO_FORCE_PROVIDER: "hosted", ZERO_SELECTED_PROVIDER: "hosted", ZERO_MODEL: "", ZERO_CLOUD_TOKEN: "synthetic-test-token" },
    settings: { onboardingCompleted: true, diagnosticReporting: "off" },
  });
  const blocked = await tui.waitForText(/Signed in · account access restricted/);
  expect(blocked).toContain("prepaid_disabled");
  expect(blocked).not.toContain("Choose model");
  await tui.sendKeys("Please keep my draft");
  await tui.sendKey("return");
  expect(tui.captureFrame()).toContain("Please keep my draft");
  expect(tui.captureFrame()).not.toContain("Could not complete this message");
  expect(inferenceCalls).toBe(0);

  eligible = true;
  await tui.sendKey("r", { ctrl: true });
  await vi.waitFor(() => expect(tui!.captureFrame()).not.toMatch(/account access restricted|Checking service availability/));
  expect(tui.captureFrame()).toContain("Please keep my draft");
  expect(inferenceCalls).toBe(0);
  await tui.sendKey("return");
  await tui.waitForText(/Your draft reached the service/);
  expect(sentDrafts).toBe(1);
});

test("missing credentials open connection recovery, not account admission recovery", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 404 }));
  tui = await launch({
    route: { type: "chat", options: { providerId: "hosted" } },
    env: { ZERO_FORCE_PROVIDER: "hosted", ZERO_SELECTED_PROVIDER: "hosted", ZERO_MODEL: "", ZERO_CLOUD_TOKEN: undefined },
    settings: { onboardingCompleted: true, diagnosticReporting: "off" },
  });
  const frame = await tui.waitForText(/Connect a provider to start chatting/);
  expect(frame).not.toContain("account access restricted");
  expect(frame).not.toContain("Choose model");
  await tui.sendKeys("Keep this disconnected draft");
  await tui.sendKey("return");
  expect(tui.captureFrame()).toContain("Keep this disconnected draft");
  expect(tui.captureFrame()).not.toContain("Could not complete this message");
  await tui.sendKey("p", { ctrl: true });
  await tui.sendKeys("connect");
  await tui.sendKey("return");
  await tui.waitForText(/Connections/);
});
