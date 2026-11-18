/**
 * Tool registry barrel (0#611).
 *
 * Assembles the canonical `TOOL_DEFINITIONS` map from the per-domain
 * definition modules. Splitting the old 600-line object literal into
 * per-domain files lets parallel feature PRs (scanner #585, WAF #590,
 * access-control #586, …) edit disjoint files instead of all serializing on
 * one merge-conflict chokepoint.
 *
 * `agent/tools.ts` imports + re-exports `TOOL_DEFINITIONS` and
 * `SCANNER_TOOL_NAMES` from here, so every existing `./tools.js` importer is
 * unaffected.
 */
import type { ToolDefinition } from "../types.js";
import { reconToolDefinitions } from "./recon.js";
import { findingsToolDefinitions } from "./findings.js";
import { systemToolDefinitions } from "./system.js";
import { skillsToolDefinitions } from "./skills.js";
import { askOperatorToolDefinitions } from "./ask-operator.js";

// Every per-domain definition map, merged. Key collisions are impossible —
// each tool name is owned by exactly one domain module.
const DOMAIN_DEFINITIONS: Record<string, ToolDefinition> = {
  ...reconToolDefinitions,
  ...findingsToolDefinitions,
  ...systemToolDefinitions,
  ...skillsToolDefinitions,
  ...askOperatorToolDefinitions,
};

// Canonical registry order. getToolsForRole("audit"/"review") enumerates
// Object.keys(TOOL_DEFINITIONS), so keep additions deliberate and deterministic.
const TOOL_REGISTRY_ORDER = [
  "finding",
  "str_replace",
  "bash",
  "spawn_agent",
  "web_search",
  "load_skill",
  "ask_operator",
  "memory",
] as const;

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = Object.fromEntries(
  TOOL_REGISTRY_ORDER.map((name): [string, ToolDefinition] => [name, DOMAIN_DEFINITIONS[name]]),
);
