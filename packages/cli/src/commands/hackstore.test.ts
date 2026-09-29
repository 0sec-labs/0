/**
 * Command-layer tests for `0 hackstore`.
 *
 * The `validate` subcommand drives the REAL `validatePluginManifest` through its
 * injected {@link HackstoreCorePort}. The validator is imported directly from
 * core source via a runtime URL import (the same technique commands/__tests__/
 * uses) so the test exercises the true contract without a barrel round-trip.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  runInit,
  runValidate,
  readLocalExtension,
  runPrepareSubmission,
  slugifyId,
  HACKSTORE_SCHEMA_ID,
  type HackstoreCorePort,
} from "./hackstore.js";
import { runEnable, runInstall, runRun } from "./plugin.js";
import type { CorePort, PluginCommandDeps } from "./plugin.js";

// ── Real validator from core source (no barrel dependency) ────────────────────

async function realCorePort(): Promise<HackstoreCorePort> {
  const mod = await import(
    /* @vite-ignore */ new URL("../../../core/src/plugins/manifest.ts", import.meta.url).href
  );
  return {
    validatePluginManifest: mod.validatePluginManifest,
    reservedToolNames: ["run_command"],
    reservedPluginIds: ["scope"],
  };
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
let logSpy: MockInstance<typeof console.log>;
let errSpy: MockInstance<typeof console.error>;

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

  it("does not follow a scaffold-file symlink even with --force", () => {
    runInit("hash-tool", { dir: tmp });
    const target = join(tmp, "hash-tool");
    const outside = join(tmp, "outside.txt");
    writeFileSync(outside, "preserve");
    rmSync(join(target, "README.md"));
    symlinkSync(outside, join(target, "README.md"));
    const manifest = readFileSync(join(target, "manifest.json"), "utf8");
    runInit("hash-tool", { dir: tmp, force: true });
    expect(process.exitCode).toBe(1);
    expect(readFileSync(outside, "utf8")).toBe("preserve");
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toBe(manifest);
  });

  it("rejects directory traversal without writing scaffold files", () => {
    const project = join(tmp, "project");
    mkdirSync(project);
    runInit("../escape", { dir: project });
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(tmp, "escape"))).toBe(false);
  });

  it("slugifyId always yields a valid plugin id", () => {
    for (const name of ["My Cool Ext!", "123", "  ", "Acme.SQLi-Pack", "___"]) {
      const id = slugifyId(name);
      expect(id).toMatch(/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/);
    }
  });
});

