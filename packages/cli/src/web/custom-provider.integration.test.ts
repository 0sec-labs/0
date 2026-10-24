import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebOperatorServices, createWebConsoleRuntime } from "./operator-services.js";
import { loadConnectionConfigs } from "./connection-config.js";
import { loadCredentials } from "../tui/credential-store.js";
import { PROVIDERS } from "../tui/provider-status.js";
import { reloadSettings } from "../tui/settings-store.js";

// Catalog synchronization is unrelated to the selected gateway; keep this smoke
// entirely offline while exercising real credentials, persistence and HTTP I/O.
vi.mock("../tui/model-catalog-sync.js", async original => ({
  ...await original<typeof import("../tui/model-catalog-sync.js")>(),
  syncModelCatalog: async () => undefined,
}));

let home: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
  server = undefined;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); reloadSettings();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

it("restores a saved custom gateway and unlisted model, then completes a native tool round trip over HTTP", async () => {
  home = mkdtempSync(join(tmpdir(), "0-custom-gateway-"));
  vi.stubEnv("HOME", home);
  for (const info of PROVIDERS) for (const key of info.envVars) vi.stubEnv(key, undefined);
  for (const key of ["OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_WIRE_API", "ZERO_MODEL", "ZERO_PROVIDER", "ZERO_SELECTED_PROVIDER", "ZERO_FORCE_PROVIDER", "ZERO_WORKBENCH_PROVIDER_PROXY", "ZERO_WORKBENCH_PROVIDER_PROXY_TOKEN"]) vi.stubEnv(key, undefined);
  vi.stubEnv("ZERO_LLM_FALLBACK", ""); vi.stubEnv("ZERO_SKIP_PROVIDER_BANNER", "1");
  reloadSettings();
  const captured: Array<{ path: string; authorization: string | undefined; body: Record<string, any> }> = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : {};
    captured.push({ path: request.url!, authorization: request.headers.authorization, body });
    if (request.url === "/router/v1/models") { response.writeHead(404); response.end("No catalog"); return; }
    if (request.url !== "/router/v1/chat/completions") { response.writeHead(404); response.end(); return; }
    const hasToolResult = body.messages.some((message: { role: string }) => message.role === "tool");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: hasToolResult ? { role: "assistant", content: "Gateway tool round trip complete" }
      : { role: "assistant", content: null, tool_calls: [{ id: "call-local", type: "function", function: { name: "read_fixture", arguments: '{"path":"fixture.txt"}' } }] },
      finish_reason: hasToolResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing gateway address");
  const baseUrl = `http://127.0.0.1:${address.port}/router/v1`;
  const model = "9router/vendor/unlisted:custom-model";
  const key = "synthetic-local-gateway-key";
  const service = new WebOperatorServices();
  const connected = await service.handle("/api/console/connections", "POST", { action: "connect", providerId: "openai", baseUrl, model, apiKey: key }, new URLSearchParams());
  expect(connected?.status).toBe(200);
  expect(JSON.stringify(connected?.data)).not.toContain(key);
  expect(loadConnectionConfigs().openai).toEqual({ baseUrl, model });
  expect(loadCredentials().openai).toBe(key);
  expect(process.env.OPENAI_API_KEY).toBeUndefined();
  expect(process.env.OPENAI_BASE_URL).toBeUndefined();
  const inventory = await new WebOperatorServices().handle("/api/console/models", "GET", undefined, new URLSearchParams("providerId=openai"));
  expect(inventory?.data).toMatchObject({ models: [expect.objectContaining({ id: model, provider: "openai" })] });
  expect(captured.some(request => request.path === "/router/v1/models")).toBe(true);
  const { runtime } = await createWebConsoleRuntime({ providerId: "openai", singleModel: true, autoRoute: false });
  expect(runtime.resolvedModel()).toBe(model);
  const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "Read the local fixture" }] }];
  const tools = [{ name: "read_fixture", description: "Read a test fixture", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
  const first = await runtime.executeNative("Use the fixture tool.", messages, tools);
  expect(first).toMatchObject({ stopReason: "tool_use", content: [{ type: "tool_use", id: "call-local", name: "read_fixture", input: { path: "fixture.txt" } }] });
  const final = await runtime.executeNative("Use the fixture tool.", [...messages, { role: "assistant", content: first.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-local", content: "Synthetic fixture contents" }] }], tools);
  expect(final).toMatchObject({ stopReason: "end_turn", content: [{ type: "text", text: "Gateway tool round trip complete" }] });
  const requests = captured.filter(request => request.path.endsWith("/chat/completions"));
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.authorization).toBe(`Bearer ${key}`);
    expect(request.body.model).toBe(model);
    expect(request.body.tools[0].function.name).toBe("read_fixture");
  }
  expect(requests[1].body.messages).toContainEqual({ role: "tool", tool_call_id: "call-local", content: "Synthetic fixture contents" });
}, 20_000);
