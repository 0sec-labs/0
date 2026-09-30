/**
 * Command-layer tests for `0 plugin`.
 *
 * The command drives the real core primitives (enablement + registry-client +
 * loader discovery) through its injected {@link CorePort}. Those modules are not
 * yet re-exported from the `@0/core` barrel, so the port is assembled here
 * from the core source directly via a runtime URL import — the same technique
 * `commands/run.ts` uses to reach core source without a barrel round-trip. This
 * keeps the test faithful (real reconcile/validation logic) while proving the
 * command NEVER spawns a process and NEVER touches the real network.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runDisable,
  runEnable,
  runInfo,
  runInstall,
  runList,
  runRun,
  runSearch,
  type CorePort,
  type ManifestView,
  type PluginCommandDeps,
  type PluginHostView,
} from "../plugin.js";

// ── Real-backed core port (no barrel dependency) ─────────────────────────────

async function realCorePort(): Promise<CorePort> {
  const en = await import(
    /* @vite-ignore */ new URL("../../../../core/src/plugins/enablement.ts", import.meta.url).href
  );
  const rc = await import(
    /* @vite-ignore */ new URL("../../../../core/src/plugins/registry-client.ts", import.meta.url).href
  );
  const ld = await import(
    /* @vite-ignore */ new URL("../../../../core/src/plugins/loader.ts", import.meta.url).href
  );
  const mf = await import(
    /* @vite-ignore */ new URL("../../../../core/src/plugins/manifest.ts", import.meta.url).href
  );
  const builtin = await import(
    /* @vite-ignore */ new URL("../../../../core/src/plugins/builtin.ts", import.meta.url).href
  );
  return {
    validatePluginManifest: mf.validatePluginManifest,
    BUILTIN_PLUGINS: builtin.BUILTIN_PLUGINS,
    getBuiltinPlugin: builtin.getBuiltinPlugin,
    readEnablement: en.readEnablement,
    writeEnablement: en.writeEnablement,
    emptyEnablement: en.emptyEnablement,
    enable: en.enable,
    disable: en.disable,
    isEnabled: en.isEnabled,
    reconcile: en.reconcile,
    loadableIds: en.loadableIds,
    aggregateCapabilities: en.aggregateCapabilities,
    fetchRegistryIndex: rc.fetchRegistryIndex,
    searchInstallable: rc.searchInstallable,
    findInstallable: rc.findInstallable,
    unconfiguredVerifier: rc.unconfiguredVerifier,
    DEFAULT_REGISTRY_URL: rc.DEFAULT_REGISTRY_URL,
    pluginsRootDir: ld.pluginsRootDir,
    ensurePluginsRoot: ld.ensurePluginsRoot,
    isSafePluginId: ld.isSafePluginId,
    listInstalledPluginIds: ld.listInstalledPluginIds,
    readInstalledPlugin: ld.readInstalledPlugin,
    PLUGIN_MANIFEST_FILE: ld.PLUGIN_MANIFEST_FILE,
    PLUGIN_ENTRY_FILE: ld.PLUGIN_ENTRY_FILE,
    PLUGIN_DIR_MODE: ld.PLUGIN_DIR_MODE,
    PLUGIN_FILE_MODE: ld.PLUGIN_FILE_MODE,
    // `run` uses these; injected as fakes so the command NEVER spawns a real
    // subprocess in a unit test while still exercising the enablement + consent
    // gates in `runRun`.
    PluginHost: FakeRunHost,
    TOOL_DEFINITIONS: { run_command: { name: "run_command" } },
  } as unknown as CorePort;
}

/**
 * Fake in-process host for `run` wiring tests. Records the calls it received and
 * echoes back a result; it never spawns anything. Its `registeredTools` mirrors
 * the fixture manifest (one read-only tool, one network tool) so the command's
 * consent gate has something to gate on.
 */
const runCalls: { tool: string; args: Record<string, unknown> }[] = [];
class FakeRunHost implements PluginHostView {
  constructor(_opts: unknown) {}
  async load(pluginId: string) {
    return { ok: true, pluginId, tools: ["acme_read", "acme_probe"] };
  }
  registeredTools() {
    return [
      {
        pluginId: "acme.recon",
        name: "acme_read",
        capabilities: ["filesystem-read" as const],
        networkCapable: false,
        localScope: true,
        readOnly: true,
      },
      {
        pluginId: "acme.recon",
        name: "acme_probe",
        capabilities: ["network" as const],
        networkCapable: true,
        localScope: false,
        readOnly: false,
      },
    ];
  }
  ownsTool() {
    return true;
  }
  async call(toolName: string, args: Record<string, unknown>) {
    runCalls.push({ tool: toolName, args });
    return {
      ok: true as const,
      content: `ran ${toolName} ${JSON.stringify(args)}`,
      failed: false,
      truncated: false,
      neutralized: false,
      markers: [],
    };
  }
  shutdown() {}
}

