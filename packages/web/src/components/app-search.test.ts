import { describe, expect, it } from "vitest";
import {
  filterAppSearch, footerHints, highlightParts, LOCAL_RECENT_GROUP, matchScore, nextTab, parseRecents, pushRecent, RECENT_GROUP, SEARCH_GROUPS, SEARCH_TABS, searchKeywords, wrapIndex,
  type RecentEntry, type SearchableItem,
} from "./app-search";

const item = (group: string, label: string, meta = "", keywords: string[] = [], extra: Partial<SearchableItem> = {}): SearchableItem => ({ group, label, meta, keywords, ...extra });

describe("matchScore and ranking", () => {
  it("ranks prefix over word start over substring over metadata", () => {
    const rows = [item("Pages", "Dashboard overview", "", ["models"]), item("Pages", "Choose models"), item("Pages", "Models"), item("Pages", "Bimodels")];
    const ranked = filterAppSearch(rows, "models").map(row => row.label);
    expect(ranked).toEqual(["Models", "Choose models", "Bimodels", "Dashboard overview"]);
    expect(matchScore(rows[2]!, "models")).toBe(0);
  });
  it("keeps source order for equal scores", () => {
    const rows = [item("Findings", "SQL one"), item("Findings", "SQL two")];
    expect(filterAppSearch(rows, "sql").map(row => row.label)).toEqual(["SQL one", "SQL two"]);
  });
});

describe("grouping and caps", () => {
  const many = (group: string, count: number) => Array.from({ length: count }, (_, index) => item(group, `Item ${index}`));
  it("caps every group at 8 on All with a term", () => {
    const out = filterAppSearch([...many("Findings", 20), ...many("Pages", 20)], "item");
    expect(out.filter(row => row.group === "Findings")).toHaveLength(8);
    expect(out.filter(row => row.group === "Pages")).toHaveLength(8);
  });
  it("shows short lists without a term and long lists on a dedicated tab", () => {
    expect(filterAppSearch(many("Findings", 20), "")).toHaveLength(4);
    expect(filterAppSearch(many("Findings", 20), "", "findings")).toHaveLength(20);
  });
  it("restricts a tab to its groups", () => {
    const rows = [item("Plugins", "A"), item("Skills", "B"), item("Findings", "C")];
  });
  it("trusts prefiltered rows and server-matched threads", () => {
    const rows = [item("Settings", "Theme", "", [], { prefiltered: true }), item(RECENT_GROUP, "Unrelated title")];
    expect(filterAppSearch(rows, "dark")).toHaveLength(2);
  });
  it("shows local recents only on All without a term", () => {
    const rows = [item(LOCAL_RECENT_GROUP, "Last page"), item("Pages", "Other")];
    expect(filterAppSearch(rows, "").map(row => row.label)).toEqual(["Last page", "Other"]);
    expect(filterAppSearch(rows, "o").map(row => row.group)).toEqual(["Pages"]);
    expect(filterAppSearch(rows, "", "settings")).toEqual([]);
  });
  it("caps local recents at 5", () => {
    expect(filterAppSearch(many(LOCAL_RECENT_GROUP, 9), "")).toHaveLength(5);
  });
});

describe("tabs and keyboard stepping", () => {
  it("wraps tabs in both directions", () => {
    expect(nextTab("all", -1)).toBe(SEARCH_TABS[SEARCH_TABS.length - 1]!.id);
    expect(nextTab(SEARCH_TABS[SEARCH_TABS.length - 1]!.id, 1)).toBe("all");
    expect(nextTab("all", 1)).toBe("chats");
  });
  it("wraps row selection", () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(-1, 1, 3)).toBe(0);
    expect(wrapIndex(-1, -1, 3)).toBe(2);
    expect(wrapIndex(0, 1, 0)).toBe(-1);
  });
});

describe("highlightParts", () => {
  it("marks every term case-insensitively and merges adjacent hits", () => {
    expect(highlightParts("Fix SQL injection", "sql inj")).toEqual([
      { text: "Fix ", match: false }, { text: "SQL", match: true }, { text: " ", match: false }, { text: "inj", match: true }, { text: "ection", match: false },
    ]);
    expect(highlightParts("abab", "ab")).toEqual([{ text: "abab", match: true }]);
  });
  it("treats regex characters literally and returns plain text for empty queries", () => {
    expect(highlightParts("a (b) c", "(b)")).toEqual([{ text: "a ", match: false }, { text: "(b)", match: true }, { text: " c", match: false }]);
    expect(highlightParts("plain", "  ")).toEqual([{ text: "plain", match: false }]);
    expect(highlightParts("", "x")).toEqual([{ text: "", match: false }]);
  });
});

