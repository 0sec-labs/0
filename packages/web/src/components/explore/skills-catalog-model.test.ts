import { describe, expect, it } from "vitest";
import { abbreviateStars, catalogSkillPath, catalogSummary, githubTreeUrl, parseGithubSource, rankCatalog, splitSkillMarkdown, titleCase, type CatalogSkill } from "./skills-catalog-model";
import { resolveCrumbs } from "@/lib/breadcrumbs";

const skill = (id: string, stars: number, extra: Partial<CatalogSkill> = {}): CatalogSkill => ({ id, name: id, title: titleCase(id), summary: `Does ${id}.`, repo: "o/r", path: id, ref: "main", commit: "a".repeat(40), publisher: "o", verified: true, stars, pushedAt: "", licence: "MIT", licenceSource: "repository", installable: true, security: false, files: 1, bytes: 1, hasScripts: false, installed: null, ...extra });
const publishers = { o: { name: "Octo Org", url: "https://github.com/o", avatar: "" } };

describe("abbreviateStars", () => {
  it("uses Capy's abbreviations", () => {
    expect([0, 346, 999, 1000, 8188, 323_876, 999_949, 1_250_000].map(abbreviateStars)).toEqual(["0", "346", "999", "1k", "8.2k", "323.9k", "999.9k", "1.3M"]);
    expect(abbreviateStars(-1)).toBe("0"); expect(abbreviateStars(Number.NaN)).toBe("0");
  });
});

describe("titleCase", () => {
  it("title-cases folder names and keeps acronyms", () => { expect(titleCase("diagnosing-bugs")).toBe("Diagnosing Bugs"); expect(titleCase("pr-body")).toBe("PR Body"); expect(titleCase("mcp-builder")).toBe("MCP Builder"); expect(titleCase("owasp_security")).toBe("OWASP Security"); expect(titleCase("spec-to-code-compliance")).toBe("Spec to Code Compliance"); expect(titleCase("codeql")).toBe("CodeQL"); });
});

describe("rankCatalog", () => {
  const list = [skill("popular", 300_000), skill("sec-small", 100, { security: true }), skill("sec-big", 8000, { security: true }), skill("medium", 5000)];
  it("lists Security first, then the rest, each by stars", () => {
    expect(rankCatalog(list, publishers).map(item => item.id)).toEqual(["sec-big", "sec-small", "popular", "medium"]);
  });
  it("filters to Security and searches title, summary, publisher and repo", () => {
    expect(rankCatalog(list, publishers, "", "security").map(item => item.id)).toEqual(["sec-big", "sec-small"]);
    expect(rankCatalog(list, publishers, "octo").length).toBe(4);
    expect(rankCatalog(list, publishers, "MEDIUM").map(item => item.id)).toEqual(["medium"]);
    expect(rankCatalog(list, publishers, "medium", "security")).toEqual([]);
  });
  it("keeps the server's repository grouping on star ties", () => {
    expect(rankCatalog([skill("b", 5), skill("a", 5)], publishers).map(item => item.id)).toEqual(["b", "a"]);
  });
});

describe("rows and links", () => {
  it("cuts the summary to one sentence and 110 characters", () => {
    expect(catalogSummary("First sentence. Second sentence.")).toBe("First sentence.");
    expect(catalogSummary("word ".repeat(60)).length).toBeLessThanOrEqual(110);
  });
  it("builds the detail route and a pinned GitHub tree link", () => {
    expect(catalogSkillPath("trailofbits~skills~semgrep")).toBe("/plugins/skills/catalog/trailofbits~skills~semgrep");
    expect(githubTreeUrl("o/r", "abc", "skills/x")).toBe("https://github.com/o/r/tree/abc/skills/x");
  });
  it("shows Skills > Browse > name for a catalog skill", () => {
    expect(resolveCrumbs("/plugins/skills/catalog/o~r~x", "", "Semgrep Scan")).toEqual([{ label: "Skills", to: "/plugins/skills" }, { label: "Browse", to: "/plugins/skills?tab=browse" }, { label: "Semgrep Scan" }]);
    expect(resolveCrumbs("/plugins/skills", "")).toEqual([{ label: "Skills", to: "/plugins/skills" }, { label: "Installed" }]);
  });
});

describe("parseGithubSource", () => {
  it("accepts owner/repo, folders and GitHub URLs", () => {
    expect(parseGithubSource("trailofbits/skills")).toEqual({ repo: "trailofbits/skills", path: "", ref: "" });
    expect(parseGithubSource("o/r/skills/x")).toEqual({ repo: "o/r", path: "skills/x", ref: "" });
    expect(parseGithubSource("https://github.com/o/r/tree/v2/skills/x/SKILL.md?plain=1")).toEqual({ repo: "o/r", path: "skills/x", ref: "v2" });
    expect(parseGithubSource("https://github.com/o/r.git")).toEqual({ repo: "o/r", path: "", ref: "" });
  });
  it("rejects anything that is not a repository", () => { for (const bad of ["", "owner", "a b/c", "-x/y", "https://evil.example/o/r"]) expect(parseGithubSource(bad), bad).toBeNull(); });
});

describe("splitSkillMarkdown", () => {
  it("separates the YAML metadata block from the instructions", () => {
    expect(splitSkillMarkdown("---\nname: x\ndescription: y\n---\n\n# Title\nBody")).toEqual({ frontmatter: "name: x\ndescription: y", body: "# Title\nBody" });
    expect(splitSkillMarkdown("# No metadata")).toEqual({ frontmatter: "", body: "# No metadata" });
  });
});
