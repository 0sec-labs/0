/**
 * Skill definitions for JIT methodology loading (#410).
 *
 * Skills are YAML files providing focused, actionable methodology guides
 * that the agent can load mid-scan via `load_skill`. They replace the
 * monolithic playbook injection with targeted, on-demand knowledge.
 */

import type { VerifySpec } from "../../verifier/spec.js";

export interface SkillDefinition {
  id: string;
  name: string;
  /** Model-facing routing text. Changing it changes when the agent loads the skill. */
  description: string;
  /** Optional plain-English line for people browsing skills (<= 90 chars, no markdown). */
  summary?: string;
  /** Optional browse group such as "Web" or "LLM". */
  category?: string;
  /** Hidden from browse lists; the engine can still load it. */
  internal?: boolean;
  version: number;
  applicable_roles: Array<"attack" | "audit" | "review">;
  tags: string[];
  triggers: string[]; // regex patterns
  estimated_tokens: number;
  /**
   * Tool packs this skill needs (names from TOOL_PACKS in ../toolset.ts). Loading
   * the skill advertises those tools on the next turn when the console runs the
   * `core` toolset. Honoured for built-in skills only; never grants authority.
   */
  tools?: string[];
  /**
   * Harness-run verifier. When present, a Thread started with this skill cannot
   * finish with a "fixed" or "verified" claim unless the harness ran this and it passed.
   */
  verify?: VerifySpec;
  content: string; // markdown methodology
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  estimated_tokens: number;
  suggested: boolean;
}
