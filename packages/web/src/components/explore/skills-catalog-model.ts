/** View model for the Skills directory in Explore: a curated GitHub catalog, pinned to commits by the server. */
export type CatalogSkill = {
  id: string; name: string; title: string; summary: string; repo: string; path: string; ref: string; commit: string; publisher: string; verified: boolean;
  stars: number; pushedAt: string; licence: string | null; licenceSource: string; installable: boolean; security: boolean; files: number; bytes: number; hasScripts: boolean;
  installed: { name: string; sha: string; current: boolean } | null;
};
export type CatalogPublisher = { name: string; url: string; avatar: string };
export type CatalogResponse = { generated: string; publishers: Record<string, CatalogPublisher>; skills: CatalogSkill[] };
export type CatalogFilter = "all" | "security";

export const VERIFIED_BY_0 = "Verified by 0";
export const VERIFIED_HINT = "Listed and pinned by 0. Review a skill before adding it.";

/** 323876 -> "323.9k", 8188 -> "8.2k", 346 -> "346", 1_250_000 -> "1.3M". */
export function abbreviateStars(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (count >= 999_950) return `${trim(count / 1_000_000)}M`;
  if (count >= 1000) return `${trim(Math.min(count, 999_949) / 1000)}k`;
  return String(Math.round(count));
}

const ACRONYMS: Record<string, string> = { api: "API", pr: "PR", ctf: "CTF", cvss: "CVSS", owasp: "OWASP", sarif: "SARIF", yara: "YARA", mcp: "MCP", ui: "UI", ci: "CI", cd: "CD", tdd: "TDD", gha: "GHA", ai: "AI", llm: "LLM", pwn: "Pwn", fp: "FP", sql: "SQL", xss: "XSS", adr: "ADR", adrs: "ADRs", codeql: "CodeQL" };
const SMALL_WORDS = new Set(["to", "of", "and", "for", "the", "a", "an", "in", "on", "or", "with"]);
/** "mcp-builder" -> "MCP Builder". */
export const titleCase = (name: string) => name.split(/[-_\s]+/).filter(Boolean).map((word, index) => ACRONYMS[word.toLowerCase()] ?? (index > 0 && SMALL_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1))).join(" ");

export const catalogSkillPath = (id: string) => `/plugins/skills/catalog/${encodeURIComponent(id)}`;
export const githubTreeUrl = (repo: string, sha: string, path: string) => `https://github.com/${repo}${path ? `/tree/${sha}/${path}` : `/tree/${sha}`}`;
export const githubCommitUrl = (repo: string, sha: string) => `https://github.com/${repo}/commit/${sha}`;

/**
 * Default order is Security first, then the rest, each by stars (ties keep the repository grouping the server sent).
 * The Security filter keeps only security entries. Search looks at title, name, summary, publisher and repository.
 */
export function rankCatalog(skills: readonly CatalogSkill[], publishers: Record<string, CatalogPublisher>, query = "", filter: CatalogFilter = "all"): CatalogSkill[] {
  const needle = query.trim().toLowerCase();
  const matches = skills.filter(skill => (filter === "all" || skill.security)
    && (!needle || `${skill.title} ${skill.name} ${skill.summary} ${publishers[skill.publisher]?.name ?? skill.publisher} ${skill.repo}`.toLowerCase().includes(needle)));
  const order = new Map(skills.map((skill, index) => [skill.id, index]));
  return [...matches].sort((a, b) => Number(b.security) - Number(a.security) || b.stars - a.stars || order.get(a.id)! - order.get(b.id)!);
}

/** One line for the row: the catalog summary, cut at the first sentence and 110 characters. */
export function catalogSummary(summary: string): string {
  const text = summary.replace(/\s+/g, " ").trim();
  const sentence = text.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? text;
  return sentence.length > 110 ? `${sentence.slice(0, 109).trimEnd()}…` : sentence;
}

/** "owner/repo", "owner/repo/sub/folder", a github.com URL or a /tree/<ref>/<folder> URL -> the three request fields. */
export function parseGithubSource(input: string): { repo: string; path: string; ref: string } | null {
  let text = input.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//i, "").replace(/\.git(?=\/|$)/, "").replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
  const parts = text.split("/");
  if (parts.length < 2 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(parts[0]!) || !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1]!)) return null;
  let ref = ""; let rest = parts.slice(2);
  if ((rest[0] === "tree" || rest[0] === "blob") && rest.length >= 2) { ref = rest[1]!; rest = rest.slice(2); }
  if (rest.at(-1) === "SKILL.md") rest = rest.slice(0, -1);
  return { repo: `${parts[0]}/${parts[1]}`, path: rest.join("/"), ref };
}

export type CatalogPreview = {
  id: string | null; repo: string; path: string; ref: string | null; sha: string; name: string; title: string; description: string; verified: boolean; publisher: string;
  licence: { spdx: string | null; installable: boolean; shareAlike: boolean; notice: string; source: string; attribution: string };
  skillMd: { text: string; truncated: boolean; bytes: number }; files: { path: string; size: number }[]; bytes: number; hasScripts: boolean; warnings: string[];
  installed: { name: string; sha: string } | null;
};

/** SKILL.md starts with a YAML block that Markdown would render as a heading; show it as metadata and render only the body. */
export function splitSkillMarkdown(text: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? { frontmatter: match[1]!.trim(), body: text.slice(match[0].length).replace(/^\s+/, "") } : { frontmatter: "", body: text };
}
