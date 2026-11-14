/** Custom MCP tools reach missions as `mcp__custom-<id>__<tool>`; people should see the bare tool name. */
const CUSTOM = /^mcp__(custom-[a-z0-9-]+)__(.+)$/;
const EXTERNAL_PREFIX = /^\s*\[external MCP tool[^\]]*\]\s*/i;

export function parseCustomMcpTool(name: string): { serverId: string; tool: string } | null {
  const match = CUSTOM.exec(name);
  return match ? { serverId: match[1]!, tool: match[2]! } : null;
}
/** Bare tool name for custom MCP tools; every other name is returned unchanged. Keep the full name for a title/tooltip. */
export const displayToolName = (name: string): string => parseCustomMcpTool(name)?.tool ?? name;
/** Drops the engine's `[external MCP tool …]` safety prefix, which is for the model rather than for people. */
export const displayToolDescription = (description: string): string => description.replace(EXTERNAL_PREFIX, "");
