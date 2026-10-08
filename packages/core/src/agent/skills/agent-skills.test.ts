import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgentSkills, loadAgentSkill, validateAgentSkillContent } from "./agent-skills.js";

const temporary: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "zero-agent-skills-")); temporary.push(dir); return dir; }
function skill(root: string, name = "reverse-engineering", body = "Read references/guide.md when needed.") {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Inspect binary formats and document findings.\n---\n${body}\n`);
  return directory;
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("standard Agent Skills", () => {
  it("discovers project and personal folders without loading resources or running scripts", () => {
    const project = temp(), home = temp();
    const directory = skill(join(project, ".agents", "skills"));
    mkdirSync(join(directory, "references"));
    writeFileSync(join(directory, "references", "guide.md"), "Private reference content");
    writeFileSync(join(directory, "execute.sh"), "exit 99");
    skill(join(home, ".agents", "skills"), "personal-guide");
    const found = discoverAgentSkills({ projectRoot: project, homeDir: home });
    expect(found.diagnostics).toEqual([]);
    expect(found.skills.map((item) => item.id)).toEqual(["project/reverse-engineering", "personal/personal-guide"]);
    expect(found.skills[0]).not.toHaveProperty("content");
    const loaded = loadAgentSkill(found.skills[0]!);
    expect(loaded.content).toContain(directory);
    expect(loaded.content).toContain("Read references/guide.md");
    expect(loaded.content).not.toContain("Private reference content");
  });

  it("gives standard folders precedence and keeps separate sources separate", () => {
    const project = temp(), home = temp(), mount = temp();
    skill(join(project, ".agents", "skills"), "same", "Standard");
    skill(join(project, ".claude", "skills"), "same", "Compatibility");
    skill(join(home, ".agents", "skills"), "same");
    skill(mount, "same");
    const found = discoverAgentSkills({ projectRoot: project, homeDir: home, mounts: [{ path: mount, id: "shared" }] });
    expect(found.skills.map((item) => item.id)).toEqual(["project/same", "mount/shared/same"]);
    expect(found.diagnostics[0]?.message).toContain("Duplicate");
    expect(loadAgentSkill(found.skills[0]!).content).toContain("Standard");
  });

  it("isolates team mounts from personal skill discovery", () => {
    const mount = temp(); skill(mount, "team-guide");
    const found = discoverAgentSkills({ homeDir: null, mounts: [{ path: join(mount, "team-guide"), id: "workspace" }] });
    expect(found.skills.map((item) => item.id)).toEqual(["mount/workspace/team-guide"]);
    expect(discoverAgentSkills({ homeDir: null }).skills).toEqual([]);
  });

  it("rejects symlink escapes and entrypoint replacement between discovery and loading", () => {
    const mount = temp(), outside = temp();
    const external = skill(outside, "external");
    symlinkSync(external, join(mount, "external"));
    const directory = skill(mount, "valid");
    const found = discoverAgentSkills({ homeDir: null, mounts: [{ path: mount }] });
    expect(found.skills).toHaveLength(1);
    expect(found.diagnostics[0]?.message).toContain("outside");
    rmSync(join(directory, "SKILL.md"));
    symlinkSync(join(external, "SKILL.md"), join(directory, "SKILL.md"));
    expect(() => loadAgentSkill(found.skills[0]!)).toThrow("location changed");
  });

  it("reports malformed folders while continuing valid discovery", () => {
    const mount = temp(); skill(mount, "valid");
    const bad = skill(mount, "bad");
    writeFileSync(join(bad, "SKILL.md"), "---\nname: Nope\ndescription: Missing name format\n---\nInstructions");
    const found = discoverAgentSkills({ homeDir: null, mounts: [{ path: mount }] });
    expect(found.skills).toHaveLength(1);
    expect(found.diagnostics).toHaveLength(1);
    expect(() => validateAgentSkillContent("---\nname: guide\n---\nBody")).toThrow("description");
    expect(() => validateAgentSkillContent("---\nname: guide\ndescription: Guide\n---\nBody", "other")).toThrow("directory name");
  });

  it("re-reads instructions on demand after edits", () => {
    const mount = temp(), directory = skill(mount, "guide", "Before");
    const found = discoverAgentSkills({ homeDir: null, mounts: [{ path: mount }] });
    skill(mount, "guide", "After");
    expect(loadAgentSkill(found.skills[0]!).content).toContain("After");
    expect(realpathSync(directory)).toBe(found.skills[0]!.directory);
  });

  it("warns about directory name differences while allowing existing skills to load", () => {
    const mount = temp();
    const directory = skill(mount, "original");
    writeFileSync(join(directory, "SKILL.md"), "---\nname: renamed\ndescription: An existing skill.\n---\nRead the reference.");
    const found = discoverAgentSkills({ homeDir: null, mounts: [{ path: mount }] });
    expect(found.skills).toHaveLength(1);
    expect(found.diagnostics[0]?.message).toContain("differs");
    expect(loadAgentSkill(found.skills[0]!).content).toContain("Read the reference.");
  });
});
