/**
 * `load_tool` for MCP servers. A lazy host lists one catalog entry per server; loading that entry starts the server and
 * (after the hash review) makes its tools advertised on the next turn. Other names still go to the deferred registry.
 */
import type { McpToolHost } from "../../agent/mcp-host.js";
import { LOAD_TOOL_NAME } from "../../agent/deferred-tools.js";
import type { ToolCall, ToolResult } from "../../agent/types.js";

/** Splits a `load_tool` call; null when it names no lazy MCP server (the common case, and every non-lazy host). */
export async function loadMcpServers(host: McpToolHost | undefined, call: ToolCall): Promise<{ messages: string[]; rest: string[] } | null> {
  if (call.name !== LOAD_TOOL_NAME || !host?.loadServer || !host.lazyServers) return null;
  const names = Array.isArray(call.arguments?.["names"]) ? (call.arguments["names"] as unknown[]).filter((n): n is string => typeof n === "string") : [];
  const known = new Set(host.lazyServers().index.map(def => def.name));
  const servers = [...new Set(names.map(n => n.trim()))].filter(n => known.has(n));
  if (!servers.length) return null;
  const messages: string[] = [];
  for (const name of servers) messages.push((await host.loadServer(name)).message);
  return { messages, rest: names.filter(n => !known.has(n.trim())) };
}

/** Result for the model: the server messages, then whatever the registry said about the remaining names. */
export const mcpLoadResult = (messages: readonly string[], other: ToolResult | null): ToolResult =>
  ({ success: true, output: [...messages, ...(other ? [typeof other.output === "string" ? other.output : other.error ?? ""] : [])].filter(Boolean).join(" ") });
