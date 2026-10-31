import { describe, expect, it } from "vitest";

import {
  DeferredToolRegistry,
  partitionToolDefinitions,
  IMMEDIATE_TOOL_NAMES,
  DEFERRED_TOOLS_MIN,
  LIST_TOOLS_NAME,
  LOAD_TOOL_NAME,
  listToolsDef,
  loadToolDef,
  formatToolCatalog,
  formatLoadResult,
} from "./deferred-tools.js";
import type { ToolDefinition } from "./types.js";

const def = (name: string, description = `desc for ${name}`): ToolDefinition => ({
  name,
  description,
  parameters: {},
  required: [],
});

describe("DeferredToolRegistry", () => {
  it("seeds a catalog, nothing loaded initially", () => {
    const r = new DeferredToolRegistry();
    r.seed([def("a"), def("b")]);
    expect(r.size()).toBe(2);
    expect(r.isLoaded("a")).toBe(false);
    expect(r.loadedDefinitions()).toEqual([]);
  });

  it("loads known tools, reports unknown, is idempotent", () => {
    const r = new DeferredToolRegistry();
    r.seed([def("a"), def("b")]);
    expect(r.load(["a", "nope"])).toEqual({ loaded: ["a"], unknown: ["nope"] });
    expect(r.isLoaded("a")).toBe(true);
    // idempotent re-load
    expect(r.load(["a"])).toEqual({ loaded: ["a"], unknown: [] });
    expect(r.loadedDefinitions().map((d) => d.name)).toEqual(["a"]);
  });

  it("trims and ignores blank names", () => {
    const r = new DeferredToolRegistry();
    r.seed([def("a")]);
    expect(r.load([" a ", "", "   "])).toEqual({ loaded: ["a"], unknown: [] });
  });

  it("deduplicates batch load names after trimming", () => {
    const r = new DeferredToolRegistry();
    r.seed([def("a"), def("b")]);
    expect(r.load(["a", " a ", "b", "missing", "missing"])).toEqual({
      loaded: ["a", "b"], unknown: ["missing"],
    });
  });

  it("re-seeding prunes vanished tools from catalog and loaded set", () => {
    const r = new DeferredToolRegistry();
    r.seed([def("a"), def("b")]);
    r.load(["a", "b"]);
    r.seed([def("a")]); // b vanished (server dropped)
    expect(r.size()).toBe(1);
    expect(r.isLoaded("b")).toBe(false);
    expect(r.loadedDefinitions().map((d) => d.name)).toEqual(["a"]);
  });

  it("catalogEntries filters by name or description, sorted, marks loaded", () => {
    const r = new DeferredToolRegistry();
    r.seed([def("send_mail", "send an email"), def("nmap_scan", "port scan a host")]);
    r.load(["send_mail"]);
    const all = r.catalogEntries();
    expect(all.map((e) => e.name)).toEqual(["nmap_scan", "send_mail"]);
    expect(all.find((e) => e.name === "send_mail")?.loaded).toBe(true);
    // filter by description keyword
    expect(r.catalogEntries("email").map((e) => e.name)).toEqual(["send_mail"]);
    // filter by name substring
    expect(r.catalogEntries("nmap").map((e) => e.name)).toEqual(["nmap_scan"]);
  });

  it("reports builtin, plugin and MCP origins through loading and catalog refresh", () => {
    const registry = new DeferredToolRegistry();
    const definitions = [def("builtin_probe"), def("plugin_probe"), def("mcp_probe")];
    const origins = new Map<string, "plugin" | "mcp">([["plugin_probe", "plugin"], ["mcp_probe", "mcp"]]);
    registry.seed(definitions, origins);
    registry.load(["plugin_probe", "mcp_probe"]);
    registry.seed(definitions, origins);
    expect(registry.catalogEntries().map(({ name, provenance, loaded }) => ({ name, provenance, loaded }))).toEqual([
      { name: "builtin_probe", provenance: "builtin", loaded: false },
      { name: "mcp_probe", provenance: "mcp", loaded: true },
      { name: "plugin_probe", provenance: "plugin", loaded: true },
    ]);
    registry.seed([definitions[0]]);
    registry.seed(definitions);
    expect(registry.catalogEntries().find(entry => entry.name === "plugin_probe")).toMatchObject({ provenance: "builtin", loaded: false });
  });

  it("recognizes its control tools", () => {
    const r = new DeferredToolRegistry();
    expect(r.isControlTool(LIST_TOOLS_NAME)).toBe(true);
    expect(r.isControlTool(LOAD_TOOL_NAME)).toBe(true);
    expect(r.isControlTool("bash")).toBe(false);
  });
});

