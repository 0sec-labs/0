import { describe, expect, it } from "vitest";
import { createConsoleSession } from "./turn-engine.js";
import type { NativeMessage, NativeRuntime, NativeRuntimeResult, NativeToolDef } from "../runtime/types.js";
import { CORE_TOOL_NAMES, TOOL_ALIASES, TOOL_PACKS, resolvePacks, resolveToolset } from "../agent/toolset.js";
import { TOOL_DEFINITIONS } from "../agent/tools.js";
import { loadSkillRegistry } from "../agent/skills/index.js";

class ScriptedRuntime implements NativeRuntime {
  readonly type = "api" as const;
  calls: Array<{ tools: NativeToolDef[]; system: string }> = [];
  constructor(private readonly script: NativeRuntimeResult[]) {}
  async isAvailable(): Promise<boolean> { return true; }
  async executeNative(system: string, _messages: NativeMessage[], tools: NativeToolDef[]): Promise<NativeRuntimeResult> {
    this.calls.push({ tools, system });
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  }
}
const end = (text: string): NativeRuntimeResult => ({ content: [{ type: "text", text }], stopReason: "end_turn", durationMs: 1 });
const call = (name: string, input: Record<string, unknown>): NativeRuntimeResult => ({ content: [{ type: "tool_use", id: `c-${name}`, name, input }], stopReason: "tool_use", durationMs: 1 });
const names = (tools: NativeToolDef[]) => tools.map(tool => tool.name);

describe("core toolset registry", () => {
  it("only names registered tools", () => {
    for (const name of CORE_TOOL_NAMES) expect(TOOL_DEFINITIONS[name], name).toBeDefined();
    for (const [pack, members] of Object.entries(TOOL_PACKS)) for (const name of members) expect(TOOL_DEFINITIONS[name], `${pack}:${name}`).toBeDefined();
    for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
      expect(TOOL_DEFINITIONS[alias], alias).toBeDefined();
      expect(TOOL_DEFINITIONS[canonical], canonical).toBeDefined();
    }
  });
  it("lists each tool in exactly one place", () => {
    const seen = new Map<string, string>();
    for (const name of CORE_TOOL_NAMES) seen.set(name, "core");
    for (const [pack, members] of Object.entries(TOOL_PACKS)) for (const name of members) {
      expect(seen.get(name), `${name} in ${pack}`).toBeUndefined();
      seen.set(name, pack);
    }
    for (const alias of Object.keys(TOOL_ALIASES)) expect(seen.has(alias), alias).toBe(false);
  });
  it("only lets built-in skills reference known packs", () => {
    for (const skill of loadSkillRegistry().values()) expect(resolvePacks(skill.tools).unknown, skill.id).toEqual([]);
  });
  it("accepts core and pack:<name> spellings", () => {
    expect(resolvePacks(["core", "pack:nope"])).toEqual({ tools: [], unknown: ["nope"] });
  });
  it("resolves the toolset from explicit value, then env, then the surface default", () => {
    expect(resolveToolset({ surfaceDefault: "core", env: {} })).toBe("core");
    expect(resolveToolset({ surfaceDefault: "full", env: {} })).toBe("full");
    expect(resolveToolset({ surfaceDefault: "core", env: { ZERO_TOOLSET: "full" } })).toBe("full");
    expect(resolveToolset({ explicit: "core", surfaceDefault: "full", env: { ZERO_TOOLSET: "full" } })).toBe("core");
    expect(resolveToolset({ explicit: "bogus", surfaceDefault: "full", env: {} })).toBe("full");
  });
});

describe("core toolset in the console", () => {
  it("advertises only the core list by default and keeps the schema order stable", async () => {
    const runtime = new ScriptedRuntime([end("a"), end("b")]);
    const session = createConsoleSession({ runtime, refineObjective: false });
    try {
      await session.send("hello");
      await session.send("again");
      const first = names(runtime.calls[0]!.tools);
      expect(first.sort()).toEqual([...CORE_TOOL_NAMES].sort());
      expect(JSON.stringify(runtime.calls[1]!.tools)).toBe(JSON.stringify(runtime.calls[0]!.tools));
    } finally { await session.cleanup(); }
  });

  it("lists skills when load_skill gets no id", async () => {
    const runtime = new ScriptedRuntime([call("load_skill", {}), end("done")]);
    const session = createConsoleSession({ runtime, refineObjective: false });
    try {
      const outcome = await session.send("what skills exist");
      expect(outcome.toolCalls[0]!.result.success).toBe(true);
      expect(JSON.stringify(outcome.toolCalls[0]!.result.output)).toContain("graphql-introspection");
    } finally { await session.cleanup(); }
  });
});