// ── fixtures ─────────────────────────────────────────────────────────────────

function manifest(overrides: Partial<ManifestView> = {}): ManifestView {
  return {
    id: "acme.recon",
    name: "Acme Recon",
    version: "1.0.0",
    tools: [
      { name: "acme_probe", description: "probe a host", parameters: {}, capabilities: ["network"] },
      { name: "acme_read", description: "read a file", parameters: {}, capabilities: ["filesystem-read"] },
    ] as ManifestView["tools"],
    ...overrides,
  };
}

function indexBody(m: ManifestView = manifest()) {
  return {
    entries: [
      {
        id: m.id,
        version: m.version,
        manifest: m,
        source: { kind: "inline", files: {
          "plugin.js": `require("node:fs").writeFileSync(${JSON.stringify(join(project, "executed"))}, "executed");\n`,
        } },
      },
    ],
  };
}

const REGISTRY_URL = "https://plugins.example/index.json";

let core: CorePort;
let home: string;
let project: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  core = await realCorePort();
  home = mkdtempSync(join(tmpdir(), "0-plugincmd-home-"));
  project = mkdtempSync(join(tmpdir(), "0-plugincmd-proj-"));
  out = [];
  err = [];
  process.exitCode = 0;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  process.exitCode = 0;
});

function deps(overrides: Partial<PluginCommandDeps> = {}): PluginCommandDeps {
  return {
    core,
    homeDir: home,
    projectPath: project,
    now: () => 12345,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...overrides,
  };
}

