/** Pure: the per-tool hash that pins what an MCP server told the model about a tool. */
import { createHash } from "node:crypto";

/** What `tools/list` says about one tool. Everything here can change without a new commit of the extension. */
export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations?: unknown;
}

/** JSON with object keys sorted at every depth, so equal values always serialise to the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

/**
 * sha256 over name, description, input schema and annotations. A new field in a future spec is not hashed until added
 * here with a new version prefix: do that for anything that reaches the model.
 */
export function mcpToolHash(tool: McpToolInfo): string {
  const canonical = canonicalJson({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? {}, annotations: tool.annotations ?? {} });
  return createHash("sha256").update(`0:mcp-tool:v1\0${canonical}`).digest("hex");
}

export const hashTools = (tools: readonly McpToolInfo[]): Record<string, string> => Object.fromEntries(tools.map(t => [t.name, mcpToolHash(t)]));

/** Sorted unique tool names that appear more than once in `tools`. Duplicate names make hash pinning ambiguous. */
export function findDuplicateToolNames(tools: readonly McpToolInfo[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) duplicates.add(tool.name);
    else seen.add(tool.name);
  }
  return [...duplicates].sort();
}