describe("recents", () => {
  const entry = (id: string): RecentEntry => ({ id, kind: "page", label: id, href: `/${id}` });
  it("puts the newest first, dedupes by id and keeps five", () => {
    let list: RecentEntry[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f"]) list = pushRecent(list, entry(id));
    expect(list.map(row => row.id)).toEqual(["f", "e", "d", "c", "b"]);
    expect(pushRecent(list, entry("c")).map(row => row.id)).toEqual(["c", "f", "e", "d", "b"]);
  });
  it("drops corrupt or unsafe stored entries", () => {
    expect(parseRecents("nope")).toEqual([]);
    expect(parseRecents([entry("ok"), { id: 1 }, { ...entry("x"), href: "https://evil.example" }, null, { ...entry("y"), kind: "other" }])).toEqual([entry("ok")]);
    expect(parseRecents(Array.from({ length: 9 }, (_, index) => entry(String(index))))).toHaveLength(5);
  });
});

describe("footerHints", () => {
  it("changes with context", () => {
    const labels = (context: Parameters<typeof footerHints>[0]) => footerHints(context).map(hint => hint.keys);
    expect(labels({ hasSelection: false, canOpenInTab: false, hasQuery: false, mod: "⌘" })).toEqual(["←/→", "esc"]);
    expect(labels({ hasSelection: true, canOpenInTab: false, hasQuery: false, mod: "⌘" })).toEqual(["↵", "←/→", "esc"]);
    expect(labels({ hasSelection: true, canOpenInTab: true, hasQuery: true, mod: "⌘" })).toEqual(["↵", "⌘↵", "Tab", "←/→", "esc"]);
  });
});

describe("entity coverage and keyword selection", () => {
  it("includes each workspace entity category and matches all words across selected fields", () => {
    const index = SEARCH_GROUPS.map(group => item(group, `${group} example`, "", ["security audit"]));
    expect(filterAppSearch(index, "example audit").map(result => result.group)).toEqual(SEARCH_GROUPS.filter(group => group !== LOCAL_RECENT_GROUP));
    expect(filterAppSearch([item("Skills", "Review source", "", ["security audit"])], "source security")).toHaveLength(1);
    expect(filterAppSearch([item("Skills", "Review source", "", ["security audit"])], "source missing")).toEqual([]);
    expect(filterAppSearch([item("Skills", "Review source")], "skills source")).toHaveLength(1);
  });
  it("matches before section limits, including entities beyond the old fourteen-row cutoff", () => {
    const findings = Array.from({ length: 50 }, (_, index) => item("Findings", `Finding ${index}`));
    expect(filterAppSearch(findings, "49").map(result => result.label)).toEqual(["Finding 49"]);
    expect(filterAppSearch(findings, "finding")).toHaveLength(8);
    expect(filterAppSearch(findings, "")).toHaveLength(4);
  });
  it("offers bounded groups when empty while chat mode preserves paginated server full-text results", () => {
    const chats = Array.from({ length: 30 }, (_, index) => item(RECENT_GROUP, `Chat ${index}`));
    const index = [...chats, ...Array.from({ length: 12 }, (_, i) => item("Pages", `Page ${i}`)), item("Memory", "Lesson")];
    expect(filterAppSearch(index, "").filter(result => result.group === RECENT_GROUP)).toHaveLength(6);
    expect(filterAppSearch(index, "").filter(result => result.group === "Pages")).toHaveLength(6);
    expect(filterAppSearch(index, "body-only match", "chats")).toEqual(chats);
  });
  it("ignores absent keyword fields and never serializes arbitrary objects", () => {
    expect(searchKeywords("description", undefined, null, "", " ", "target")).toEqual(["description", "target"]);
  });
  it("derives the recent group label from the thread vocabulary", async () => {
    const { VOCAB, v } = await import("../lib/vocabulary");
    expect(RECENT_GROUP).toBe(`Recent ${VOCAB.mission.plural}`);
    expect(v("Open {a mission}")).toBe(`Open a ${VOCAB.mission.singular}`);
  });
});
