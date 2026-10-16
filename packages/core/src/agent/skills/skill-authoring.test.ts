import { describe, expect, it, vi } from "vitest";
import { executeSkillAuthoring, type SkillAuthoringAdapter } from "./skill-authoring.js";
import { getToolsForRole, ToolExecutor, TOOL_DEFINITIONS } from "../tools.js";
import { LOCAL_SCOPE_TOOLS, READ_ONLY_TOOLS } from "../../plugins/capability-classification.js";

const content = "---\nname: binary-review\ndescription: Review binary evidence.\n---\nInspect headers before drawing conclusions.";
const revision = "a".repeat(64);
function adapter(): SkillAuthoringAdapter {
  return { read: vi.fn(() => ({ content, revision })), create: vi.fn(() => ({ id: "mount/workspace/binary-review" })),
    update: vi.fn(() => ({ revision: "b".repeat(64) })), copy: vi.fn(() => ({ id: "mount/workspace/copied-review" })) };
}

describe("server-issued skill authoring", () => {
  it("reads editable content and forwards validated writes with their exact revisions", async () => {
    const host = adapter();
    expect((await executeSkillAuthoring("read", { skill_id: "project/binary-review" }, host)).output).toEqual({ content, revision });
    expect((await executeSkillAuthoring("create", { content }, host)).success).toBe(true);
    expect(host.create).toHaveBeenCalledWith(content);
    expect((await executeSkillAuthoring("update", { skill_id: "project/binary-review", content, expected_revision: revision }, host)).success).toBe(true);
    expect(host.update).toHaveBeenCalledWith("project/binary-review", { content, expectedRevision: revision });
    expect((await executeSkillAuthoring("copy", { skill_id: "project/binary-review", content, expected_revision: revision }, host)).success).toBe(true);
    expect(host.copy).toHaveBeenCalledWith("project/binary-review", { content, expectedRevision: revision });
  });

  it.each(["update", "copy"] as const)("requires a real CAS revision for %s", async (action) => {
    const host = adapter();
    for (const expected_revision of [undefined, "", 1, "latest", "A".repeat(64)]) {
      const result = await executeSkillAuthoring(action, { skill_id: "project/binary-review", content, ...(expected_revision === undefined ? {} : { expected_revision }) }, host);
      expect(result.success).toBe(false);
    }
    expect(host[action]).not.toHaveBeenCalled();
  });

  it("rejects malformed or oversized content and arbitrary filesystem parameters before calling the host", async () => {
    const host = adapter();
    expect((await executeSkillAuthoring("create", { content: "No frontmatter" }, host)).success).toBe(false);
    expect((await executeSkillAuthoring("create", { content: `${content}${"é".repeat(70_000)}` }, host)).success).toBe(false);
    expect((await executeSkillAuthoring("create", { content, path: "/etc/profile" }, host)).success).toBe(false);
    expect(host.create).not.toHaveBeenCalled();
  });

  it("handles absent capabilities and host permission/conflict errors without filesystem fallback", async () => {
    expect((await executeSkillAuthoring("create", { content })).error).toContain("unavailable");
    const host = adapter();
    host.update = vi.fn(() => { throw new Error("Skill changed. Read the latest version before saving."); });
    expect((await executeSkillAuthoring("update", { skill_id: "personal/binary-review", content, expected_revision: revision }, host)).error).toContain("Skill changed");
    host.create = vi.fn(() => { throw new Error("Read-only workspace"); });
    expect((await executeSkillAuthoring("create", { content }, host)).error).toBe("Read-only workspace");
  });

  it("resolves the trusted current actor capability for every actual tool call", async () => {
    let current: SkillAuthoringAdapter | undefined;
    const executor = new ToolExecutor({ target: "http://localhost", scanId: "skill-author", role: "report", findings: [], attackResults: [], targetInfo: {}, skillAuthoring: () => current });
    expect((await executor.execute({ name: "create_skill", arguments: { content } })).success).toBe(false);
    const host = adapter(); current = host;
    expect((await executor.execute({ name: "create_skill", arguments: { content } })).success).toBe(true);
    expect((await executor.execute({ name: "save_skill", arguments: { skill_id: "mount/workspace/binary-review", content, expected_revision: revision } })).success).toBe(true);
    expect(host.update).toHaveBeenCalledOnce();
    current = undefined;
    expect((await executor.execute({ name: "copy_skill", arguments: { skill_id: "mount/workspace/binary-review", content, expected_revision: revision } })).success).toBe(false);
  });

  it("offers library tools to all agent roles while classifying only reads as read-only", () => {
    for (const role of ["discovery", "attack", "verify", "report", "audit", "review"]) {
      const names = getToolsForRole(role, { hasScope: true }).map((tool) => tool.name);
      for (const name of ["read_skill", "create_skill", "save_skill", "copy_skill"]) expect(names).toContain(name);
    }
    expect(READ_ONLY_TOOLS.read_skill).toBe(true);
    for (const name of ["create_skill", "save_skill", "copy_skill"]) {
      expect(READ_ONLY_TOOLS[name]).toBeUndefined();
      expect(LOCAL_SCOPE_TOOLS[name]).toBeUndefined();
      expect(TOOL_DEFINITIONS[name]).toBeDefined();
    }
  });
});
