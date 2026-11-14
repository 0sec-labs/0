/** Browse model shared by Explore and the skills library: plain summaries and category groups. */
export type BrowsableSkill = { id: string; name: string; description: string; scope: string; summary?: string; category?: string; internal?: boolean };

export const YOURS = "Your skills";
const OTHER = "Other";
const CATEGORY_ORDER = ["Web", "Injection", "Identity", "LLM", "Native & crypto", "Code review", "Supply chain", "Reporting", "Development"];
const FALLBACK = "Reusable instructions for the agent.";
const MAX_SUMMARY = 90;

/** URL-safe category key, for `?category=` links. */
export const categorySlug = (name: string) => name.toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * One plain line for people. Prefers the authored `summary`; otherwise cleans the model-facing
 * description: drops "When to reach for ..." boilerplate and backticks, keeps the first sentence.
 */
export function cleanSkillSummary(skill: Pick<BrowsableSkill, "summary" | "description">): string {
  const authored = skill.summary?.replace(/`/g, "").trim();
  if (authored) return authored;
  let text = (skill.description ?? "").replace(/\s+/g, " ").trim();
  text = text.replace(/^when (?:to reach for|and how to use|to use|to call)\s+(?:the\s+)?(?:(?:offline|read-only)\s+)?(?:`[^`]*`|[\w-]+)\s*(?:engine|tool)?\s*[:,-]?\s*/i, "")
    .replace(/^when\s+(?:an?|the)\s+/i, "");
  text = text.replace(/`/g, "");
  const sentence = text.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? text;
  let line = sentence.replace(/[.:;,\s]+$/, "").trim();
  if (!line) return FALLBACK;
  line = line[0]!.toUpperCase() + line.slice(1);
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : line;
}

export const isBuiltinSkill = (skill: Pick<BrowsableSkill, "scope">) => skill.scope === "builtin";

/** Group name a skill is listed under. User skills share one group so they never mix into built-in categories. */
export const skillCategory = (skill: BrowsableSkill) => isBuiltinSkill(skill) ? skill.category?.trim() || OTHER : YOURS;

const rank = (name: string) => name === YOURS ? -1 : name === OTHER ? 1000 : (CATEGORY_ORDER.indexOf(name) + 1 || 500);

export type SkillSection<T extends BrowsableSkill = BrowsableSkill> = { category: string; slug: string; skills: T[] };

/** Visible skills grouped by category. Internal built-ins are hidden; `category` is a slug or empty. */
export function skillSections<T extends BrowsableSkill>(skills: readonly T[], query = "", category = ""): SkillSection<T>[] {
  const needle = query.trim().toLowerCase();
  const map = new Map<string, T[]>();
  for (const skill of skills) {
    if (skill.internal) continue;
    const group = skillCategory(skill);
    if (category && categorySlug(group) !== category) continue;
    if (needle && !`${skill.name} ${cleanSkillSummary(skill)} ${group}`.toLowerCase().includes(needle)) continue;
    map.set(group, [...(map.get(group) ?? []), skill]);
  }
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([name, list]) => ({ category: name, slug: categorySlug(name), skills: list.sort((a, b) => a.name.localeCompare(b.name)) }));
}

export const skillCategories = (skills: readonly BrowsableSkill[]) => skillSections(skills).map(({ category, slug }) => ({ value: slug, label: category }));
