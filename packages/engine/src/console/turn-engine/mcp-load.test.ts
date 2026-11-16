import { describe, expect, it } from "vitest";
import type { McpToolHost } from "../../agent/mcp-host.js";
import { loadMcpServers, mcpLoadResult } from "./mcp-load.js";

const host = (loaded: string[] = []): McpToolHost => ({
  registeredTools: () => [], callTool: async () => ({ success: true, output: null }), closeAll: async () => undefined,
  lazyServers: () => ({ index: [{ name: "mcp__docs-fake", description: "x", parameters: {} }], loaded: new Set() }),
  loadServer: async name => { loaded.push(name); return { ok: true, message: `loaded ${name}` }; },
});

describe("load_tool for lazy MCP servers", () => {
  it("starts the named server and leaves other names to the registry", async () => {
    const loaded: string[] = [];
    const r = await loadMcpServers(host(loaded), { name: "load_tool", arguments: { names: ["mcp__docs-fake", "bash"] } });
    expect(loaded).toEqual(["mcp__docs-fake"]); expect(r).toEqual({ messages: ["loaded mcp__docs-fake"], rest: ["bash"] });
    expect(mcpLoadResult(r!.messages, { success: true, output: "Loaded 1 tool(s)" }).output).toBe("loaded mcp__docs-fake Loaded 1 tool(s)");
  });
  it("ignores everything that is not a lazy server, and eager hosts", async () => {
    expect(await loadMcpServers(host(), { name: "load_tool", arguments: { names: ["bash"] } })).toBeNull();
    expect(await loadMcpServers(host(), { name: "list_tools", arguments: {} })).toBeNull();
    expect(await loadMcpServers({ registeredTools: () => [], callTool: async () => ({ success: true, output: null }), closeAll: async () => undefined }, { name: "load_tool", arguments: { names: ["mcp__docs-fake"] } })).toBeNull();
    expect(await loadMcpServers(undefined, { name: "load_tool", arguments: { names: ["x"] } })).toBeNull();
  });
});
