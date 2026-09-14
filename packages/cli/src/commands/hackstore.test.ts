/**
 * Command-layer tests for `0sec hackstore`.
 *
 * The `validate` subcommand drives the REAL `validatePluginManifest` through its
 * injected {@link HackstoreCorePort}. The validator is imported directly from
 * core source via a runtime URL import (the same technique commands/__tests__/
 * uses) so the test exercises the true contract without a barrel round-trip.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runInit,
  runValidate,
  slugifyId,
  HACKSTORE_SCHEMA_ID,
  type HackstoreCorePort,
} from "./hackstore.js";

// ── Real validator from core source (no barrel dependency) ────────────────────

async function realCorePort(): Promise<HackstoreCorePort> {
  const mod = await import(
    /* @vite-ignore */ new URL("../../../core/src/plugins/manifest.ts", import.meta.url).href
  );
  return { validatePluginManifest: mod.validatePluginManifest };
}

const PLUGIN_CAPABILITIES = [
  "compute",
  "model-call",
  "network",
  "filesystem-read",
  "filesystem-write",
  "process-exec",
  "findings-write",
] as const;

// ── Fixtures ──────────────────────────────────────────────────────────────────

function goodManifest(): Record<string, unknown> {
  return {
    id: "acme.example",
    name: "Example",
    version: "1.0.0",
    tools: [
      {
        name: "do_thing",
        description: "Does a thing.",
        parameters: { input: { type: "string" } },
        required: ["input"],
        capabilities: ["compute"],
      },
    ],
  };
}

let core: HackstoreCorePort;
let tmp: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  core = await realCorePort();
  tmp = mkdtempSync(join(tmpdir(), "hackstore-test-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = 0;
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
  process.exitCode = 0;
});

function writeManifest(dir: string, obj: unknown): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify(obj), "utf8");
  return file;
}

// ── validate ────────────────────────────────────────────────────────────────

