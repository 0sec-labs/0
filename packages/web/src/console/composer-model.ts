/** Pure helpers for the composer's menus: slash curation, @ mentions and reasoning-effort choices. */
import { matchesSlashQuery, type SlashCommand } from "@0/engine/shared/slash-commands";

/** Commands shown first when the slash menu opens with no query. */
export const CURATED_SLASH_COMMANDS = [
  "threads start",
  "threads list",
  "findings list",
  "models default",
  "extensions list",
  "config list",
  "status",
  "help",
] as const;
export const SLASH_CURATED_LIMIT = 8;

/**
 * Empty query: the curated top 8 (when `showAll` is false), with `hidden` counting the rest. A typed query always
 * searches every command, so nothing is unreachable.
 */
export function curateSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  showAll: boolean,
): { items: SlashCommand[]; hidden: number } {
  const matches = commands.filter((command) => matchesSlashQuery(command, query));
  if (query.trim() || showAll) return { items: matches, hidden: 0 };
  const curated = CURATED_SLASH_COMMANDS.flatMap(
    (name) => matches.find((command) => command.name === name) ?? [],
  ).slice(0, SLASH_CURATED_LIMIT);
  return {
    items: curated,
    hidden: Math.max(0, matches.length - curated.length),
  };
}

/** Consecutive commands of one group under one heading, in the order given (the keyboard walks the flat list). */
export function groupSlashCommands(commands: readonly SlashCommand[]): { group: string; items: SlashCommand[] }[] {
  const groups: { group: string; items: SlashCommand[] }[] = [];
  for (const command of commands) {
    const last = groups[groups.length - 1];
    if (last && last.group === command.group) last.items.push(command);
    else groups.push({ group: command.group, items: [command] });
  }
  return groups;
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
  plugin: "Extensions",
  finding: "Findings",
  mission: "Threads",
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
  needsConnection = false,
): { text: string; known: boolean } {
  const model = runtime?.model || remembered?.model;
  if (model) return { text: model, known: true };
  if (needsConnection) return { text: "Connect a model", known: false };
  // Models are listed but none is picked: the mission runs on the host's own default, and the button says so.
  return hasModels ? { text: "Default model", known: false } : { text: "Choose model", known: false };
}

/**
 * A bound model the picker no longer lists: not an enabled catalog row, or (for an empty draft, which can simply move)
 * served by a provider that is rejected or unreachable. Unknown until the catalog has loaded, and never for local/relay sources.
 */
export function boundModelStale(
  runtime: { providerId?: string; model?: string; modelSource?: string } | null | undefined,
  models: readonly { id: string; provider: string; enabled?: boolean }[] | undefined,
  options: { unusable?: ReadonlySet<string>; emptyThread?: boolean; discoveryFailed?: ReadonlySet<string> } = {},
): boolean {
  if (!runtime?.model || !models || runtime.modelSource === "local") return false;
  // A provider whose model list could not be read (offline, rate limited) says nothing about this model.
  if (runtime.providerId && options.discoveryFailed?.has(runtime.providerId)) return false;
  const listed = models.some((item) => item.provider === runtime.providerId && item.id === runtime.model && item.enabled !== false);
  if (!listed) return true;
  return Boolean(options.emptyThread && runtime.providerId && options.unusable?.has(runtime.providerId));
}
