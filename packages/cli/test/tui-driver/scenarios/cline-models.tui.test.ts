import { afterEach, expect, test } from "vitest";
import { launch, type TuiHandle } from "../index.js";

let tui: TuiHandle | undefined;
afterEach(async () => { await tui?.close(); tui = undefined; });

test("ClinePass picker keeps public catalog access unverified and sends the exact subscription slug", async () => {
  const requests: Array<{ url: string; model: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    if (url === "https://cline.fixture/api/v1/ai/cline/models") {
      expect(headers.has("Authorization")).toBe(false);
      return Response.json({ data: [{ id: "anthropic/claude-sonnet-4-6", context_length: 200_000 }] });
    }
    if (url === "https://cline.fixture/api/v1/ai/cline/recommended-models") {
      expect(headers.has("Authorization")).toBe(false);
      return Response.json({ clinePass: [{ id: "cline-pass/glm-5.3" }, { id: "cline-pass/kimi-k3" }] });
    }
    if (url === "https://cline.fixture/api/v1/chat/completions" && headers.get("Authorization") === "Bearer synthetic-cline-picker-key") {
      requests.push({ url, model: JSON.parse(String(init?.body)).model });
      return Response.json({ success: true, data: { choices: [{ message: { role: "assistant", content: "Synthetic Cline reply" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } } });
    }
    return new Response(null, { status: 503 });
  };
  tui = await launch({ cols: 120, rows: 34, fetchImpl,
    route: { type: "chat", options: { providerId: "cline", model: "cline-pass/glm-5.3" } },
    settings: { onboardingCompleted: true },
    env: { CLINE_API_KEY: "synthetic-cline-picker-key", CLINE_BASE_URL: "https://cline.fixture/api/v1", ZERO_SELECTED_PROVIDER: "cline", ZERO_MODEL: "cline-pass/glm-5.3" },
  });
  await tui.waitForText(/type to chat/);
  await tui.sendKeys("/model");
  await tui.sendKey("return");
  await tui.waitForText(/cline-pass\/kimi-k3/);
  expect(tui.captureFrame()).toContain("Pass · access unverified");
  expect(tui.captureFrame()).not.toContain("Included in subscription");
  await tui.sendKeys("kimi-k3");
  await tui.sendKey("return");
  await tui.waitForText(/◈ cline-pass\/kimi-k3/);
  await tui.sendKeys("synthetic Cline request");
  await tui.sendKey("return");
  await expect.poll(async () => { await tui!.settle(); return requests.length; }).toBeGreaterThan(0);
  expect(requests[0]).toEqual({ url: "https://cline.fixture/api/v1/chat/completions", model: "cline-pass/kimi-k3" });
});
