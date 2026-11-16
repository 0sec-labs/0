import { describe, expect, it } from "vitest";
import { bundledSkillIcon } from "./skill-icons";

describe("bundledSkillIcon", () => {
  it("uses the category when the name says nothing", () => {
    expect(bundledSkillIcon({ name: "ssrf-bypass", category: "Web" })).toBe("web");
    expect(bundledSkillIcon({ name: "blind-exploitation", category: "Injection" })).toBe("injection");
    expect(bundledSkillIcon({ name: "pr-review", category: "Code review" })).toBe("source");
    expect(bundledSkillIcon({ name: "x", category: "Reporting" })).toBe("report");
  });
  it("lets whole name words win over the category", () => {
    expect(bundledSkillIcon({ name: "github-actions-audit", category: "Code review" })).toBe("ci");
    expect(bundledSkillIcon({ name: "aws-iam-review", category: "Identity" })).toBe("cloud");
    expect(bundledSkillIcon({ name: "binary-triage", category: "Native & crypto" })).toBe("native");
    expect(bundledSkillIcon({ name: "padding-oracle", category: "Native & crypto" })).toBe("crypto");
    expect(bundledSkillIcon({ name: "dependency-confusion", category: "Supply chain" })).toBe("supply");
  });
  it("does not match inside a word", () => {
    expect(bundledSkillIcon({ name: "social-engineering", category: "Web" })).toBe("web");
  });
  it("falls back to the document icon", () => {
    expect(bundledSkillIcon({ name: "misc" })).toBe("document");
    expect(bundledSkillIcon({ name: "misc", category: "Nothing" })).toBe("document");
  });
});