describe("hackstore validate", () => {
  it("accepts a good manifest (file path) and exits zero", () => {
    const file = writeManifest(join(tmp, "good"), goodManifest());
    runValidate(file, { core });
    expect(process.exitCode).toBe(0);
  });

  it("accepts a directory containing manifest.json", () => {
    const dir = join(tmp, "gooddir");
    writeManifest(dir, goodManifest());
    runValidate(dir, { core });
    expect(process.exitCode).toBe(0);
  });

  it("emits machine JSON with --json on success", () => {
    const dir = join(tmp, "goodjson");
    writeManifest(dir, goodManifest());
    runValidate(dir, { core, json: true });
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, id: "acme.example", version: "1.0.0", tools: 1 });
    expect(parsed.capabilities).toEqual(["compute"]);
  });

  it("rejects a bad capability", () => {
    const m = goodManifest();
    (m.tools as any[])[0].capabilities = ["compute", "root"];
    const file = writeManifest(join(tmp, "badcap"), m);
    runValidate(file, { core });
    expect(process.exitCode).not.toBe(0);
    const out = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toMatch(/unknown capabilit/i);
  });

  it("rejects empty capabilities", () => {
    const m = goodManifest();
    (m.tools as any[])[0].capabilities = [];
    const file = writeManifest(join(tmp, "emptycap"), m);
    runValidate(file, { core });
    expect(process.exitCode).not.toBe(0);
  });

  it("rejects a bad tool name", () => {
    const m = goodManifest();
    (m.tools as any[])[0].name = "1bad-Name";
    const file = writeManifest(join(tmp, "badname"), m);
    runValidate(file, { core });
    expect(process.exitCode).not.toBe(0);
  });

  it("rejects a missing required field (version)", () => {
    const m = goodManifest();
    delete m.version;
    const file = writeManifest(join(tmp, "noversion"), m);
    runValidate(file, { core });
    expect(process.exitCode).not.toBe(0);
    const out = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toMatch(/version/i);
  });

  it("errors (non-zero) on invalid JSON", () => {
    const dir = join(tmp, "badjson");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{ not json", "utf8");
    runValidate(dir, { core });
    expect(process.exitCode).not.toBe(0);
  });

  it("errors (non-zero) on a missing path", () => {
    runValidate(join(tmp, "nope"), { core });
    expect(process.exitCode).not.toBe(0);
  });

  it("--json reports errors on failure", () => {
    const m = goodManifest();
    (m.tools as any[])[0].capabilities = [];
    const file = writeManifest(join(tmp, "badjsonout"), m);
    runValidate(file, { core, json: true });
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

// ── init ──────────────────────────────────────────────────────────────────────

describe("hackstore init", () => {

  it("refuses to write into a non-empty dir without --force", () => {
    const dir = join(tmp, "occupied");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "x", "utf8");
    runInit("occupied", { dir: tmp });
    expect(process.exitCode).not.toBe(0);
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
  });

  it("writes into a non-empty dir with --force", () => {
    const dir = join(tmp, "occupied2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "x", "utf8");
    runInit("occupied2", { dir: tmp, force: true });
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  });

  it("slugifyId always yields a valid plugin id", () => {
    for (const name of ["My Cool Ext!", "123", "  ", "Acme.SQLi-Pack", "___"]) {
      const id = slugifyId(name);
      expect(id).toMatch(/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/);
    }
  });
});

// ── schema file ────────────────────────────────────────────────────────────

describe("hackstore-manifest.schema.json", () => {
  const schemaPath = new URL(
    "../../../core/src/plugins/hackstore-manifest.schema.json",
    import.meta.url,
  );


  it("$id matches the code constant and enum matches PLUGIN_CAPABILITIES", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema.$id).toBe(HACKSTORE_SCHEMA_ID);
    expect(schema.definitions.capability.enum).toEqual([...PLUGIN_CAPABILITIES]);
    // The tool-name pattern is the one the validator enforces (TOOL_NAME_RE):
    // lowercase [a-z0-9_], not starting with a digit OR underscore.
    expect(schema.definitions.tool.properties.name.pattern).toBe("^[a-z][a-z0-9_]*$");
    expect(schema.properties.tools.minItems).toBe(1);
    expect(schema.definitions.tool.properties.capabilities.minItems).toBe(1);
  });
});

describe("generated plugin through the real host", () => {
  async function installGeneratedPlugin(version = "0.1.0") {
    // A runtime URL keeps the real source loader outside this package's src
    // rootDir, matching realCorePort above without pulling in the core barrel.
    const { PluginHost } = await import(
      /* @vite-ignore */ new URL("../../../core/src/plugins/loader.ts", import.meta.url).href
    );
    const sourceRoot = join(tmp, "source");
    runInit("hash-tool", { dir: sourceRoot });
    const source = join(sourceRoot, "hash-tool");
    const pluginsDir = join(tmp, "plugins");
    const installed = join(pluginsDir, "hash-tool");
    mkdirSync(installed, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
    manifest.version = version;
    const validated = core.validatePluginManifest(manifest);
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
    writeFileSync(join(installed, "plugin.json"), JSON.stringify(validated.manifest));
    writeFileSync(join(installed, "plugin.js"), readFileSync(join(source, "plugin.js")));
    return new PluginHost({
      pluginsDir,
      enabled: ["hash-tool"],
      reservedToolNames: [],
      coreVersion: "0.16.3",
    });
  }

  it("loads and hashes after an author changes the manifest version", async () => {
    const host = await installGeneratedPlugin("0.2.0");
    try {
      expect((await host.load("hash-tool")).ok).toBe(true);
      const result = await host.call("sha256", { input: "hello" });
      expect(result.ok).toBe(true);
      expect(result.failed).toBe(false);
      expect(result.content).toContain("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    } finally {
      host.shutdown();
    }
  });

  it("rejects invalid arguments without turning them into an empty-string hash", async () => {
    const host = await installGeneratedPlugin();
    try {
      expect((await host.load("hash-tool")).ok).toBe(true);
      const invalid = await host.call("sha256", { input: 42 });
      expect(invalid.ok).toBe(true);
      expect(invalid.failed).toBe(true);
      const valid = await host.call("sha256", { input: "" });
      expect(valid.ok).toBe(true);
      expect(valid.failed).toBe(false);
      expect(valid.content).toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    } finally {
      host.shutdown();
    }
  });
});
