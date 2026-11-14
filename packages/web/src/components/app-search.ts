import { v } from "@/lib/vocabulary";
export const RECENT_GROUP = v("Recent {missions}");
export type SearchGroup = string;
export const SEARCH_GROUPS: SearchGroup[] = [RECENT_GROUP, "Actions", "Pages", "Findings", "Automations", "Sentinels", "Skills", "Plugins", "Memory", "Hosts", "Engines", "Settings", "Runs"];

export interface SearchableItem { group: SearchGroup; label: string; meta: string; keywords: string[] }

/** Filter the whole available index before bounding each section's rendered rows. */
export function filterAppSearch<T extends SearchableItem>(items: T[], query: string, mode: "all" | "chats" = "all"): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const counts = new Map<SearchGroup, number>();
  return items.filter(item => {
    if (mode === "chats" && item.group !== RECENT_GROUP) return false;
    // Mission results already come from the server's conversational full-text index.
    if (item.group !== RECENT_GROUP && !terms.every(term => [item.group, item.label, item.meta, ...item.keywords].join(" ").toLocaleLowerCase().includes(term))) return false;
    const limit = item.group === RECENT_GROUP ? (terms.length || mode === "chats" ? Number.POSITIVE_INFINITY : 6) : terms.length ? 12 : item.group === "Pages" ? 6 : 4;
    const count = counts.get(item.group) || 0;
    counts.set(item.group, count + 1);
    return count < limit;
  });
}

/** Index only human-facing fields explicitly selected by each adapter. */
export function searchKeywords(...values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
}
