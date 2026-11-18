// Typed accessors for optional session hosts attached to the ToolContext (MCP host, deferred-tool registries).
import type { ToolContext } from "../types.js";
import type { McpToolHost } from "../mcp-host.js";
import type { DeferredToolRegistry } from "../deferred-tools.js";

export interface McpHostCtx {
  mcpHost?: McpToolHost;
}
export function mcpHostOf(ctx: ToolContext): McpToolHost | undefined {
  return (ctx as ToolContext & McpHostCtx).mcpHost;
}

/**
 * Session-scoped deferred-tool registry (progressive tool disclosure). The console turn engine seeds it
 * with a high-cardinality tool catalog (e.g. many MCP-server tools) and advertises only
 * `list_tools`/`load_tool`; a `load_tool` call adds to the loaded set the NEXT turn picks up.
 */
export interface DeferredToolsCtx {
  deferredTools?: DeferredToolRegistry;
  /** Core toolset: tools that only a loaded skill's pack can add. Never reachable through load_tool. */
  packTools?: DeferredToolRegistry;
}
export function packToolsOf(ctx: ToolContext): DeferredToolRegistry | undefined {
  return (ctx as ToolContext & DeferredToolsCtx).packTools;
}
export function deferredToolsOf(ctx: ToolContext): DeferredToolRegistry | undefined {
  return (ctx as ToolContext & DeferredToolsCtx).deferredTools;
}