describe("control tool definitions", () => {
  it("expose stable names", () => {
    expect(listToolsDef.name).toBe(LIST_TOOLS_NAME);
    expect(loadToolDef.name).toBe(LOAD_TOOL_NAME);
    expect(loadToolDef.required).toContain("names");
  });
});

describe("formatToolCatalog", () => {
  it("reports emptiness distinctly with/without a query", () => {
    expect(formatToolCatalog([])).toMatch(/No additional loadable tools/);
    expect(formatToolCatalog([], "xyz")).toMatch(/No loadable tools match "xyz"/);
  });

  it("lists entries and flags loaded ones", () => {
    const out = formatToolCatalog([
      { name: "a", description: "alpha", loaded: false },
      { name: "b", description: "beta", loaded: true },
    ]);
    expect(out).toContain("- a — alpha");
    expect(out).toContain("- b [loaded] — beta");
  });

  it("truncates long descriptions", () => {
    const out = formatToolCatalog([{ name: "a", description: "x".repeat(500), loaded: false }]);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(300);
  });
});

describe("formatLoadResult", () => {
  it("summarizes loaded and unknown", () => {
    expect(formatLoadResult({ loaded: ["a", "b"], unknown: [] })).toMatch(/Loaded 2 tool/);
    expect(formatLoadResult({ loaded: [], unknown: ["z"] })).toMatch(/Not found.*z/);
    expect(formatLoadResult({ loaded: [], unknown: [] })).toMatch(/No tool names/);
  });
});

describe("threshold", () => {
  it("is a sane positive floor", () => {
    expect(DEFERRED_TOOLS_MIN).toBeGreaterThan(0);
  });
});


describe("partitionToolDefinitions", () => {
  it("keeps a small explicit surface available without discovery overhead", () => {
    const tools = [def("specialist_probe"), def("bash")];
    expect(partitionToolDefinitions(tools)).toEqual({ immediate: tools, deferred: [] });
  });

  it("keeps common operations and defers specialist schemas in a large catalog", () => {
    const tools = [
      def("bash"), def("http_request"), def("read_file"), def("done"),
      ...Array.from({ length: DEFERRED_TOOLS_MIN }, (_, i) => def(`probe_${i}`)),
      def("run_command"), def("create_schedule"),
    ];
    const { immediate, deferred } = partitionToolDefinitions(tools);
    expect(immediate.map(t => t.name)).toEqual(["bash", "http_request", "read_file", "done"]);
    expect(deferred.map(t => t.name)).toEqual(tools.slice(4).map(t => t.name));
    expect(deferred[0]).toBe(tools[4]);
    expect(tools).toHaveLength(DEFERRED_TOOLS_MIN + 6);
  });

  it("keeps task-specific tools discoverable and loadable without advertising their schemas", () => {
    const specialists = [def("send_prompt"), def("use_loot"), def("read_skill")];
    const tools = [...Array.from(IMMEDIATE_TOOL_NAMES, name => def(name)), ...specialists];
    const { immediate, deferred } = partitionToolDefinitions(tools);
    for (const tool of specialists) expect(immediate).not.toContain(tool);
    expect(deferred).toEqual(specialists);
    const registry = new DeferredToolRegistry();
    registry.seed(deferred);
    expect(registry.catalogEntries().map(tool => tool.name)).toEqual(["read_skill", "send_prompt", "use_loot"]);
    expect(registry.load(specialists.map(tool => tool.name))).toEqual({ loaded: ["send_prompt", "use_loot", "read_skill"], unknown: [] });
    expect(registry.loadedDefinitions()).toEqual(specialists);
  });

  it("never adds unavailable default tools or changes schema objects", () => {
    const tools = Array.from({ length: DEFERRED_TOOLS_MIN }, (_, i) => def(`specialist_${i}`));
    const { immediate, deferred } = partitionToolDefinitions(tools);
    expect(immediate).toEqual([]);
    expect(deferred).toEqual(tools);
    expect(deferred[0]).toBe(tools[0]);
    expect(IMMEDIATE_TOOL_NAMES.has("bash")).toBe(true);
  });
});
