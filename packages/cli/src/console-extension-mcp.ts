import { createExtensionService, runBeforeCommand, type McpToolHost } from "@0/engine";
import { consoleExecutionProfile } from "./console-execution.js";

/**
 * MCP servers declared by extensions enabled for this project. They start lazily (the model loads one from the tool index),
 * go through `beforeCommand` and the extension environment allowlist, and are hash-pinned. The operator's own servers
 * (`base`) keep working unchanged underneath. Returns `base` when no enabled extension declares an MCP server.
 */
export function connectExtensionMcp<T extends McpToolHost>(base: T | undefined, project: string, home?: string): T | McpToolHost | undefined {
  if (consoleExecutionProfile(home) === "smolvm") return base;
  try {
    const host = createExtensionService(home ? { home } : {}).mcpHost({ project, gate: runBeforeCommand, ...(base ? { base } : {}) });
    return host.serverIds().length ? host : base;
  } catch { return base; }
}
