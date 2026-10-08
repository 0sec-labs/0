import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor, TOOL_DEFINITIONS, getToolsForRole } from "../tools.js";
import { clearSkillRegistry, loadSkillRegistry } from "./index.js";
import type { ToolContext } from "../types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Build a minimal ToolContext for skill-tool tests. Skills only need
 * `role`, `recentToolResultTexts`, and `loadedSkills` — the rest are
 * stubs so the ToolExecutor constructor doesn't complain.
 */
function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    target: "http://localhost:1234",
    scanId: "test-scan",
    findings: [],
    attackResults: [],
    targetInfo: {},
    role: "attack",
    skillDiscoveryOptions: { homeDir: null },
    ...overrides,
  };
}

describe("Skill Tools (#457)", () => {
  let savedJitSkills: string | undefined;

  beforeEach(() => {
    savedJitSkills = process.env["ZERO_FEATURE_JIT_SKILLS"];
    process.env["ZERO_FEATURE_JIT_SKILLS"] = "1";
    clearSkillRegistry();
    loadSkillRegistry(__dirname);
  });

  afterEach(() => {
    if (savedJitSkills === undefined) delete process.env["ZERO_FEATURE_JIT_SKILLS"];
    else process.env["ZERO_FEATURE_JIT_SKILLS"] = savedJitSkills;
    clearSkillRegistry();
  });

  // ── list_skills ─────────────────────────────────────────────────

  it("lists standard folder metadata and loads instructions only on demand", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-skill-tool-"));
    try {
      const directory = join(root, "binary-review");
      mkdirSync(directory);
      writeFileSync(join(directory, "SKILL.md"), "---\nname: binary-review\ndescription: Review a binary.\n---\nInspect the binary header first.");
      let mounted = false;
      const executor = new ToolExecutor(makeCtx({ skillDiscoveryOptions: () => ({ homeDir: null, mounts: mounted ? [{ path: root, id: "workspace" }] : [] }) }));
      const beforeMount = await executor.execute({ name: "list_skills", arguments: {} });
      expect(JSON.stringify(beforeMount.output)).not.toContain("mount/workspace/binary-review");
      mounted = true;
      const listed = await executor.execute({ name: "list_skills", arguments: {} });
      const output = listed.output as { skills: Array<{ id: string; content?: string }> };
      const metadata = output.skills.find((item) => item.id === "mount/workspace/binary-review");
      expect(metadata).toBeDefined();
      expect(metadata).not.toHaveProperty("content");
      const loaded = await executor.execute({ name: "load_skill", arguments: { skill_id: metadata!.id } });
      expect(loaded.success).toBe(true);
      expect((loaded.output as { content: string }).content).toContain("Inspect the binary header first.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["discovery", "verify", "report"])("allows %s agents to load standard folder skills", async (role) => {
    const root = mkdtempSync(join(tmpdir(), "zero-skill-role-"));
    try {
      mkdirSync(join(root, "evidence-review"));
      writeFileSync(join(root, "evidence-review", "SKILL.md"), "---\nname: evidence-review\ndescription: Review collected evidence.\n---\nConfirm the evidence supports each finding.");
      expect(getToolsForRole(role).map((tool) => tool.name)).toContain("load_skill");
      const executor = new ToolExecutor(makeCtx({ role, skillDiscoveryOptions: { homeDir: null, mounts: [{ path: root, id: "shared" }] } }));
      const loaded = await executor.execute({ name: "load_skill", arguments: { skill_id: "mount/shared/evidence-review" } });
      expect(loaded.success).toBe(true);
      expect((loaded.output as { content: string }).content).toContain("Confirm the evidence");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("list_skills", () => {
    it("returns summaries for all skills", async () => {
      const executor = new ToolExecutor(makeCtx());
      const result = await executor.execute({
        name: "list_skills",
        arguments: {},
      });

      expect(result.success).toBe(true);
      const output = result.output as {
        skills: Array<{ id: string; name: string; suggested: boolean }>;
        total: number;
      };
      const expectedTotal = loadSkillRegistry().size;
      expect(output.total).toBe(expectedTotal);
      expect(output.skills.length).toBe(expectedTotal);

      // Every skill should have the expected shape
      for (const s of output.skills) {
        expect(typeof s.id).toBe("string");
        expect(typeof s.name).toBe("string");
        expect(typeof s.suggested).toBe("boolean");
      }
    });

    it("filters by tag", async () => {
      const executor = new ToolExecutor(makeCtx());
      const result = await executor.execute({
        name: "list_skills",
        arguments: { tag: "sqli" },
      });

      expect(result.success).toBe(true);
      const output = result.output as {
        skills: Array<{ id: string; tags: string[] }>;
        total: number;
      };
      expect(output.total).toBeGreaterThanOrEqual(1);
      for (const s of output.skills) {
        expect(s.tags).toContain("sqli");
      }
    });

    it("returns empty list for nonexistent tag", async () => {
      const executor = new ToolExecutor(makeCtx());
      const result = await executor.execute({
        name: "list_skills",
        arguments: { tag: "does-not-exist-xyz" },
      });

      expect(result.success).toBe(true);
      const output = result.output as { total: number };
      expect(output.total).toBe(0);
    });

    it("marks suggested skills based on trigger matching", async () => {
      const executor = new ToolExecutor(
        makeCtx({
          recentToolResultTexts: [
            "ERROR: You have an error in your SQL syntax near 'test'",
            "UNION SELECT 1,2,3 from information_schema.tables",
          ],
        }),
      );

      const result = await executor.execute({
        name: "list_skills",
        arguments: {},
      });

      expect(result.success).toBe(true);
      const output = result.output as {
        skills: Array<{ id: string; suggested: boolean }>;
        suggested_count: number;
      };

      const sqli = output.skills.find((s) => s.id === "sqli-advanced");
      expect(sqli).toBeDefined();
      expect(sqli!.suggested).toBe(true);
      expect(output.suggested_count).toBeGreaterThanOrEqual(1);
    });

    it("marks no skills suggested when there are no recent texts", async () => {
      const executor = new ToolExecutor(makeCtx());
      const result = await executor.execute({
        name: "list_skills",
        arguments: {},
      });

      expect(result.success).toBe(true);
      const output = result.output as {
        skills: Array<{ suggested: boolean }>;
        suggested_count: number;
      };
      expect(output.suggested_count).toBe(0);
      expect(output.skills.every((s) => !s.suggested)).toBe(true);
    });
  });

  // ── load_skill ──────────────────────────────────────────────────

  describe("load_skill", () => {
    it("returns skill content for a valid skill ID", async () => {
      const executor = new ToolExecutor(
        makeCtx({ loadedSkills: new Set() }),
      );
      const result = await executor.execute({
        name: "load_skill",
        arguments: { skill_id: "sqli-advanced" },
      });

      expect(result.success).toBe(true);
      const output = result.output as {
        kind: string;
        skill_id: string;
        name: string;
        content: string;
        estimated_tokens: number;
      };
      expect(output.kind).toBe("skill_loaded");
      expect(output.skill_id).toBe("sqli-advanced");
      expect(output.name).toBe("Advanced SQL Injection");
      expect(typeof output.content).toBe("string");
      expect(output.content.length).toBeGreaterThan(0);
      expect(output.estimated_tokens).toBeGreaterThan(0);
    });

    it("refuses double-load for already loaded skills", async () => {
      const loaded = new Set(["sqli-advanced"]);
      const executor = new ToolExecutor(makeCtx({ loadedSkills: loaded }));
      const result = await executor.execute({
        name: "load_skill",
        arguments: { skill_id: "sqli-advanced" },
      });

      expect(result.success).toBe(true);
      const output = result.output as { kind: string; message: string };
      expect(output.kind).toBe("already_loaded");
      expect(output.message).toBe("Skill already loaded");
    });

    it("tracks loaded skills across consecutive calls", async () => {
      const ctx = makeCtx({ loadedSkills: new Set() });
      const executor = new ToolExecutor(ctx);

      // First load — should succeed
      const first = await executor.execute({
        name: "load_skill",
        arguments: { skill_id: "jwt-attacks" },
      });
      expect(first.success).toBe(true);
      expect((first.output as { kind: string }).kind).toBe("skill_loaded");

      // Second load of same skill — should return already_loaded
      const second = await executor.execute({
        name: "load_skill",
        arguments: { skill_id: "jwt-attacks" },
      });
      expect(second.success).toBe(true);
      expect((second.output as { kind: string }).kind).toBe("already_loaded");
    });

    it("initializes loadedSkills set when ctx has none", async () => {
      // ctx.loadedSkills is undefined (not pre-initialized)
      const ctx = makeCtx();
      expect(ctx.loadedSkills).toBeUndefined();

      const executor = new ToolExecutor(ctx);
      const result = await executor.execute({
        name: "load_skill",
        arguments: { skill_id: "prototype-pollution" },
      });

      expect(result.success).toBe(true);
      expect(ctx.loadedSkills).toBeDefined();
      expect(ctx.loadedSkills!.has("prototype-pollution")).toBe(true);
    });

    it("returns error for unknown skill ID", async () => {
      const executor = new ToolExecutor(
        makeCtx({ loadedSkills: new Set() }),
      );
      const result = await executor.execute({
        name: "load_skill",
        arguments: { skill_id: "nonexistent-skill-xyz" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown skill ID");
      expect(result.error).toContain("nonexistent-skill-xyz");
    });

    it("returns error when skill_id is missing", async () => {
      const executor = new ToolExecutor(makeCtx());
      const result = await executor.execute({
        name: "load_skill",
        arguments: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("skill_id is required");
    });
  });

  // Skills remain available independently of automatic JIT methodology.

  describe("skill availability", () => {
    const originalEnv = process.env["ZERO_FEATURE_JIT_SKILLS"];

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env["ZERO_FEATURE_JIT_SKILLS"];
      } else {
        process.env["ZERO_FEATURE_JIT_SKILLS"] = originalEnv;
      }
    });

    it("skill tools remain available to working agent roles when automatic JIT is off", async () => {
      process.env["ZERO_FEATURE_JIT_SKILLS"] = "0";

      for (const role of ["discovery", "attack", "audit", "review"]) {
        const tools = getToolsForRole(role);
        const names = tools.map((t) => t.name);
        expect(names).toContain("list_skills");
        expect(names).toContain("load_skill");
      }
      const executor = new ToolExecutor(makeCtx());
      expect((await executor.execute({ name: "list_skills", arguments: {} })).success).toBe(true);
    });

    it("both tools are present for attack role when feature flag is on", () => {
      process.env["ZERO_FEATURE_JIT_SKILLS"] = "1";

      const tools = getToolsForRole("attack");
      const names = tools.map((t) => t.name);
      expect(names).toContain("list_skills");
      expect(names).toContain("load_skill");
    });

    it("both tools are present for audit role when feature flag is on", () => {
      process.env["ZERO_FEATURE_JIT_SKILLS"] = "1";

      const tools = getToolsForRole("audit");
      const names = tools.map((t) => t.name);
      expect(names).toContain("list_skills");
      expect(names).toContain("load_skill");
    });

    it("both tools are present for review role when feature flag is on", () => {
      process.env["ZERO_FEATURE_JIT_SKILLS"] = "1";

      const tools = getToolsForRole("review");
      const names = tools.map((t) => t.name);
      expect(names).toContain("list_skills");
      expect(names).toContain("load_skill");
    });
  });

  // ── Tool definitions exist in TOOL_DEFINITIONS ──────────────────

  describe("tool definitions", () => {
    it("list_skills is defined in TOOL_DEFINITIONS", () => {
      expect(TOOL_DEFINITIONS.list_skills).toBeDefined();
      expect(TOOL_DEFINITIONS.list_skills.name).toBe("list_skills");
      expect(TOOL_DEFINITIONS.list_skills.parameters.tag).toBeDefined();
    });

    it("load_skill is defined in TOOL_DEFINITIONS", () => {
      expect(TOOL_DEFINITIONS.load_skill).toBeDefined();
      expect(TOOL_DEFINITIONS.load_skill.name).toBe("load_skill");
      expect(TOOL_DEFINITIONS.load_skill.parameters.skill_id).toBeDefined();
      expect(TOOL_DEFINITIONS.load_skill.required).toEqual(["skill_id"]);
    });
  });
});
