import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebOperatorServices } from "./operator-services.js";
import { loadCredentials } from "../state/credential-store.js";
import { PROVIDERS } from "../state/provider-status.js";
import { getSettings, reloadSettings } from "../state/settings-store.js";

vi.mock("../state/model-catalog-sync.js", async original => ({
  ...await original<typeof import("../state/model-catalog-sync.js")>(),
  syncModelCatalog: async () => undefined,
}));

let home: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  server = undefined;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); reloadSettings();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

async function setup(status: number): Promise<{ service: WebOperatorServices; baseUrl: string; seen: string[] }> {
  home = mkdtempSync(join(tmpdir(), "0-connect-validate-"));
  vi.stubEnv("HOME", home);
  for (const info of PROVIDERS) for (const key of info.envVars) vi.stubEnv(key, undefined);
  for (const key of ["OPENAI_BASE_URL", "OPENAI_MODEL", "ZERO_MODEL", "ZERO_PROVIDER", "ZERO_SELECTED_PROVIDER", "ZERO_FORCE_PROVIDER"]) vi.stubEnv(key, undefined);
  vi.stubEnv("ZERO_LLM_FALLBACK", ""); vi.stubEnv("ZERO_SUPPRESS_PROVIDER_STARTUP_LOG", "1");
  reloadSettings();
  const seen: string[] = [];
  server = createServer((request, response) => {
    seen.push(`${request.url} ${request.headers.authorization ?? ""}`);
    if (status === 200) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "model-a" }] })); return; }
    response.writeHead(status); response.end("no");
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return { service: new WebOperatorServices(), baseUrl: `http://127.0.0.1:${address.port}/v1`, seen };
}

it("rejects a key the provider refuses and saves nothing", async () => {
  const { service, baseUrl, seen } = await setup(401);
  const key = "synthetic-rejected-key";
  const result = await service.handle("/api/console/connections", "POST", { action: "connect", providerId: "openai", baseUrl, apiKey: key }, new URLSearchParams());
  expect(result).toMatchObject({ status: 422, data: { code: "key_rejected", error: expect.stringContaining("Key was rejected") } });
  expect(JSON.stringify(result)).not.toContain(key);
  expect(seen[0]).toContain(`Bearer ${key}`);
  expect(loadCredentials().openai).toBeUndefined();
});

it("reports an unreachable provider without saving", async () => {
  const { service, baseUrl } = await setup(200);
  await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
  const result = await service.handle("/api/console/connections", "POST", { action: "connect", providerId: "openai", baseUrl, apiKey: "synthetic-key" }, new URLSearchParams());
  expect(result).toMatchObject({ status: 422, data: { code: "provider_unreachable", error: expect.stringContaining("Couldn't reach the provider") } });
  expect(loadCredentials().openai).toBeUndefined();
});

it("saves a key the provider accepts", async () => {
  const { service, baseUrl } = await setup(200);
  const result = await service.handle("/api/console/connections", "POST", { action: "connect", providerId: "openai", baseUrl, apiKey: "synthetic-good-key" }, new URLSearchParams());
  expect(result?.status).toBe(200);
  expect(loadCredentials().openai).toBe("synthetic-good-key");
});

it("stores the global default model for the connected provider and refuses a disconnected one", async () => {
  const { service, baseUrl } = await setup(200);
  const none = await service.handle("/api/console/models/preference", "PATCH", { providerId: "openai", model: "model-a" }, new URLSearchParams());
  expect(none).toMatchObject({ status: 409, data: { code: "not_connected" } });
  await service.handle("/api/console/connections", "POST", { action: "connect", providerId: "openai", baseUrl, apiKey: "synthetic-good-key" }, new URLSearchParams());
  const saved = await service.handle("/api/console/models/preference", "PATCH", { providerId: "openai", model: "model-a" }, new URLSearchParams());
  expect(saved).toMatchObject({ status: 200, data: { preference: { providerId: "openai", model: "model-a" } } });
  expect(getSettings().modelPreference).toMatchObject({ providerId: "openai", model: "model-a" });
  const providers = await service.handle("/api/console/providers", "GET", undefined, new URLSearchParams());
  expect(providers?.data).toMatchObject({ preference: { providerId: "openai", model: "model-a" } });
  expect(JSON.stringify(saved)).not.toContain("synthetic-good-key");
});

it("rejects a bad key for providers whose model list does not prove it", async () => {
  const { service } = await setup(200);
  const original = globalThis.fetch;
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (!/openrouter\.ai|api\.z\.ai|api\.x\.ai/.test(href)) return original(url, init);
    seen.push(href);
    return href.includes("x.ai") ? new Response("{}", { status: 400 }) : new Response("{}", { status: 401 });
  });
  for (const providerId of ["openrouter", "z-ai", "xai"]) {
    const result = await service.handle("/api/console/connections", "POST", { action: "connect", providerId, apiKey: "synthetic-bad-key" }, new URLSearchParams());
    expect(result, providerId).toMatchObject({ status: 422, data: { code: "key_rejected" } });
  }
  expect(seen.some(href => href.endsWith("/api/v1/key"))).toBe(true);
  expect(loadCredentials().openrouter).toBeUndefined();
  vi.unstubAllGlobals();
});
