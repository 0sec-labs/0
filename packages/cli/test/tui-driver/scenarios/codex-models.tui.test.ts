import { afterEach, expect, test, vi } from "vitest";
import { LlmApiRuntime } from "@0/core";
import { launch, type TuiHandle } from "../index.js";

vi.mock("../../../src/tui/credential-store.js", async (original) => ({
  ...await original<typeof import("../../../src/tui/credential-store.js")>(),
  loadCredentials: () => ({}), credentialEnvPatch: () => ({}),
}));
let tui: TuiHandle | undefined;
afterEach(async () => { await tui?.close(); tui = undefined; vi.restoreAllMocks(); });

function fixture(discovery: "ok" | "denied" = "ok", publicDiscovery: "ok" | "denied" = "denied") {
  const originalCatalog = LlmApiRuntime.prototype.availableModelCatalog;
  vi.spyOn(LlmApiRuntime.prototype, "availableModelCatalog").mockImplementation(async function(this: LlmApiRuntime, signal) {
    if (this.resolvedProvider() === "azure" && process.env.AZURE_OPENAI_API_KEY === "synthetic-azure-key" && process.env.AZURE_OPENAI_BASE_URL === "https://azure.fixture/v1") {
      return [{ id: "gpt-5.5" }];
    }
    return originalCatalog.call(this, signal);
  });
  const requests: Array<{ url: string; model: string }> = [];
  let publicRequests = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://models.dev/api.json") {
      publicRequests += 1;
      return publicDiscovery === "denied" ? new Response(null, { status: 503 }) : Response.json({
        openai: { models: {
          "aaa-automatic-model": { cost: { input: 1, output: 2, cache_read: 0.1 }, limit: { context: 524288 } },
        } },
        "chatgpt-codex": { models: { "aaa-public-subscription": {} } },
      });
    }
    if (url === "https://api.openai.com/v1/models" && new Headers(init?.headers).get("Authorization") === "Bearer synthetic-api-key") {
      return Response.json({ data: [{ id: "aaa-automatic-model", context_length: 524288 }, { id: "gpt-5.5" }] });
    }
    if (url.includes("/codex/models?")) {
      return discovery === "denied" ? new Response(null, { status: 403 }) : Response.json({ models: [
        { slug: "gpt-5.5", priority: 13 }, { slug: "gpt-daybreak-blue-latest", context_window: 1_050_000, priority: 1 },
      ] });
    }
    if (url.endsWith("/codex/responses")) {
      requests.push({ url, model: JSON.parse(String(init?.body)).model });
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic reply" }] }],
        usage: { input_tokens: 10, output_tokens: 2 },
      } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url === "https://api.openai.com/v1/chat/completions") {
      requests.push({ url, model: JSON.parse(String(init?.body)).model });
      return Response.json({
        choices: [{ message: { role: "assistant", content: "Synthetic API reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    }
    return new Response(null, { status: 503 });
  });
  return {
    requests,
    fetchMock,
    publicRequestCount: () => publicRequests,
    setPublicDiscovery: (next: "ok" | "denied") => { publicDiscovery = next; },
    setDiscovery: (next: "ok" | "denied") => { discovery = next; },
  };
}

async function start(apiKey?: string, providerId: "chatgpt-codex" | "openai" | "azure" = "chatgpt-codex") {
  tui = await launch({
    route: { type: "chat", options: { providerId, model: "gpt-5.5" } },
    settings: { onboardingCompleted: true, allowModelSelfExtension: false },
    env: { ZERO_PROVIDER: providerId, ZERO_MODEL: "gpt-5.5", ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-fixture-token", OPENAI_API_KEY: apiKey, ...(providerId === "azure" ? { AZURE_OPENAI_API_KEY: "synthetic-azure-key", AZURE_OPENAI_BASE_URL: "https://azure.fixture/v1" } : {}) },
  });
  await tui.waitForText(/type to chat/);
}

test("account-discovered subscription choices lead metered models without losing provider prices", async () => {
  fixture("ok", "ok");
  await start("synthetic-api-key", "openai");
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/gpt-daybreak-blue-latest/);
  await tui!.waitForText(/aaa-automatic-model/);

  const frame = tui!.captureFrame();
  expect(frame.indexOf("gpt-daybreak-blue-latest")).toBeLessThan(frame.indexOf("aaa-automatic-model"));
  expect(frame.indexOf("gpt-daybreak-blue-latest")).toBeLessThan(frame.indexOf("gpt-5.5"));
  expect(frame).toContain("subscription");
  expect(frame).toMatch(/\$1\/2 per M/);
  expect(frame).toContain("OPENAI");
});

test("subscription selection reaches the Codex request with its exact discovered model ID", async () => {
  const { requests } = fixture();
  await start();
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/2 Codex models/);
  await tui!.sendKeys("daybreak");
  await tui!.waitForText(/gpt-daybreak-blue-latest/);
  await tui!.sendKey("return");
  await tui!.waitForText(/◈ gpt-daybreak-blue-latest/);
  await tui!.sendKeys("synthetic request");
  await tui!.sendKey("return");
  await expect.poll(async () => { await tui!.settle(); return requests.length; }).toBeGreaterThan(0);
  expect(requests.every((request) => request.model === "gpt-daybreak-blue-latest")).toBe(true);
  expect(requests[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
});

test("a model-only slash switch preserves the active subscription", async () => {
  const { requests } = fixture();
  await start();
  await tui!.sendKeys("/model gpt-daybreak-blue-latest");
  await tui!.sendKey("return");
  await tui!.waitForText(/◈ gpt-daybreak-blue-latest/);
  await tui!.sendKeys("synthetic subscription request");
  await tui!.sendKey("return");
  await expect.poll(async () => { await tui!.settle(); return requests.length; }).toBeGreaterThan(0);
  expect(requests[0]).toEqual({ url: "https://chatgpt.com/backend-api/codex/responses", model: "gpt-daybreak-blue-latest" });
});

test("a denied account catalog shows discovery failure rather than a public subscription list", async () => {
  fixture("denied");
  await start();
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/Codex models unavailable/);
  await tui!.sendKeys("daybreak");
  expect(tui!.captureFrame()).not.toContain("gpt-daybreak-blue-latest");
});


test("confirming a duplicate current model keeps subscription billing when an API key also exists", async () => {
  const { requests } = fixture();
  await start("synthetic-api-key");
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/2 Codex models/);
  await tui!.sendKey("return");
  await tui!.waitForText(/◈ gpt-5\.5/);
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
  await tui!.waitForText(/Codex models unavailable/);
  setDiscovery("ok");
  await tui!.sendKey("r", { ctrl: true });
  await tui!.waitForText(/2 Codex models/);
  await tui!.sendKeys("daybreak");
  await tui!.waitForText(/gpt-daybreak-blue-latest/);
});

test("API-backed roles cannot pick a subscription model through the ID-only role map", async () => {
  fixture();
  await start("synthetic-api-key", "openai");
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/2 Codex models/);
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
  await tui!.waitForText(/2 Codex models/);
  await tui!.sendKey("right", { ctrl: true });
  await tui!.sendKeys("gpt-5.5");
  await tui!.sendKey("return");
  await tui!.waitForText(/discovery: gpt-5.5 set/);
});

test("connection-discovered models appear unfiltered, retain pricing through an offline refresh, and keep their API route", async () => {
  const { requests, publicRequestCount, setPublicDiscovery } = fixture("ok", "ok");
  await start("synthetic-api-key", "openai");
  await tui!.sendKeys("/model");
  await tui!.sendKey("return");
  await tui!.waitForText(/aaa-automatic-model/);
  expect(tui!.captureFrame()).not.toContain("aaa-public-subscription");
  expect(publicRequestCount()).toBe(1);
  setPublicDiscovery("denied");
  await tui!.sendKey("r", { ctrl: true });
  await tui!.waitForText(/Pricing offline/);
  expect(publicRequestCount()).toBe(2);
  expect(tui!.captureFrame()).toContain("aaa-automatic-model");
  await tui!.sendKeys("aaa-automatic-model");
  await tui!.sendKey("return");
  await tui!.waitForText(/◈ aaa-automatic-model/);
  await tui!.sendKeys("synthetic discovered-model request");
  await tui!.sendKey("return");
  await expect.poll(async () => { await tui!.settle(); return requests.length; }).toBeGreaterThan(0);
  expect(requests[0]).toEqual({ url: "https://api.openai.com/v1/chat/completions", model: "aaa-automatic-model" });
});
