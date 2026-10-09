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
  read_skill: {
    name: "read_skill",
    description: "Read a skill's editable SKILL.md and current revision from the workspace library. Use its revision when saving edits or creating a copy.",
    parameters: { skill_id: { type: "string", description: "Skill ID from list_skills" } },
    required: ["skill_id"],
  },
  create_skill: {
    name: "create_skill",
    description: "Create a reusable skill in this workspace's library. Provide the complete SKILL.md with name and description YAML frontmatter, then instructions. This saves the skill; it does not run scripts.",
    parameters: { content: { type: "string", description: "Complete SKILL.md content" } },
    required: ["content"],
  },
  save_skill: {
    name: "save_skill",
    description: "Save edits to an existing writable skill. First read_skill, retain its revision, and supply the complete revised SKILL.md. A stale revision is rejected; read the latest version and reconcile changes.",
    parameters: {
      skill_id: { type: "string", description: "Skill ID from read_skill" },
      content: { type: "string", description: "Complete revised SKILL.md content" },
      expected_revision: { type: "string", description: "64-character SHA256 revision returned by read_skill" },
    },
    required: ["skill_id", "content", "expected_revision"],
  },
  copy_skill: {
    name: "copy_skill",
    description: "Create an editable workspace copy of an existing skill, preserving its supporting resources. First read_skill, then provide its revision and SKILL.md content with a new name. Source files are unchanged.",
    parameters: {
      skill_id: { type: "string", description: "Source skill ID from read_skill" },
      content: { type: "string", description: "Complete SKILL.md content for the new copy" },
      expected_revision: { type: "string", description: "64-character SHA256 source revision returned by read_skill" },
    },
    required: ["skill_id", "content", "expected_revision"],
  },
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
  read_skill: "readSkill",
  create_skill: "createSkill",
  save_skill: "saveSkill",
  copy_skill: "copySkill",
  list_skills: "listSkills",
  load_skill: "loadSkill",
};
