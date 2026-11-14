/** Pure helpers for the composer's menus: slash curation, @ mentions and reasoning-effort choices. */

/** Commands shown first when the slash menu opens with no query. */
export const CURATED_SLASH_COMMANDS = [
  "model",
  "new-chat",
  "status",
  "findings",
  "plugins",
  "settings",
  "tools",
  "help",
] as const;
export const SLASH_CURATED_LIMIT = 8;

export interface SlashLike {
  name: string;
  aliases: readonly string[];
}

/**
 * Empty query: the curated top 8 (when `showAll` is false), with `hidden` counting the rest. A typed query always
 * searches every command, so nothing is unreachable.
 */
export function curateSlashCommands<T extends SlashLike>(
  commands: readonly T[],
  query: string,
  showAll: boolean,
): { items: T[]; hidden: number } {
  const q = query.toLowerCase();
  const matches = commands.filter(
    (command) =>
      command.name !== "launcher" &&
      (command.name.startsWith(q) || command.aliases.some((alias) => alias.startsWith(q))),
  );
  if (q || showAll) return { items: matches, hidden: 0 };
  const curated = CURATED_SLASH_COMMANDS.flatMap(
    (name) => matches.find((command) => command.name === name) ?? [],
  ).slice(0, SLASH_CURATED_LIMIT);
  return {
    items: curated,
    hidden: Math.max(0, matches.length - curated.length),
  };
}

export type MentionKind = "plugin" | "finding" | "mission";
export interface MentionItem {
  kind: MentionKind;
  id: string;
  label: string;
  description?: string;
  /** Text inserted into the draft. */
  token: string;
}
export const MENTION_GROUP_LABELS: Record<MentionKind, string> = {
  plugin: "Plugins",
  finding: "Findings",
  mission: "Missions",
};
export const MENTION_GROUP_LIMIT = 5;

/** Subsequence match so "xss" finds "Reflected XSS in search"; contiguous hits rank first. */
export function fuzzyScore(text: string, query: string): number | null {
  const haystack = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return direct === 0 ? 0 : 1 + direct / 1000;
  let at = 0;
  for (const char of needle) {
    at = haystack.indexOf(char, at);
    if (at < 0) return null;
    at += 1;
  }
  return 10;
}

/** Reference text for a finding or mission, written like the "Ask about this" visual references. */
export function mentionToken(kind: Exclude<MentionKind, "plugin">, id: string, title: string): string {
  const clean = title.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 80) || id;
  return `"${clean}" (${kind} ${id}) `;
}

/** Filter one group fuzzily by label/id, best matches first, capped. */
export function filterMentions(
  items: readonly MentionItem[],
  query: string,
  limit = MENTION_GROUP_LIMIT,
): MentionItem[] {
  return items
    .flatMap((item) => {
      const score = fuzzyScore(`${item.label} ${item.id}`, query);
      return score === null ? [] : [{ item, score }];
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** Plugins, then findings, then missions: the flat order the keyboard walks. */
export function orderMentions(groups: Partial<Record<MentionKind, MentionItem[]>>): MentionItem[] {
  return (["plugin", "finding", "mission"] as const).flatMap((kind) => groups[kind] ?? []);
}

/** Reasoning choices in a stable low-to-high order with labels; models without >=2 options get none. */
const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Very high",
  max: "Maximum",
};
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export function effortChoices(
  reasoning: { effort: string; options: readonly string[] } | null | undefined,
): { value: string; label: string; selected: boolean }[] {
  if (!reasoning || reasoning.options.length < 2) return [];
  const rank = (value: string) => {
    const index = EFFORT_ORDER.indexOf(value);
    return index < 0 ? EFFORT_ORDER.length : index;
  };
  return [...reasoning.options]
    .sort((a, b) => rank(a) - rank(b))
    .map((value) => ({
      value,
      label: EFFORT_LABELS[value] ?? value,
      selected: value === reasoning.effort,
    }));
}

/** What the model button shows before a runtime exists: the live model, else the remembered pick, else a prompt. */
export function modelButtonLabel(
  runtime: { model?: string } | null | undefined,
  remembered: { model: string } | undefined,
  hasModels = false,
): { text: string; known: boolean } {
  const model = runtime?.model || remembered?.model;
  // With a connected provider the next mission starts on its default model; nobody has to pick one first.
  return model ? { text: model, known: true } : { text: hasModels ? "Default model" : "Choose model", known: false };
}
