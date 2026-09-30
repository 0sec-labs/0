import { describe, expect, it, vi } from "vitest";
import { createWorkbenchProviderBroker } from "./workbench-provider-broker.js";
import type { WorkbenchProviderBrokerOptions, WorkbenchProviderRequest } from "./workbench-provider-broker.js";

const model = "gpt-5.6-sol", token = "host-only-fixture-access-token";
function request(): WorkbenchProviderRequest {
  return { provider: "chatgpt-codex", model, body: JSON.stringify({ model, instructions: "fixture", input: [], store: false, stream: true }) };
}
function fixture(extra: Partial<WorkbenchProviderBrokerOptions> = {}) {
  const resolveCredentials = vi.fn(async () => ({ accessToken: token, accountId: "fixture-account" }));
  const fetchImpl = vi.fn(async () => new Response("data: fixture\n\n", { headers: { "content-type": "text/event-stream", "set-cookie": token } }));
  const broker = createWorkbenchProviderBroker({ provider: "chatgpt-codex", models: [model], resolveCredentials, fetchImpl, ...extra });
  return { broker, resolveCredentials, fetchImpl };
}

describe("host provider credential broker", () => {
  it("keeps credentials private and only sends them to the fixed upstream route", async () => {
    const { broker, resolveCredentials, fetchImpl } = fixture();
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(JSON.stringify(broker.grant)).not.toContain(token);
    const response = await broker.request(request());
    expect(await response.text()).toContain("fixture");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(options.headers).get("chatgpt-account-id")).toBe("fixture-account");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
    await broker.close();
  });

  it.each([
    (r: WorkbenchProviderRequest) => ({ ...r, provider: "openai" }),
    (r: WorkbenchProviderRequest) => ({ ...r, model: "ungranted-model" }),
    (r: WorkbenchProviderRequest) => ({ ...r, url: "https://attacker.invalid" }),
    (r: WorkbenchProviderRequest) => ({ ...r, headers: { Authorization: "guest-selected" } }),
    (r: WorkbenchProviderRequest) => ({ ...r, body: JSON.stringify({ ...JSON.parse(r.body), model: "different-model" }) }),
    (r: WorkbenchProviderRequest) => ({ ...r, body: JSON.stringify({ ...JSON.parse(r.body), store: true }) }),
    (r: WorkbenchProviderRequest) => ({ ...r, body: JSON.stringify({ ...JSON.parse(r.body), tools: [{ type: "mcp", server_url: "https://attacker.invalid" }] }) }),
    (r: WorkbenchProviderRequest) => ({ ...r, body: JSON.stringify({ ...JSON.parse(r.body), input: [{ content: [{ type: "input_image", image_url: "https://attacker.invalid" }] }] }) }),
  ])("refuses ungranted route/model/state/hosted capability before credential resolution (%#)", async (mutate) => {
    const { broker, resolveCredentials, fetchImpl } = fixture();
    await expect(broker.request(mutate(request()))).rejects.toThrow();
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await broker.close();
  });

  it("redacts token echoes across response chunks without exporting raw errors", async () => {
    const encoder = new TextEncoder();
    let n = 0;
    const chunks = [`data: ${token.slice(0, 11)}`, `${token.slice(11)}\n\n`];
    const { broker } = fixture({ fetchImpl: async () => new Response(new ReadableStream({
      pull(stream) { if (n < chunks.length) stream.enqueue(encoder.encode(chunks[n++])); else stream.close(); },
    }), { status: 400 }) });
    const response = await broker.request(request());
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("data: [redacted]\n\n");
    await broker.close();
    const failed = fixture({ fetchImpl: async () => { throw new Error(`private failure ${token}`); } });
    await expect(failed.broker.request(request())).rejects.toThrow("Host provider request failed");
    await failed.broker.close();
  });

  it("counts a streaming response against concurrency until consumed, then enforces the request budget", async () => {
    const { broker } = fixture({ limits: { maxConcurrent: 1, maxRequests: 2 } });
    const first = await broker.request(request());
    await expect(broker.request(request())).rejects.toThrow("concurrency limit");
    await first.text();
    await (await broker.request(request())).text();
    await expect(broker.request(request())).rejects.toThrow("budget exhausted");
    await broker.close();
  });

  it("rejects oversized input before auth and cancels oversized upstream output", async () => {
    const input = fixture({ limits: { maxRequestBytes: 10 } });
    await expect(input.broker.request(request())).rejects.toThrow("byte limit");
    expect(input.resolveCredentials).not.toHaveBeenCalled();
    await input.broker.close();
    let cancelled = false;
    const output = fixture({ limits: { maxResponseBytes: 10 }, fetchImpl: async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode("data: this is too much\n\n")); },
      cancel() { cancelled = true; },
    })) });
    await expect((await output.broker.request(request())).text()).rejects.toThrow();
    expect(cancelled).toBe(true);
    await output.broker.close();
  });

  it("propagates caller cancellation through an open response and closes session authority", async () => {
    let cancelled = false;
    const caller = new AbortController();
    const { broker } = fixture({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    const response = await broker.request(request(), caller.signal);
    caller.abort();
    await expect(response.text()).rejects.toThrow("cancelled");
    expect(cancelled).toBe(true);
    await broker.close();
    await expect(broker.request(request())).rejects.toThrow("closed");
  });

  it("enforces deadlines during host credential resolution without calling upstream", async () => {
    const pending = new Promise<{ accessToken: string }>(() => {});
    const { broker, fetchImpl } = fixture({ limits: { timeoutMs: 15 }, resolveCredentials: () => pending });
    await expect(broker.request(request())).rejects.toThrow("timed out");
    expect(fetchImpl).not.toHaveBeenCalled();
    await broker.close();
  });
});
