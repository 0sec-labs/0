import { createExtensionService, runBeforeCommand, type ExtensionRunPort, type McpToolHost } from "@0/engine";
import { consoleExecutionProfile } from "./console-execution.js";

/** What the bash tool may add to a script of an enabled, approved extension (its declared and approved variables, a connector's token included). Nothing in a smolvm guest. */
export function connectExtensionRuns(project: string, home?: string): ExtensionRunPort | undefined {
  if (consoleExecutionProfile(home) === "smolvm") return undefined;
  try { return createExtensionService(home ? { home } : {}).scriptRuns(project); } catch { return undefined; }
}

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
