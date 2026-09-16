import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { analyticsPipeline } from "../telemetry/analytics-pipeline.js";
import { ExecutablePluginManager } from "./executable.js";
import { BUILTIN_GUARDS } from "./guards.js";
import { SelfExtensionRegistry } from "./self-extension.js";

let root: string;
let manager: ExecutablePluginManager;
let records: Record<string, unknown>[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "0sec-submitted-code-"));
  records = [];
  analyticsPipeline.__resetForTests();
  for (const name of ["0SEC_OFFLINE", "0SEC_NO_TELEMETRY", "DO_NOT_TRACK"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("0SEC_ANALYTICS_LEVEL", "commands");
  vi.stubEnv("0SEC_CLOUD_HOST", "https://analytics.test");
  vi.stubEnv("0SEC_CLOUD_TOKEN", "test-token");
  analyticsPipeline.configure({
    homeDir: root,
    fetchImpl: (async (_url, init) => {
      const batch = JSON.parse(String(init?.body)).records as Record<string, unknown>[];
      records.push(...batch);
      return new Response(JSON.stringify({ ok: true, accepted: batch.length }), { status: 202 });
    }) as typeof fetch,
  });
  analyticsPipeline.setLevel("commands");
  manager = new ExecutablePluginManager({
    registry: new SelfExtensionRegistry({ enabled: true, baseGuards: BUILTIN_GUARDS }),
    root: join(root, "plugins"),
    backend: "smolvm",
    image: "unused",
    // Submission capture must not depend on a sandbox being available.
    imageArchive: join(root, "missing-image.tar"),
  });
});

afterEach(async () => {
  await manager.close();
  analyticsPipeline.__resetForTests();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it("captures redacted helper modules as well as the submitted entry source", async () => {
  const secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const entry = 'export { probe } from "./helper.mts";';
  await manager.submit({
    manifest: {
      id: "acme.probe-pack",
      name: "Probe Pack",
      version: "1.0.0",
      tools: [{
        name: "acme_probe",
        description: "Probe a thing.",
        parameters: {},
        required: [],
        capabilities: ["compute"],
      }],
    },
    entry: "main.ts",
    files: {
      "main.ts": entry,
      "helper.mts": `export const probe = "helper-module";\nexport const token = "${secret}";`,
    },
  });
  await analyticsPipeline.flushNow();

  const code = records.filter((record) => record.origin === "executable-plugin");
  expect(code).toHaveLength(2);
  expect(code).toEqual(expect.arrayContaining([
    expect.objectContaining({ lang: "ts", sourceRedacted: entry }),
    expect.objectContaining({ lang: "mts", sourceRedacted: expect.stringContaining("helper-module") }),
  ]));
  expect(JSON.stringify(code)).not.toContain(secret);
});
