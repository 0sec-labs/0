import { describe, expect, it } from "vitest";
import { categorySlug, cleanSkillSummary, skillCategories, skillSections, YOURS, type BrowsableSkill } from "./skills-model";

const row = (name: string, extra: Partial<BrowsableSkill> = {}): BrowsableSkill => ({ id: `builtin/${name}`, name, description: "", scope: "builtin", ...extra });

describe("cleanSkillSummary", () => {
  it("prefers the authored summary and strips backticks", () => {
    expect(cleanSkillSummary({ summary: "Map `paths` offline.", description: "When to reach for x" })).toBe("Map paths offline.");
  });
  it("drops routing boilerplate, backticks and everything after the first sentence", () => {
    expect(cleanSkillSummary({ description: "When to reach for the offline `ad_attack_paths` engine: given a BloodHound JSON, enumerate paths to Domain Admin. Files only." }))
      .toBe("Given a BloodHound JSON, enumerate paths to Domain Admin");
    expect(cleanSkillSummary({ description: "When to reach for the read-only `entra_posture` engine: assess a tenant." })).toBe("Assess a tenant");
    expect(cleanSkillSummary({ description: "When an LLM target has tools, chain injection." })).toBe("LLM target has tools, chain injection");
  });
  it("keeps plain descriptions, truncates long ones and falls back when empty", () => {
    expect(cleanSkillSummary({ description: "Review infrastructure-as-code." })).toBe("Review infrastructure-as-code");
    const long = cleanSkillSummary({ description: "word ".repeat(60) });
    expect(long.length).toBeLessThanOrEqual(90); expect(long.endsWith("…")).toBe(true);
    expect(cleanSkillSummary({ description: "  " })).toBe("Reusable instructions for the agent.");
  });
});

describe("skillSections", () => {
  const skills = [
    row("jwt-attacks", { category: "Identity", summary: "Test JWT handling." }),
    row("nextjs-appsec", { category: "Web" }),
    row("race-condition", { category: "Web" }),
    row("develop-this-app", { category: "Development", internal: true }),
    row("legacy"),
    { id: "mine", name: "my-review", description: "Mine.", scope: "workspace" },
  ];
  it("hides internal skills and orders yours first, then known categories, then other", () => {
    expect(skillSections(skills).map(section => section.category)).toEqual([YOURS, "Web", "Identity", "Other"]);
    expect(skillSections(skills).flatMap(section => section.skills.map(skill => skill.name))).not.toContain("develop-this-app");
  });
  it("filters by category slug and by search over name, summary and category", () => {
    expect(skillSections(skills, "", "web")[0]!.skills.map(skill => skill.name)).toEqual(["nextjs-appsec", "race-condition"]);
    expect(skillSections(skills, "jwt handling").flatMap(section => section.skills.map(skill => skill.name))).toEqual(["jwt-attacks"]);
    expect(skillSections(skills, "identity").flatMap(section => section.skills.map(skill => skill.name))).toEqual(["jwt-attacks"]);
    expect(skillSections(skills, "", "your-skills")[0]!.skills).toHaveLength(1);
  });
  it("exposes dropdown options with stable slugs", () => {
    expect(skillCategories(skills)).toContainEqual({ value: "identity", label: "Identity" });
    expect(categorySlug("Native & crypto")).toBe("native-crypto");
  });
});
