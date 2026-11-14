import { v } from "@/lib/vocabulary";
export const RECENT_GROUP = v("Recent {missions}");
/** Locally remembered missions and pages the operator opened from search. */
export const LOCAL_RECENT_GROUP = "Recent";
export type SearchGroup = string;
export const SEARCH_GROUPS: SearchGroup[] = [LOCAL_RECENT_GROUP, RECENT_GROUP, "Actions", "Pages", "Findings", "Automations", "Sentinels", "Plugins", "Skills", "Memory", "Hosts", "Engines", "Settings", "Runs"];

export type SearchTab = "all" | "chats" | "findings" | "automations" | "plugins" | "settings" | "sentinels";
/** `groups: null` means every group. Each tab's sources are queried only while it (or a typed term on All) is active. */
export const SEARCH_TABS: ReadonlyArray<{ id: SearchTab; label: string; groups: readonly SearchGroup[] | null }> = [
  { id: "all", label: "All", groups: null },
  { id: "chats", label: v("{Missions}"), groups: [RECENT_GROUP] },
  { id: "findings", label: "Findings", groups: ["Findings"] },
  { id: "automations", label: "Automations", groups: ["Automations"] },
  { id: "plugins", label: "Plugins", groups: ["Plugins", "Skills"] },
  { id: "settings", label: "Settings", groups: ["Settings"] },
  { id: "sentinels", label: v("{Sentinels}"), groups: ["Sentinels"] },
];

/** Step to the neighbouring tab, wrapping at both ends. */
export function nextTab(current: SearchTab, direction: 1 | -1): SearchTab {
  const index = SEARCH_TABS.findIndex(tab => tab.id === current);
  return SEARCH_TABS[(Math.max(index, 0) + direction + SEARCH_TABS.length) % SEARCH_TABS.length]!.id;
}

/** Wrap an arrow-key move through `count` rows. -1 means nothing is selected yet. */
export function wrapIndex(current: number, step: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

export interface SearchableItem { group: SearchGroup; label: string; meta: string; keywords: string[]; /** Already matched by its source (server search, settings index). */ prefiltered?: boolean }

const termsOf = (query: string) => query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

/** Lower is better: label prefix, word start, label substring, then metadata/keyword hits. */
export function matchScore(item: SearchableItem, query: string): number {
  const terms = termsOf(query);
  if (!terms.length) return 0;
  const label = item.label.toLocaleLowerCase();
  const full = terms.join(" ");
  if (label.startsWith(full)) return 0;
  if (terms.every(term => label.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(term)))) return 1;
  if (terms.every(term => label.includes(term))) return 2;
  return 3;
}

const TAB_CAP = 50;
/**
 * Filter the whole available index, rank each section by match quality, then bound every section's rows:
 * 8 per section on All with a term, a short list without one, and a long list on a dedicated tab.
 */
export function filterAppSearch<T extends SearchableItem>(items: T[], query: string, tab: SearchTab = "all"): T[] {
  const terms = termsOf(query);
  const groups = SEARCH_TABS.find(entry => entry.id === tab)?.groups ?? null;
  const buckets = new Map<SearchGroup, Array<{ item: T; score: number; index: number }>>();
  items.forEach((item, index) => {
    if (groups && !groups.includes(item.group)) return;
    if (item.group === LOCAL_RECENT_GROUP && (terms.length || tab !== "all")) return;
    if (!item.prefiltered && item.group !== RECENT_GROUP && !terms.every(term => [item.group, item.label, item.meta, ...item.keywords].join(" ").toLocaleLowerCase().includes(term))) return;
    const bucket = buckets.get(item.group) ?? [];
    bucket.push({ item, score: item.prefiltered || item.group === RECENT_GROUP || item.group === LOCAL_RECENT_GROUP ? 0 : matchScore(item, query), index });
    buckets.set(item.group, bucket);
  });
  const out: T[] = [];
  for (const [group, bucket] of buckets) {
    const limit = group === LOCAL_RECENT_GROUP ? 5
      : group === RECENT_GROUP ? (terms.length || tab === "chats" ? Number.POSITIVE_INFINITY : 6)
      : tab !== "all" ? TAB_CAP
      : terms.length ? 8 : group === "Pages" ? 6 : 4;
    bucket.sort((a, b) => a.score - b.score || a.index - b.index);
    out.push(...bucket.slice(0, limit).map(entry => entry.item));
  }
  return out;
}

export type HighlightPart = { text: string; match: boolean };
/** Split `text` so the parts matching any query term can be emphasised. Case-insensitive; adjacent hits merge. */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const terms = [...new Set(termsOf(query))].sort((a, b) => b.length - a.length);
  if (!text || !terms.length) return [{ text, match: false }];
  const lower = text.toLocaleLowerCase();
  // Lowercasing can change length for a few scripts; skip highlighting rather than mis-slice.
  if (lower.length !== text.length) return [{ text, match: false }];
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) marked.fill(true, at, at + term.length);
  const parts: HighlightPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.match === marked[i]) last.text += text[i]; else parts.push({ text: text[i]!, match: marked[i]! });
  }
  return parts;
}

export type RecentEntry = { id: string; kind: "mission" | "page"; label: string; href: string };
export const MAX_RECENTS = 5;
export function parseRecents(value: unknown): RecentEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is RecentEntry => Boolean(entry) && typeof entry === "object"
    && typeof entry.id === "string" && typeof entry.label === "string" && typeof entry.href === "string" && entry.href.startsWith("/")
    && (entry.kind === "mission" || entry.kind === "page")).slice(0, MAX_RECENTS);
}
/** Most recent first, one entry per id, capped. */
export function pushRecent(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...list.filter(item => item.id !== entry.id)].slice(0, MAX_RECENTS);
}

export type FooterHint = { keys: string; label: string };
/** Footer hints for the current context. `mod` is the platform's command key label. */
export function footerHints(context: { hasSelection: boolean; canOpenInTab: boolean; hasQuery: boolean; mod: string }): FooterHint[] {
  const hints: FooterHint[] = [];
  if (context.hasSelection) hints.push({ keys: "↵", label: "Open" });
  if (context.hasSelection && context.canOpenInTab) hints.push({ keys: `${context.mod}↵`, label: "Open in new tab" });
  if (context.hasQuery) hints.push({ keys: "Tab", label: v("New {mission} with this text") });
  hints.push({ keys: "←/→", label: "Switch tab" }, { keys: "esc", label: "Close" });
  return hints;
}

/** Index only human-facing fields explicitly selected by each adapter. */
export function searchKeywords(...values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
}

/** Reduce markdown to one line of plain text for single-line result previews. */
export function plainPreview(text: string | null | undefined, max = 120): string {
  const plain = (text ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~|[*_`])/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
