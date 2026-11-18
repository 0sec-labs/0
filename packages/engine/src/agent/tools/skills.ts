/**
 * JIT skills tool definitions (0#611 — split out of the monolithic
 * agent/tools.ts registry).
 *
 * Agent Skills discovery/loading. Automatic methodology selection is separate
 * from the always available library tools.
 *
 * Pure `ToolDefinition` metadata (name / description / parameter schema). The
 * ./tools/index.ts barrel merges every per-domain map into the canonical
 * `TOOL_DEFINITIONS` registry; the matching runtime handlers live on the
 * `ToolExecutor` class in agent/tools.ts.
 */
import type { ToolDefinition } from "../types.js";

export const skillsToolDefinitions: Record<string, ToolDefinition> = {
  load_skill: {
    name: "load_skill",
    description:
      "Load a skill's instructions into your working context. Resolve referenced resources relative to its skill directory and read them only as needed. Loading a skill does not execute its scripts. Call with no skill_id to list the available skills.",
    parameters: {
      skill_id: { type: "string", description: "Skill ID; omit to list available skills" },
    },
  },
};

// Tool-name → ToolExecutor handler-method name (0#614). Co-located with
// this domain's definitions so a new tool adds its route here, not in a
// shared dispatch switch. Assembled by ./dispatch.ts; resolved off the
// executor instance in agent/tools.ts (handler bodies stay private methods).
export const skillsDispatch: Record<string, string> = {
  load_skill: "loadSkill",
};
