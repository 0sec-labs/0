import { cleanSkillSummary, matchesWords, type BrowsableSkill } from "@/components/skills-model";

export type InstalledSkill = BrowsableSkill & { source: string; origin?: { repo: string; sha: string; publisher?: string | null; catalogId?: string | null } };

/** Yours (made or added by you) first, then the ones that come with 0, then the ones an extension provides. */
export type SkillGroup = "yours" | "builtin" | "extension";
export const skillGroup = (skill: Pick<InstalledSkill, "scope">): SkillGroup => skill.scope === "builtin" ? "builtin" : skill.scope === "extension" ? "extension" : "yours";
const ORDER: Record<SkillGroup, number> = { yours: 0, builtin: 1, extension: 2 };

/** Flat, ranked list: group, then name. Internal skills never show; search must start a word in the name, summary or source. */
export function rankInstalled<T extends InstalledSkill>(skills: readonly T[], query = "", shared = false): T[] {
  const needle = query.trim();
  return skills.filter(skill => !skill.internal && (!needle || matchesWords(`${skill.name} ${cleanSkillSummary(skill)} ${installedSource(skill, shared)}`, needle)))
    .sort((a, b) => ORDER[skillGroup(a)] - ORDER[skillGroup(b)] || a.name.localeCompare(b.name));
}

/** Where an installed skill comes from, as the row's second right-hand line. */
export function installedSource(skill: InstalledSkill, shared = false): string {
  if (skill.scope === "builtin") return "Built-in";
  if (skill.scope === "extension") return skill.source || "Extension";
  if (skill.origin) return skill.origin.repo;
  if (skill.scope === "mounted" || skill.scope === "project") return "Your folder";
  return shared ? "Team" : "You";
}

/** Owner of a GitHub-sourced skill ("owner/repo" -> "owner"), the key into the catalog's publishers. */
export const originOwner = (skill: Pick<InstalledSkill, "origin">): string | undefined => skill.origin?.publisher ?? skill.origin?.repo.split("/")[0]?.toLowerCase();

export type SkillTile =
  | { kind: "publisher"; owner: string; name: string }
  | { kind: "brand" }
  | { kind: "extension" }
  | { kind: "monogram"; name: string };

/** Tile content: GitHub skills show their publisher, bundled ones the 0security mark, extensions the puzzle icon, yours a monogram. */
export function installedTile(skill: InstalledSkill): SkillTile {
  if (skill.scope === "builtin") return { kind: "brand" };
  if (skill.scope === "extension") return { kind: "extension" };
  if (skill.origin) return { kind: "publisher", owner: originOwner(skill)!, name: skill.origin.repo.split("/")[0]! };
  return { kind: "monogram", name: skill.name };
}
