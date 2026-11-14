import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
const guest = vi.hoisted(() => ({ admitted: true }));
vi.mock("./smolvm-broker.js", () => ({ isAdmittedSmolvmWorkbench: () => guest.admitted }));
import { LlmApiRuntime } from "./llm-api.js";
import { createWorkbenchProviderBroker } from "./workbench-provider-broker.js";

afterEach(() => { guest.admitted = true; vi.unstubAllEnvs(); });
function environment(url = "http://127.0.0.1:43210/provider/request") {
  return { ZERO_WORKBENCH_PROVIDER_PROXY: url, ZERO_WORKBENCH_PROVIDER_MODEL: "gpt-5.6-sol",
    ZERO_SELECTED_PROVIDER: "chatgpt-codex", ZERO_FORCE_PROVIDER: "chatgpt-codex" };
}

describe("admitted guest provider adapter", () => {
  it("uses a real loopback proxy and host broker without sending provider secrets from the guest", async () => {
    const hostSecret = "host-only-loopback-fixture-token";
    const auth = vi.fn(async () => ({ accessToken: hostSecret }));
    let upstreamCalls = 0, proxyCalls = 0, proxyBody = "", proxyAuthorization: string | undefined;
    const broker = createWorkbenchProviderBroker({ provider: "chatgpt-codex", models: ["gpt-5.6-sol"], resolveCredentials: auth,
      fetchImpl: async (url, options) => {
        upstreamCalls++;
        expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
        expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${hostSecret}`);
        const body = JSON.parse(String(options?.body));
        expect(body.model).toBe("gpt-5.6-sol");
        expect(body.instructions).toBe("Reply briefly.");
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "brokered reply" }] }],
          usage: { input_tokens: 11, output_tokens: 3 },
        } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const server = createServer(async (incoming, outgoing) => {
      proxyCalls++; proxyAuthorization = incoming.headers.authorization;
      proxyBody = "";
      for await (const chunk of incoming) proxyBody += String(chunk);
      try {
        const response = await broker.request(JSON.parse(proxyBody));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        const reader = response.body!.getReader();
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; outgoing.write(chunk.value); }
        outgoing.end();
      } catch { outgoing.writeHead(502); outgoing.end("broker fixture failed"); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/provider/request`;
    // Ambient guest-looking secrets must never become wire credentials in
    // proxy mode; all authentication is resolved by the host-only closure.
    vi.stubEnv("ZERO_CHATGPT_ACCESS_TOKEN", "guest-ambient-must-not-forward");
    vi.stubEnv("ZERO_CHATGPT_OAUTH_REFRESH_TOKEN", "guest-refresh-must-not-forward");
    try {
      const runtime = new LlmApiRuntime({ type: "api", timeout: 5000, env: environment(url) });
      expect(await runtime.isAvailable()).toBe(true);
      expect(runtime.getConfigurationDiagnostics().valid).toBe(true);
      expect(() => runtime.workbenchCredentialResolver()).toThrow("captured chatgpt-codex account");
      expect(runtime.accessibleProviders()).toEqual(["chatgpt-codex"]);
      const result = await runtime.executeNative("Reply briefly.", [{ role: "user", content: [{ type: "text", text: "Hello" }] }], []);
      expect(result.stopReason).toBe("end_turn");
      expect(result.content).toEqual([{ type: "text", text: "brokered reply" }]);
      const plain = await runtime.execute("Hello", { systemPrompt: "Reply briefly." });
      expect(plain.exitCode).toBe(0); expect(plain.output).toBe("brokered reply");
      expect(proxyCalls).toBe(2); expect(upstreamCalls).toBe(2); expect(auth).toHaveBeenCalledTimes(2);
      expect(proxyAuthorization).toBeUndefined();
      expect(proxyBody).not.toContain(hostSecret);
      expect(proxyBody).not.toContain("guest-ambient");
      expect(proxyBody).not.toContain("guest-refresh");
      expect(runtime.outputTokenLimit).toBeUndefined();
    } finally {
      await broker.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("refuses proxy markers outside an admitted guest and refuses remote/alternate routes", () => {
    guest.admitted = false;
    expect(() => new LlmApiRuntime({ type: "api", timeout: 5000, env: environment() })).toThrow("authenticated SmolVM");
    guest.admitted = true;
    for (const url of ["http://attacker.invalid/provider/request", "http://127.0.0.1:43210/arbitrary", "http://user:pass@127.0.0.1:43210/provider/request"]) {
      expect(() => new LlmApiRuntime({ type: "api", timeout: 5000, env: environment(url) })).toThrow("fixed guest loopback");
    }
    expect(() => new LlmApiRuntime({ type: "api", timeout: 5000, provider: "openai", env: environment() })).toThrow("no fallback");
  });
});
