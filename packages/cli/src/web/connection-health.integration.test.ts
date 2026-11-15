import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebOperatorServices } from "./operator-services.js";
import { PROVIDERS } from "../state/provider-status.js";
import { reloadSettings } from "../state/settings-store.js";

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

/** A local OpenAI-compatible provider whose /models answers with the given status ("hang" never answers). */
async function setup(mode: number | "hang"): Promise<{ service: WebOperatorServices; hits: () => number }> {
  home = mkdtempSync(join(tmpdir(), "0-connection-health-"));
  vi.stubEnv("HOME", home);
  for (const info of PROVIDERS) for (const key of info.envVars) vi.stubEnv(key, undefined);
  for (const key of ["OPENAI_MODEL", "ZERO_MODEL", "ZERO_PROVIDER", "ZERO_SELECTED_PROVIDER", "ZERO_FORCE_PROVIDER"]) vi.stubEnv(key, undefined);
  vi.stubEnv("ZERO_LLM_FALLBACK", ""); vi.stubEnv("ZERO_SUPPRESS_PROVIDER_STARTUP_LOG", "1");
  reloadSettings();
  let count = 0;
  server = createServer((_request, response) => {
    count += 1;
    if (mode === "hang") return;
    if (mode === 200) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "model-a" }] })); return; }
    response.writeHead(mode); response.end("no");
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-health-key");
  vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
  return { service: new WebOperatorServices(), hits: () => count };
}

const list = async (service: WebOperatorServices, wait = true) => {
  const result = await service.handle("/api/console/providers", "GET", undefined, new URLSearchParams(wait ? "wait=1" : ""));
  const providers = (result!.data as { providers: Array<{ id: string; health: { state: string; checking: boolean; hint: string | null }; source: string | null; environmentVariable: string | null }> }).providers;
  return providers.find(provider => provider.id === "openai")!;
};

it("is unknown and checking first, never blocking the response", async () => {
  const { service } = await setup(200);
  const first = await list(service, false);
  expect(first.health).toMatchObject({ state: "unknown", checking: true });
});

it("classifies a working key as ok and caches the verdict", async () => {
  const { service, hits } = await setup(200);
  expect((await list(service)).health.state).toBe("ok");
  const probes = hits();
  expect(probes).toBeGreaterThan(0);
  for (let n = 0; n < 3; n++) expect((await list(service)).health.state).toBe("ok");
  expect(hits()).toBe(probes);
});

it("classifies a 401 as rejected and says where to fix an environment key", async () => {
  const { service } = await setup(401);
  const row = await list(service);
  expect(row.health).toMatchObject({ state: "rejected", hint: "Set OPENAI_API_KEY in your environment" });
  expect(row).toMatchObject({ source: "environment", environmentVariable: "OPENAI_API_KEY" });
  expect(JSON.stringify(row)).not.toContain("synthetic-health-key");
});

it("classifies a provider that never answers as unreachable within the 3 s budget", async () => {
  const { service } = await setup("hang");
  const started = Date.now();
  expect((await list(service)).health.state).toBe("unreachable");
  expect(Date.now() - started).toBeLessThan(6_000);
}, 15_000);

it("does not offer a fallback model for a rejected provider", async () => {
  const { service } = await setup(401);
  await list(service);
  const result = await service.handle("/api/console/models", "GET", undefined, new URLSearchParams("fresh=1"));
  const data = result!.data as { models: Array<{ provider: string }>; recommended: Array<{ providerId: string }> };
  expect(data.models.filter(model => model.provider === "openai")).toEqual([]);
  expect(data.recommended.filter(pick => pick.providerId === "openai")).toEqual([]);
});
