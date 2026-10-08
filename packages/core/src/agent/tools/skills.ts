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
  list_skills: {
    name: "list_skills",
    description:
      "List available skills from the project, personal folders, mounted libraries, and built-in methodology. Returns metadata only; use load_skill to read a matching skill's instructions. Skills marked suggested match patterns in recent findings.",
    parameters: {
      tag: { type: "string", description: "Optional tag filter" },
    },
  },

  load_skill: {
    name: "load_skill",
    description:
      "Load a skill's instructions into your working context. Resolve referenced resources relative to its skill directory and read them only as needed. Loading a skill does not execute its scripts. Use list_skills first to see available IDs.",
    parameters: {
      skill_id: { type: "string", description: "Skill ID from list_skills" },
    },
    required: ["skill_id"],
  },
};

// Tool-name → ToolExecutor handler-method name (0#614). Co-located with
// this domain's definitions so a new tool adds its route here, not in a
// shared dispatch switch. Assembled by ./dispatch.ts; resolved off the
// executor instance in agent/tools.ts (handler bodies stay private methods).
export const skillsDispatch: Record<string, string> = {
  list_skills: "listSkills",
  load_skill: "loadSkill",
};
