import { afterEach, expect, test, vi } from "vitest";
import { launch, type TuiHandle } from "../index.js";

vi.mock("../../../src/tui/credential-store.js", async (original) => ({
  ...await original<typeof import("../../../src/tui/credential-store.js")>(),
  loadCredentials: () => ({}), credentialEnvPatch: () => ({}),
}));
let tui: TuiHandle | undefined;
afterEach(async () => { await tui?.close(); tui = undefined; vi.restoreAllMocks(); });

function fixture(discovery: "ok" | "denied" = "ok") {
  const requests: Array<{ url: string; model: string }> = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/codex/models?")) {
      return discovery === "denied" ? new Response(null, { status: 403 }) : Response.json({ models: [
        { slug: "gpt-5.5" }, { slug: "gpt-daybreak-blue-latest", context_window: 1_050_000 },
      ] });
    }
    if (url.endsWith("/codex/responses")) {
      requests.push({ url, model: JSON.parse(String(init?.body)).model });
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic reply" }] }],
        usage: { input_tokens: 10, output_tokens: 2 },
      } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(null, { status: 503 });
  });
  return { requests, fetchMock, setDiscovery: (next: "ok" | "denied") => { discovery = next; } };
}

async function start(apiKey?: string, providerId: "chatgpt-codex" | "openai" | "azure" = "chatgpt-codex") {
  tui = await launch({
    route: { type: "chat", options: { providerId, model: "gpt-5.5" } },
    settings: { onboardingCompleted: true, allowModelSelfExtension: false },
    env: { ZERO_PROVIDER: providerId, ZERO_MODEL: "gpt-5.5", ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-fixture-token", OPENAI_API_KEY: apiKey, ...(providerId === "azure" ? { AZURE_OPENAI_API_KEY: "synthetic-azure-key", AZURE_OPENAI_BASE_URL: "https://azure.fixture/v1" } : {}) },
  });
  await tui.waitForText(/type to chat/);
}

test("subscription selection reaches the Codex request with its exact discovered model ID", async () => {
  const { requests } = fixture();
  await start();
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/2 Codex account models/);
  await tui!.sendKeys("daybreak");
  await tui!.waitForText(/gpt-daybreak-blue-latest/);
  await tui!.sendKey("return");
  await tui!.waitForText(/Applied to this audit: gpt-daybreak-blue-latest/);
  await tui!.sendKeys("synthetic request");
  await tui!.sendKey("return");
  await expect.poll(async () => { await tui!.settle(); return requests.length; }).toBeGreaterThan(0);
  expect(requests.every((request) => request.model === "gpt-daybreak-blue-latest")).toBe(true);
  expect(requests[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
});

test("a model-only slash switch preserves the active subscription", async () => {
  fixture();
  await start();
  await tui!.sendKeys("/model gpt-daybreak-blue-latest");
  await tui!.sendKey("return");
  await tui!.waitForText(/Applied to this audit: gpt-daybreak-blue-latest/);
  expect(tui!.captureFrame()).not.toContain("Connect OpenAI");
});

test("a denied account catalog shows discovery failure rather than a public subscription list", async () => {
  fixture("denied");
  await start();
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/Codex model discovery unavailable/);
  await tui!.sendKeys("daybreak");
  expect(tui!.captureFrame()).not.toContain("gpt-daybreak-blue-latest");
});


test("confirming a duplicate current model keeps subscription billing when an API key also exists", async () => {
  const { requests } = fixture();
  await start("synthetic-api-key");
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/2 Codex account models/);
  await tui!.sendKey("return");
  await tui!.waitForText(/Applied to this audit: gpt-5.5 \(ChatGPT Codex\)/);
  await tui!.sendKeys("synthetic request");
  await tui!.sendKey("return");
  await expect.poll(async () => { await tui!.settle(); return requests.length; }).toBeGreaterThan(0);
  expect(requests[0]).toEqual({ url: "https://chatgpt.com/backend-api/codex/responses", model: "gpt-5.5" });
});


test("Ctrl+R retries account discovery after a failure", async () => {
  const { setDiscovery } = fixture("denied");
  await start();
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/Codex model discovery unavailable/);
  setDiscovery("ok");
  await tui!.sendKey("r", { ctrl: true });
  await tui!.waitForText(/2 Codex account models/);
  await tui!.sendKeys("daybreak");
  await tui!.waitForText(/gpt-daybreak-blue-latest/);
});

test("API-backed roles cannot pick a subscription model through the ID-only role map", async () => {
  fixture();
  await start("synthetic-api-key", "openai");
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/2 Codex account models/);
  await tui!.sendKey("right", { ctrl: true });
  await tui!.sendKeys("daybreak");
  await tui!.settle();
  expect(tui!.captureFrame()).not.toContain("gpt-daybreak-blue-latest");
});


test("Azure roles retain OpenAI-named models while excluding subscription-only rows", async () => {
  fixture();
  await start(undefined, "azure");
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/2 Codex account models/);
  await tui!.sendKey("right", { ctrl: true });
  await tui!.sendKeys("gpt-5.5");
  await tui!.sendKey("return");
  await tui!.waitForText(/discovery: gpt-5.5 applied/);
});
