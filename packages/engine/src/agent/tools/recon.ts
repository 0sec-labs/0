/**
 * Web search tool definition (0#611 — split out of the monolithic
 * agent/tools.ts registry).
 *
 * Pure `ToolDefinition` metadata (name / description / parameter schema). The
 * ./tools/index.ts barrel merges every per-domain map into the canonical
 * `TOOL_DEFINITIONS` registry; the matching runtime handlers live on the
 * `ToolExecutor` class in agent/tools.ts.
 */
import type { ToolDefinition } from "../types.js";

export const reconToolDefinitions: Record<string, ToolDefinition> = {
  web_search: {
    name: "web_search",
    description:
      "Search the web for CVE details, API documentation, or security technique references. Cannot be used to find writeups or solutions.",
    parameters: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
};

// Tool-name → ToolExecutor handler-method name (0#614). Co-located with
// this domain's definitions so a new tool adds its route here, not in a
// shared dispatch switch. Assembled by ./dispatch.ts; resolved off the
// executor instance in agent/tools.ts (handler bodies stay private methods).
export const reconDispatch: Record<string, string> = {
  web_search: "webSearch",
};
