import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diag } from "../../diagnostics/channel.js";
import { clearSkillRegistry, loadSkillRegistry, skillRegistryProblems } from "./index.js";

const good = (id: string, tools = "") => `id: ${id}\nname: ${id}\ndescription: d\nversion: 1\napplicable_roles: [audit]\ntags: []\ntriggers: []\nestimated_tokens: 10\n${tools}content: |\n  body\n`;

describe("skill registry tolerance", () => {
  afterEach(() => { clearSkillRegistry(); vi.restoreAllMocks(); });

  it("skips a malformed skill and still loads the rest", () => {
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    try {
      mkdirSync(join(dir, "frameworks"));
      writeFileSync(join(dir, "ok.yaml"), good("ok"));
      writeFileSync(join(dir, "frameworks", "entra-id.yaml"), good("entra-id", "tools: [removed-pack]\n"));
      writeFileSync(join(dir, "dup.yaml"), good("ok"));
      const registry = loadSkillRegistry(dir);
      expect([...registry.keys()]).toEqual(["ok"]);
      expect(warn).toHaveBeenCalledWith("skill_skipped", expect.stringContaining("entra-id.yaml"));
      expect(skillRegistryProblems().join("\n")).toMatch(/entra-id\.yaml.*tools/s);
      expect(skillRegistryProblems().join("\n")).toMatch(/Duplicate skill ID "ok"/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("every shipped skill is valid", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    expect(loadSkillRegistry(dir).size).toBeGreaterThan(10);
    expect(skillRegistryProblems()).toEqual([]);
  });
});