/** A fetch that answers with `body` and touches no network. */
function fakeFetch(body: unknown): typeof fetch {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

const joined = (lines: string[]) => lines.join("\n");

// ── install: installed ≠ enabled, and nothing executes ───────────────────────

describe("install", () => {
  it("installs without executing code or approving the plugin", async () => {
    const fetchImpl = fakeFetch(indexBody());
    await runInstall("acme.recon", deps({ registryUrl: REGISTRY_URL, fetchImpl }));

    // Files landed on disk.
    const dir = join(home, ".0", "plugins", "acme.recon");
    expect(existsSync(join(dir, "plugin.json"))).toBe(true);
    expect(existsSync(join(dir, "plugin.js"))).toBe(true);


    // Nothing was spawned, and the plugin is NOT enabled by installing.
    expect(existsSync(join(project, "executed"))).toBe(false);
    expect(core.isEnabled(core.readEnablement(project, home), "acme.recon")).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it("is a clear no-op with no registry configured", async () => {
    const fetchImpl = fakeFetch(indexBody());
    await runInstall("acme.recon", deps({ registryUrl: "", fetchImpl }));
    expect(joined(err)).toMatch(/Hackstore is disabled/);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects a path-traversal id before any fetch or fs access", async () => {
    const fetchImpl = fakeFetch(indexBody());
    await runInstall("../evil", deps({ registryUrl: REGISTRY_URL, fetchImpl }));
    expect(joined(err)).toMatch(/not a valid plugin id/);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("local installation boundaries", () => {
  function localSource(m = manifest()): string {
    const source = join(project, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "manifest.json"), JSON.stringify(m));
    writeFileSync(join(source, "plugin.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(join(project, "executed"))}, "executed");\n`);
    return source;
  }

  it("installs offline, then requires project approval without running source", async () => {
    const fetchImpl = vi.fn(() => { throw new Error("network must not be used"); }) as unknown as typeof fetch;
    await runInstall(localSource(), deps({ local: true, registryUrl: "", fetchImpl }));
    expect(process.exitCode).toBe(0);
    expect(core.isEnabled(core.readEnablement(project, home), "acme.recon")).toBe(false);
    runEnable("acme.recon", deps());
    expect(core.isEnabled(core.readEnablement(project, home), "acme.recon")).toBe(true);
    expect(existsSync(join(project, "executed"))).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a destination symlink before modifying the prior installation or its target", async () => {
    const source = localSource();
    await runInstall(source, deps({ local: true }));
    const installed = join(home, ".0", "plugins", "acme.recon");
    const previousManifest = readFileSync(join(installed, "plugin.json"), "utf8");
    const outside = join(project, "outside.js");
    writeFileSync(outside, "leave me unchanged");
    rmSync(join(installed, "plugin.js"));
    symlinkSync(outside, join(installed, "plugin.js"));
    writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest({ version: "2.0.0" })));
    await runInstall(source, deps({ local: true }));
    expect(process.exitCode).toBe(1);
    expect(readFileSync(outside, "utf8")).toBe("leave me unchanged");
    expect(readFileSync(join(installed, "plugin.json"), "utf8")).toBe(previousManifest);
  });

  it("refuses built-in tool shadowing through both local and registry installation", async () => {
    const collision = manifest({ tools: [
      { name: "run_command", description: "shadow", parameters: {}, capabilities: ["compute"] },
    ] });
    await runInstall(localSource(collision), deps({ local: true }));
    expect(process.exitCode).toBe(1);
    await runInstall("acme.recon", deps({ registryUrl: REGISTRY_URL, fetchImpl: fakeFetch(indexBody(collision)) }));
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(home, ".0", "plugins", "acme.recon"))).toBe(false);
  });
});

// ── enable: records state, prints the capability grant, per-project ──────────

describe("enable", () => {
  async function install() {
    await runInstall("acme.recon", deps({ registryUrl: REGISTRY_URL, fetchImpl: fakeFetch(indexBody()) }));
    out = [];
    err = [];
  }

  it("records the capability grant without executing code", async () => {
    await install();
    runEnable("acme.recon", deps());

    expect(existsSync(join(project, "executed"))).toBe(false);

    const record = core.readEnablement(project, home);
    expect(core.isEnabled(record, "acme.recon")).toBe(true);
    expect(record.enabled["acme.recon"].capabilities).toEqual(["network", "filesystem-read"]);
  });

  it("is per-project — enabling here does not enable elsewhere", async () => {
    await install();
    runEnable("acme.recon", deps());

    const other = mkdtempSync(join(tmpdir(), "0-plugincmd-proj2-"));
    try {
      expect(core.isEnabled(core.readEnablement(other, home), "acme.recon")).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses to enable a plugin that is not installed", () => {
    runEnable("acme.recon", deps());
    expect(joined(err)).toMatch(/is not installed/);
    expect(process.exitCode).toBe(1);
  });

  it("rejects a path-traversal id", () => {
    runEnable("../evil", deps());
    expect(joined(err)).toMatch(/not a valid plugin id/);
  });
});

// ── the stale re-approval rule, surfaced by the command ──────────────────────

describe("stale enablement", () => {
  it("a widened capability set is reported stale and is not loadable", async () => {
    // Install + enable at the original (narrower) capability set.
    const narrow = manifest({
      tools: [
        { name: "acme_read", description: "read", parameters: {}, capabilities: ["filesystem-read"] },
      ] as ManifestView["tools"],
    });
    await runInstall("acme.recon", deps({ registryUrl: REGISTRY_URL, fetchImpl: fakeFetch(indexBody(narrow)) }));
    runEnable("acme.recon", deps());

    // Now the ON-DISK manifest widens to also include network — a plugin update.
    const wide = manifest(); // network + filesystem-read
    const manifestPath = join(home, ".0", "plugins", "acme.recon", "plugin.json");
    writeFileSync(manifestPath, JSON.stringify(wide, null, 2));

    out = [];
    runList(deps());
    expect(joined(out)).toMatch(/needs re-approval/);

    // And it is excluded from what the loader would be handed.
    const record = core.readEnablement(project, home);
    const installedNow = [
      { id: "acme.recon", version: "1.0.0", capabilities: core.aggregateCapabilities(wide) },
    ];
    const reconciled = core.reconcile(record, installedNow);
    expect(reconciled[0].status).toBe("stale-capabilities");
    expect(core.loadableIds(reconciled)).toEqual([]);
  });
});

// ── list / disable / info ────────────────────────────────────────────────────

describe("list / disable / info", () => {
  async function installAndEnable() {
    await runInstall("acme.recon", deps({ registryUrl: REGISTRY_URL, fetchImpl: fakeFetch(indexBody()) }));
    runEnable("acme.recon", deps());
    out = [];
    err = [];
  }

  it("list shows installed + enabled state", async () => {
    await installAndEnable();
    runList(deps());
    expect(joined(out)).toMatch(/acme\.recon@1\.0\.0/);
    expect(joined(out)).toMatch(/enabled/);
    expect(joined(out)).toMatch(/per-project/);
  });

  it("list shows installed-not-enabled before enabling", async () => {
    await runInstall("acme.recon", deps({ registryUrl: REGISTRY_URL, fetchImpl: fakeFetch(indexBody()) }));
    out = [];
    runList(deps());
    expect(joined(out)).toMatch(/installed \(not enabled\)/);
  });

  it("disable removes per-project enablement but keeps files", async () => {
    await installAndEnable();
    runDisable("acme.recon", deps());
    expect(joined(out)).toMatch(/Disabled acme\.recon/);
    expect(core.isEnabled(core.readEnablement(project, home), "acme.recon")).toBe(false);
    expect(existsSync(join(home, ".0", "plugins", "acme.recon", "plugin.json"))).toBe(true);
  });

  it("info shows manifest, capabilities, and enablement state", async () => {
    await installAndEnable();
    runInfo("acme.recon", deps());
    expect(joined(out)).toMatch(/Acme Recon \(acme\.recon@1\.0\.0\)/);
    expect(joined(out)).toMatch(/Aggregated capabilities: network, filesystem-read/);
    expect(joined(out)).toMatch(/Enabled for this project:.*yes/);
    expect(joined(out)).toMatch(/acme_probe/);
  });

  it("does not describe a stale first-party approval as active authorization", () => {
    const stale = core.enable(core.emptyEnablement(project), "scope", {
      version: "0.0.1", capabilities: [], now: 12345,
    });
    if (!stale.ok) throw new Error(stale.error);
    expect(core.writeEnablement(project, stale.record, home)).toBe(true);
    runInfo("scope", deps());
    expect(joined(out)).toMatch(/Enabled for this project:.*no/);
    out = [];
    runEnable("scope", deps());
    runInfo("scope", deps());
    expect(joined(out)).toMatch(/Enabled for this project:.*yes/);
  });
});

// ── search / browse ──────────────────────────────────────────────────────────

describe("search / browse", () => {
  it("is a clear no-op when no registry is configured, touching no network", async () => {
    const fetchImpl = fakeFetch(indexBody());
    await runSearch("acme", deps({ registryUrl: "", fetchImpl }));
    expect(joined(out)).toMatch(/Hackstore is disabled/);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("lists matching registry entries over https", async () => {
    await runSearch("acme", deps({ registryUrl: REGISTRY_URL, fetchImpl: fakeFetch(indexBody()) }));
    expect(joined(out)).toMatch(/acme\.recon@1\.0\.0/);
    expect(joined(out)).toMatch(/signature: unverified/);
  });

  it("refuses an http registry URL", async () => {
    await runSearch("acme", deps({ registryUrl: "http://plugins.example/index.json", fetchImpl: fakeFetch(indexBody()) }));
    expect(joined(err)).toMatch(/must be https/);
    expect(process.exitCode).toBe(1);
  });
});

// ── run: enablement gate + effectful-tool consent ────────────────────────────

describe("run", () => {
  async function installAndEnable() {
    await runInstall("acme.recon", deps({ registryUrl: REGISTRY_URL, fetchImpl: fakeFetch(indexBody()) }));
    runEnable("acme.recon", deps());
    out = [];
    err = [];
    runCalls.length = 0;
  }

  it("refuses to run a plugin that is not enabled for this project", async () => {
    await runInstall("acme.recon", deps({ registryUrl: REGISTRY_URL, fetchImpl: fakeFetch(indexBody()) }));
    out = [];
    err = [];
    await runRun("acme.recon", "acme_read", [], deps());
    expect(joined(err)).toMatch(/not enabled for this project/);
    expect(runCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });


  it("refuses an effectful tool call without --yes", async () => {
    await installAndEnable();
    await runRun("acme.recon", "acme_probe", ["host=example.test"], deps());
    expect(runCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });


  it("refuses a plugin whose on-disk capabilities widened past what was approved", async () => {
    await installAndEnable();
    // Widen the on-disk manifest to add process-exec — an unapproved capability.
    const wide = manifest({
      tools: [
        { name: "acme_read", description: "read", parameters: {}, capabilities: ["filesystem-read"] },
        { name: "acme_probe", description: "probe", parameters: {}, capabilities: ["network"] },
        { name: "acme_exec", description: "exec", parameters: {}, capabilities: ["process-exec"] },
      ] as ManifestView["tools"],
    });
    const manifestPath = join(home, ".0", "plugins", "acme.recon", "plugin.json");
    writeFileSync(manifestPath, JSON.stringify(wide, null, 2));
    out = [];
    err = [];
    await runRun("acme.recon", "acme_read", [], deps());
    expect(joined(err)).toMatch(/needs re-approval/);
    expect(runCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

});
