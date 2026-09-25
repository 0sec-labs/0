import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
});

test("a missing direct-provider key retains the draft despite saved Cloud credentials", async () => {
  tui = await launch({
    route: { type: "chat", options: { providerId: "openai" } },
    env: {
      ZERO_SELECTED_PROVIDER: "openai",
      ZERO_CLOUD_TOKEN: "synthetic-managed-service-token",
      OPENAI_API_KEY: undefined,
    },
    settings: { onboardingCompleted: true, diagnosticReporting: "off" },
  });
  const frame = await tui.waitForText(/OpenAI credentials need attention/);
  expect(frame).not.toContain("0security Auto");
  await tui.sendKey("escape");
  await tui.waitForText(/Connect a provider to start chatting/);
  await tui.sendKeys("Keep this draft until I connect my own model");
  await tui.sendKey("return");
  expect(tui.captureFrame()).toContain("Keep this draft until I connect my own model");
});
