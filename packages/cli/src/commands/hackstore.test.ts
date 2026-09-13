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
  it("accepts a good manifest (file path) and reports id/version/tool count", () => {
    const file = writeManifest(join(tmp, "good"), goodManifest());
    runValidate(file, { core });
    expect(process.exitCode).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("OK: acme.example@1.0.0, 1 tool");
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
  it("scaffolds the expected files", () => {
    runInit("my-ext", { dir: tmp });
    expect(process.exitCode).toBe(0);
    const dir = join(tmp, "my-ext");
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, "example_tool.mjs"))).toBe(true);
  });

  it("the scaffolded manifest itself passes validatePluginManifest", () => {
    runInit("My Cool Ext!", { dir: tmp });
    const raw = JSON.parse(readFileSync(join(tmp, "My Cool Ext!", "manifest.json"), "utf8"));
    expect(raw.$schema).toBe(HACKSTORE_SCHEMA_ID);
    const res = core.validatePluginManifest(raw);
    expect(res.ok).toBe(true);
  });

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

  it("is valid JSON", () => {
    const text = readFileSync(schemaPath, "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
  });

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
