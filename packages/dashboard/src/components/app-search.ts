export type SearchGroup = "Recent chats" | "Actions" | "Pages" | "Findings" | "Automations" | "Skills" | "Plugins" | "Memory" | "Hosts" | "Workflow workers" | "Settings" | "Runs";
export const SEARCH_GROUPS: SearchGroup[] = ["Recent chats", "Actions", "Pages", "Findings", "Automations", "Skills", "Plugins", "Memory", "Hosts", "Workflow workers", "Settings", "Runs"];

export interface SearchableItem { group: SearchGroup; label: string; meta: string; keywords: string[] }

/** Filter the whole available index before bounding each section's rendered rows. */
export function filterAppSearch<T extends SearchableItem>(items: T[], query: string, mode: "all" | "chats" = "all"): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const counts = new Map<SearchGroup, number>();
  return items.filter(item => {
    if (mode === "chats" && item.group !== "Recent chats") return false;
    // Chat results already come from the server's conversational full-text index.
    if (item.group !== "Recent chats" && !terms.every(term => [item.group, item.label, item.meta, ...item.keywords].join(" ").toLocaleLowerCase().includes(term))) return false;
    const limit = item.group === "Recent chats" ? (terms.length || mode === "chats" ? Number.POSITIVE_INFINITY : 6) : terms.length ? 12 : item.group === "Pages" ? 6 : 4;
    const count = counts.get(item.group) || 0;
    counts.set(item.group, count + 1);
    return count < limit;
  });
}

/** Index only human-facing fields explicitly selected by each adapter. */
export function searchKeywords(...values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
}
