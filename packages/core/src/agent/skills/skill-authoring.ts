import { z } from "zod";
import type { ToolResult } from "../types.js";
import { validateAgentSkillContent } from "./agent-skills.js";

/** Host-issued capability. The server owns identity, writable scope and CAS. */
export interface SkillAuthoringAdapter {
  read(id: string): unknown | Promise<unknown>;
  create(content: string): unknown | Promise<unknown>;
  update(id: string, input: { content: string; expectedRevision: string }): unknown | Promise<unknown>;
  copy(id: string, input: { content: string; expectedRevision: string }): unknown | Promise<unknown>;
}

type Action = "read" | "create" | "update" | "copy";
const id = z.string().min(1).max(384).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const content = z.string().min(1).max(131_072);
const expectedRevision = z.string().regex(/^[a-f0-9]{64}$/);
const schemas = {
  read: z.object({ skill_id: id }).strict(),
  create: z.object({ content }).strict(),
  update: z.object({ skill_id: id, content, expected_revision: expectedRevision }).strict(),
  copy: z.object({ skill_id: id, content, expected_revision: expectedRevision }).strict(),
};

export async function executeSkillAuthoring(
  action: Action,
  args: Record<string, unknown>,
  adapter?: SkillAuthoringAdapter,
): Promise<ToolResult> {
  if (!adapter) return { success: false, output: null, error: "Skill editing is unavailable in this session." };
  const parsed = schemas[action].safeParse(args);
  if (!parsed.success) return { success: false, output: null, error: action === "update" || action === "copy"
    ? "Provide skill_id, valid SKILL.md content and the expected_revision from read_skill."
    : action === "read" ? "Provide a valid skill_id." : "Provide valid SKILL.md content." };
  try {
    const input = parsed.data;
    if ("content" in input) validateAgentSkillContent(input.content);
    let output: unknown;
    if (action === "read") output = await adapter.read((input as { skill_id: string }).skill_id);
    else if (action === "create") output = await adapter.create((input as { content: string }).content);
    else {
      const write = input as { skill_id: string; content: string; expected_revision: string };
      output = await adapter[action](write.skill_id, { content: write.content, expectedRevision: write.expected_revision });
    }
    return { success: true, output };
  } catch (error) {
    return { success: false, output: null, error: error instanceof Error ? error.message : String(error) };
  }
}