describe("submission boundaries", () => {
  it("creates reproducible registry source without copying unrelated files or overwriting an artifact", () => {
    runInit("hash-tool", { dir: tmp });
    const source = join(tmp, "hash-tool");
    writeFileSync(join(source, "private.env"), "do not package");
    const first = join(tmp, "submission-a");
    const second = join(tmp, "submission-b");
    runPrepareSubmission(source, { core, out: first });
    expect(process.exitCode).toBe(0);
    runPrepareSubmission(source, { core, out: second });
    expect(process.exitCode).toBe(0);
    const files = ["manifest.json", "plugin.js", "README.md"];
    for (const name of files) {
      expect(readFileSync(join(first, "extensions", "hash-tool", name), "utf8"))
        .toBe(readFileSync(join(second, "extensions", "hash-tool", name), "utf8"));
    }
    expect(readLocalExtension(join(first, "extensions", "hash-tool"), core).ok).toBe(true);
    expect(existsSync(join(first, "extensions", "hash-tool", "private.env"))).toBe(false);
    const original = readFileSync(join(first, "extensions", "hash-tool", "plugin.js"), "utf8");
    writeFileSync(join(source, "plugin.js"), "different source");
    runPrepareSubmission(source, { core, out: first });
    expect(process.exitCode).toBe(1);
    expect(readFileSync(join(first, "extensions", "hash-tool", "plugin.js"), "utf8")).toBe(original);
  });

  it("refuses a source symlink and creates no submission directory", () => {
    runInit("hash-tool", { dir: tmp });
    const source = join(tmp, "hash-tool");
    const outside = join(tmp, "outside.js");
    writeFileSync(outside, "private source");
    rmSync(join(source, "plugin.js"));
    symlinkSync(outside, join(source, "plugin.js"));
    const output = join(tmp, "submission");
    runPrepareSubmission(source, { core, out: output });
    expect(process.exitCode).toBe(1);
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("private source");
  });

  it("refuses reserved host identities in scaffolding, validation, and submission", () => {
    runInit("scope", { dir: tmp, reservedPluginIds: core.reservedPluginIds });
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(tmp, "scope"))).toBe(false);
    const source = join(tmp, "reserved");
    writeManifest(source, { ...goodManifest(), id: "scope" });
    writeFileSync(join(source, "plugin.js"), "self-contained source");
    writeFileSync(join(source, "README.md"), "Usage");
    runValidate(source, { core });
    expect(process.exitCode).toBe(1);
    const output = join(tmp, "submission");
    runPrepareSubmission(source, { core, out: output });
    expect(process.exitCode).toBe(1);
    expect(existsSync(output)).toBe(false);
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

describe("generated plugin through the real CLI workflow", () => {
  async function installGeneratedPlugin(version = "0.1.0"): Promise<PluginCommandDeps> {
    // Runtime URLs keep source modules outside this package's rootDir without booting the core barrel.
    const en = await import(
      /* @vite-ignore */ new URL("../../../core/src/plugins/enablement.ts", import.meta.url).href
    );
    const ld = await import(
      /* @vite-ignore */ new URL("../../../core/src/plugins/loader.ts", import.meta.url).href
    );
    const rc = await import(
      /* @vite-ignore */ new URL("../../../core/src/plugins/registry-client.ts", import.meta.url).href
    );
    const builtin = await import(
      /* @vite-ignore */ new URL("../../../core/src/plugins/builtin.ts", import.meta.url).href
    );
    const pluginCore: CorePort = {
      ...en, ...ld, ...rc, ...builtin,
      validatePluginManifest: core.validatePluginManifest,
      TOOL_DEFINITIONS: {},
    };
    const sourceRoot = join(tmp, "source");
    runInit("hash-tool", { dir: sourceRoot });
    const source = join(sourceRoot, "hash-tool");
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
    manifest.version = version;
    writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest));
    const deps: PluginCommandDeps = {
      core: pluginCore, homeDir: tmp, projectPath: join(tmp, "project"),
      coreVersion: "0.21.4", local: true,
    };
    await runInstall(source, deps);
    expect(process.exitCode).toBe(0);
    return deps;
  }

  it("requires approval, then runs real source after a version edit with pair-over-JSON precedence", async () => {
    const deps = await installGeneratedPlugin("0.2.0");
    await runRun("hash-tool", "sha256", ["input=hello"], deps);
    expect(process.exitCode).toBe(1);
    runEnable("hash-tool", deps);
    expect(process.exitCode).toBe(0);
    logSpy.mockClear();
    await runRun("hash-tool", "sha256", ["input=hello"], { ...deps, jsonArgs: '{"input":"wrong"}' });
    expect(process.exitCode).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n"))
      .toContain("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("reports invalid arguments as failure instead of a successful empty-input hash", async () => {
    const deps = await installGeneratedPlugin();
    runEnable("hash-tool", deps);
    logSpy.mockClear();
    await runRun("hash-tool", "sha256", [], { ...deps, jsonArgs: '{"input":42}' });
    expect(process.exitCode).toBe(1);
    const failureOutput = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(failureOutput).toContain("input must be a string");
    expect(failureOutput).not.toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    logSpy.mockClear();
    await runRun("hash-tool", "sha256", ["input="], deps);
    expect(process.exitCode).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n"))
      .toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
